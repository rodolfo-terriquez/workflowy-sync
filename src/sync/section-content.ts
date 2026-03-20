export const WORKFLOWY_SYNC_START_MARKER = "<!-- workflowy-sync:start -->";
export const WORKFLOWY_SYNC_END_MARKER = "<!-- workflowy-sync:end -->";

export interface HeadingSectionMatch {
	startLine: number;
	endLine: number;
	level: number;
}

export function extractSyncSectionMarkdown(markdown: string, sectionHeading: string): string {
	const lines = markdown.replace(/\r\n/g, "\n").split("\n");
	const match = findHeadingSection(lines, sectionHeading);
	if (!match) {
		throw new Error(`Could not find the "${sectionHeading}" section in the destination note.`);
	}

	const sectionLines = lines.slice(match.startLine + 1, match.endLine);
	const managedRange = findManagedRange(sectionLines);
	if (!managedRange) {
		return sectionLines.join("\n").trim();
	}

	return sectionLines.slice(managedRange.start + 1, managedRange.end).join("\n").trim();
}

export function upsertSyncSection(
	existingContent: string,
	sectionHeading: string,
	renderedBody: string,
): string {
	const normalizedContent = existingContent.replace(/\r\n/g, "\n");
	const lines = normalizedContent.split("\n");
	const match = findHeadingSection(lines, sectionHeading);
	const sectionLevel = match?.level ?? chooseNewSectionLevel(normalizedContent);
	const renderedSection = renderManagedSection(
		sectionHeading,
		sectionLevel,
		renderedBody,
		match ? lines.slice(match.startLine + 1, match.endLine) : [],
	);

	if (!match) {
		return joinMarkdownParts([normalizedContent, renderedSection]);
	}

	const beforeSection = lines.slice(0, match.startLine).join("\n");
	const afterSection = lines.slice(match.endLine).join("\n");
	return joinMarkdownParts([beforeSection, renderedSection, afterSection]);
}

export function findHeadingSection(
	lines: string[],
	sectionHeading: string,
): HeadingSectionMatch | null {
	const normalizedTarget = normalizeHeadingText(sectionHeading);
	if (!normalizedTarget) {
		return null;
	}

	for (let index = 0; index < lines.length; index += 1) {
		const heading = parseHeadingLine(lines[index] ?? "");
		if (!heading || normalizeHeadingText(heading.text) !== normalizedTarget) {
			continue;
		}

		let endLine = lines.length;
		for (let candidateIndex = index + 1; candidateIndex < lines.length; candidateIndex += 1) {
			const nextHeading = parseHeadingLine(lines[candidateIndex] ?? "");
			if (nextHeading && nextHeading.level <= heading.level) {
				endLine = candidateIndex;
				break;
			}
		}

		return {
			startLine: index,
			endLine,
			level: heading.level,
		};
	}

	return null;
}

export function chooseNewSectionLevel(existingContent: string): number {
	return existingContent.trim().length > 0 ? 2 : 1;
}

export function clampHeadingLevel(level: number): number {
	return Math.max(1, Math.min(6, level));
}

export function normalizeHeadingText(value: string): string {
	return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function renderManagedSection(
	sectionHeading: string,
	sectionLevel: number,
	renderedBody: string,
	existingSectionLines: string[],
): string {
	const headingLine = `${"#".repeat(clampHeadingLevel(sectionLevel))} ${sectionHeading.trim()}`;
	const managedRange = findManagedRange(existingSectionLines);
	const preservedBefore = managedRange ? existingSectionLines.slice(0, managedRange.start).join("\n").trim() : "";
	const preservedAfter = managedRange ? existingSectionLines.slice(managedRange.end + 1).join("\n").trim() : existingSectionLines.join("\n").trim();
	const managedBlock = [
		WORKFLOWY_SYNC_START_MARKER,
		renderedBody.trim(),
		WORKFLOWY_SYNC_END_MARKER,
	].filter((part) => part.length > 0).join("\n");

	return joinMarkdownParts([headingLine, preservedBefore, managedBlock, preservedAfter]);
}

function findManagedRange(lines: string[]): { start: number; end: number } | null {
	const start = lines.findIndex((line) => line.trim() === WORKFLOWY_SYNC_START_MARKER);
	if (start === -1) {
		return null;
	}

	const end = lines.findIndex((line, index) => index > start && line.trim() === WORKFLOWY_SYNC_END_MARKER);
	if (end === -1) {
		return null;
	}

	return { start, end };
}

function joinMarkdownParts(parts: string[]): string {
	const normalizedParts = parts
		.map((part) => part.trim())
		.filter((part) => part.length > 0);

	return normalizedParts.length > 0 ? `${normalizedParts.join("\n\n")}\n` : "";
}

function parseHeadingLine(line: string): { level: number; text: string } | null {
	const match = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
	if (!match) {
		return null;
	}

	return {
		level: match[1]?.length ?? 1,
		text: match[2] ?? "",
	};
}
