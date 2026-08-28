import { describe, expect, test } from "bun:test";
import { contextMessages, MAX_RECORD_TEXT, MAX_TRANSCRIPT_RECORDS, normalizeTranscript } from "./transcript.ts";

describe("normalizeTranscript", () => {
	test("projects active context entries into messages and summaries", () => {
		expect(contextMessages([
			{ type: "message", message: { role: "user", content: "Original task" } },
			{ type: "model_change", model: "ignored" },
			{ type: "compaction", summary: "Earlier work was compacted.", timestamp: "2026-08-27T10:00:00Z" },
		])).toEqual([
			{ role: "user", content: "Original task" },
			{ role: "summary", content: "Earlier work was compacted.", timestamp: 1787824800000 },
		]);
	});

	test("keeps useful message and tool context while excluding thinking and images", () => {
		const records = normalizeTranscript([
			{ role: "user", content: "Inspect authentication", timestamp: 1 },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "private reasoning" },
					{ type: "text", text: "I found the handler." },
					{ type: "toolCall", name: "read", arguments: { path: "src/auth.ts" } },
					{ type: "image", data: "secret" },
				],
			},
			{ role: "toolResult", toolName: "read", content: [{ type: "text", text: "export function auth() {}" }] },
		]);

		expect(records).toEqual([
			{ sequence: 1, role: "user", text: "Inspect authentication", timestamp: 1 },
			{
				sequence: 2,
				role: "assistant",
				text: "I found the handler.\n[tool read] {\"path\":\"src/auth.ts\"}\n[image omitted]",
			},
			{ sequence: 3, role: "toolResult", text: "export function auth() {}", toolName: "read" },
		]);
		expect(JSON.stringify(records)).not.toContain("private reasoning");
		expect(JSON.stringify(records)).not.toContain("secret");
	});

	test("bounds record size and transcript length", () => {
		const messages = Array.from({ length: MAX_TRANSCRIPT_RECORDS + 5 }, (_, index) => ({
			role: "user",
			content: index === MAX_TRANSCRIPT_RECORDS + 4 ? "x".repeat(MAX_RECORD_TEXT + 10) : `message ${index}`,
		}));
		const records = normalizeTranscript(messages);
		expect(records).toHaveLength(MAX_TRANSCRIPT_RECORDS);
		expect(records[0].sequence).toBe(6);
		expect(records.at(-1)?.truncated).toBeTrue();
		expect(records.at(-1)?.text).toEndWith("[record truncated]");
	});

	test("projects oversized nested tool arguments before serialization", () => {
		const argumentsValue = {
			large: "x".repeat(1_000_000),
			array: Array.from({ length: 10_000 }, (_, index) => ({ index, nested: { value: index } })),
		};
		const records = normalizeTranscript([{
			role: "assistant",
			content: [{ type: "toolCall", name: "example", arguments: argumentsValue }],
		}]);
		expect(records).toHaveLength(1);
		expect(records[0].text.length).toBeLessThan(MAX_RECORD_TEXT);
		expect(records[0].text).toContain("items omitted");
		expect(records[0].text).not.toContain("x".repeat(10_000));
	});
});
