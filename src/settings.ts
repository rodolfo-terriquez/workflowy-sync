import type { WorkflowyPluginSettings } from "./types";

export const DEFAULT_SETTINGS: WorkflowyPluginSettings = {
	apiKey: "",
	defaultTargetNodeId: "",
	defaultTargetLabel: "",
	includeObsidianBacklink: true,
	embedShowCompleted: true,
	recentTargetNodeIds: [],
	mappings: [],
};

export type { WorkflowyPluginSettings };
