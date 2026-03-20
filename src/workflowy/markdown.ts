export function sanitizeWorkflowyContent(markdown: string): string {
	const normalizedMarkdown = markdown.replace(/\u00A0/g, " ");
	return convertMarkdownLinksToHtml(normalizedMarkdown);
}

function convertMarkdownLinksToHtml(markdown: string): string {
	let output = "";
	let index = 0;

	while (index < markdown.length) {
		if (markdown[index] !== "[") {
			output += markdown[index];
			index += 1;
			continue;
		}

		const textEnd = findMatchingBracket(markdown, index, "[", "]");
		if (textEnd === -1 || markdown[textEnd + 1] !== "(") {
			output += markdown[index];
			index += 1;
			continue;
		}

		const destinationEnd = findMatchingBracket(markdown, textEnd + 1, "(", ")");
		if (destinationEnd === -1) {
			output += markdown[index];
			index += 1;
			continue;
		}

		const linkText = markdown.slice(index + 1, textEnd);
		const rawDestination = markdown.slice(textEnd + 2, destinationEnd);
		const href = extractLinkHref(rawDestination);
		if (!href) {
			output += markdown.slice(index, destinationEnd + 1);
			index = destinationEnd + 1;
			continue;
		}

		output += `<a href="${escapeHtmlAttribute(href)}">${linkText}</a>`;
		index = destinationEnd + 1;
	}

	return output;
}

function findMatchingBracket(value: string, startIndex: number, openChar: string, closeChar: string): number {
	let depth = 0;

	for (let index = startIndex; index < value.length; index += 1) {
		const char = value[index];
		const previousChar = index > startIndex ? value[index - 1] : "";
		if (previousChar === "\\") {
			continue;
		}

		if (char === openChar) {
			depth += 1;
			continue;
		}

		if (char === closeChar) {
			depth -= 1;
			if (depth === 0) {
				return index;
			}
		}
	}

	return -1;
}

function extractLinkHref(rawDestination: string): string | null {
	const trimmedDestination = rawDestination.trim();
	if (!trimmedDestination) {
		return null;
	}

	if (trimmedDestination.startsWith("<") && trimmedDestination.endsWith(">")) {
		return trimmedDestination.slice(1, -1).trim();
	}

	let insideAngleBrackets = false;
	let escapeNext = false;
	for (let index = 0; index < trimmedDestination.length; index += 1) {
		const char = trimmedDestination[index];
		if (char === undefined) {
			continue;
		}
		if (escapeNext) {
			escapeNext = false;
			continue;
		}

		if (char === "\\") {
			escapeNext = true;
			continue;
		}

		if (char === "<") {
			insideAngleBrackets = true;
			continue;
		}

		if (char === ">") {
			insideAngleBrackets = false;
			continue;
		}

		if (!insideAngleBrackets && /\s/.test(char)) {
			return trimmedDestination.slice(0, index).replace(/\\([()])/g, "$1");
		}
	}

	return trimmedDestination.replace(/\\([()])/g, "$1");
}

function escapeHtmlAttribute(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}
