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
    try {
      const configRes = await requestUrl(this.settings.configUrl);
      const config = configRes.json;

      this.connection = await amqp.connect(this.settings.rabbitUrl);
      this.channel = await this.connection.createChannel();

      await this.channel.assertExchange(config.exchange, "topic", {
        durable: true,
      });

      for (const topic of config.topics) {
        const queueName = topic.replace("tg.", "");

        await this.channel.assertQueue(queueName, {
          durable: true,
        });

        await this.channel.consume(
          queueName,
          async (msg: amqp.ConsumeMessage | null) => {
            if (msg) {
              await this.saveMessage(
                msg.fields.routingKey,
                msg.content.toString(),
              );
              this.channel.ack(msg);
            }
          },
        );
      }

      new Notice("Успешное подключение к RabbitMQ");
    } catch (e) {
      console.error(e);
      new Notice("Ошибка подключения к RabbitMQ. Проверьте консоль.");
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
