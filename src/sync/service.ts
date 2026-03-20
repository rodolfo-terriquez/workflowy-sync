import { normalizePath, TFile, TFolder } from "obsidian";
import type WorkflowySyncPlugin from "../main";
import type { SyncMapping, SyncResult, WorkflowyNode } from "../types";
import { ConfirmModal } from "../ui/confirm-modal";
import { upsertSyncSection } from "./section-content";

export async function syncMappingToNote(
	plugin: WorkflowySyncPlugin,
	mapping: SyncMapping,
	options: { allowOverwritePrompt?: boolean } = {},
): Promise<SyncResult> {
	const client = plugin.getClientOrNotice();
	if (!client) {
		throw new Error("Missing Workflowy API key");
	}

	const rootNode = await client.getNodeTree(mapping.wfNodeId, { forceRefresh: true });
	const filteredRootNode = applyCompletedFilter(rootNode, mapping.filter.includeCompleted ?? true);
	const notePath = normalizePath(mapping.obsidianPath);
	const existingFile = plugin.app.vault.getAbstractFileByPath(notePath);
	const sectionHeading = mapping.obsidianSectionHeading?.trim();

	await ensureParentFolders(plugin, notePath);

	let created = false;
	if (existingFile instanceof TFile) {
		if (sectionHeading) {
			const renderedBody = serializeWorkflowyContent(filteredRootNode);
			await plugin.app.vault.process(existingFile, (existingContent) => upsertSyncSection(
				existingContent,
				sectionHeading,
				renderedBody,
			));
		} else {
			const noteContent = serializeWorkflowyContent(filteredRootNode);
			await confirmFirstSyncOverwrite(
				plugin,
				mapping,
				existingFile,
				filteredRootNode.name.trim() || mapping.wfNodeLabel || mapping.wfNodeId,
				options.allowOverwritePrompt ?? true,
			);
			await plugin.app.vault.process(existingFile, () => noteContent);
		}
	} else if (existingFile) {
		throw new Error(`A folder already exists at ${notePath}. Choose a markdown file path instead.`);
	} else {
		const noteContent = sectionHeading
			? upsertSyncSection("", sectionHeading, serializeWorkflowyContent(filteredRootNode))
			: serializeWorkflowyContent(filteredRootNode);
		await plugin.app.vault.create(notePath, noteContent);
		created = true;
	}

	const syncedAt = new Date().toISOString();
	await plugin.markMappingSynced(mapping.id, syncedAt, filteredRootNode.name.trim() || mapping.wfNodeLabel || mapping.wfNodeId);

	return {
		mappingId: mapping.id,
		mappingLabel: mapping.label,
		notePath,
		rootLabel: filteredRootNode.name.trim() || mapping.wfNodeLabel || mapping.wfNodeId,
		nodeCount: countNodes(filteredRootNode),
		created,
		syncedAt,
	};
}

function serializeWorkflowyContent(rootNode: WorkflowyNode): string {
	const lines: string[] = [];

	const rootNote = serializeNoteBlock(rootNode.note, "");
	if (rootNote.length > 0) {
		lines.push(...rootNote);
	}

	if (rootNode.children && rootNode.children.length > 0) {
		if (lines.length > 0) {
			lines.push("");
		}
		for (const child of rootNode.children) {
			lines.push(...serializeNode(child, 0));
		}
	}

	const trimmedLines = trimTrailingBlankLines(lines);
	return trimmedLines.length > 0 ? `${trimmedLines.join("\n")}\n` : "";
}

function serializeNode(node: WorkflowyNode, depth: number): string[] {
	const indent = "  ".repeat(depth);
	const text = htmlToMarkdownish(node.name).trim() || "Untitled item";
	const marker = getListMarker(node);
	const lines = [`${indent}${marker} ${text}`];

	const noteLines = serializeNoteBlock(node.note, `${indent}  `);
	if (noteLines.length > 0) {
		lines.push(...noteLines);
	}

	for (const child of node.children ?? []) {
		lines.push(...serializeNode(child, depth + 1));
	}

	return lines;
}

function getListMarker(node: WorkflowyNode): string {
	if (node.data.layoutMode === "todo") {
		return node.completedAt || node.completed ? "- [x]" : "- [ ]";
	}

	return "-";
}

function serializeNoteBlock(note: string | null, indent: string): string[] {
	const renderedNote = htmlToMarkdownish(note).trim();
	if (!renderedNote) {
		return [];
	}

	return renderedNote
		.split(/\r?\n/)
		.filter((line, index, array) => line.trim().length > 0 || (index > 0 && index < array.length - 1))
		.map((line) => `${indent}> ${line}`);
}

function htmlToMarkdownish(value: string | null): string {
	if (!value) {
		return "";
	}

	if (!value.includes("<") && !value.includes("&")) {
		return value;
	}

	const parser = new DOMParser();
	const document = parser.parseFromString(`<div>${value}</div>`, "text/html");
	const root = document.body.firstElementChild;
	if (!root) {
		return value;
	}

	return normalizeInlineWhitespace(serializeChildren(root.childNodes));
}

function serializeChildren(nodes: NodeListOf<ChildNode> | ChildNode[]): string {
	return Array.from(nodes).map((node) => serializeNodeContent(node)).join("");
}

function serializeNodeContent(node: ChildNode): string {
	if (node.nodeType === Node.TEXT_NODE) {
		return decodeHtmlEntities(node.textContent ?? "");
	}

	if (!(node instanceof HTMLElement)) {
		return "";
	}

	const content = serializeChildren(Array.from(node.childNodes));
	switch (node.tagName.toLowerCase()) {
		case "a": {
			const href = node.getAttribute("href")?.trim();
			return href ? `[${content || href}](${href})` : content;
		}
		case "strong":
		case "b":
			return content ? `**${content}**` : "";
		case "em":
		case "i":
			return content ? `*${content}*` : "";
		case "code":
			return content ? `\`${content}\`` : "";
		case "br":
			return "\n";
		case "p":
			return `${content}\n\n`;
		default:
			return content;
	}
}

function decodeHtmlEntities(value: string): string {
	const parser = new DOMParser();
	const document = parser.parseFromString(value, "text/html");
	return document.documentElement.textContent ?? "";
}

function normalizeInlineWhitespace(value: string): string {
	return value
		.replace(/\u00A0/g, " ")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function trimTrailingBlankLines(lines: string[]): string[] {
	const trimmedLines = [...lines];
	while (trimmedLines.length > 0 && trimmedLines[trimmedLines.length - 1]?.trim() === "") {
		trimmedLines.pop();
	}

	return trimmedLines;
}

function countNodes(node: WorkflowyNode): number {
	return 1 + (node.children ?? []).reduce((total, child) => total + countNodes(child), 0);
}

function applyCompletedFilter(rootNode: WorkflowyNode, includeCompleted: boolean): WorkflowyNode {
	if (includeCompleted) {
		return rootNode;
	}

	return {
		...rootNode,
		children: filterIncompleteChildren(rootNode.children ?? []),
	};
}

function filterIncompleteChildren(nodes: WorkflowyNode[]): WorkflowyNode[] {
	return nodes.flatMap((node) => {
		if (node.completedAt || node.completed) {
			return [];
		}

		return [{
			...node,
			children: filterIncompleteChildren(node.children ?? []),
		}];
	});
}

async function confirmFirstSyncOverwrite(
	plugin: WorkflowySyncPlugin,
	mapping: SyncMapping,
	file: TFile,
	rootLabel: string,
	allowOverwritePrompt: boolean,
): Promise<void> {
	if (mapping.lastSynced) {
		return;
	}

	const existingContent = await plugin.app.vault.cachedRead(file);
	if (!existingContent.trim()) {
		return;
	}

	if (!allowOverwritePrompt) {
		throw new Error("Run this mapping manually once before using scheduled sync so Workflowy Sync can confirm the first overwrite.");
	}

	const confirmed = await promptForOverwriteConfirmation(
		plugin,
		`The first sync for "${mapping.label}" will replace the current contents of "${file.path}" with the latest Workflowy content from "${rootLabel}".`,
	);
	if (!confirmed) {
		throw new Error("Sync canceled before overwriting the existing note.");
	}
}

async function ensureParentFolders(plugin: WorkflowySyncPlugin, notePath: string): Promise<void> {
	const parentPath = notePath.split("/").slice(0, -1).join("/");
	if (!parentPath) {
		return;
	}

	const normalizedParentPath = normalizePath(parentPath);
	const existingFolder = plugin.app.vault.getAbstractFileByPath(normalizedParentPath);
	if (existingFolder instanceof TFolder) {
		return;
	}

	if (existingFolder) {
		throw new Error(`A file already exists at ${normalizedParentPath}. Choose another note path.`);
	}

	const segments = normalizedParentPath.split("/");
	let currentPath = "";
	for (const segment of segments) {
		currentPath = currentPath ? `${currentPath}/${segment}` : segment;
		const existingEntry = plugin.app.vault.getAbstractFileByPath(currentPath);
		if (existingEntry instanceof TFolder) {
			continue;
		}
		if (existingEntry) {
			throw new Error(`A file already exists at ${currentPath}. Choose another note path.`);
		}

		await plugin.app.vault.createFolder(currentPath);
	}
}

async function promptForOverwriteConfirmation(
	plugin: WorkflowySyncPlugin,
	message: string,
): Promise<boolean> {
	return await new Promise<boolean>((resolve) => {
		const modal = new ConfirmModal(plugin.app, {
			title: "Overwrite note?",
			message,
			confirmText: "Overwrite note",
			onConfirm: () => resolve(true),
			onCancel: () => resolve(false),
		});
		modal.open();
	});
}
