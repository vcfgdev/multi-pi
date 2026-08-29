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
		}, { async run(_command, args) {
			if (args[0] === "--version") return { stdout: "zellij 0.45.0\n" };
			if (args[1] === "list-panes") return { stdout: JSON.stringify([
				{ id: 7, is_plugin: false, is_floating: false, tab_id: 1, pane_x: 0, pane_y: 0 },
			]) };
			return { stdout: "" };
		} })).rejects.toThrow("Zellij 0.45+");
	});

	test("adds default peers below the bottom-most pane in the right column", async () => {
		process.env.ZELLIJ = "1";
		process.env.ZELLIJ_PANE_ID = "7";
		const calls: string[][] = [];
		let spawnEnvironment: NodeJS.ProcessEnv | undefined;
		await spawnZellijPeer({ prompt: "task", parentSessionId: "parent", cwd: "/tmp", name: "worker" }, {
			async run(_command, args, options) {
				calls.push(args);
				if (args[0] === "--version") return { stdout: "zellij 0.45.1\n" };
				if (args[1] === "list-panes") return { stdout: JSON.stringify([
					{ id: 7, is_plugin: false, is_floating: false, tab_id: 1, pane_x: 0, pane_y: 0 },
					{ id: 8, is_plugin: false, is_floating: false, tab_id: 1, pane_x: 80, pane_y: 0 },
					{ id: 9, is_plugin: false, is_floating: false, tab_id: 1, pane_x: 80, pane_y: 20 },
				]) };
				if (args[1] === "new-pane") spawnEnvironment = options?.env;
				return { stdout: args[1] === "new-pane" ? "terminal_10\n" : "" };
			},
		});
		expect(calls[2]).toContain("--direction");
		expect(calls[2]).toContain("down");
		expect(spawnEnvironment?.ZELLIJ_PANE_ID).toBe("9");
		rmSync(dirname(calls[2].at(-1)!), { recursive: true, force: true });
	});
});
