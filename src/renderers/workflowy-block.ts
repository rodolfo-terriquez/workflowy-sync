import { MarkdownRenderChild, MarkdownRenderer, setIcon } from "obsidian";
import type WorkflowySyncPlugin from "../main";
import type { WorkflowyNode } from "../types";

interface WorkflowyBlockConfig {
	node: string;
}

export class WorkflowyBlockRenderer extends MarkdownRenderChild {
	private readonly plugin: WorkflowySyncPlugin;
	private readonly source: string;
	private readonly sourcePath: string;

	constructor(containerEl: HTMLElement, plugin: WorkflowySyncPlugin, source: string, sourcePath: string) {
		super(containerEl);
		this.plugin = plugin;
		this.source = source;
		this.sourcePath = sourcePath;
	}

	async render(): Promise<void> {
		this.containerEl.empty();

		let config: WorkflowyBlockConfig;
		try {
			config = parseWorkflowyBlock(this.source);
		} catch (error) {
			this.renderError(error instanceof Error ? error.message : "Invalid workflowy block.");
			return;
			}

			const wrapper = this.containerEl.createDiv({ cls: "workflowy-sync-block" });
			const header = wrapper.createDiv({ cls: "workflowy-sync-block-header" });
			const title = header.createDiv({ cls: "workflowy-sync-block-title" });
			title.setText("Workflowy embed");

		const status = header.createDiv({ cls: "workflowy-sync-block-status" });
		const refreshButton = header.createEl("button", {
				cls: "workflowy-sync-refresh-button",
				attr: {
					type: "button",
					"aria-label": "Refresh embedded block",
				},
		});
		setIcon(refreshButton, "refresh-cw");
		this.registerDomEvent(refreshButton, "click", () => {
			void this.refresh(config, wrapper, status, true);
		});

		await this.refresh(config, wrapper, status, false);
	}

	private async refresh(
		config: WorkflowyBlockConfig,
		wrapper: HTMLElement,
		statusEl: HTMLElement,
		forceRefresh: boolean,
	): Promise<void> {
		statusEl.setText("Loading...");
		const existingContent = wrapper.find(".workflowy-sync-block-content");
		existingContent?.remove();
		const contentEl = wrapper.createDiv({ cls: "workflowy-sync-block-content" });

		const client = this.plugin.getClientOrNotice();
		if (!client) {
			contentEl.setText("Add your API key in plugin settings to render this block.");
			statusEl.setText("Not connected");
			return;
		}

		try {
			const rootNode = await client.getNodeTree(config.node, { forceRefresh });
			statusEl.setText(`Updated ${new Date().toLocaleTimeString()}`);
			await this.renderTree(rootNode, contentEl);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unable to load Workflowy content.";
			contentEl.createDiv({ text: message, cls: "workflowy-sync-error" });
			statusEl.setText("Error");
		}
	}

	private async renderTree(rootNode: WorkflowyNode, containerEl: HTMLElement): Promise<void> {
		const visibleRoot = this.shouldRenderNode(rootNode);
		if (!visibleRoot && (!rootNode.children || rootNode.children.length === 0)) {
			containerEl.createDiv({
				text: "No visible Workflowy items matched this block.",
				cls: "workflowy-sync-empty-state",
			});
			return;
		}

		const listEl = containerEl.createEl("ul", { cls: "workflowy-sync-tree" });
		if (visibleRoot) {
			await this.renderNode(rootNode, listEl);
			return;
		}

		for (const child of rootNode.children ?? []) {
			if (this.shouldRenderNode(child)) {
				await this.renderNode(child, listEl);
			}
		}
	}

	private async renderNode(node: WorkflowyNode, parentEl: HTMLElement): Promise<void> {
		const itemEl = parentEl.createEl("li", { cls: "workflowy-sync-tree-item" });
		if (node.completedAt) {
			itemEl.addClass("is-completed");
		}
		if (node.data.layoutMode) {
			itemEl.addClass(`is-layout-${node.data.layoutMode}`);
		}

		const rowEl = itemEl.createDiv({ cls: "workflowy-sync-tree-row" });
		if (node.data.layoutMode === "todo") {
			const checkbox = rowEl.createEl("input", {
				cls: "workflowy-sync-checkbox",
				attr: {
					type: "checkbox",
				},
			});
			checkbox.checked = Boolean(node.completedAt);
			checkbox.disabled = true;
		}

		const contentEl = rowEl.createDiv({ cls: "workflowy-sync-tree-content" });
		await MarkdownRenderer.render(
			this.plugin.app,
			node.name || "*Untitled*",
			contentEl,
			this.sourcePath,
			this,
		);

		if (node.note) {
			const noteEl = itemEl.createDiv({ cls: "workflowy-sync-tree-note" });
			await MarkdownRenderer.render(
				this.plugin.app,
				node.note,
				noteEl,
				this.sourcePath,
				this,
			);
		}

		const visibleChildren = (node.children ?? []).filter((child) => this.shouldRenderNode(child));
		if (visibleChildren.length > 0) {
			const childrenEl = itemEl.createEl("ul", { cls: "workflowy-sync-tree" });
			for (const child of visibleChildren) {
				await this.renderNode(child, childrenEl);
			}
		}
	}

	private shouldRenderNode(node: WorkflowyNode): boolean {
		if (this.plugin.settings.embedShowCompleted) {
			return true;
		}

		return !node.completedAt;
	}

	private renderError(message: string): void {
		this.containerEl.empty();
		this.containerEl.createDiv({
			text: message,
			cls: "workflowy-sync-error",
		});
	}
}

function parseWorkflowyBlock(source: string): WorkflowyBlockConfig {
	const rawLines = source.split("\n").map((line) => line.trim()).filter(Boolean);
	const parsedEntries = new Map<string, string>();

	for (const line of rawLines) {
		const separatorIndex = line.indexOf(":");
		if (separatorIndex === -1) {
			continue;
		}

		const key = line.slice(0, separatorIndex).trim().toLowerCase();
		const value = line.slice(separatorIndex + 1).trim();
		if (key && value) {
			parsedEntries.set(key, value);
		}
	}

	const node = parsedEntries.get("node");
	if (!node) {
		throw new Error("Workflowy blocks require a node: value.");
	}

	return { node };
}
