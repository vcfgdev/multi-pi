export const MAX_TRANSCRIPT_RECORDS = 100;
export const MAX_RECORD_TEXT = 16 * 1024;
const MAX_STRUCTURED_DEPTH = 6;
const MAX_COLLECTION_ENTRIES = 50;
const MAX_STRUCTURED_STRING = 4 * 1024;

export interface PeerTranscriptRecord {
	sequence: number;
	role: string;
	text: string;
	timestamp?: number;
	toolName?: string;
	isError?: boolean;
	truncated?: boolean;
}

export function contextMessages(entries: unknown[]): unknown[] {
	const messages: unknown[] = [];
	for (const raw of entries) {
		if (!raw || typeof raw !== "object") continue;
		const entry = raw as Record<string, unknown>;
		if (entry.type === "message" && entry.message) {
			messages.push(entry.message);
		} else if (entry.type === "compaction" && typeof entry.summary === "string") {
			messages.push({ role: "summary", content: entry.summary, timestamp: Date.parse(String(entry.timestamp ?? "")) });
		} else if (entry.type === "branch_summary" && typeof entry.summary === "string") {
			messages.push({ role: "summary", content: entry.summary, timestamp: Date.parse(String(entry.timestamp ?? "")) });
		}
	}
	return messages;
}

function project(value: unknown, depth: number, seen: WeakSet<object>): unknown {
	if (value === null || typeof value === "boolean" || typeof value === "number") return value;
	if (typeof value === "string") {
		return value.length > MAX_STRUCTURED_STRING ? `${value.slice(0, MAX_STRUCTURED_STRING)}…` : value;
	}
	if (typeof value === "bigint") return String(value);
	if (typeof value !== "object") return `[${typeof value}]`;
	if (seen.has(value)) return "[circular]";
	if (depth >= MAX_STRUCTURED_DEPTH) return "[depth omitted]";
	seen.add(value);
	try {
		if (Array.isArray(value)) {
			const items = value.slice(0, MAX_COLLECTION_ENTRIES).map((item) => project(item, depth + 1, seen));
			if (value.length > MAX_COLLECTION_ENTRIES) items.push(`[${value.length - MAX_COLLECTION_ENTRIES} items omitted]`);
			return items;
		}
		const output: Record<string, unknown> = {};
		let count = 0;
		for (const name in value as Record<string, unknown>) {
			if (!Object.hasOwn(value, name)) continue;
			if (count >= MAX_COLLECTION_ENTRIES) {
				output["…"] = "[entries omitted]";
				break;
			}
			try {
				output[name] = project((value as Record<string, unknown>)[name], depth + 1, seen);
			} catch {
				output[name] = "[unreadable]";
			}
			count += 1;
		}
		return output;
	} finally {
		seen.delete(value);
	}
}

function stringify(value: unknown): string {
	try {
		return JSON.stringify(project(value, 0, new WeakSet()));
	} catch {
		return "[unserializable]";
	}
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return content == null ? "" : stringify(content);
	const parts: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const item = part as Record<string, unknown>;
		switch (item.type) {
			case "text":
				if (typeof item.text === "string") parts.push(item.text);
				break;
			case "toolCall":
				parts.push(`[tool ${String(item.name ?? "unknown")}] ${stringify(item.arguments ?? item.args ?? {})}`);
				break;
			case "image":
				parts.push("[image omitted]");
				break;
			// Thinking is deliberately excluded from cross-session inspection.
		}
	}
	return parts.join("\n");
}

export function normalizeTranscript(messages: unknown[]): PeerTranscriptRecord[] {
	const records: PeerTranscriptRecord[] = [];
	for (let index = 0; index < messages.length; index += 1) {
		const raw = messages[index];
		if (!raw || typeof raw !== "object") continue;
		const message = raw as Record<string, unknown>;
		const role = typeof message.role === "string" ? message.role : "unknown";
		let text = contentText(message.content);
		if (!text && role === "assistant") continue;
		const truncated = text.length > MAX_RECORD_TEXT;
		if (truncated) text = `${text.slice(0, MAX_RECORD_TEXT)}\n[record truncated]`;
		records.push({
			sequence: index + 1,
			role,
			text,
			...(typeof message.timestamp === "number" ? { timestamp: message.timestamp } : {}),
			...(typeof message.toolName === "string" ? { toolName: message.toolName } : {}),
			...(typeof message.isError === "boolean" ? { isError: message.isError } : {}),
			...(truncated ? { truncated: true } : {}),
		});
	}
	return records.slice(-MAX_TRANSCRIPT_RECORDS);
}
