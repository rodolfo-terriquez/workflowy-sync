import { TFile } from "obsidian";
import type WorkflowySyncPlugin from "../main";
import type { SyncMapping, SyncResult, WorkflowyNode } from "../types";
import { extractSyncSectionMarkdown } from "./section-content";
import { ConfirmModal } from "../ui/confirm-modal";
import type { WorkflowyLlmEditOperation, WorkflowyLlmInsertItem, WorkflowyLlmNode } from "../workflowy/client";
import { sanitizeWorkflowyContent } from "../workflowy/markdown";

interface WorkflowyDraftNode {
	name: string;
	note: string | null;
	layoutMode: "bullets" | "todo";
	completed: boolean;
	children: WorkflowyDraftNode[];
}

interface ParsedListItem {
	indentWidth: number;
	text: string;
	layoutMode: "bullets" | "todo";
	completed: boolean;
}

export async function syncObsidianToWorkflowy(
	plugin: WorkflowySyncPlugin,
	mapping: SyncMapping,
	options: { allowOverwritePrompt?: boolean } = {},
): Promise<SyncResult> {
	const client = plugin.getClientOrNotice();
	if (!client) {
		throw new Error("Missing Workflowy API key");
	}

	const noteFile = plugin.app.vault.getAbstractFileByPath(mapping.obsidianPath);
	if (!(noteFile instanceof TFile)) {
		throw new Error(`Could not find the Obsidian note at ${mapping.obsidianPath}.`);
	}

	const noteContent = await plugin.app.vault.cachedRead(noteFile);
	const rootNode = await client.getNodeTree(mapping.wfNodeId, { forceRefresh: true });
	const sourceMarkdown = extractSourceMarkdown(noteContent, mapping.obsidianSectionHeading);
	const desiredRoot = parseMarkdownToWorkflowyTree(
		sourceMarkdown,
		rootNode.name.trim() || mapping.wfNodeLabel || mapping.wfNodeId,
	);
	await confirmFirstWorkflowyOverwrite(plugin, mapping, rootNode, noteFile.path, options.allowOverwritePrompt ?? true);
	const syncedAt = new Date().toISOString();
	await syncDraftNodeToWorkflowy(client, rootNode, desiredRoot, true);
	await plugin.markMappingSynced(mapping.id, syncedAt, rootNode.name.trim() || mapping.wfNodeLabel || mapping.wfNodeId);

	return {
		mappingId: mapping.id,
		mappingLabel: mapping.label,
		notePath: noteFile.path,
		rootLabel: rootNode.name.trim() || mapping.wfNodeLabel || mapping.wfNodeId,
		nodeCount: countDraftNodes(desiredRoot),
		created: false,
		syncedAt,
	};
}

async function syncDraftNodeToWorkflowy(
	client: ReturnType<WorkflowySyncPlugin["createClient"]>,
	existingNode: WorkflowyNode,
	desiredNode: WorkflowyDraftNode,
	isRoot: boolean,
): Promise<void> {
	await syncSingleNodeMetadata(client, existingNode, desiredNode, isRoot);

	const llmRoot = await client.readLlmDocument(existingNode.id, 1);
	const operations = buildLlmReplaceOperations(llmRoot, desiredNode);
	await client.editLlmDocument(llmRoot.ref, operations);

	if (!treeContainsItemNotes(desiredNode.children)) {
		return;
	}

	const refreshedNode = await client.getNodeTree(existingNode.id, { forceRefresh: true });
	await syncDraftMetadataRecursively(client, refreshedNode, desiredNode, isRoot);
}

async function syncCompletionState(
	client: ReturnType<WorkflowySyncPlugin["createClient"]>,
	existingNode: WorkflowyNode,
	desiredNode: WorkflowyDraftNode,
): Promise<void> {
	if (desiredNode.layoutMode !== "todo") {
		if (existingNode.completedAt || existingNode.completed) {
			await client.uncompleteNode(existingNode.id);
		}
		return;
	}

	if (desiredNode.completed && !(existingNode.completedAt || existingNode.completed)) {
		await client.completeNode(existingNode.id);
		return;
	}

	if (!desiredNode.completed && (existingNode.completedAt || existingNode.completed)) {
		await client.uncompleteNode(existingNode.id);
	}
}

async function syncDraftMetadataRecursively(
	client: ReturnType<WorkflowySyncPlugin["createClient"]>,
	existingNode: WorkflowyNode,
	desiredNode: WorkflowyDraftNode,
	isRoot: boolean,
): Promise<void> {
	await syncSingleNodeMetadata(client, existingNode, desiredNode, isRoot);

	const existingChildren = existingNode.children ?? [];
	if (existingChildren.length !== desiredNode.children.length) {
		throw new Error("Workflowy structure did not match the inserted child tree.");
	}

	for (let index = 0; index < existingChildren.length; index += 1) {
		const existingChild = existingChildren[index];
		const desiredChild = desiredNode.children[index];
		if (!existingChild || !desiredChild) {
			continue;
		}

		await syncDraftMetadataRecursively(client, existingChild, desiredChild, false);
	}
}

async function syncSingleNodeMetadata(
	client: ReturnType<WorkflowySyncPlugin["createClient"]>,
	existingNode: WorkflowyNode,
	desiredNode: WorkflowyDraftNode,
	isRoot: boolean,
): Promise<void> {
	const shouldUpdateNode = normalizeOptionalText(existingNode.note) !== normalizeOptionalText(desiredNode.note)
		|| (!isRoot && (existingNode.data.layoutMode ?? "bullets") !== desiredNode.layoutMode);

	if (shouldUpdateNode) {
		await client.updateNode({
			id: existingNode.id,
			name: isRoot ? sanitizeWorkflowyContent(existingNode.name) : sanitizeWorkflowyContent(desiredNode.name),
			note: desiredNode.note ? sanitizeWorkflowyContent(desiredNode.note) : "",
			layoutMode: isRoot ? existingNode.data.layoutMode : desiredNode.layoutMode,
		});
	}

	if (!isRoot) {
		await syncCompletionState(client, existingNode, desiredNode);
	}
}

function buildLlmReplaceOperations(
	rootNode: WorkflowyLlmNode,
	desiredNode: WorkflowyDraftNode,
): WorkflowyLlmEditOperation[] {
	const operations: WorkflowyLlmEditOperation[] = rootNode.children.map((child) => ({
		op: "delete",
		ref: child.ref,
	}));

	if (desiredNode.children.length > 0) {
		operations.push({
			op: "insert",
			under: rootNode.ref,
			items: desiredNode.children.map((child) => buildLlmInsertItem(child)),
			position: "bottom",
		});
	}

	return operations;
}

function buildLlmInsertItem(node: WorkflowyDraftNode): WorkflowyLlmInsertItem {
	const item: WorkflowyLlmInsertItem = {
		n: sanitizeWorkflowyContent(node.name),
	};

	if (node.layoutMode === "todo") {
		item.l = "todo";
		item.x = node.completed ? 1 : 0;
	}

	if (node.children.length > 0) {
		item.c = node.children.map((child) => buildLlmInsertItem(child));
	}

	return item;
}

function extractSourceMarkdown(markdown: string, sectionHeading?: string): string {
	if (!sectionHeading?.trim()) {
		return markdown;
	}

	return extractSyncSectionMarkdown(markdown, sectionHeading);
}

function parseMarkdownToWorkflowyTree(markdown: string, fallbackName: string): WorkflowyDraftNode {
	const normalizedMarkdown = markdown.replace(/\r\n/g, "\n");
	const lines = normalizedMarkdown.split("\n");
	let index = 0;

	while (index < lines.length && (lines[index]?.trim() ?? "") === "") {
		index += 1;
	}

	let rootName = fallbackName.trim() || "Obsidian sync";
	const heading = parseHeadingLine(lines[index] ?? "");
	if (heading) {
		rootName = heading.text || rootName;
		index += 1;
	}

	const noteLines: string[] = [];
	const rawNoteLines: string[] = [];
	while (index < lines.length) {
		const line = lines[index] ?? "";
		if (parseListItemLine(line) || parseHeadingLine(line)) {
			break;
		}

		rawNoteLines.push(line);
		noteLines.push(stripBlockquotePrefix(line.trimStart()));
		index += 1;
	}

	let rootNote: string | null = normalizeMarkdownText(noteLines.join("\n")) || null;
	let { nodes } = parseChildNodes(lines, index, -1);

	if (nodes.length === 0) {
		const fallbackChildren = parsePlainTextLinesAsChildren(rawNoteLines);
		if (fallbackChildren.length > 0) {
			nodes = fallbackChildren;
			rootNote = null;
		}
	}

	return {
		name: rootName,
		note: rootNote,
		layoutMode: "bullets",
		completed: false,
		children: nodes,
	};
}

function parseChildNodes(
	lines: string[],
	startIndex: number,
	parentIndentWidth: number,
): { nodes: WorkflowyDraftNode[]; nextIndex: number } {
	const nodes: WorkflowyDraftNode[] = [];
	let index = startIndex;
	let currentLevelIndent: number | null = null;

	while (index < lines.length) {
		const currentLine = lines[index] ?? "";
		if (currentLine.trim() === "") {
			index += 1;
			continue;
		}

		const itemMatch = parseListItemLine(currentLine);
		if (!itemMatch || itemMatch.indentWidth <= parentIndentWidth) {
			break;
		}

		if (currentLevelIndent === null) {
			currentLevelIndent = itemMatch.indentWidth;
		}

		if (itemMatch.indentWidth !== currentLevelIndent) {
			break;
		}

		index += 1;
		const noteLines: string[] = [];
		while (index < lines.length) {
			const noteLine = lines[index] ?? "";
			if (noteLine.trim() === "") {
				noteLines.push("");
				index += 1;
				continue;
			}

			if (parseListItemLine(noteLine) || parseHeadingLine(noteLine)) {
				break;
			}

			noteLines.push(stripBlockquotePrefix(noteLine.trimStart()));
			index += 1;
		}

		const childResult = parseChildNodes(lines, index, currentLevelIndent);
		index = childResult.nextIndex;
		nodes.push({
			name: itemMatch.text || "Untitled item",
			note: normalizeMarkdownText(noteLines.join("\n")) || null,
			layoutMode: itemMatch.layoutMode,
			completed: itemMatch.completed,
			children: childResult.nodes,
		});
	}

	return {
		nodes,
		nextIndex: index,
	};
}

function parseListItemLine(line: string): ParsedListItem | null {
	const match = line.match(/^([ \t]*)([-*+])\s+(?:\[( |x|X)\]\s+)?(.*)$/);
	if (!match) {
		return null;
	}

	const markerPrefix = match[0].slice(0, match[0].length - (match[4] ?? "").length);
	const isTodo = /\[[ xX]\]\s+$/.test(markerPrefix);
	if (isTodo) {
		return {
			indentWidth: measureIndentWidth(match[1] ?? ""),
			text: (match[4] ?? "").trim(),
			layoutMode: "todo",
			completed: (match[3] ?? "").toLowerCase() === "x",
		};
	}

	return {
		indentWidth: measureIndentWidth(match[1] ?? ""),
		text: (match[4] ?? "").trim(),
		layoutMode: "bullets",
		completed: false,
	};
}

function stripBlockquotePrefix(line: string): string {
	return line.replace(/^>\s?/, "");
}

function normalizeMarkdownText(value: string): string {
	return value
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function parsePlainTextLinesAsChildren(lines: string[]): WorkflowyDraftNode[] {
	const trimmedLines = lines.map((line) => line.trim()).filter(Boolean);
	if (trimmedLines.length === 0) {
		return [];
	}

	const containsStructuredMarkdown = lines.some((line) => {
		const trimmedLine = line.trimStart();
		return trimmedLine.startsWith(">") || trimmedLine.startsWith("#");
	});
	if (containsStructuredMarkdown) {
		return [];
	}

	return trimmedLines.map((line) => ({
		name: line,
		note: null,
		layoutMode: "bullets",
		completed: false,
		children: [],
	}));
}

function countDraftNodes(node: WorkflowyDraftNode): number {
	return 1 + node.children.reduce((total, child) => total + countDraftNodes(child), 0);
}

function treeContainsItemNotes(nodes: WorkflowyDraftNode[]): boolean {
	return nodes.some((node) => Boolean(node.note?.trim()) || treeContainsItemNotes(node.children));
}

async function confirmFirstWorkflowyOverwrite(
	plugin: WorkflowySyncPlugin,
	mapping: SyncMapping,
	rootNode: WorkflowyNode,
	notePath: string,
	allowOverwritePrompt: boolean,
): Promise<void> {
	if (mapping.lastSynced) {
		return;
	}

	if (!workflowyNodeHasContent(rootNode)) {
		return;
	}

	if (!allowOverwritePrompt) {
		throw new Error("Run this mapping manually once before using scheduled sync so Workflowy Sync can confirm the first Workflowy overwrite.");
	}

	const confirmed = await new Promise<boolean>((resolve) => {
		const modal = new ConfirmModal(plugin.app, {
			title: "Overwrite Workflowy node?",
			message: `The first sync for "${mapping.label}" will replace the existing contents of the Workflowy node "${rootNode.name.trim() || rootNode.id}" with content from "${notePath}".`,
			confirmText: "Overwrite Workflowy",
			onConfirm: () => resolve(true),
			onCancel: () => resolve(false),
		});
		modal.open();
	});

	if (!confirmed) {
		throw new Error("Sync canceled before overwriting the existing Workflowy node.");
	}
}

function workflowyNodeHasContent(node: WorkflowyNode): boolean {
	return Boolean(node.note?.trim() || (node.children?.length ?? 0) > 0);
}

function parseHeadingLine(line: string): { level: number; text: string } | null {
	const match = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
	if (!match) {
		return null;
	}

	return {
		level: match[1]?.length ?? 1,
		text: (match[2] ?? "").trim(),
	};
}

function measureIndentWidth(indent: string): number {
	let width = 0;
	for (const character of indent) {
		width += character === "\t" ? 2 : 1;
	}

	return width;
}

function normalizeOptionalText(value: string | null | undefined): string {
	return (value ?? "").trim();
}
