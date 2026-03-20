import { requestUrl } from "obsidian";
import type {
	WorkflowyNode,
	WorkflowyResolvedTarget,
	WorkflowyTarget,
} from "../types";
import {
	formatTargetLabel,
	isWorkflowyFullNodeId,
	isWorkflowyShortNodeId,
	normalizeWorkflowyIdentifier,
	stripWorkflowyShortNodePrefix,
} from "./identifiers";

interface WorkflowyTargetsResponse {
	targets: WorkflowyTarget[];
}

interface WorkflowyNodeResponse {
	node: WorkflowyNode;
}

interface WorkflowyListNodesResponse {
	nodes: WorkflowyNode[];
}

interface WorkflowyNodesExportResponse {
	nodes: WorkflowyNode[];
}

interface WorkflowyCreateNodeResponse {
	item_id?: string;
}

interface WorkflowyStatusResponse {
	status?: string;
}

export interface WorkflowyLlmNode {
	ref: string;
	name: string;
	layoutMode?: string;
	completed: boolean;
	children: WorkflowyLlmNode[];
}

export interface WorkflowyLlmInsertItem {
	n: string;
	l?: "todo" | "bullets";
	x?: 0 | 1;
	c?: WorkflowyLlmInsertItem[];
}

export type WorkflowyLlmEditOperation = {
	op: "delete";
	ref: string;
} | {
	op: "insert";
	under: string;
	items: WorkflowyLlmInsertItem[];
	position?: "top" | "bottom";
};

export class WorkflowyClient {
	private static readonly minRequestIntervalMs = 1600;
	private static readonly rateLimitRetryDelayMs = 2500;
	private static readonly maxRateLimitRetries = 3;
	private static requestQueue: Promise<void> = Promise.resolve();
	private static lastRequestAt = 0;

	private readonly apiKey: string;
	private readonly apiBaseUrl = "https://workflowy.com/api/v1";
	private readonly llmBaseUrl = "https://beta.workflowy.com/api/llm/doc";
	private cachedTargets: WorkflowyTarget[] | null = null;
	private cachedExportedNodes: WorkflowyNode[] | null = null;

	constructor(apiKey: string) {
		this.apiKey = apiKey.trim();
	}

	async validateApiKey(): Promise<WorkflowyTarget[]> {
		return await this.listTargets();
	}

	async listTargets(): Promise<WorkflowyTarget[]> {
		if (this.cachedTargets) {
			return this.cachedTargets;
		}

		const response = await this.requestJson<WorkflowyTargetsResponse>("/targets");
		this.cachedTargets = response.targets;
		return response.targets;
	}

	async getTargetLabel(identifier: string): Promise<string> {
		const resolvedTarget = await this.resolveTarget(identifier);
		return resolvedTarget.label;
	}

	async resolveTarget(rawIdentifier: string): Promise<WorkflowyResolvedTarget> {
		const identifier = normalizeWorkflowyIdentifier(rawIdentifier);
		const targets = await this.listTargets();
		const matchingTarget = targets.find((target) => target.key.toLowerCase() === identifier.toLowerCase());

		if (matchingTarget) {
			return {
				identifier: matchingTarget.key,
				label: formatTargetLabel(matchingTarget.key, matchingTarget.name),
				type: "target",
			};
		}

		const node = await this.getNode(identifier);
		return {
			identifier: node.id,
			label: node.name.trim() || node.id,
			type: "node",
		};
	}

	async getNode(rawIdentifier: string): Promise<WorkflowyNode> {
		const identifier = await this.resolveNodeIdentifier(rawIdentifier);
		const response = await this.requestJson<WorkflowyNodeResponse>(`/nodes/${encodeURIComponent(identifier)}`);
		return response.node;
	}

	async listNodes(rawParentIdentifier: string): Promise<WorkflowyNode[]> {
		const parentIdentifier = normalizeWorkflowyIdentifier(rawParentIdentifier);
		const query = new URLSearchParams({
			parent_id: parentIdentifier,
		});
		const response = await this.requestJson<WorkflowyListNodesResponse>(`/nodes?${query.toString()}`);
		return [...response.nodes].sort((left, right) => left.priority - right.priority);
	}

	async getNodeTree(rawIdentifier: string, options: { forceRefresh?: boolean } = {}): Promise<WorkflowyNode> {
		const identifier = normalizeWorkflowyIdentifier(rawIdentifier);
		const exportedNodes = await this.exportAllNodes(options.forceRefresh);
		const nodeIndex = this.createNodeIndex(exportedNodes);
		const targets = await this.listTargets();
		const matchingTarget = targets.find((target) => target.key.toLowerCase() === identifier.toLowerCase());

		if (matchingTarget) {
			const directChildren = await this.listNodes(matchingTarget.key);
			const children = directChildren.map((child) => this.cloneNodeTree(nodeIndex, child));
			return {
				id: matchingTarget.key,
				name: formatTargetLabel(matchingTarget.key, matchingTarget.name),
				note: null,
				priority: 0,
				parent_id: null,
				data: {
					layoutMode: "bullets",
				},
				createdAt: 0,
				modifiedAt: 0,
				completedAt: null,
				children,
			};
		}

		const resolvedNodeId = await this.resolveNodeIdentifier(identifier);
		const rootNode = nodeIndex.get(resolvedNodeId);
		if (rootNode) {
			return this.cloneNodeTree(nodeIndex, rootNode);
		}

		const fetchedNode = await this.getNode(resolvedNodeId);
		const children = await this.listNodes(fetchedNode.id);
		return {
			...fetchedNode,
			children,
		};
	}

	async createNode(options: {
		parentId: string;
		name: string;
		note?: string;
		position?: "top" | "bottom";
	}): Promise<string> {
		const payload = {
			parent_id: normalizeWorkflowyIdentifier(options.parentId),
			name: options.name,
			note: options.note,
			position: options.position ?? "top",
		};

		const response = await this.requestJson<WorkflowyCreateNodeResponse>("/nodes", {
			method: "POST",
			body: payload,
		});

		if (!response.item_id) {
			throw new Error("Workflowy did not return a node ID for the created item.");
		}

		this.invalidateCaches();
		return response.item_id;
	}

	async updateNode(options: {
		id: string;
		name?: string;
		note?: string;
		layoutMode?: string;
	}): Promise<void> {
		const response = await this.requestJson<WorkflowyStatusResponse>(`/nodes/${encodeURIComponent(options.id)}`, {
			method: "POST",
			body: {
				name: options.name,
				note: options.note,
				layoutMode: options.layoutMode,
			},
		});

		if (response.status !== "ok") {
			throw new Error("Workflowy did not confirm the node update.");
		}

		this.invalidateCaches();
	}

	async completeNode(id: string): Promise<void> {
		await this.requestBetaStatus("/complete-item/", {
			item_id: id,
		});
		this.invalidateCaches();
	}

	async uncompleteNode(id: string): Promise<void> {
		await this.requestBetaStatus("/uncomplete-item/", {
			item_id: id,
		});
		this.invalidateCaches();
	}

	async deleteNode(id: string): Promise<void> {
		await this.requestBetaStatus("/delete-item/", {
			item_id: id,
		});
		this.invalidateCaches();
	}

	async readLlmDocument(rawIdentifier: string, depth = 1): Promise<WorkflowyLlmNode> {
		const identifier = this.normalizeLlmReadIdentifier(rawIdentifier);
		const query = new URLSearchParams({
			depth: String(depth),
		});
		const response = await this.requestLlmJson<Record<string, unknown>>(`/read/${encodeURIComponent(identifier)}/?${query.toString()}`);
		return this.parseLlmNode(response);
	}

	async editLlmDocument(rootRef: string, operations: WorkflowyLlmEditOperation[]): Promise<void> {
		if (operations.length === 0) {
			return;
		}

		await this.requestLlmJson<Record<string, unknown>>("/edit", {
			method: "POST",
			body: {
				root: rootRef,
				operations,
			},
		});
		this.invalidateCaches();
	}

	private async requestJson<TResponse>(
		path: string,
		options: {
			method?: string;
			body?: Record<string, unknown>;
			baseUrl?: string;
		} = {},
	): Promise<TResponse> {
		if (!this.apiKey) {
			throw new Error("Missing Workflowy API key.");
		}

		for (let attempt = 0; attempt <= WorkflowyClient.maxRateLimitRetries; attempt += 1) {
			const response = await this.enqueueRequest(async () => (
				await requestUrl({
					url: `${options.baseUrl ?? this.apiBaseUrl}${path}`,
					method: options.method ?? "GET",
					headers: {
						Authorization: `Bearer ${this.apiKey}`,
					},
					contentType: "application/json",
					body: options.body ? JSON.stringify(this.compactObject(options.body)) : undefined,
					throw: false,
				})
			));

			if (response.status >= 400) {
				const errorMessage = this.extractErrorMessage(response.text);
				if (this.isRateLimitError(response.status, errorMessage) && attempt < WorkflowyClient.maxRateLimitRetries) {
					await this.sleep(WorkflowyClient.rateLimitRetryDelayMs * (attempt + 1));
					continue;
				}

				throw new Error(errorMessage);
			}

			return response.json as TResponse;
		}

		throw new Error("Workflowy API request failed after retrying.");
	}

	private async requestLlmJson<TResponse>(
		path: string,
		options: {
			method?: string;
			body?: Record<string, unknown>;
		} = {},
	): Promise<TResponse> {
		if (!this.apiKey) {
			throw new Error("Missing Workflowy API key.");
		}

		for (let attempt = 0; attempt <= WorkflowyClient.maxRateLimitRetries; attempt += 1) {
			const response = await this.enqueueRequest(async () => (
				await requestUrl({
					url: `${this.llmBaseUrl}${path}`,
					method: options.method ?? "GET",
					headers: {
						Authorization: `Token ${this.apiKey}`,
					},
					contentType: "application/json",
					body: options.body ? JSON.stringify(this.compactObject(options.body)) : undefined,
					throw: false,
				})
			));

			if (response.status >= 400) {
				const errorMessage = this.extractErrorMessage(response.text);
				if (this.isRateLimitError(response.status, errorMessage) && attempt < WorkflowyClient.maxRateLimitRetries) {
					await this.sleep(WorkflowyClient.rateLimitRetryDelayMs * (attempt + 1));
					continue;
				}

				throw new Error(errorMessage);
			}

			return response.json as TResponse;
		}

		throw new Error("Workflowy LLM API request failed after retrying.");
	}

	private async requestBetaStatus(path: string, body: Record<string, unknown>): Promise<void> {
		const response = await this.requestJson<WorkflowyStatusResponse>(
			path,
			{
				method: "POST",
				body,
				baseUrl: "https://beta.workflowy.com/api/beta",
			},
		);

		if (response.status !== "ok") {
			throw new Error("Workflowy did not confirm the requested change.");
		}
	}

	private async resolveNodeIdentifier(rawIdentifier: string): Promise<string> {
		const identifier = normalizeWorkflowyIdentifier(rawIdentifier);
		if (isWorkflowyFullNodeId(identifier)) {
			return identifier;
		}

		if (!isWorkflowyShortNodeId(identifier)) {
			return identifier;
		}

		const shortIdentifier = stripWorkflowyShortNodePrefix(identifier).toLowerCase();
		const matchingNode = await this.findNodeByShortIdentifier(shortIdentifier);
		if (matchingNode) {
			return matchingNode.id;
		}

		const directIdentifier = await this.tryResolveNodeIdentifierDirectly(identifier, shortIdentifier);
		if (directIdentifier) {
			return directIdentifier;
		}

		throw new Error("Could not resolve that Workflowy item URL. Try copying the item URL again or choose it from the picker.");
	}

	private async findNodeByShortIdentifier(shortIdentifier: string): Promise<WorkflowyNode | null> {
		for (const forceRefresh of [false, true]) {
			const exportedNodes = await this.exportAllNodes(forceRefresh);
			const matchingNode = exportedNodes.find((node) => node.id.toLowerCase().endsWith(shortIdentifier));
			if (matchingNode) {
				return matchingNode;
			}
		}

		return null;
	}

	private async exportAllNodes(forceRefresh = false): Promise<WorkflowyNode[]> {
		if (!forceRefresh && this.cachedExportedNodes) {
			return this.cachedExportedNodes;
		}

		const response = await this.requestJson<WorkflowyNodesExportResponse>("/nodes-export");
		this.cachedExportedNodes = response.nodes;
		return response.nodes;
	}

	private async tryResolveNodeIdentifierDirectly(
		identifier: string,
		shortIdentifier: string,
	): Promise<string | null> {
		for (const candidate of [identifier, shortIdentifier, `x${shortIdentifier}`]) {
			try {
				const response = await this.requestJson<WorkflowyNodeResponse>(`/nodes/${encodeURIComponent(candidate)}`);
				return response.node.id;
			} catch {
				// Try the next candidate.
			}
		}

		return null;
	}

	private normalizeLlmReadIdentifier(rawIdentifier: string): string {
		if (rawIdentifier === "None" || rawIdentifier.startsWith("target:")) {
			return rawIdentifier;
		}

		const identifier = normalizeWorkflowyIdentifier(rawIdentifier);
		if (identifier === "None" || identifier.startsWith("target:")) {
			return identifier;
		}

		if (isWorkflowyFullNodeId(identifier)) {
			return identifier.slice(-12).toLowerCase();
		}

		if (isWorkflowyShortNodeId(identifier)) {
			return stripWorkflowyShortNodePrefix(identifier).toLowerCase();
		}

		return identifier;
	}

	private parseLlmNode(value: Record<string, unknown>): WorkflowyLlmNode {
		const reservedKeys = new Set(["c", "l", "x", "m", "+", "ancestors"]);
		const rootEntry = Object.entries(value).find(([key, entryValue]) => !reservedKeys.has(key) && typeof entryValue === "string");
		if (!rootEntry) {
			throw new Error("Workflowy LLM API returned an unexpected document shape.");
		}

		const [ref, rawName] = rootEntry;
		const childValues = Array.isArray(value.c) ? value.c : [];

		return {
			ref,
			name: String(rawName),
			layoutMode: typeof value.l === "string" ? value.l : undefined,
			completed: value.x === 1,
			children: childValues
				.filter((child): child is Record<string, unknown> => typeof child === "object" && child !== null)
				.map((child) => this.parseLlmNode(child)),
		};
	}

	private async enqueueRequest<TResponse>(callback: () => Promise<TResponse>): Promise<TResponse> {
		const runRequest = async (): Promise<TResponse> => {
			const waitTime = Math.max(
				0,
				WorkflowyClient.minRequestIntervalMs - (Date.now() - WorkflowyClient.lastRequestAt),
			);
			if (waitTime > 0) {
				await this.sleep(waitTime);
			}

			const response = await callback();
			WorkflowyClient.lastRequestAt = Date.now();
			return response;
		};

		const queuedRequest = WorkflowyClient.requestQueue.then(runRequest, runRequest);
		WorkflowyClient.requestQueue = queuedRequest.then(
			() => undefined,
			() => undefined,
		);

		return await queuedRequest;
	}

	private compactObject(object: Record<string, unknown>): Record<string, unknown> {
		return Object.fromEntries(
			Object.entries(object).filter(([, value]) => value !== undefined),
		);
	}

	private createNodeIndex(flatNodes: WorkflowyNode[]): Map<string, WorkflowyNode> {
		const nodeIndex = new Map<string, WorkflowyNode>();
		const childrenIndex = new Map<string | null, WorkflowyNode[]>();

		for (const node of flatNodes) {
			nodeIndex.set(node.id, {
				...node,
				children: [],
			});
		}

		for (const node of flatNodes) {
			const parentId = node.parent_id ?? null;
			const siblings = childrenIndex.get(parentId) ?? [];
			siblings.push(node);
			childrenIndex.set(parentId, siblings);
		}

		for (const [parentId, children] of childrenIndex.entries()) {
			if (!parentId) {
				continue;
			}

			const parentNode = nodeIndex.get(parentId);
			if (!parentNode) {
				continue;
			}

			parentNode.children = [...children]
				.sort((left, right) => left.priority - right.priority)
				.map((child) => nodeIndex.get(child.id) ?? {
					...child,
					children: [],
				});
		}

		return nodeIndex;
	}

	private cloneNodeTree(nodeIndex: Map<string, WorkflowyNode>, node: WorkflowyNode): WorkflowyNode {
		const indexedNode = nodeIndex.get(node.id) ?? node;
		return {
			...indexedNode,
			children: (indexedNode.children ?? []).map((child) => this.cloneNodeTree(nodeIndex, child)),
		};
	}

	private invalidateCaches(): void {
		this.cachedExportedNodes = null;
	}

	private sleep(durationMs: number): Promise<void> {
		return new Promise((resolve) => {
			window.setTimeout(resolve, durationMs);
		});
	}

	private isRateLimitError(status: number, message: string): boolean {
		return status === 429 || /rate limit/i.test(message);
	}

	private extractErrorMessage(responseText: string): string {
		try {
			const parsed = JSON.parse(responseText) as { error?: string; message?: string };
			if (parsed.error) {
				return `Workflowy API error: ${parsed.error}`;
			}
			if (parsed.message) {
				return `Workflowy API error: ${parsed.message}`;
			}
		} catch {
			// Fall through to raw text handling.
		}

		if (responseText.trim()) {
			return `Workflowy API error: ${responseText.trim()}`;
		}

		return "Workflowy API request failed.";
	}
}
