const FULL_NODE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const SHORT_NODE_ID_PATTERN = /^x?[0-9a-f]{12}$/i;
const SIMPLE_TARGET_PATTERN = /^[a-z0-9_-]+$/i;

export function normalizeWorkflowyIdentifier(rawInput: string): string {
	const trimmedInput = rawInput.trim();
	if (!trimmedInput) {
		throw new Error("Enter a Workflowy node URL, node ID, or target key.");
	}

	const uuidMatch = trimmedInput.match(UUID_PATTERN);
	if (uuidMatch) {
		return uuidMatch[0];
	}

	try {
		const parsedUrl = new URL(trimmedInput);
		for (const candidate of [parsedUrl.hash, parsedUrl.pathname]) {
			const identifier = extractIdentifierCandidate(decodeURIComponent(candidate));
			if (identifier) {
				return identifier;
			}
		}
	} catch {
		// Ignore URL parsing errors and fall back to raw input parsing.
	}

	if (SHORT_NODE_ID_PATTERN.test(trimmedInput)) {
		return trimmedInput;
	}

	if (SIMPLE_TARGET_PATTERN.test(trimmedInput)) {
		return trimmedInput;
	}

	throw new Error("Could not extract a Workflowy node ID or target key from that value.");
}

export function isWorkflowyFullNodeId(identifier: string): boolean {
	return FULL_NODE_ID_PATTERN.test(identifier);
}

export function isWorkflowyShortNodeId(identifier: string): boolean {
	return SHORT_NODE_ID_PATTERN.test(identifier);
}

export function stripWorkflowyShortNodePrefix(identifier: string): string {
	return identifier.toLowerCase().startsWith("x") && identifier.length === 13
		? identifier.slice(1)
		: identifier;
}

export function formatTargetLabel(identifier: string, name: string | null): string {
	if (name && name.trim()) {
		return name.trim();
	}

	return identifier
		.split(/[-_]/g)
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

function extractIdentifierCandidate(rawValue: string): string | null {
	const cleanedValue = rawValue.trim().replace(/^#\/?/, "");
	if (!cleanedValue) {
		return null;
	}

	const uuidMatch = cleanedValue.match(UUID_PATTERN);
	if (uuidMatch) {
		return uuidMatch[0];
	}

	const segments = cleanedValue.split(/[/?]/).filter(Boolean);
	const lastSegment = segments.at(-1);
	if (!lastSegment) {
		return null;
	}

	if (isWorkflowyShortNodeId(lastSegment)) {
		return lastSegment;
	}

	return SIMPLE_TARGET_PATTERN.test(lastSegment) ? lastSegment : null;
}
