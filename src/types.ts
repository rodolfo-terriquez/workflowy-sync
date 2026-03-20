export interface SyncMapping {
	id: string;
	label: string;
	wfNodeId: string;
	wfNodeLabel?: string;
	obsidianPath: string;
	obsidianSectionHeading?: string;
	direction: "wf-to-ob" | "ob-to-wf" | "bidirectional";
	filter: {
		includeCompleted?: boolean;
		onlyTasks?: boolean;
		tags?: string[];
		dateRange?: "today" | "this-week" | "all";
	};
	trigger: "manual" | "on-open" | "interval";
	intervalMinutes?: number;
	lastSynced?: string;
}

export interface WorkflowyPluginSettings {
	apiKey: string;
	defaultTargetNodeId: string;
	defaultTargetLabel: string;
	includeObsidianBacklink: boolean;
	embedShowCompleted: boolean;
	recentTargetNodeIds: string[];
	mappings: SyncMapping[];
}

export interface WorkflowyNode {
	id: string;
	name: string;
	note: string | null;
	priority: number;
	parent_id?: string | null;
	data: {
		layoutMode?: string;
	};
	createdAt: number;
	modifiedAt: number;
	completedAt: number | null;
	completed?: boolean;
	children?: WorkflowyNode[];
}

export interface WorkflowyTarget {
	key: string;
	type: string;
	name: string | null;
}

export interface WorkflowyResolvedTarget {
	identifier: string;
	label: string;
	type: "node" | "target";
}

export interface QuickSendPayload {
	target: WorkflowyResolvedTarget;
	previewMarkdown: string;
	items: Array<{
		name: string;
		note: string | null;
	}>;
}

export interface RenderedWorkflowyBlock {
	identifier: string;
	lastUpdatedAt: string | null;
}

export interface SyncMappingDraft {
	label: string;
	wfNodeId: string;
	wfNodeLabel: string;
	obsidianPath: string;
	obsidianSectionHeading: string;
	includeCompleted: boolean;
	direction: "wf-to-ob" | "ob-to-wf";
	trigger: "manual" | "on-open" | "interval";
	intervalMinutes?: number;
}

export interface SyncResult {
	mappingId: string;
	mappingLabel: string;
	notePath: string;
	rootLabel: string;
	nodeCount: number;
	created: boolean;
	syncedAt: string;
}
