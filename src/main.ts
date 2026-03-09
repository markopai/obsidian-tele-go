import { Plugin, normalizePath, requestUrl, moment, Notice } from "obsidian";
import {
  PluginSettings,
  DEFAULT_SETTINGS,
  TelegramSyncSettingTab,
} from "./settings";
import * as amqp from "amqplib";

export default class TelegramSyncPlugin extends Plugin {
  isSyncing: boolean = false;
  settings!: PluginSettings;
  connection: any;
  channel: any;

  // Состояния для маршрутизации RabbitMQ
  queueName: string = "";
  currentExchange: string = "";
  currentTopics: Set<string> = new Set();

  // Состояния для переподключения
  isUnloading: boolean = false;
  reconnectTimeout: number | null = null;
  syncInterval: number | null = null;

  async onload() {
    this.isUnloading = false;
    await this.loadSettings();
    this.addSettingTab(new TelegramSyncSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(() => {
      this.initRabbitMQ();
    });
  }

  async onunload() {
    this.isUnloading = true; // Блокируем попытки переподключения

    // Очищаем таймеры
    if (this.reconnectTimeout) {
      window.clearTimeout(this.reconnectTimeout);
    }
    if (this.syncInterval) {
      window.clearInterval(this.syncInterval);
    }

    try {
      if (this.channel) await this.channel.close();
      if (this.connection) await this.connection.close();
    } catch (e) {
      // Игнорируем ошибки при закрытии
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  scheduleReconnect() {
    if (this.isUnloading) return;
    if (this.reconnectTimeout) return; // Переподключение уже запланировано

    console.log("[RabbitMQ] Планирование переподключения через 5 секунд...");
    this.reconnectTimeout = window.setTimeout(() => {
      this.reconnectTimeout = null;
      this.initRabbitMQ();
    }, 5000);
  }

  async initRabbitMQ() {
    // Очищаем старые ресурсы, если они зависли
    if (this.channel) {
      try {
        await this.channel.close();
      } catch (e) {}
    }
    if (this.connection) {
      try {
        await this.connection.close();
      } catch (e) {}
    }

    try {
      // 1. Подключаемся к RabbitMQ
      this.connection = await amqp.connect(this.settings.rabbitUrl);

      // Обработка обрывов на уровне соединения
      this.connection.on("error", (err: any) => {
        console.error("[RabbitMQ] Ошибка соединения:", err);
        this.scheduleReconnect();
      });
      this.connection.on("close", () => {
        console.warn("[RabbitMQ] Соединение закрыто");
        this.scheduleReconnect();
      });

      this.channel = await this.connection.createChannel();

      // Обработка обрывов на уровне канала
      this.channel.on("error", (err: any) => {
        console.error("[RabbitMQ] Ошибка канала:", err);
        this.scheduleReconnect();
      });
      this.channel.on("close", () => {
        console.warn("[RabbitMQ] Канал закрыт");
        this.scheduleReconnect();
      });

      // 2. Создаем эксклюзивную очередь
      const q = await this.channel.assertQueue("", { exclusive: true });
      this.queueName = q.queue;

      // Очищаем кэш топиков, так как имя очереди изменилось и биндинги слетели
      this.currentTopics.clear();

      // 3. Подписываемся на прослушивание сообщений
      await this.channel.consume(
        this.queueName,
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

      new Notice("Успешное подключение к RabbitMQ");

      // 4. Запускаем первичную загрузку конфига
      await this.fetchAndSyncConfig();

      // 5. Запускаем поллинг конфига (очищаем предыдущий интервал, если был)
      if (this.syncInterval) {
        window.clearInterval(this.syncInterval);
      }
      this.syncInterval = window.setInterval(async () => {
        await this.fetchAndSyncConfig();
      }, 10000);
    } catch (e) {
      console.error("Init Error RabbitMQ:", e);
      new Notice("Ошибка подключения к RabbitMQ. Повторная попытка...");
      this.scheduleReconnect();
    }
  }

  async fetchAndSyncConfig() {
    // Если синхронизация уже идет или канал не готов — выходим
    if (this.isSyncing || !this.channel || !this.queueName) return;

    this.isSyncing = true; // Ставим замок
    try {
      const timestamp = new Date().getTime();
      const urlWithCacheBuster = `${this.settings.configUrl}?t=${timestamp}`;
      const configRes = await requestUrl(urlWithCacheBuster);
      const config = configRes.json;

      if (!config || !config.exchange || !Array.isArray(config.topics)) {
        console.error("Неверный формат конфига", config);
        return;
      }

      const newExchange = config.exchange;
      const newTopics: string[] = config.topics;

      await this.channel.assertExchange(newExchange, "topic", {
        durable: true,
      });
      this.currentExchange = newExchange;

      const newTopicsSet = new Set(newTopics);

      // ШАГ 1: Отписка
      for (const oldTopic of Array.from(this.currentTopics)) {
        if (!newTopicsSet.has(oldTopic)) {
          await this.channel.unbindQueue(
            this.queueName,
            this.currentExchange,
            oldTopic,
          );
          this.currentTopics.delete(oldTopic);
          console.log(`[RabbitMQ] Отписались от топика: ${oldTopic}`);
        }
      }

      // ШАГ 2: Подписка
      for (const newTopic of newTopics) {
        if (!this.currentTopics.has(newTopic)) {
          // Сначала добавляем в Set, чтобы параллельные вызовы (если они прорвутся)
          // сразу увидели, что топик в процессе обработки
          this.currentTopics.add(newTopic);

          await this.channel.bindQueue(
            this.queueName,
            this.currentExchange,
            newTopic,
          );
          console.log(`[RabbitMQ] Подписались на топик: ${newTopic}`);
        }
      }
    } catch (e) {
      console.error("Ошибка при обновлении конфига:", e);
    } finally {
      this.isSyncing = false; // Снимаем замок в любом случае
    }
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
