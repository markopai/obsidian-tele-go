import { Plugin, normalizePath, requestUrl, Notice } from "obsidian";
import {
  PluginSettings,
  DEFAULT_SETTINGS,
  TelegramSyncSettingTab,
} from "./settings";
import * as amqp from "amqplib";

export default class TelegramSyncPlugin extends Plugin {
  settings!: PluginSettings;
  connection!: any;
  channel!: any;
  retryTimeout: NodeJS.Timeout | null = null;
  configPollingInterval: NodeJS.Timeout | null = null;
  isReconnecting: boolean = false;
  currentTopics: string[] = [];
  currentQueue: string = "";
  currentExchange: string = "";

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new TelegramSyncSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(() => {
      this.initRabbitMQ();
    });
  }

  async onunload() {
    this.clearTimers();
    if (this.channel) {
      this.channel.removeAllListeners();
      await this.channel.close();
    }
    if (this.connection) {
      this.connection.removeAllListeners();
      await this.connection.close();
    }
  }

  clearTimers() {
    if (this.retryTimeout) clearTimeout(this.retryTimeout);
    if (this.configPollingInterval) clearInterval(this.configPollingInterval);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async initRabbitMQ() {
    if (this.isReconnecting) return;
    this.isReconnecting = true;

    try {
      const configRes = await requestUrl(this.settings.configUrl);
      const config = configRes.json;

      this.connection = await amqp.connect(this.settings.rabbitUrl);

      this.connection.on("error", () => {
        new Notice("RabbitMQ: Ошибка соединения");
        this.scheduleReconnect();
      });

      this.connection.on("close", () => {
        new Notice("RabbitMQ: Соединение закрыто");
        this.scheduleReconnect();
      });

      this.channel = await this.connection.createChannel();

      this.channel.on("error", () => {
        new Notice("RabbitMQ: Ошибка канала");
        this.scheduleReconnect();
      });

      this.channel.on("close", () => {
        new Notice("RabbitMQ: Канал закрыт");
        this.scheduleReconnect();
      });

      this.currentExchange = config.exchange;
      await this.channel.assertExchange(this.currentExchange, "topic", {
        durable: true,
      });

      const q = await this.channel.assertQueue("", { exclusive: true });
      this.currentQueue = q.queue;
      this.currentTopics = [];

      for (const topic of config.topics) {
        await this.channel.bindQueue(
          this.currentQueue,
          this.currentExchange,
          topic,
        );
        this.currentTopics.push(topic);
      }

      await this.channel.consume(this.currentQueue, async (msg: any) => {
        if (msg) {
          await this.saveMessage(msg.fields.routingKey, msg.content.toString());
          this.channel.ack(msg);
        }
      });

      new Notice("Успешное подключение к RabbitMQ и загрузка конфигов");

      this.clearTimers();
      this.isReconnecting = false;

      this.configPollingInterval = setInterval(() => this.pollConfig(), 60000);
    } catch (e) {
      new Notice("Ошибка подключения. Повтор через 15 секунд...");
      this.scheduleReconnect();
    }
  }

  async pollConfig() {
    if (!this.channel || this.isReconnecting) return;

    try {
      const configRes = await requestUrl(this.settings.configUrl);
      const config = configRes.json;

      if (config.exchange !== this.currentExchange) {
        return;
      }

      const newTopics = config.topics.filter(
        (t: string) => !this.currentTopics.includes(t),
      );

      if (newTopics.length > 0) {
        for (const topic of newTopics) {
          await this.channel.bindQueue(
            this.currentQueue,
            this.currentExchange,
            topic,
          );
          this.currentTopics.push(topic);
        }
        new Notice(`Добавлены новые топики: ${newTopics.join(", ")}`);
      }
    } catch (e) {
      console.error(e);
    }
  }

  scheduleReconnect() {
    this.clearTimers();
    this.isReconnecting = false;
    this.retryTimeout = setTimeout(() => this.initRabbitMQ(), 15000);
  }

  async saveMessage(routingKey: string, content: string) {
    const folderPath = normalizePath(this.settings.saveFolder);
    const folderExists = this.app.vault.getAbstractFileByPath(folderPath);

    if (!folderExists) {
      await this.app.vault.createFolder(folderPath);
    }

    const timestamp = window.moment().format("YYYY-MM-DD_HH-mm-ss");
    const title = `${routingKey}_${timestamp}`;
    const tag = `#${routingKey}`;
    const fileName = normalizePath(`${folderPath}/${title}.md`);
    const fileContent = `${tag}\n# ${title}\n\n${content}`;

    await this.app.vault.create(fileName, fileContent);
  }
}
