import { App, PluginSettingTab, Setting } from "obsidian";
import TelegramSyncPlugin from "./main";

export interface PluginSettings {
  serverIp: string; // Новый параметр
  saveFolder: string;
  configUrl: string;
  rabbitUrl: string;
}

export const DEFAULT_SETTINGS: PluginSettings = {
  serverIp: "127.0.0.1:8080",
  saveFolder: "TelegramSync",
  configUrl: "http://127.0.0.1:8080/config.json",
  rabbitUrl: "amqp://guest:guest@127.0.0.1:5672/",
};

export class TelegramSyncSettingTab extends PluginSettingTab {
  plugin: TelegramSyncPlugin;

  constructor(app: App, plugin: TelegramSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Настройки интеграции" });

    new Setting(containerEl)
      .setName("IP и Порт сервера")
      .setDesc("Пример: 192.168.1.10:8080")
      .addText((text) =>
        text.setValue(this.plugin.settings.serverIp).onChange(async (value) => {
          this.plugin.settings.serverIp = value;
          // Автоматически обновляем зависимые URL для удобства
          this.plugin.settings.configUrl = `http://${value}/config.json`;
          const ipOnly = value.split(":")[0];
          this.plugin.settings.rabbitUrl = `amqp://guest:guest@${ipOnly}:5672/`;
          await this.plugin.saveSettings();
          this.display(); // Перерисовываем, чтобы обновить текстовые поля ниже
        }),
      );

    new Setting(containerEl).setName("Папка для сохранения").addText((text) =>
      text.setValue(this.plugin.settings.saveFolder).onChange(async (value) => {
        this.plugin.settings.saveFolder = value;
        await this.plugin.saveSettings();
      }),
    );

    new Setting(containerEl).setName("Полный URL конфига").addText((text) =>
      text.setValue(this.plugin.settings.configUrl).onChange(async (value) => {
        this.plugin.settings.configUrl = value;
        await this.plugin.saveSettings();
      }),
    );

    new Setting(containerEl)
      .setName("RabbitMQ Connection String")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.rabbitUrl)
          .onChange(async (value) => {
            this.plugin.settings.rabbitUrl = value;
            await this.plugin.saveSettings();
          }),
      );
  }
}
