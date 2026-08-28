import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { spawnZellijPeer } from "./zellij.ts";

const originalZellij = process.env.ZELLIJ;
const originalZellijPaneId = process.env.ZELLIJ_PANE_ID;

afterEach(() => {
	if (originalZellij === undefined) delete process.env.ZELLIJ;
	else process.env.ZELLIJ = originalZellij;
	if (originalZellijPaneId === undefined) delete process.env.ZELLIJ_PANE_ID;
	else process.env.ZELLIJ_PANE_ID = originalZellijPaneId;
});

describe("spawnZellijPeer", () => {
	test("opens an interactive Pi pane with parent routing metadata", async () => {
		process.env.ZELLIJ = "1";
		process.env.ZELLIJ_PANE_ID = "7";
		const invocations: Array<{ command: string; args: string[] }> = [];
		const result = await spawnZellijPeer({
			prompt: "Review auth and report with pi-peer send.",
			parentSessionId: "parent-session",
			cwd: "/workspace/project",
			name: "auth-review",
			direction: "right",
			model: "sonnet:high",
		}, {
			async run(command, args) {
				invocations.push({ command, args });
				if (args[0] === "--version") return { stdout: "zellij 0.45.1\n" };
				return { stdout: "terminal_4\n" };
			},
		});

		expect(result).toEqual({ paneId: "terminal_4" });
		expect(invocations[0]).toEqual({ command: "zellij", args: ["--version"] });
		const invocation = invocations[1];
		expect(invocation?.command).toBe("zellij");
		expect(invocation?.args.slice(0, -2)).toEqual([
			"action", "new-pane", "--no-focus", "--close-on-exit", "--cwd", "/workspace/project", "--name", "auth-review",
			"--direction", "right", "--",
		]);
		expect(invocation?.args.at(-2)).toBe("sh");
		const launcherPath = invocation!.args.at(-1)!;
		const launcher = readFileSync(launcherPath, "utf8");
		expect(launcher).toContain("'PI_PEER_PARENT=parent-session'");
		expect(launcher).toContain("'PI_PEER_TASK_ID=auth-review'");
		expect(launcher).not.toContain("ZELLIJ_PANE_ID=");
		rmSync(dirname(launcherPath), { recursive: true, force: true });
	});

	test("fails clearly outside Zellij", async () => {
		delete process.env.ZELLIJ;
		delete process.env.ZELLIJ_SESSION_NAME;
		delete process.env.ZELLIJ_PANE_ID;
		expect(spawnZellijPeer({
			prompt: "task",
			parentSessionId: "parent",
			cwd: "/tmp",
			name: "worker",
		})).rejects.toThrow("Zellij 0.45+");
	});

	test("rejects old versions and empty pane IDs", async () => {
		process.env.ZELLIJ = "1";
		process.env.ZELLIJ_PANE_ID = "7";
		const input = {
			prompt: "task",
			parentSessionId: "parent",
			cwd: "/tmp",
			name: "worker",
		};
		expect(spawnZellijPeer(input, {
			async run() { return { stdout: "zellij 0.44.0\n" }; },
		})).rejects.toThrow("0.45 or newer");
		expect(spawnZellijPeer({
			prompt: "task",
			parentSessionId: "parent",
			cwd: "/tmp",
			name: "worker",
		}, { async run(_command, args) { return { stdout: args[0] === "--version" ? "zellij 0.45.0\n" : "" }; } })).rejects.toThrow("Zellij 0.45+");
	});
});
