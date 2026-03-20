import { App, Modal, Notice, Setting, normalizePath } from "obsidian";
import type WorkflowySyncPlugin from "../main";
import type { SyncMapping, SyncMappingDraft } from "../types";

interface WorkflowyMappingModalOptions {
	plugin: WorkflowySyncPlugin;
	mapping?: SyncMapping;
	onSubmit: (draft: SyncMappingDraft) => Promise<void>;
	onCancel: () => void;
}

export class WorkflowyMappingModal extends Modal {
	private static readonly minimumIntervalMinutes = 1;

	private readonly options: WorkflowyMappingModalOptions;
	private closedBySubmit = false;
	private label = "";
	private workflowyIdentifier = "";
	private workflowyLabel = "";
	private obsidianPath = "";
	private obsidianSectionHeading = "";
	private includeCompleted = true;
	private direction: SyncMappingDraft["direction"] = "wf-to-ob";
	private trigger: SyncMapping["trigger"] = "manual";
	private intervalMinutes = "15";

	constructor(app: App, options: WorkflowyMappingModalOptions) {
		super(app);
		this.options = options;
		this.label = options.mapping?.label ?? "";
		this.workflowyIdentifier = options.mapping?.wfNodeId ?? "";
		this.workflowyLabel = options.mapping?.wfNodeLabel ?? "";
		this.obsidianPath = options.mapping?.obsidianPath ?? "";
		this.obsidianSectionHeading = options.mapping?.obsidianSectionHeading ?? "";
		this.includeCompleted = options.mapping?.filter.includeCompleted ?? true;
		this.direction = options.mapping?.direction === "ob-to-wf" ? "ob-to-wf" : "wf-to-ob";
		this.trigger = options.mapping?.trigger ?? "manual";
		this.intervalMinutes = String(options.mapping?.intervalMinutes ?? 15);
	}

	onOpen(): void {
		this.renderContent();
	}

	onClose(): void {
		const { contentEl } = this;
		contentEl.empty();
		if (!this.closedBySubmit) {
			this.options.onCancel();
		}
	}

	private renderContent(): void {
		const { contentEl, titleEl } = this;
		contentEl.empty();
		titleEl.setText(this.options.mapping ? "Edit sync mapping" : "Add sync mapping");

		contentEl.createEl("p", {
			text: "Create a sync mapping between one outline item and one Obsidian note. Sync mappings move content only, without renaming the mapped root item or note title.",
			cls: "workflowy-sync-settings-note",
		});

		new Setting(contentEl)
			.setName("Mapping label")
			.setDesc("A short name that helps you find this mapping later.")
			.addText((text) => {
				text
					.setPlaceholder("Inbox to daily review")
					.setValue(this.label)
					.onChange((value) => {
						this.label = value;
					});
				text.inputEl.focus();
			});

		new Setting(contentEl)
			.setName("Workflowy source")
			.setDesc(this.workflowyLabel
				? `Selected Workflowy item: ${this.workflowyLabel}`
				: "Choose a Workflowy node, target, or pasted URL. Obsidian to Workflowy sync requires a specific Workflowy item.")
			.addText((text) => {
				text
					.setPlaceholder("inbox or https://workflowy.com/#/...")
					.setValue(this.workflowyIdentifier)
					.onChange((value) => {
						this.workflowyIdentifier = value.trim();
					});
			})
			.addButton((button) => {
				button.setButtonText("Choose");
				button.onClick(async () => {
					const target = await this.options.plugin.promptForTarget(this.workflowyIdentifier);
					if (!target) {
						return;
					}

					this.workflowyIdentifier = target.identifier;
					this.workflowyLabel = target.label;
					this.renderContent();
				});
			});

		new Setting(contentEl)
			.setName("Sync direction")
			.setDesc("Choose whether this mapping pulls content into Obsidian or pushes note content back out.")
			.addDropdown((dropdown) => {
				dropdown
					.addOption("wf-to-ob", "Workflowy -> Obsidian")
					.addOption("ob-to-wf", "Obsidian -> selected item")
					.setValue(this.direction)
					.onChange((value: SyncMappingDraft["direction"]) => {
						this.direction = value;
						this.renderContent();
					});
			});

		if (this.direction === "ob-to-wf") {
			contentEl.createEl("p", {
				text: "Reverse sync keeps the selected root item and replaces its children in place. Plain lines become bullets, Markdown tasks become todos, and item notes require extra follow-up updates.",
				cls: "workflowy-sync-settings-note",
			});
		}

		new Setting(contentEl)
			.setName("Obsidian note")
			.setDesc(this.direction === "wf-to-ob"
				? "Choose the note that should receive the synced Workflowy outline. Leave section blank to replace the whole note, or set a section heading to update only that section."
				: "Choose the note that should be pushed into Workflowy. Leave section blank to use the whole note, or set a section heading to push only that section.")
			.addText((text) => {
				text
					.setPlaceholder("Workflowy/Inbox.md")
					.setValue(this.obsidianPath)
					.onChange((value) => {
						this.obsidianPath = value.trim();
					});
			})
			.addButton((button) => {
				button.setButtonText("Use current note");
				button.onClick(() => {
					const activeFile = this.options.plugin.getActiveMarkdownFile();
					if (!activeFile) {
						new Notice("Open the destination note first, then try again.");
						return;
					}

					this.obsidianPath = activeFile.path;
					this.renderContent();
				});
			});

		new Setting(contentEl)
			.setName("Sync to section")
			.setDesc(this.direction === "wf-to-ob"
				? "Optional. Use a heading name like Workflowy or Tasks. Workflowy Sync manages its own block under that heading and leaves the rest of the section alone. If the heading does not exist, sync adds it to the end of the note."
				: "Optional. Use a heading name like Workflowy or Tasks. Workflowy Sync reads and writes its own managed block under that heading, without using the rest of the note section.")
			.addText((text) => {
				text
					.setPlaceholder("Workflowy")
					.setValue(this.obsidianSectionHeading)
					.onChange((value) => {
						this.obsidianSectionHeading = value.trim();
					});
			});

		new Setting(contentEl)
			.setName("Include completed items")
			.setDesc("Keep completed items in this synced note.")
			.addToggle((toggle) => {
				toggle
					.setValue(this.includeCompleted)
					.onChange((value) => {
						this.includeCompleted = value;
					});
			});

		new Setting(contentEl)
			.setName("Run sync")
			.setDesc("Choose whether this mapping runs only when you trigger it, once when Obsidian opens, or on a repeating interval.")
			.addDropdown((dropdown) => {
				dropdown
					.addOption("manual", "Manually")
					.addOption("on-open", "On app open")
					.addOption("interval", "Every interval")
					.setValue(this.trigger)
					.onChange((value: SyncMapping["trigger"]) => {
						this.trigger = value;
						this.renderContent();
					});
			});

		if (this.trigger === "interval") {
			new Setting(contentEl)
				.setName("Interval minutes")
				.setDesc(`How often to run this mapping automatically. Minimum ${WorkflowyMappingModal.minimumIntervalMinutes} minutes.`)
				.addText((text) => {
					text
						.setPlaceholder("15")
						.setValue(this.intervalMinutes)
						.onChange((value) => {
							this.intervalMinutes = value.trim();
						});
					text.inputEl.inputMode = "numeric";
				});
		}

		const actionsEl = contentEl.createDiv({ cls: "workflowy-sync-modal-actions" });
		const cancelButton = actionsEl.createEl("button", {
			text: "Cancel",
			cls: "workflowy-sync-secondary-button",
		});
		cancelButton.addEventListener("click", () => this.close());

		const submitButton = actionsEl.createEl("button", {
			text: this.options.mapping ? "Save mapping" : "Add mapping",
			cls: "mod-cta",
		});
		submitButton.addEventListener("click", () => {
			void this.submit();
		});
	}

	private async submit(): Promise<void> {
		const draft = this.buildDraft();
		if (!draft) {
			return;
		}

		try {
			this.closedBySubmit = true;
			await this.options.onSubmit(draft);
			this.close();
		} catch (error) {
			this.closedBySubmit = false;
			const message = error instanceof Error ? error.message : "Unable to save that sync mapping.";
			new Notice(message);
		}
	}

	private buildDraft(): SyncMappingDraft | null {
		const label = this.label.trim();
		const workflowyIdentifier = this.workflowyIdentifier.trim();
		const obsidianPath = normalizePath(this.obsidianPath.trim());

		if (!label) {
			new Notice("Add a label for this sync mapping.");
			return null;
		}

		if (!workflowyIdentifier) {
			new Notice("Choose a node or target for this mapping.");
			return null;
		}

		if (!obsidianPath) {
			new Notice("Choose an Obsidian note path for this mapping.");
			return null;
		}

		if (!obsidianPath.toLowerCase().endsWith(".md")) {
			new Notice("Sync mappings currently require a Markdown note path ending in .md.");
			return null;
		}

		const intervalMinutes = this.parseIntervalMinutes();
		if (this.trigger === "interval" && intervalMinutes === undefined) {
			return null;
		}

		return {
			label,
			wfNodeId: workflowyIdentifier,
			wfNodeLabel: this.workflowyLabel || workflowyIdentifier,
			obsidianPath,
			obsidianSectionHeading: this.obsidianSectionHeading,
			includeCompleted: this.includeCompleted,
			direction: this.direction,
			trigger: this.trigger,
			intervalMinutes,
		};
	}

	private parseIntervalMinutes(): number | undefined {
		if (this.trigger !== "interval") {
			return undefined;
		}

		const parsedValue = Number(this.intervalMinutes);
		if (!Number.isFinite(parsedValue) || !Number.isInteger(parsedValue)) {
			new Notice("Enter a whole number of minutes for the sync interval.");
			return undefined;
		}

		if (parsedValue < WorkflowyMappingModal.minimumIntervalMinutes) {
			new Notice(`Sync intervals must be at least ${WorkflowyMappingModal.minimumIntervalMinutes} minutes.`);
			return undefined;
		}

		return parsedValue;
	}
}
