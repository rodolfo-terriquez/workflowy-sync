import { App, SuggestModal } from "obsidian";
import type { WorkflowyResolvedTarget } from "../types";

export interface WorkflowyTargetSuggestion {
	title: string;
	subtitle: string;
	identifier: string;
	category: "Recent" | "Shortcut" | "System" | "Node" | "Custom";
	target?: WorkflowyResolvedTarget;
	customInput?: string;
}

interface WorkflowyTargetModalOptions {
	initialValue?: string;
	getSuggestions: (query: string) => Promise<WorkflowyTargetSuggestion[]>;
	onChoose: (suggestion: WorkflowyTargetSuggestion) => Promise<void>;
	onCancel: () => void;
}

export class WorkflowyTargetModal extends SuggestModal<WorkflowyTargetSuggestion> {
	private readonly options: WorkflowyTargetModalOptions;
	private closedByChoice = false;
	private cancelTimeoutId: number | null = null;

	constructor(app: App, options: WorkflowyTargetModalOptions) {
		super(app);
		this.options = options;
		this.emptyStateText = "Type a Workflowy target, node ID, or URL.";
		this.setPlaceholder("Search targets or paste a URL / node ID");
	}

	onOpen(): void {
		void super.onOpen();
		if (this.options.initialValue?.trim()) {
			this.inputEl.value = this.options.initialValue;
			this.inputEl.dispatchEvent(new Event("input"));
		}
	}

	async getSuggestions(query: string): Promise<WorkflowyTargetSuggestion[]> {
		const suggestions = await this.options.getSuggestions(query);
		const customSuggestion = this.buildCustomSuggestion(query);
		if (!customSuggestion) {
			return suggestions;
		}

		const alreadyPresent = suggestions.some((suggestion) => suggestion.identifier.toLowerCase() === customSuggestion.identifier.toLowerCase());
		return alreadyPresent ? suggestions : [customSuggestion, ...suggestions];
	}

	renderSuggestion(suggestion: WorkflowyTargetSuggestion, el: HTMLElement): void {
		el.addClass("workflowy-sync-target-suggestion");

		const topRow = el.createDiv({ cls: "workflowy-sync-target-suggestion-row" });
		topRow.createDiv({
			text: suggestion.title,
			cls: "workflowy-sync-target-suggestion-title",
		});
		topRow.createDiv({
			text: suggestion.category,
			cls: "workflowy-sync-target-suggestion-badge",
		});

		el.createDiv({
			text: suggestion.subtitle,
			cls: "workflowy-sync-target-suggestion-subtitle",
		});
	}

	onChooseSuggestion(suggestion: WorkflowyTargetSuggestion): void {
		this.closedByChoice = true;
		if (this.cancelTimeoutId !== null) {
			window.clearTimeout(this.cancelTimeoutId);
			this.cancelTimeoutId = null;
		}
		void this.options.onChoose(suggestion);
		this.close();
	}

	onClose(): void {
		super.onClose();
		this.cancelTimeoutId = window.setTimeout(() => {
			if (!this.closedByChoice) {
				this.options.onCancel();
			}
			this.cancelTimeoutId = null;
		}, 0);
	}

	private buildCustomSuggestion(query: string): WorkflowyTargetSuggestion | null {
		const trimmedQuery = query.trim();
		if (!trimmedQuery) {
			return null;
		}

		return {
			title: `Use "${trimmedQuery}"`,
			subtitle: "Treat this as a pasted Workflowy URL, node ID, or target key.",
			identifier: trimmedQuery,
			category: "Custom",
			customInput: trimmedQuery,
		};
	}
}
