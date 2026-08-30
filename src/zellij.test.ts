import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { PeerPaneCleanupError } from "./protocol.ts";
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
		let spawned = false;
		const result = await spawnZellijPeer({
			prompt: "Review auth and report with pi-peer send.",
			parentSessionId: "parent-session",
			cwd: "/workspace/project",
			name: "auth-review",
			piArgs: ["--model", "sonnet:high"],
		}, {
			async run(command, args) {
				invocations.push({ command, args });
				if (args[0] === "--version") return { stdout: "zellij 0.45.1\n" };
				if (args[1] === "list-panes") return { stdout: JSON.stringify([
					{ id: 7, is_plugin: false, is_floating: false, tab_id: 1, pane_x: 0, pane_y: 0 },
					...(spawned ? [{ id: 4, is_plugin: false, is_floating: false, tab_id: 1, pane_x: 80, pane_y: 0 }] : []),
				]) };
				if (args[0] === "run") spawned = true;
				return { stdout: "terminal_4\n" };
			},
		});

		expect(result).toEqual({ paneId: "terminal_4" });
		expect(invocations[0]).toEqual({ command: "zellij", args: ["--version"] });
		const invocation = invocations[2];
		expect(invocation?.command).toBe("zellij");
		expect(invocation?.args.slice(0, -2)).toEqual([
			"run", "--no-focus", "--close-on-exit", "--cwd", "/workspace/project", "--name", "auth-review",
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
		let spawned = false;
		await spawnZellijPeer({ prompt: "task", parentSessionId: "parent", cwd: "/tmp", name: "worker" }, {
			async run(_command, args, options) {
				calls.push(args);
				if (args[0] === "--version") return { stdout: "zellij 0.45.1\n" };
				if (args[1] === "list-panes") return { stdout: JSON.stringify([
					{ id: 7, is_plugin: false, is_floating: false, tab_id: 1, pane_x: 0, pane_y: 0, pane_rows: 60 },
					{ id: 8, is_plugin: false, is_floating: false, tab_id: 1, pane_x: 80, pane_y: 0, pane_rows: 20 },
					{ id: 9, is_plugin: false, is_floating: false, tab_id: 1, pane_x: 80, pane_y: 20, pane_rows: 20 },
					...(spawned ? [{ id: 10, is_plugin: false, is_floating: false, tab_id: 1, pane_x: 80, pane_y: 40, pane_rows: 20 }] : []),
				]) };
				if (args[0] === "run") {
					spawnEnvironment = options?.env;
					spawned = true;
				}
				return { stdout: args[0] === "run" ? "terminal_10\n" : "" };
			},
		});
		expect(calls[2][0]).toBe("run");
		expect(calls[2]).toContain("--direction");
		expect(calls[2]).toContain("down");
		expect(spawnEnvironment?.ZELLIJ_PANE_ID).toBe("9");
		rmSync(dirname(calls[2].at(-1)!), { recursive: true, force: true });
	});

	test("places peers below the main pane after four right-column peers", async () => {
		process.env.ZELLIJ = "1";
		process.env.ZELLIJ_PANE_ID = "7";
		const calls: string[][] = [];
		let spawnEnvironment: NodeJS.ProcessEnv | undefined;
		let spawned = false;
		await spawnZellijPeer({ prompt: "task", parentSessionId: "parent", cwd: "/tmp", name: "worker" }, {
			async run(_command, args, options) {
				calls.push(args);
				if (args[0] === "--version") return { stdout: "zellij 0.45.1\n" };
				if (args[1] === "list-panes") return { stdout: JSON.stringify([
					{ id: 7, is_plugin: false, is_floating: false, tab_id: 1, pane_x: 0, pane_y: 0, pane_rows: 30 },
					{ id: 8, is_plugin: false, is_floating: false, tab_id: 1, pane_x: 80, pane_y: 0 },
					{ id: 9, is_plugin: false, is_floating: false, tab_id: 1, pane_x: 80, pane_y: 10 },
					{ id: 10, is_plugin: false, is_floating: false, tab_id: 1, pane_x: 80, pane_y: 20 },
					{ id: 11, is_plugin: false, is_floating: false, tab_id: 1, pane_x: 80, pane_y: 30 },
					{ id: 12, is_plugin: false, is_floating: false, tab_id: 1, pane_x: 0, pane_y: 30, pane_rows: 30 },
					...(spawned ? [{ id: 13, is_plugin: false, is_floating: false, tab_id: 1, pane_x: 0, pane_y: 60, pane_rows: 30 }] : []),
				]) };
				if (args[0] === "run") {
					spawnEnvironment = options?.env;
					spawned = true;
				}
				return { stdout: args[0] === "run" ? "terminal_13\n" : "" };
			},
		});
		expect(calls[2]).toContain("down");
		expect(spawnEnvironment?.ZELLIJ_PANE_ID).toBe("12");
		rmSync(dirname(calls[2].at(-1)!), { recursive: true, force: true });
	});

	test("balances the selected column after creating a pane", async () => {
		process.env.ZELLIJ = "1";
		process.env.ZELLIJ_PANE_ID = "7";
		const calls: string[][] = [];
		let spawned = false;
		const rightColumn = [
			{ id: 8, is_plugin: false, is_floating: false, tab_id: 1, pane_x: 80, pane_y: 0, pane_rows: 40 },
			{ id: 9, is_plugin: false, is_floating: false, tab_id: 1, pane_x: 80, pane_y: 40, pane_rows: 20 },
			{ id: 10, is_plugin: false, is_floating: false, tab_id: 1, pane_x: 80, pane_y: 60, pane_rows: 20 },
		];
		await spawnZellijPeer({ prompt: "task", parentSessionId: "parent", cwd: "/tmp", name: "worker" }, {
			async run(_command, args) {
				calls.push(args);
				if (args[0] === "--version") return { stdout: "zellij 0.45.1\n" };
				if (args[1] === "list-panes") {
					return { stdout: JSON.stringify(spawned ? [
						{ id: 7, is_plugin: false, is_floating: false, tab_id: 1, pane_x: 0, pane_y: 0, pane_rows: 80 },
						...rightColumn,
					] : [
						{ id: 7, is_plugin: false, is_floating: false, tab_id: 1, pane_x: 0, pane_y: 0, pane_rows: 80 },
						{ id: 8, is_plugin: false, is_floating: false, tab_id: 1, pane_x: 80, pane_y: 0, pane_rows: 40 },
						{ id: 9, is_plugin: false, is_floating: false, tab_id: 1, pane_x: 80, pane_y: 40, pane_rows: 40 },
					]) };
				}
				if (args[0] === "run") {
					spawned = true;
					return { stdout: "terminal_10\n" };
				}
				if (args[1] === "resize") {
					const paneId = Number(args.at(-1)?.replace("terminal_", ""));
					const index = rightColumn.findIndex((pane) => pane.id === paneId);
					const pane = rightColumn[index]!;
					const next = rightColumn[index + 1]!;
					const delta = args[2] === "increase" ? 4 : -4;
					pane.pane_rows += delta;
					next.pane_y += delta;
					next.pane_rows -= delta;
				}
				return { stdout: "" };
			},
		});
		const resizeCalls = calls.filter((args) => args[1] === "resize");
		expect(resizeCalls.length).toBeGreaterThan(0);
		const heights = rightColumn.map((pane) => pane.pane_rows);
		expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(5);
		const launcherPath = calls.find((args) => args[0] === "run")!.at(-1)!;
		rmSync(dirname(launcherPath), { recursive: true, force: true });
	});

	test("reports when a pane cannot be closed after balancing fails", async () => {
		process.env.ZELLIJ = "1";
		process.env.ZELLIJ_PANE_ID = "7";
		let spawned = false;
		const calls: string[][] = [];
		const operation = spawnZellijPeer({ prompt: "task", cwd: "/tmp", name: "worker" }, {
			async run(_command, args) {
				calls.push(args);
				if (args[0] === "--version") return { stdout: "zellij 0.45.1" };
				if (args[1] === "list-panes") return { stdout: spawned ? "invalid" : JSON.stringify([
					{ id: 7, is_plugin: false, is_floating: false, tab_id: 1, pane_x: 0, pane_y: 0 },
				]) };
				if (args[0] === "run") {
					spawned = true;
					return { stdout: "terminal_8" };
				}
				if (args[1] === "close-pane") throw new Error("close failed");
				return { stdout: "" };
			},
		});
		expect(operation).rejects.toBeInstanceOf(PeerPaneCleanupError);
		expect(operation).rejects.toThrow("Zellij pane terminal_8 still exists");
		expect(calls).toContainEqual(["action", "close-pane", "--pane-id", "terminal_8"]);
	});
});
