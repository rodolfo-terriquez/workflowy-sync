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

interface CachedValue<TValue> {
	value: TValue;
	fetchedAt: number;
}

interface CachedSubtree extends CachedValue<WorkflowyNode> {
	complete: boolean;
}

interface WorkflowySnapshotCache {
	fetchedAt: number;
	nodesById: Map<string, WorkflowyNode>;
	childrenByParentId: Map<string | null, string[]>;
	idsByShortId: Map<string, string>;
}

type WorkflowyTreeFreshness = "cache-first" | "refresh-root" | "full-snapshot";

interface WorkflowyGetNodeTreeOptions {
	forceRefresh?: boolean;
	freshness?: WorkflowyTreeFreshness;
	allowFullSnapshotFallback?: boolean;
}

export interface WorkflowyLlmNode {
	ref: string;
	name: string;
	note: string | null;
	layoutMode?: string;
	completed: boolean;
	hasMoreChildren: boolean;
	children: WorkflowyLlmNode[];
}

export interface WorkflowyNodeSearchResult {
	identifier: string;
	label: string;
	path: string;
}

export interface WorkflowyLlmInsertItem {
	n: string;
	d?: string;
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
	private static readonly targetCacheTtlMs = 10 * 60 * 1000;
	private static readonly subtreeCacheTtlMs = 45 * 1000;
	private static readonly fullSnapshotTtlMs = 15 * 60 * 1000;
	private static readonly fullExportCooldownMs = 65 * 1000;
	private static readonly llmSubtreeDepth = 10;
	private static requestQueue: Promise<void> = Promise.resolve();
	private static lastRequestAt = 0;
	private static lastFullExportAt = 0;

	private readonly apiKey: string;
	private readonly apiBaseUrl = "https://workflowy.com/api/v1";
	private readonly llmBaseUrl = "https://beta.workflowy.com/api/llm/doc";
	private cachedTargets: CachedValue<WorkflowyTarget[]> | null = null;
	private fullSnapshotCache: WorkflowySnapshotCache | null = null;
	private readonly cachedSubtrees = new Map<string, CachedSubtree>();
	private readonly cachedChildrenLists = new Map<string, CachedValue<WorkflowyNode[]>>();
	private readonly inFlightRequests = new Map<string, Promise<unknown>>();

	constructor(apiKey: string) {
		this.apiKey = apiKey.trim();
	}

	async validateApiKey(): Promise<WorkflowyTarget[]> {
		return await this.listTargets();
	}

	primeSessionCacheInBackground(): void {
		void this.ensureFullSnapshot({
			allowStaleSnapshot: true,
			reason: "startup",
		}).catch(() => undefined);
	}

	async listTargets(options: { forceRefresh?: boolean } = {}): Promise<WorkflowyTarget[]> {
		const now = Date.now();
		if (!options.forceRefresh && this.cachedTargets && now - this.cachedTargets.fetchedAt < WorkflowyClient.targetCacheTtlMs) {
			return this.cachedTargets.value;
		}

		return await this.runSharedRequest("targets", async () => {
			const response = await this.requestJson<WorkflowyTargetsResponse>("/targets");
			this.cachedTargets = {
				value: response.targets,
				fetchedAt: Date.now(),
			};
			return response.targets;
		});
	}

	async getTargetLabel(identifier: string): Promise<string> {
		const resolvedTarget = await this.resolveTarget(identifier);
		return resolvedTarget.label;
	}

	async searchCachedNodes(query: string, limit = 20): Promise<WorkflowyNodeSearchResult[]> {
		const normalizedQuery = query.trim().toLowerCase();
		if (!normalizedQuery) {
			return [];
		}

		const candidates = new Map<string, WorkflowyNodeSearchResult & { score: number }>();
		const snapshot = this.fullSnapshotCache;
		if (snapshot) {
			for (const node of snapshot.nodesById.values()) {
				const result = this.scoreNodeSearchResult({
					identifier: node.id,
					label: node.name,
					note: node.note,
					path: this.buildNodePath(snapshot, node.id),
					depth: this.getNodeDepth(snapshot, node.id),
				}, normalizedQuery);
				if (result) {
					candidates.set(result.identifier, result);
				}
			}
		}

		for (const cachedSubtree of this.cachedSubtrees.values()) {
			this.collectSearchResultsFromTree(cachedSubtree.value, normalizedQuery, candidates, []);
		}

		return Array.from(candidates.values())
			.sort((left, right) => right.score - left.score || left.label.localeCompare(right.label))
			.slice(0, limit)
			.map(({ score: _score, ...result }) => result);
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
		const subtree = this.getCachedSubtree(identifier, { requireFresh: false });
		if (subtree) {
			return this.cloneNode(subtree.value);
		}

		const snapshotNode = this.getNodeFromSnapshot(identifier);
		if (snapshotNode) {
			return this.cloneNode(snapshotNode);
		}

		return await this.fetchSingleNode(identifier, { forceRefresh: false });
	}

	async listNodes(
		rawParentIdentifier: string,
		options: { forceRefresh?: boolean } = {},
	): Promise<WorkflowyNode[]> {
		const parentIdentifier = normalizeWorkflowyIdentifier(rawParentIdentifier);
		const cacheKey = this.getChildrenCacheKey(parentIdentifier);
		const now = Date.now();
		const cachedChildren = this.cachedChildrenLists.get(cacheKey);
		if (!options.forceRefresh && cachedChildren && now - cachedChildren.fetchedAt < WorkflowyClient.subtreeCacheTtlMs) {
			return cachedChildren.value.map((node) => this.cloneNode(node));
		}

		return await this.runSharedRequest(`children:${cacheKey}`, async () => {
			const query = new URLSearchParams({
				parent_id: parentIdentifier,
			});
			const response = await this.requestJson<WorkflowyListNodesResponse>(`/nodes?${query.toString()}`);
			const children = [...response.nodes].sort((left, right) => left.priority - right.priority);
			this.cachedChildrenLists.set(cacheKey, {
				value: children,
				fetchedAt: Date.now(),
			});
			this.replaceChildrenInSnapshot(parentIdentifier === "None" ? null : parentIdentifier, children);
			return children.map((node) => this.cloneNode(node));
		});
	}

	async getNodeTree(
		rawIdentifier: string,
		options: WorkflowyGetNodeTreeOptions = {},
	): Promise<WorkflowyNode> {
		const identifier = normalizeWorkflowyIdentifier(rawIdentifier);
		const freshness = options.freshness ?? (options.forceRefresh ? "refresh-root" : "cache-first");
		const allowFullSnapshotFallback = options.allowFullSnapshotFallback ?? true;
		const targets = await this.listTargets();
		const matchingTarget = targets.find((target) => target.key.toLowerCase() === identifier.toLowerCase());

		if (matchingTarget) {
			return await this.getTargetTree(matchingTarget, freshness, allowFullSnapshotFallback);
		}

		return await this.getNodeRootTree(identifier, freshness, allowFullSnapshotFallback);
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

		this.invalidateSubtreeCaches();
		void this.refreshNodeChildren(payload.parent_id).catch(() => undefined);
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

		this.invalidateSubtreeCaches();
		void this.refreshNode(options.id).catch(() => undefined);
	}

	async completeNode(id: string): Promise<void> {
		await this.requestBetaStatus("/complete-item/", {
			item_id: id,
		});
		this.invalidateSubtreeCaches();
		void this.refreshNode(id).catch(() => undefined);
	}

	async uncompleteNode(id: string): Promise<void> {
		await this.requestBetaStatus("/uncomplete-item/", {
			item_id: id,
		});
		this.invalidateSubtreeCaches();
		void this.refreshNode(id).catch(() => undefined);
	}

	async deleteNode(id: string): Promise<void> {
		const parentId = this.findCachedParentId(id);
		await this.requestBetaStatus("/delete-item/", {
			item_id: id,
		});
		this.removeNodeFromSnapshot(id);
		this.invalidateSubtreeCaches();
		if (parentId) {
			void this.refreshNodeChildren(parentId).catch(() => undefined);
		}
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
		this.invalidateSubtreeCaches();
		this.markSnapshotStale();
	}

	private async getNodeRootTree(
		identifier: string,
		freshness: WorkflowyTreeFreshness,
		allowFullSnapshotFallback: boolean,
	): Promise<WorkflowyNode> {
		if (freshness === "cache-first") {
			const cachedSubtree = this.getCachedSubtree(identifier, { requireFresh: true });
			if (cachedSubtree) {
				return this.cloneNode(cachedSubtree.value);
			}

			const staleSubtree = this.getCachedSubtree(identifier, { requireFresh: false });
			if (staleSubtree) {
				void this.fetchAndCacheSubtree(identifier).catch(() => undefined);
				return this.cloneNode(staleSubtree.value);
			}

			const snapshotTree = await this.getTreeFromSnapshot(identifier, { refreshIfStale: false });
			if (snapshotTree) {
				void this.fetchAndCacheSubtree(identifier).catch(() => undefined);
				return snapshotTree;
			}
		}

		try {
			const subtreeResult = await this.fetchAndCacheSubtree(identifier);
			if (subtreeResult.complete || !allowFullSnapshotFallback) {
				return this.cloneNode(subtreeResult.root);
			}
		} catch {
			const cachedSubtree = this.getCachedSubtree(identifier, { requireFresh: false });
			if (cachedSubtree) {
				return this.cloneNode(cachedSubtree.value);
			}
		}

		if (allowFullSnapshotFallback) {
			const snapshotTree = await this.getTreeFromSnapshot(identifier, {
				refreshIfStale: freshness !== "cache-first",
			});
			if (snapshotTree) {
				return snapshotTree;
			}
		}

		const cachedSubtree = this.getCachedSubtree(identifier, { requireFresh: false });
		if (cachedSubtree) {
			return this.cloneNode(cachedSubtree.value);
		}

		const fetchedNode = await this.fetchSingleNode(identifier, { forceRefresh: freshness !== "cache-first" });
		const children = await this.listNodes(fetchedNode.id, { forceRefresh: freshness !== "cache-first" });
		return {
			...fetchedNode,
			children,
		};
	}

	private async getTargetTree(
		target: WorkflowyTarget,
		freshness: WorkflowyTreeFreshness,
		allowFullSnapshotFallback: boolean,
	): Promise<WorkflowyNode> {
		if (freshness === "cache-first") {
			const cachedSubtree = this.getCachedSubtree(target.key, { requireFresh: true });
			if (cachedSubtree) {
				return this.normalizeTargetRoot(target, cachedSubtree.value);
			}

			const staleSubtree = this.getCachedSubtree(target.key, { requireFresh: false });
			if (staleSubtree) {
				void this.fetchAndCacheSubtree(target.key).catch(() => undefined);
				return this.normalizeTargetRoot(target, staleSubtree.value);
			}
		}

		try {
			const subtreeResult = await this.fetchAndCacheSubtree(target.key);
			if (subtreeResult.complete || !allowFullSnapshotFallback) {
				return this.normalizeTargetRoot(target, subtreeResult.root);
			}
		} catch {
			const cachedSubtree = this.getCachedSubtree(target.key, { requireFresh: false });
			if (cachedSubtree) {
				return this.normalizeTargetRoot(target, cachedSubtree.value);
			}
		}

		const directChildren = await this.listNodes(target.key, { forceRefresh: freshness !== "cache-first" });
		return {
			id: target.key,
			name: formatTargetLabel(target.key, target.name),
			note: null,
			priority: 0,
			parent_id: null,
			data: {
				layoutMode: "bullets",
			},
			createdAt: 0,
			modifiedAt: 0,
			completedAt: null,
			children: directChildren.map((child) => this.cloneNode(child)),
		};
	}

	private normalizeTargetRoot(target: WorkflowyTarget, subtreeRoot: WorkflowyNode): WorkflowyNode {
		return {
			...this.cloneNode(subtreeRoot),
			id: target.key,
			name: formatTargetLabel(target.key, target.name),
			parent_id: null,
		};
	}

	private getCachedSubtree(
		identifier: string,
		options: { requireFresh: boolean },
	): CachedSubtree | null {
		const now = Date.now();
		for (const cacheKey of this.getSubtreeLookupKeys(identifier)) {
			const cachedSubtree = this.cachedSubtrees.get(cacheKey);
			if (!cachedSubtree) {
				continue;
			}
			if (!options.requireFresh || now - cachedSubtree.fetchedAt < WorkflowyClient.subtreeCacheTtlMs) {
				return cachedSubtree;
			}
		}

		return null;
	}

	private getSubtreeLookupKeys(identifier: string): string[] {
		const normalizedIdentifier = normalizeWorkflowyIdentifier(identifier);
		const keys = new Set<string>([normalizedIdentifier]);
		if (isWorkflowyFullNodeId(normalizedIdentifier)) {
			keys.add(normalizedIdentifier.slice(-12).toLowerCase());
		}
		if (isWorkflowyShortNodeId(normalizedIdentifier)) {
			keys.add(stripWorkflowyShortNodePrefix(normalizedIdentifier).toLowerCase());
		}
		return [...keys];
	}

	private cacheSubtree(identifier: string, subtree: WorkflowyNode, complete: boolean): void {
		const cachedSubtree: CachedSubtree = {
			value: this.cloneNode(subtree),
			fetchedAt: Date.now(),
			complete,
		};

		for (const cacheKey of this.getSubtreeLookupKeys(identifier)) {
			this.cachedSubtrees.set(cacheKey, cachedSubtree);
		}
		for (const cacheKey of this.getSubtreeLookupKeys(subtree.id)) {
			this.cachedSubtrees.set(cacheKey, cachedSubtree);
		}
	}

	private invalidateSubtreeCaches(): void {
		this.cachedSubtrees.clear();
	}

	private markSnapshotStale(): void {
		if (!this.fullSnapshotCache) {
			return;
		}

		this.fullSnapshotCache = {
			...this.fullSnapshotCache,
			fetchedAt: 0,
		};
	}

	private async fetchAndCacheSubtree(identifier: string): Promise<{ root: WorkflowyNode; complete: boolean }> {
		return await this.runSharedRequest(`subtree:${identifier}`, async () => {
			const llmRoot = await this.readLlmDocument(identifier, WorkflowyClient.llmSubtreeDepth);
			const subtreeRoot = this.buildWorkflowyTreeFromLlm(identifier, llmRoot, null, true);
			const complete = !this.llmTreeHasTruncation(llmRoot);
			this.cacheSubtree(identifier, subtreeRoot, complete);
			return {
				root: subtreeRoot,
				complete,
			};
		});
	}

	private buildWorkflowyTreeFromLlm(
		requestedIdentifier: string,
		node: WorkflowyLlmNode,
		parentId: string | null,
		isRoot: boolean,
	): WorkflowyNode {
		const normalizedRequestedIdentifier = normalizeWorkflowyIdentifier(requestedIdentifier);
		const nodeId = isRoot && isWorkflowyFullNodeId(normalizedRequestedIdentifier)
			? normalizedRequestedIdentifier
			: node.ref;
		const workflowyNode: WorkflowyNode = {
			id: nodeId,
			name: node.name,
			note: node.note,
			priority: 0,
			parent_id: parentId,
			data: {
				layoutMode: node.layoutMode,
			},
			createdAt: 0,
			modifiedAt: 0,
			completedAt: node.completed ? 1 : null,
			completed: node.completed,
			children: [],
		};

		workflowyNode.children = node.children.map((child, index) => ({
			...this.buildWorkflowyTreeFromLlm(child.ref, child, workflowyNode.id, false),
			priority: index,
		}));
		return workflowyNode;
	}

	private llmTreeHasTruncation(node: WorkflowyLlmNode): boolean {
		if (node.hasMoreChildren) {
			return true;
		}

		return node.children.some((child) => this.llmTreeHasTruncation(child));
	}

	private async ensureFullSnapshot(options: {
		allowStaleSnapshot: boolean;
		refreshIfStale?: boolean;
		reason: string;
	}): Promise<WorkflowySnapshotCache | null> {
		const snapshotFresh = Boolean(
			this.fullSnapshotCache
			&& Date.now() - this.fullSnapshotCache.fetchedAt < WorkflowyClient.fullSnapshotTtlMs,
		);
		if (snapshotFresh) {
			return this.fullSnapshotCache;
		}

		if (!options.refreshIfStale && this.fullSnapshotCache) {
			return this.fullSnapshotCache;
		}

		try {
			return await this.runSharedRequest("full-snapshot", async () => {
				const now = Date.now();
				const waitMs = Math.max(0, WorkflowyClient.fullExportCooldownMs - (now - WorkflowyClient.lastFullExportAt));
				if (waitMs > 0) {
					await this.sleep(waitMs);
				}

				const response = await this.requestJson<WorkflowyNodesExportResponse>("/nodes-export");
				WorkflowyClient.lastFullExportAt = Date.now();
				this.fullSnapshotCache = this.buildSnapshotCache(response.nodes);
				return this.fullSnapshotCache;
			});
		} catch {
			if (options.allowStaleSnapshot && this.fullSnapshotCache) {
				return this.fullSnapshotCache;
			}
			return null;
		}
	}

	private buildSnapshotCache(flatNodes: WorkflowyNode[]): WorkflowySnapshotCache {
		const nodesById = new Map<string, WorkflowyNode>();
		const childrenByParentId = new Map<string | null, string[]>();
		const idsByShortId = new Map<string, string>();

		for (const node of flatNodes) {
			nodesById.set(node.id, {
				...node,
				children: [],
			});
			const shortId = this.getShortIdKey(node.id);
			if (shortId) {
				idsByShortId.set(shortId, node.id);
			}
		}

		for (const node of flatNodes) {
			const parentId = node.parent_id ?? null;
			const siblingIds = childrenByParentId.get(parentId) ?? [];
			siblingIds.push(node.id);
			childrenByParentId.set(parentId, siblingIds);
		}

		for (const siblingIds of childrenByParentId.values()) {
			siblingIds.sort((leftId, rightId) => {
				const leftNode = nodesById.get(leftId);
				const rightNode = nodesById.get(rightId);
				return (leftNode?.priority ?? 0) - (rightNode?.priority ?? 0);
			});
		}

		return {
			fetchedAt: Date.now(),
			nodesById,
			childrenByParentId,
			idsByShortId,
		};
	}

	private async getTreeFromSnapshot(
		identifier: string,
		options: { refreshIfStale: boolean },
	): Promise<WorkflowyNode | null> {
		const snapshot = await this.ensureFullSnapshot({
			allowStaleSnapshot: true,
			refreshIfStale: options.refreshIfStale,
			reason: `tree:${identifier}`,
		});
		if (!snapshot) {
			return null;
		}

		const snapshotId = this.resolveSnapshotNodeId(identifier);
		if (!snapshotId) {
			return null;
		}

		return this.cloneNodeTreeFromSnapshot(snapshot, snapshotId);
	}

	private resolveSnapshotNodeId(identifier: string): string | null {
		const normalizedIdentifier = normalizeWorkflowyIdentifier(identifier);
		if (this.fullSnapshotCache?.nodesById.has(normalizedIdentifier)) {
			return normalizedIdentifier;
		}

		const shortId = this.getShortIdKey(normalizedIdentifier);
		if (!shortId) {
			return null;
		}

		return this.fullSnapshotCache?.idsByShortId.get(shortId) ?? null;
	}

	private getNodeFromSnapshot(identifier: string): WorkflowyNode | null {
		const snapshotId = this.resolveSnapshotNodeId(identifier);
		if (!snapshotId) {
			return null;
		}
		const node = this.fullSnapshotCache?.nodesById.get(snapshotId);
		return node ? this.cloneNode(node) : null;
	}

	private cloneNodeTreeFromSnapshot(snapshot: WorkflowySnapshotCache, nodeId: string): WorkflowyNode | null {
		const node = snapshot.nodesById.get(nodeId);
		if (!node) {
			return null;
		}

		const childIds = snapshot.childrenByParentId.get(node.id) ?? [];
		return {
			...node,
			children: childIds
				.map((childId) => this.cloneNodeTreeFromSnapshot(snapshot, childId))
				.filter((child): child is WorkflowyNode => child !== null),
		};
	}

	private buildNodePath(snapshot: WorkflowySnapshotCache, nodeId: string): string {
		const parts: string[] = [];
		let currentId: string | null = nodeId;
		while (currentId) {
			const currentNode = snapshot.nodesById.get(currentId);
			if (!currentNode) {
				break;
			}
			parts.unshift(currentNode.name.trim() || currentNode.id);
			currentId = currentNode.parent_id ?? null;
		}

		return parts.join(" > ");
	}

	private scoreNodeSearchResult(
		node: {
			identifier: string;
			label: string;
			note: string | null;
			path: string;
			depth: number;
		},
		normalizedQuery: string,
	): (WorkflowyNodeSearchResult & { score: number }) | null {
		const label = node.label.trim();
		const note = node.note?.trim() ?? "";
		const haystack = `${label}\n${note}`.toLowerCase();
		if (!haystack.includes(normalizedQuery)) {
			return null;
		}

		let score = 0;
		if (label.toLowerCase() === normalizedQuery) {
			score += 120;
		} else if (label.toLowerCase().startsWith(normalizedQuery)) {
			score += 90;
		} else if (label.toLowerCase().includes(normalizedQuery)) {
			score += 60;
		} else {
			score += 25;
		}
		if (note.toLowerCase().includes(normalizedQuery)) {
			score += 10;
		}
		score -= node.depth;

		return {
			identifier: node.identifier,
			label: label || node.identifier,
			path: node.path,
			score,
		};
	}

	private collectSearchResultsFromTree(
		node: WorkflowyNode,
		normalizedQuery: string,
		results: Map<string, WorkflowyNodeSearchResult & { score: number }>,
		ancestorLabels: string[],
	): void {
		const result = this.scoreNodeSearchResult({
			identifier: node.id,
			label: node.name,
			note: node.note,
			path: [...ancestorLabels, node.name.trim() || node.id].join(" > "),
			depth: ancestorLabels.length,
		}, normalizedQuery);
		if (result) {
			const existingResult = results.get(result.identifier);
			if (!existingResult || result.score > existingResult.score) {
				results.set(result.identifier, result);
			}
		}

		const nextAncestorLabels = [...ancestorLabels, node.name.trim() || node.id];
		for (const child of node.children ?? []) {
			this.collectSearchResultsFromTree(child, normalizedQuery, results, nextAncestorLabels);
		}
	}

	private getNodeDepth(snapshot: WorkflowySnapshotCache, nodeId: string): number {
		let depth = 0;
		let currentId = nodeId;
		while (true) {
			const currentNode = snapshot.nodesById.get(currentId);
			const parentId = currentNode?.parent_id ?? null;
			if (!parentId) {
				return depth;
			}
			depth += 1;
			currentId = parentId;
		}
	}

	private replaceChildrenInSnapshot(parentId: string | null, children: WorkflowyNode[]): void {
		const snapshot = this.ensureSnapshotCache();
		const normalizedParentId = parentId ?? null;
		const existingChildIds = snapshot.childrenByParentId.get(normalizedParentId) ?? [];
		const nextChildIds = children.map((child) => child.id);
		const nextChildIdSet = new Set(nextChildIds);

		for (const existingChildId of existingChildIds) {
			if (!nextChildIdSet.has(existingChildId)) {
				this.removeNodeAndDescendantsFromSnapshot(snapshot, existingChildId);
			}
		}

		snapshot.childrenByParentId.set(normalizedParentId, nextChildIds);
		for (const child of children) {
			this.upsertNodeInSnapshot(snapshot, child, normalizedParentId);
		}
		snapshot.fetchedAt = Date.now();
	}

	private upsertNodeInSnapshot(
		snapshot: WorkflowySnapshotCache,
		node: WorkflowyNode,
		parentIdOverride?: string | null,
	): void {
		const existingNode = snapshot.nodesById.get(node.id);
		const normalizedParentId = parentIdOverride !== undefined ? parentIdOverride : (node.parent_id ?? existingNode?.parent_id ?? null);
		snapshot.nodesById.set(node.id, {
			...existingNode,
			...node,
			parent_id: normalizedParentId,
			children: [],
		});

		const shortId = this.getShortIdKey(node.id);
		if (shortId) {
			snapshot.idsByShortId.set(shortId, node.id);
		}
	}

	private ensureSnapshotCache(): WorkflowySnapshotCache {
		if (!this.fullSnapshotCache) {
			this.fullSnapshotCache = {
				fetchedAt: 0,
				nodesById: new Map<string, WorkflowyNode>(),
				childrenByParentId: new Map<string | null, string[]>(),
				idsByShortId: new Map<string, string>(),
			};
		}

		return this.fullSnapshotCache;
	}

	private removeNodeFromSnapshot(identifier: string): void {
		if (!this.fullSnapshotCache) {
			return;
		}

		const snapshotId = this.resolveSnapshotNodeId(identifier) ?? identifier;
		this.removeNodeAndDescendantsFromSnapshot(this.fullSnapshotCache, snapshotId);
		for (const [parentId, childIds] of this.fullSnapshotCache.childrenByParentId.entries()) {
			if (!childIds.includes(snapshotId)) {
				continue;
			}
			this.fullSnapshotCache.childrenByParentId.set(parentId, childIds.filter((childId) => childId !== snapshotId));
		}
	}

	private removeNodeAndDescendantsFromSnapshot(snapshot: WorkflowySnapshotCache, nodeId: string): void {
		const childIds = snapshot.childrenByParentId.get(nodeId) ?? [];
		for (const childId of childIds) {
			this.removeNodeAndDescendantsFromSnapshot(snapshot, childId);
		}

		snapshot.childrenByParentId.delete(nodeId);
		const shortId = this.getShortIdKey(nodeId);
		if (shortId) {
			snapshot.idsByShortId.delete(shortId);
		}
		snapshot.nodesById.delete(nodeId);
	}

	private async refreshNode(identifier: string): Promise<void> {
		await this.runSharedRequest(`refresh-node:${identifier}`, async () => {
			const node = await this.fetchSingleNode(identifier, { forceRefresh: true });
			const snapshot = this.ensureSnapshotCache();
			this.upsertNodeInSnapshot(snapshot, node);
			snapshot.fetchedAt = Date.now();
		});
	}

	private async refreshNodeChildren(parentIdentifier: string): Promise<void> {
		const normalizedParentIdentifier = normalizeWorkflowyIdentifier(parentIdentifier);
		await this.runSharedRequest(`refresh-children:${normalizedParentIdentifier}`, async () => {
			const children = await this.listNodes(normalizedParentIdentifier, { forceRefresh: true });
			this.replaceChildrenInSnapshot(normalizedParentIdentifier === "None" ? null : normalizedParentIdentifier, children);
		});
	}

	private findCachedParentId(identifier: string): string | null {
		const normalizedIdentifier = normalizeWorkflowyIdentifier(identifier);
		const snapshotId = this.resolveSnapshotNodeId(normalizedIdentifier);
		if (snapshotId) {
			return this.fullSnapshotCache?.nodesById.get(snapshotId)?.parent_id ?? null;
		}

		const subtreeNode = this.findNodeInCachedSubtrees(normalizedIdentifier);
		return subtreeNode?.parent_id ?? null;
	}

	private findNodeInCachedSubtrees(identifier: string): WorkflowyNode | null {
		for (const cachedSubtree of this.cachedSubtrees.values()) {
			const matchingNode = this.findNodeInTree(cachedSubtree.value, identifier);
			if (matchingNode) {
				return matchingNode;
			}
		}
		return null;
	}

	private findNodeInTree(rootNode: WorkflowyNode, identifier: string): WorkflowyNode | null {
		if (rootNode.id === identifier) {
			return rootNode;
		}
		const shortId = this.getShortIdKey(identifier);
		if (shortId && this.getShortIdKey(rootNode.id) === shortId) {
			return rootNode;
		}
		for (const child of rootNode.children ?? []) {
			const matchingChild = this.findNodeInTree(child, identifier);
			if (matchingChild) {
				return matchingChild;
			}
		}
		return null;
	}

	private getShortIdKey(identifier: string): string | null {
		if (isWorkflowyFullNodeId(identifier)) {
			return identifier.slice(-12).toLowerCase();
		}
		if (isWorkflowyShortNodeId(identifier)) {
			return stripWorkflowyShortNodePrefix(identifier).toLowerCase();
		}
		return null;
	}

	private getChildrenCacheKey(parentIdentifier: string): string {
		return normalizeWorkflowyIdentifier(parentIdentifier);
	}

	private async fetchSingleNode(
		rawIdentifier: string,
		options: { forceRefresh: boolean },
	): Promise<WorkflowyNode> {
		const identifier = await this.resolveNodeIdentifier(rawIdentifier);
		if (!options.forceRefresh) {
			const snapshotNode = this.getNodeFromSnapshot(identifier);
			if (snapshotNode) {
				return snapshotNode;
			}
		}

		return await this.runSharedRequest(`node:${identifier}`, async () => {
			const response = await this.requestJson<WorkflowyNodeResponse>(`/nodes/${encodeURIComponent(identifier)}`);
			const snapshot = this.ensureSnapshotCache();
			this.upsertNodeInSnapshot(snapshot, response.node);
			snapshot.fetchedAt = Date.now();
			return response.node;
		});
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
		const directIdentifier = await this.tryResolveNodeIdentifierDirectly(identifier, shortIdentifier);
		if (directIdentifier) {
			return directIdentifier;
		}

		const snapshotMatch = this.fullSnapshotCache?.idsByShortId.get(shortIdentifier);
		if (snapshotMatch) {
			return snapshotMatch;
		}

		throw new Error("Could not resolve that Workflowy item URL. Try copying the item URL again or choose it from the picker.");
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
		const reservedKeys = new Set(["c", "d", "l", "x", "m", "+", "ancestors"]);
		const rootEntry = Object.entries(value).find(([key, entryValue]) => !reservedKeys.has(key) && typeof entryValue === "string");
		if (!rootEntry) {
			throw new Error("Workflowy LLM API returned an unexpected document shape.");
		}

		const [ref, rawName] = rootEntry;
		const childValues = Array.isArray(value.c) ? value.c : [];

		return {
			ref,
			name: String(rawName),
			note: typeof value.d === "string" ? value.d : null,
			layoutMode: typeof value.l === "string" ? value.l : undefined,
			completed: value.x === 1,
			hasMoreChildren: value["+"] === 1,
			children: childValues
				.filter((child): child is Record<string, unknown> => typeof child === "object" && child !== null)
				.map((child) => this.parseLlmNode(child)),
		};
	}

	private async runSharedRequest<TResponse>(requestKey: string, callback: () => Promise<TResponse>): Promise<TResponse> {
		const inFlightRequest = this.inFlightRequests.get(requestKey) as Promise<TResponse> | undefined;
		if (inFlightRequest) {
			return await inFlightRequest;
		}

		const requestPromise = callback().finally(() => {
			this.inFlightRequests.delete(requestKey);
		});
		this.inFlightRequests.set(requestKey, requestPromise as Promise<unknown>);
		return await requestPromise;
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

	private cloneNode(node: WorkflowyNode): WorkflowyNode {
		return {
			...node,
			children: (node.children ?? []).map((child) => this.cloneNode(child)),
		};
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
