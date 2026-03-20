import { App, Modal } from "obsidian";

interface ConfirmModalOptions {
	title: string;
	message: string;
	confirmText: string;
	cancelText?: string;
	onConfirm: () => void;
	onCancel: () => void;
}

export class ConfirmModal extends Modal {
	private readonly options: ConfirmModalOptions;
	private confirmed = false;

	constructor(app: App, options: ConfirmModalOptions) {
		super(app);
		this.options = options;
	}

	onOpen(): void {
		const { contentEl, titleEl } = this;
		contentEl.empty();
		titleEl.setText(this.options.title);

		contentEl.createEl("p", {
			text: this.options.message,
		});

		const actionsEl = contentEl.createDiv({ cls: "workflowy-sync-modal-actions" });
		const cancelButton = actionsEl.createEl("button", {
			text: this.options.cancelText ?? "Cancel",
			cls: "workflowy-sync-secondary-button",
		});
		cancelButton.addEventListener("click", () => this.close());

		const confirmButton = actionsEl.createEl("button", {
			text: this.options.confirmText,
			cls: "mod-warning",
		});
		confirmButton.addEventListener("click", () => {
			this.confirmed = true;
			this.options.onConfirm();
			this.close();
		});
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.confirmed) {
			this.options.onCancel();
		}
	}
}
