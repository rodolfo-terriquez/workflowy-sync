import { Notice } from "obsidian";
import type WorkflowySyncPlugin from "../main";
import type { SyncMapping } from "../types";
import { WorkflowyMappingPickerModal } from "../sync/mapping-picker-modal";

export function registerSyncCommands(plugin: WorkflowySyncPlugin): void {
	plugin.addCommand({
		id: "sync-mapping-now",
		name: "Workflowy: run sync mapping",
		callback: async () => {
			await runMappingSync(plugin);
		},
	});
}

export async function syncAndNotify(plugin: WorkflowySyncPlugin, mapping: SyncMapping): Promise<void> {
	try {
		const result = await plugin.syncMapping(mapping);
		new Notice(buildSyncSuccessMessage(mapping, result));
	} catch (error) {
		const message = error instanceof Error ? error.message : "Unable to sync that Workflowy mapping.";
		new Notice(message);
	}
}

function buildSyncSuccessMessage(mapping: SyncMapping, result: Awaited<ReturnType<WorkflowySyncPlugin["syncMapping"]>>): string {
	if (mapping.direction === "ob-to-wf") {
		return `Synced ${result.notePath} to ${mapping.wfNodeLabel ?? mapping.wfNodeId}. ${result.nodeCount} node(s) synced.`;
	}

	const action = result.created ? "Created" : "Updated";
	return `${action} ${result.notePath} from ${result.rootLabel}. ${result.nodeCount} node(s) synced.`;
}

async function runMappingSync(plugin: WorkflowySyncPlugin): Promise<void> {
	const mappings = plugin.settings.mappings;
	if (mappings.length === 0) {
		new Notice("Add a sync mapping in settings first.");
		return;
	}

	const firstMapping = mappings[0];
	if (mappings.length === 1 && firstMapping) {
		await syncAndNotify(plugin, firstMapping);
		return;
	}

	await new Promise<void>((resolve) => {
		const modal = new WorkflowyMappingPickerModal(plugin.app, {
			mappings,
			onCancel: () => resolve(),
			onChoose: async (mapping) => {
				await syncAndNotify(plugin, mapping);
				resolve();
			},
		});
		modal.open();
	});
}
