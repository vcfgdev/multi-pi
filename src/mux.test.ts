import { describe, expect, test } from "bun:test";
import { closePeerPane } from "./mux.ts";
import type { PeerRegistration } from "./protocol.ts";

function peer(kind: "cmux" | "zellij" | "tmux", session?: string): PeerRegistration {
	return {
		version: 2,
		endpointId: "11111111-1111-4111-8111-111111111111",
		sessionId: `${kind}-peer`,
		pid: process.pid,
		cwd: "/workspace/project",
		workspace: "project",
		startedAt: "2026-08-29T00:00:00Z",
		heartbeatAt: "2026-08-29T00:00:01Z",
		activity: "idle",
		activeTools: [],
		mux: { kind, ...(session ? { session } : {}), paneId: kind === "cmux" ? "surface:2" : kind === "zellij" ? "7" : "%3" },
		transcript: [],
	};
}

describe("closePeerPane", () => {
	test("closes the registered cmux, Zellij, and tmux pane", async () => {
		const calls: Array<{ command: string; args: string[] }> = [];
		const runner = {
			async run(command: string, args: string[]) {
				calls.push({ command, args });
				return { stdout: "" };
			},
		};
		await closePeerPane(peer("cmux", "workspace:1"), runner);
		await closePeerPane(peer("zellij", "pi-work"), runner);
		await closePeerPane(peer("tmux"), runner);
		expect(calls).toEqual([
			{ command: "cmux", args: ["close-surface", "--workspace", "workspace:1", "--surface", "surface:2"] },
			{ command: "zellij", args: ["--session", "pi-work", "action", "close-pane", "--pane-id", "7"] },
			{ command: "tmux", args: ["kill-pane", "-t", "%3"] },
		]);
	});

	test("rejects peers without a registered pane", async () => {
		const registration = peer("tmux");
		delete registration.mux;
		expect(closePeerPane(registration)).rejects.toThrow("no live terminal pane");
	});
});
