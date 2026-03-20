import { Editor, MarkdownView, Notice, Plugin, TFile, normalizePath } from "obsidian";
import { registerQuickSendCommands } from "./commands/quick-send";
import { registerSyncCommands } from "./commands/sync-mappings";
import { WorkflowyBlockRenderer } from "./renderers/workflowy-block";
import { DEFAULT_SETTINGS, type WorkflowyPluginSettings } from "./settings";
import { syncObsidianToWorkflowy } from "./sync/obsidian-to-workflowy";
import { WorkflowyMappingModal } from "./sync/mapping-modal";
import { syncMappingToNote } from "./sync/service";
import {
	WorkflowyTargetModal,
	type WorkflowyTargetSuggestion,
} from "./ui/target-modal";
import { WorkflowySettingTab } from "./ui/settings-tab";
import type {
	SyncMapping,
	SyncMappingDraft,
	SyncResult,
	WorkflowyResolvedTarget,
	WorkflowyTarget,
} from "./types";
import { WorkflowyClient } from "./workflowy/client";
import { formatTargetLabel } from "./workflowy/identifiers";

export default class WorkflowySyncPlugin extends Plugin {
	private static readonly minimumScheduledIntervalMinutes = 1;

	settings: WorkflowyPluginSettings = DEFAULT_SETTINGS;
	private workflowyClient: WorkflowyClient | null = null;
	private workflowyClientApiKey = "";
	private readonly activeIntervalIds = new Set<number>();
	private readonly syncingMappingIds = new Set<string>();

	async onload(): Promise<void> {
		await this.loadSettings();

		registerQuickSendCommands(this);
		registerSyncCommands(this);
		this.registerMarkdownCodeBlockProcessor("workflowy", (source, el, ctx) => {
			const renderer = new WorkflowyBlockRenderer(el, this, source, ctx.sourcePath);
			ctx.addChild(renderer);
			void renderer.render();
		});

		this.addSettingTab(new WorkflowySettingTab(this.app, this));
		this.app.workspace.onLayoutReady(() => {
			void this.runTriggeredMappings("on-open");
		});
		this.refreshScheduledIntervals();
	}

	async loadSettings(): Promise<void> {
		const loadedSettings = await this.loadData() as Partial<WorkflowyPluginSettings> | null;
		this.settings = {
			...DEFAULT_SETTINGS,
			...loadedSettings,
			recentTargetNodeIds: loadedSettings?.recentTargetNodeIds ?? [...DEFAULT_SETTINGS.recentTargetNodeIds],
			mappings: (loadedSettings?.mappings ?? [...DEFAULT_SETTINGS.mappings]).map((mapping) => ({
				...mapping,
				direction: mapping.direction ?? "wf-to-ob",
				filter: {
					includeCompleted: mapping.filter?.includeCompleted ?? true,
					...mapping.filter,
				},
				trigger: mapping.trigger ?? "manual",
				intervalMinutes: mapping.trigger === "interval"
					? this.normalizeScheduledInterval(mapping.intervalMinutes)
					: undefined,
			})),
		};
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		this.refreshScheduledIntervals();
	}

	createClient(): WorkflowyClient {
		const apiKey = this.settings.apiKey.trim();
		if (!this.workflowyClient || this.workflowyClientApiKey !== apiKey) {
			this.workflowyClient = new WorkflowyClient(apiKey);
			this.workflowyClientApiKey = apiKey;
		}

		return this.workflowyClient;
	}

	getClientOrNotice(): WorkflowyClient | null {
		if (!this.settings.apiKey.trim()) {
			new Notice("Add your API key in plugin settings first.");
			return null;
		}

		return this.createClient();
	}

	getActiveMarkdownEditor(): { editor: Editor; file: TFile | null } | null {
		const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!markdownView) {
			new Notice("Open a Markdown note to use sync.");
			return null;
		}

		return {
			editor: markdownView.editor,
			file: markdownView.file,
		};
	}

	getActiveMarkdownFile(): TFile | null {
		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile) {
			return null;
		}

		return activeFile.extension === "md" ? activeFile : null;
	}

	async validateConnection(): Promise<WorkflowyTarget[]> {
		const client = this.getClientOrNotice();
		if (!client) {
			throw new Error("Missing API key");
		}

		return client.validateApiKey();
	}

	async resolveTargetInput(rawInput: string): Promise<WorkflowyResolvedTarget> {
		const client = this.getClientOrNotice();
		if (!client) {
			throw new Error("Missing API key");
		}

		return client.resolveTarget(rawInput);
	}

	async resolveDefaultTarget(): Promise<WorkflowyResolvedTarget | null> {
		const identifier = this.settings.defaultTargetNodeId.trim();
		if (!identifier) {
			return null;
		}

		const resolvedTarget = await this.resolveTargetInput(identifier);
		this.settings.defaultTargetNodeId = resolvedTarget.identifier;
		this.settings.defaultTargetLabel = resolvedTarget.label;
		await this.saveSettings();
		return resolvedTarget;
	}

	async promptForTarget(initialValue = ""): Promise<WorkflowyResolvedTarget | null> {
		const client = this.getClientOrNotice();
		if (!client) {
			return null;
		}

		const suggestions = await this.getTargetSuggestions(client);
		return await new Promise<WorkflowyResolvedTarget | null>((resolve) => {
			const modal = new WorkflowyTargetModal(this.app, {
				initialValue,
				suggestions,
				onCancel: () => resolve(null),
				onChoose: async (suggestion) => {
					try {
						const target = suggestion.target ?? await client.resolveTarget(suggestion.customInput ?? suggestion.identifier);
						await this.rememberTarget(target);
						resolve(target);
					} catch (error) {
						const message = error instanceof Error ? error.message : "Unable to resolve that Workflowy target.";
						new Notice(message);
						resolve(null);
					}
				},
			});
			modal.open();
		});
	}

	async getDefaultOrPromptForTarget(): Promise<WorkflowyResolvedTarget | null> {
		if (this.settings.defaultTargetNodeId.trim()) {
			try {
				const defaultTarget = await this.resolveDefaultTarget();
				if (defaultTarget) {
					return defaultTarget;
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : "Unable to use the saved Workflowy target.";
				new Notice(`${message} Pick another target.`);
			}
		}

		return await this.promptForTarget(this.settings.defaultTargetNodeId);
	}

	async updateDefaultTarget(rawInput: string): Promise<WorkflowyResolvedTarget | null> {
		const trimmedValue = rawInput.trim();
		if (!trimmedValue) {
			this.settings.defaultTargetNodeId = "";
			this.settings.defaultTargetLabel = "";
			await this.saveSettings();
			return null;
		}

		const target = await this.resolveTargetInput(trimmedValue);
		this.settings.defaultTargetNodeId = target.identifier;
		this.settings.defaultTargetLabel = target.label;
		await this.rememberTarget(target);
		return target;
	}

	async clearDefaultTarget(): Promise<void> {
		this.settings.defaultTargetNodeId = "";
		this.settings.defaultTargetLabel = "";
		await this.saveSettings();
	}

	async rememberTarget(target: WorkflowyResolvedTarget): Promise<void> {
		const dedupedTargets = [
			target.identifier,
			...this.settings.recentTargetNodeIds.filter((value) => value !== target.identifier),
		].slice(0, 5);

		this.settings.recentTargetNodeIds = dedupedTargets;
		if (this.settings.defaultTargetNodeId === target.identifier) {
			this.settings.defaultTargetLabel = target.label;
		}
		await this.saveSettings();
	}

	async openMappingModal(mapping?: SyncMapping): Promise<boolean> {
		return await new Promise<boolean>((resolve) => {
			const modal = new WorkflowyMappingModal(this.app, {
				plugin: this,
				mapping,
				onCancel: () => resolve(false),
				onSubmit: async (draft) => {
					if (mapping) {
						await this.updateMapping(mapping.id, draft);
					} else {
						await this.addMapping(draft);
					}
					resolve(true);
				},
			});
			modal.open();
		});
	}

	async addMapping(draft: SyncMappingDraft): Promise<SyncMapping> {
		const mapping = await this.buildMappingFromDraft(draft);
		this.settings.mappings = [...this.settings.mappings, mapping];
		await this.saveSettings();
		return mapping;
	}

	async updateMapping(id: string, draft: SyncMappingDraft): Promise<SyncMapping> {
		const existingMapping = this.settings.mappings.find((mapping) => mapping.id === id);
		if (!existingMapping) {
			throw new Error("That sync mapping no longer exists.");
		}

		const updatedMapping = await this.buildMappingFromDraft(draft, existingMapping);
		this.settings.mappings = this.settings.mappings.map((mapping) => mapping.id === id ? updatedMapping : mapping);
		await this.saveSettings();
		return updatedMapping;
	}

	async removeMapping(id: string): Promise<void> {
		this.settings.mappings = this.settings.mappings.filter((mapping) => mapping.id !== id);
		await this.saveSettings();
	}

	async markMappingSynced(id: string, syncedAt: string, wfNodeLabel?: string, wfNodeId?: string): Promise<void> {
		this.settings.mappings = this.settings.mappings.map((mapping) => {
			if (mapping.id !== id) {
				return mapping;
			}

			return {
				...mapping,
				wfNodeId: wfNodeId ?? mapping.wfNodeId,
				lastSynced: syncedAt,
				wfNodeLabel: wfNodeLabel ?? mapping.wfNodeLabel,
			};
		});
		await this.saveSettings();
	}

	async syncMapping(
		mapping: SyncMapping,
		options: { allowOverwritePrompt?: boolean } = {},
	): Promise<SyncResult> {
		if (mapping.direction === "ob-to-wf") {
			return await syncObsidianToWorkflowy(this, mapping, options);
		}

		return await syncMappingToNote(this, mapping, options);
	}

	private async buildMappingFromDraft(draft: SyncMappingDraft, existingMapping?: SyncMapping): Promise<SyncMapping> {
		const resolvedTarget = await this.resolveTargetInput(draft.wfNodeId);
		await this.rememberTarget(resolvedTarget);
		if (draft.direction !== "wf-to-ob" && resolvedTarget.type !== "node") {
			throw new Error("Obsidian to Workflowy sync currently requires a specific Workflowy item, not a target shortcut.");
		}

		const normalizedPath = normalizePath(draft.obsidianPath);
		const normalizedSectionHeading = draft.obsidianSectionHeading.trim();
		const sourceChanged = existingMapping
			? existingMapping.wfNodeId !== resolvedTarget.identifier
				|| existingMapping.obsidianPath !== normalizedPath
				|| (existingMapping.obsidianSectionHeading ?? "") !== normalizedSectionHeading
				|| existingMapping.direction !== draft.direction
			: true;

		return {
			id: existingMapping?.id ?? this.createMappingId(),
			label: draft.label.trim(),
			wfNodeId: resolvedTarget.identifier,
			wfNodeLabel: resolvedTarget.label || draft.wfNodeLabel,
			obsidianPath: normalizedPath,
			obsidianSectionHeading: normalizedSectionHeading || undefined,
			direction: draft.direction,
			filter: {
				...(existingMapping?.filter ?? {}),
				includeCompleted: draft.includeCompleted,
			},
			trigger: draft.trigger,
			intervalMinutes: draft.trigger === "interval"
				? this.normalizeScheduledInterval(draft.intervalMinutes)
				: undefined,
			lastSynced: sourceChanged ? undefined : existingMapping?.lastSynced,
		};
	}

	private refreshScheduledIntervals(): void {
		for (const intervalId of this.activeIntervalIds) {
			window.clearInterval(intervalId);
		}
		this.activeIntervalIds.clear();

		for (const mapping of this.settings.mappings) {
			if (mapping.trigger !== "interval") {
				continue;
			}

			const intervalMinutes = this.normalizeScheduledInterval(mapping.intervalMinutes);
			const intervalId = window.setInterval(() => {
				void this.runScheduledMapping(mapping.id);
			}, intervalMinutes * 60 * 1000);

			this.activeIntervalIds.add(intervalId);
			this.registerInterval(intervalId);
		}
	}

	private async runTriggeredMappings(trigger: SyncMapping["trigger"]): Promise<void> {
		const mappings = this.settings.mappings.filter((mapping) => mapping.trigger === trigger);
		for (const mapping of mappings) {
			await this.runScheduledMapping(mapping.id);
		}
	}

	private async runScheduledMapping(mappingId: string): Promise<void> {
		if (this.syncingMappingIds.has(mappingId)) {
			return;
		}

		const mapping = this.settings.mappings.find((candidate) => candidate.id === mappingId);
		if (!mapping) {
			return;
		}

		this.syncingMappingIds.add(mappingId);
		try {
			await this.syncMapping(mapping, { allowOverwritePrompt: false });
		} catch (error) {
			const message = error instanceof Error ? error.message : "Scheduled sync failed.";
			new Notice(`Workflowy Sync: ${mapping.label} failed. ${message}`);
		} finally {
			this.syncingMappingIds.delete(mappingId);
		}
	}

	private normalizeScheduledInterval(value: number | undefined): number {
		if (!value || !Number.isFinite(value) || value < WorkflowySyncPlugin.minimumScheduledIntervalMinutes) {
			return WorkflowySyncPlugin.minimumScheduledIntervalMinutes;
		}

		return Math.floor(value);
	}

	private createMappingId(): string {
		return typeof crypto !== "undefined" && "randomUUID" in crypto
			? crypto.randomUUID()
			: `mapping-${Date.now()}`;
	}

	private async getTargetSuggestions(client: WorkflowyClient): Promise<WorkflowyTargetSuggestion[]> {
		const targets = await client.listTargets();
		const targetSuggestions = targets.map((target) => this.buildTargetSuggestion(target));
		const recentSuggestions = await this.buildRecentSuggestions(client, targets);
		const seenIdentifiers = new Set<string>();
		const mergedSuggestions: WorkflowyTargetSuggestion[] = [];

		for (const suggestion of [...recentSuggestions, ...targetSuggestions]) {
			const normalizedIdentifier = suggestion.identifier.toLowerCase();
			if (seenIdentifiers.has(normalizedIdentifier)) {
				continue;
			}

			seenIdentifiers.add(normalizedIdentifier);
			mergedSuggestions.push(suggestion);
		}

		return mergedSuggestions;
	}

	private buildTargetSuggestion(target: WorkflowyTarget): WorkflowyTargetSuggestion {
		const label = formatTargetLabel(target.key, target.name);
		return {
			title: label,
			subtitle: `${target.type === "system" ? "System target" : "Shortcut"} • ${target.key}`,
			identifier: target.key,
			category: target.type === "system" ? "System" : "Shortcut",
			target: {
				identifier: target.key,
				label,
				type: "target",
			},
		};
	}

	private async buildRecentSuggestions(
		client: WorkflowyClient,
		targets: WorkflowyTarget[],
	): Promise<WorkflowyTargetSuggestion[]> {
		const targetIndex = new Map(
			targets.map((target) => [target.key.toLowerCase(), target]),
		);

		const recentSuggestions: WorkflowyTargetSuggestion[] = [];
		for (const identifier of this.settings.recentTargetNodeIds) {
			const targetMatch = targetIndex.get(identifier.toLowerCase());
			if (targetMatch) {
				const targetSuggestion = this.buildTargetSuggestion(targetMatch);
				recentSuggestions.push({
					...targetSuggestion,
					category: "Recent",
					subtitle: `${targetSuggestion.subtitle} • recent`,
				});
				continue;
			}

			try {
				const resolvedTarget = await client.resolveTarget(identifier);
				recentSuggestions.push({
					title: resolvedTarget.label,
					subtitle: `Recent node • ${resolvedTarget.identifier}`,
					identifier: resolvedTarget.identifier,
					category: "Recent",
					target: resolvedTarget,
				});
			} catch {
				recentSuggestions.push({
					title: identifier,
					subtitle: "Recent destination",
					identifier,
					category: "Recent",
					customInput: identifier,
				});
			}
		}

		return recentSuggestions;
	}
}
