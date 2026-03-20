import { App, SuggestModal } from "obsidian";
import type { SyncMapping } from "../types";

interface WorkflowyMappingPickerModalOptions {
	mappings: SyncMapping[];
	onChoose: (mapping: SyncMapping) => Promise<void>;
	onCancel: () => void;
}

export class WorkflowyMappingPickerModal extends SuggestModal<SyncMapping> {
	private readonly options: WorkflowyMappingPickerModalOptions;
	private closedByChoice = false;

	constructor(app: App, options: WorkflowyMappingPickerModalOptions) {
		super(app);
		this.options = options;
		this.emptyStateText = "No sync mappings yet.";
		this.setPlaceholder("Search sync mappings");
	}

	getSuggestions(query: string): SyncMapping[] {
		const normalizedQuery = query.trim().toLowerCase();
		if (!normalizedQuery) {
			return this.options.mappings;
		}

		return this.options.mappings.filter((mapping) => {
			const haystack = [
				mapping.label,
				mapping.wfNodeLabel ?? mapping.wfNodeId,
				mapping.wfNodeId,
				mapping.obsidianPath,
			].join(" ").toLowerCase();
			return haystack.includes(normalizedQuery);
		});
	}

	renderSuggestion(mapping: SyncMapping, el: HTMLElement): void {
		el.addClass("workflowy-sync-target-suggestion");

		const topRow = el.createDiv({ cls: "workflowy-sync-target-suggestion-row" });
		topRow.createDiv({
			text: mapping.label,
			cls: "workflowy-sync-target-suggestion-title",
		});
		topRow.createDiv({
			text: mapping.lastSynced ? "Synced" : "Manual",
			cls: "workflowy-sync-target-suggestion-badge",
		});

		el.createDiv({
			text: `${mapping.wfNodeLabel ?? mapping.wfNodeId} -> ${mapping.obsidianPath}`,
			cls: "workflowy-sync-target-suggestion-subtitle",
		});
	}

	onChooseSuggestion(mapping: SyncMapping): void {
		this.closedByChoice = true;
		void this.options.onChoose(mapping);
		this.close();
	}

	onClose(): void {
		super.onClose();
		if (!this.closedByChoice) {
			this.options.onCancel();
		}
	}
}
