import { Editor, Notice, TFile } from "obsidian";
import type WorkflowySyncPlugin from "../main";
import type { QuickSendPayload, WorkflowyResolvedTarget } from "../types";
import { sanitizeWorkflowyContent } from "../workflowy/markdown";

export function registerQuickSendCommands(plugin: WorkflowySyncPlugin): void {
	plugin.addCommand({
		id: "send-to-workflowy",
		name: "Workflowy: send selected text",
		editorCallback: async () => {
			await runQuickSend(plugin, false);
		},
	});

	plugin.addCommand({
		id: "send-to-workflowy-target",
		name: "Workflowy: send selected text to target...",
		editorCallback: async () => {
			await runQuickSend(plugin, true);
		},
	});
}

async function runQuickSend(
	plugin: WorkflowySyncPlugin,
	alwaysPromptForTarget: boolean,
): Promise<void> {
	const editorContext = plugin.getActiveMarkdownEditor();
	if (!editorContext) {
		return;
	}

	const markdown = getMarkdownFromEditor(editorContext.editor);
	if (!markdown.trim()) {
		new Notice("Before sending, select some text or place your cursor on a non-empty line.");
		return;
	}

	const target = alwaysPromptForTarget
		? await plugin.promptForTarget(plugin.settings.defaultTargetNodeId)
		: await plugin.getDefaultOrPromptForTarget();

	if (!target) {
		return;
	}

	const client = plugin.getClientOrNotice();
	if (!client) {
		return;
	}

	const payload = buildQuickSendPayload(plugin, target, markdown, editorContext.file);

	try {
		for (const item of [...payload.items].reverse()) {
			await client.createNode({
				parentId: payload.target.identifier,
				name: item.name,
				note: item.note ?? undefined,
				position: "top",
			});
		}
		await plugin.rememberTarget(target);
		new Notice(buildSuccessMessage(payload));
	} catch (error) {
		new Notice(formatQuickSendError(error, target));
	}
}

function getMarkdownFromEditor(editor: Editor): string {
	const selection = editor.getSelection().trim();
	if (selection) {
		return selection;
	}

	return editor.getLine(editor.getCursor().line).trim();
}

function buildQuickSendPayload(
	plugin: WorkflowySyncPlugin,
	target: WorkflowyResolvedTarget,
	markdown: string,
	file: TFile | null,
): QuickSendPayload {
	const sanitizedMarkdown = sanitizeWorkflowyContent(markdown);
	const backlinkNote = plugin.settings.includeObsidianBacklink ? buildObsidianBacklink(plugin, file) : null;

	return {
		target,
		previewMarkdown: sanitizedMarkdown,
		items: splitQuickSendItems(sanitizedMarkdown, backlinkNote),
	};
}

function buildObsidianBacklink(plugin: WorkflowySyncPlugin, file: TFile | null): string | null {
	if (!file) {
		return null;
	}

	const vaultName = encodeURIComponent(plugin.app.vault.getName());
	const filePath = encodeURIComponent(file.path);
	return `Source: [${file.basename}](obsidian://open?vault=${vaultName}&file=${filePath})`;
}

function buildSuccessMessage(payload: QuickSendPayload): string {
	const preview = summarizeMarkdown(payload.previewMarkdown);
	return `Sent ${preview} to ${payload.target.label}.`;
}

function summarizeMarkdown(markdown: string): string {
	const lines = markdown
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);

	if (lines.length === 0) {
		return "content";
	}

	const firstLineSource = lines[0] ?? "";
	const firstLine = truncatePreview(firstLineSource.replace(/^[-*]\s+/, "").replace(/^\[[ xX]\]\s+/, ""));
	if (lines.length === 1) {
		return `"${firstLine}"`;
	}

	return `"${firstLine}" and ${lines.length - 1} more line${lines.length === 2 ? "" : "s"}`;
}

function truncatePreview(value: string, maxLength = 48): string {
	if (value.length <= maxLength) {
		return value;
	}

	return `${value.slice(0, maxLength - 1).trimEnd()}...`;
}

function splitQuickSendItems(
	markdown: string,
	backlinkNote: string | null,
): Array<{ name: string; note: string | null }> {
	const lines = markdown
		.replace(/\r\n/g, "\n")
		.split("\n")
		.map((line) => cleanQuickSendTitle(line))
		.filter((line) => line.length > 0);

	if (lines.length === 0) {
		return [{
			name: "Quick send",
			note: backlinkNote,
		}];
	}

	return lines.map((line) => ({
		name: line,
		note: backlinkNote,
	}));
}

function cleanQuickSendTitle(line: string): string {
	return line
		.trim()
		.replace(/^[-*+]\s+/, "")
		.replace(/^\[( |x|X)\]\s+/, "");
}

function formatQuickSendError(error: unknown, target: WorkflowyResolvedTarget): string {
	const fallbackMessage = "Unable to send content to Workflowy.";
	if (!(error instanceof Error)) {
		return fallbackMessage;
	}

	const message = error.message;
	if (message.includes("Rate limit exceeded")) {
		return "Workflowy rate limit exceeded. Wait a second and try sending again.";
	}

	if (message.includes("Parent item not found")) {
		return `Workflowy could not find ${target.label}. Pick another target or revalidate the saved default target.`;
	}

	if (message.includes("Could not extract")) {
		return "That Workflowy destination is not valid. Pick a target from the list or paste a full Workflowy URL.";
	}

	if (message.includes("Missing API key")) {
		return "Add your Workflowy API key in plugin settings first.";
	}

	return message || fallbackMessage;
}
