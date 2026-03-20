/* eslint-disable obsidianmd/ui/sentence-case */

import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type WorkflowySyncPlugin from "../main";
import type { SyncMapping } from "../types";

export class WorkflowySettingTab extends PluginSettingTab {
	private readonly plugin: WorkflowySyncPlugin;

	constructor(app: App, plugin: WorkflowySyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		this.renderAuthenticationSettings(containerEl);
		this.renderQuickSendSettings(containerEl);
		this.renderEmbedSettings(containerEl);
		this.renderSyncMappingSettings(containerEl);
	}

	private renderAuthenticationSettings(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Authentication").setHeading();
		const statusFragment = document.createDocumentFragment();
		statusFragment.createDiv({
			text: this.plugin.settings.apiKey.trim()
				? "API key saved. Use Test connection to verify it."
				: "No API key saved yet.",
		});

		new Setting(containerEl)
			.setName("Workflowy API key")
			.setDesc(statusFragment)
			.addText((text) => {
				text
					.setPlaceholder("wf_...")
					.setValue(this.plugin.settings.apiKey)
					.onChange(async (value) => {
						this.plugin.settings.apiKey = value.trim();
						await this.plugin.saveSettings();
					});
				text.inputEl.type = "password";
			})
			.addButton((button) => {
				button.setButtonText("Test connection");
				button.onClick(async () => {
					try {
						const targets = await this.plugin.validateConnection();
						new Notice(`Connected to Workflowy. ${targets.length} target(s) available.`);
						this.display();
					} catch (error) {
						const message = error instanceof Error ? error.message : "Unable to connect to Workflowy.";
						new Notice(message);
					}
				});
			});
	}

	private renderQuickSendSettings(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Quick send").setHeading();

		const targetDescription = this.plugin.settings.defaultTargetLabel
			? `Current default target: ${this.plugin.settings.defaultTargetLabel}`
			: "Paste a Workflowy node URL, node ID, or target key such as inbox.";

		new Setting(containerEl)
			.setName("Default target")
			.setDesc(targetDescription)
			.addText((text) => {
				text
					.setPlaceholder("inbox or https://workflowy.com/#/...")
					.setValue(this.plugin.settings.defaultTargetNodeId)
					.onChange(async (value) => {
						this.plugin.settings.defaultTargetNodeId = value.trim();
						await this.plugin.saveSettings();
					});
			})
			.addButton((button) => {
				button.setButtonText("Choose");
				button.onClick(async () => {
					try {
						const target = await this.plugin.promptForTarget(this.plugin.settings.defaultTargetNodeId);
						if (!target) {
							return;
						}

						this.plugin.settings.defaultTargetNodeId = target.identifier;
						this.plugin.settings.defaultTargetLabel = target.label;
						await this.plugin.saveSettings();
						new Notice(`Saved default Workflowy target: ${target.label}`);
						this.display();
					} catch (error) {
						const message = error instanceof Error ? error.message : "Unable to load Workflowy targets.";
						new Notice(message);
					}
				});
			})
			.addButton((button) => {
				button.setButtonText("Validate");
				button.onClick(async () => {
					try {
						const target = await this.plugin.updateDefaultTarget(this.plugin.settings.defaultTargetNodeId);
						if (target) {
							new Notice(`Saved default Workflowy target: ${target.label}`);
						} else {
							new Notice("Cleared the default Workflowy target.");
						}
						this.display();
					} catch (error) {
						const message = error instanceof Error ? error.message : "Unable to resolve that Workflowy target.";
						new Notice(message);
					}
				});
			})
			.addExtraButton((button) => {
				button.setIcon("cross");
				button.setTooltip("Clear default target");
				button.onClick(async () => {
					await this.plugin.clearDefaultTarget();
					new Notice("Cleared the default Workflowy target.");
					this.display();
				});
			});

		new Setting(containerEl)
			.setName("Include Obsidian backlink")
			.setDesc("Add an obsidian:// link to the created Workflowy node note when sending content.")
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.includeObsidianBacklink)
					.onChange(async (value) => {
						this.plugin.settings.includeObsidianBacklink = value;
						await this.plugin.saveSettings();
					});
			});
	}

	private renderEmbedSettings(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Live embeds").setHeading();

		new Setting(containerEl)
			.setName("Show completed items")
			.setDesc("When disabled, completed Workflowy nodes are hidden from live workflowy code blocks.")
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.embedShowCompleted)
					.onChange(async (value) => {
						this.plugin.settings.embedShowCompleted = value;
						await this.plugin.saveSettings();
					});
			});

		containerEl.createEl("p", {
			text: "Workflowy code blocks support one field in v1: node: <node_id_or_url>",
			cls: "workflowy-sync-settings-note",
		});
	}

	private renderSyncMappingSettings(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName("Sync mappings")
			.setHeading()
			.addButton((button) => {
				button.setButtonText("Add mapping");
				button.onClick(async () => {
					try {
						const saved = await this.plugin.openMappingModal();
						if (!saved) {
							return;
						}

						new Notice("Saved sync mapping.");
						this.display();
					} catch (error) {
						const message = error instanceof Error ? error.message : "Unable to save that sync mapping.";
						new Notice(message);
					}
				});
			});

		containerEl.createEl("p", {
			text: "Sync mappings connect one Workflowy item to one Obsidian note. They can pull Workflowy into Obsidian or push Obsidian back into Workflowy, and can run manually, on app open, or on an interval.",
			cls: "workflowy-sync-settings-note",
		});

		if (this.plugin.settings.mappings.length === 0) {
			containerEl.createEl("p", {
				text: "No sync mappings yet.",
				cls: "workflowy-sync-settings-note",
			});
			return;
		}

		for (const mapping of this.plugin.settings.mappings) {
			this.renderMappingRow(containerEl, mapping);
		}
	}

	private renderMappingRow(containerEl: HTMLElement, mapping: SyncMapping): void {
			const description = [
				mapping.direction === "ob-to-wf" ? "Obsidian -> Workflowy." : "Workflowy -> Obsidian.",
				mapping.direction === "ob-to-wf"
					? (mapping.obsidianSectionHeading
						? `${mapping.obsidianPath} > ${mapping.obsidianSectionHeading} -> ${mapping.wfNodeLabel ?? mapping.wfNodeId}`
						: `${mapping.obsidianPath} -> ${mapping.wfNodeLabel ?? mapping.wfNodeId}`)
					: (mapping.obsidianSectionHeading
						? `${mapping.wfNodeLabel ?? mapping.wfNodeId} -> ${mapping.obsidianPath} > ${mapping.obsidianSectionHeading}`
						: `${mapping.wfNodeLabel ?? mapping.wfNodeId} -> ${mapping.obsidianPath}`),
			this.formatTriggerDescription(mapping),
			mapping.filter.includeCompleted === false ? "Completed items excluded." : "Completed items included.",
			mapping.lastSynced ? `Last synced: ${this.formatTimestamp(mapping.lastSynced)}` : "Not synced yet.",
		].join(" ");

		new Setting(containerEl)
			.setName(mapping.label)
			.setDesc(description)
			.addButton((button) => {
				button.setButtonText("Sync now");
				button.onClick(async () => {
					try {
						const result = await this.plugin.syncMapping(mapping);
						if (mapping.direction === "ob-to-wf") {
							new Notice(`Synced ${result.notePath} to ${mapping.wfNodeLabel ?? mapping.wfNodeId}. ${result.nodeCount} node(s) synced.`);
						} else {
							const action = result.created ? "Created" : "Updated";
							new Notice(`${action} ${result.notePath} from ${result.rootLabel}. ${result.nodeCount} node(s) synced.`);
						}
						this.display();
					} catch (error) {
						const message = error instanceof Error ? error.message : "Unable to sync that mapping.";
						new Notice(message);
					}
				});
			})
			.addButton((button) => {
				button.setButtonText("Edit");
				button.onClick(async () => {
					try {
						const saved = await this.plugin.openMappingModal(mapping);
						if (!saved) {
							return;
						}

						new Notice("Updated sync mapping.");
						this.display();
					} catch (error) {
						const message = error instanceof Error ? error.message : "Unable to update that mapping.";
						new Notice(message);
					}
				});
			})
			.addExtraButton((button) => {
				button.setIcon("trash");
				button.setTooltip("Delete mapping");
				button.onClick(async () => {
					await this.plugin.removeMapping(mapping.id);
					new Notice(`Deleted sync mapping: ${mapping.label}`);
					this.display();
				});
			});
	}

	private formatTimestamp(value: string): string {
		const date = new Date(value);
		return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
	}

	private formatTriggerDescription(mapping: SyncMapping): string {
		if (mapping.trigger === "interval") {
			return `Runs every ${mapping.intervalMinutes ?? 5} minute(s).`;
		}

		if (mapping.trigger === "on-open") {
			return "Runs when Obsidian opens.";
		}

		return "Runs manually.";
	}
}
