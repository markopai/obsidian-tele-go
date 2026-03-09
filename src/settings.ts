import { App, PluginSettingTab, Setting } from "obsidian";
import TelegramSyncPlugin from "./main";

export interface PluginSettings {
  saveFolder: string;
  configUrl: string;
  rabbitUrl: string;
}

export const DEFAULT_SETTINGS: PluginSettings = {
  saveFolder: "TelegramSync",
  configUrl: "http://YOUR_SERVER_IP/config.json",
  rabbitUrl: "amqp://guest:guest@IP:5672/",
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
    containerEl.createEl("h2", { text: "Настройки интеграции с RabbitMQ" });

    new Setting(containerEl).setName("Папка для сохранения").addText((text) => {
      text.inputEl.style.width = "300px";
      text
        .setPlaceholder("TelegramSync")
        .setValue(this.plugin.settings.saveFolder)
        .onChange(async (value) => {
          this.plugin.settings.saveFolder = value;
          await this.plugin.saveSettings();
        });
    });

    new Setting(containerEl)
      .setName("URL конфигурации (HTTP GET)")
      .addText((text) => {
        text.inputEl.style.width = "400px";
        text
          .setValue(this.plugin.settings.configUrl)
          .onChange(async (value) => {
            this.plugin.settings.configUrl = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl).setName("RabbitMQ URL").addText((text) => {
      text.inputEl.style.width = "400px";
      text.setValue(this.plugin.settings.rabbitUrl).onChange(async (value) => {
        this.plugin.settings.rabbitUrl = value;
        await this.plugin.saveSettings();
      });
    });
  }
}
