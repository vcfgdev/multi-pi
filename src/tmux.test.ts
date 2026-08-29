import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { spawnTmuxPeer } from "./tmux.ts";

const originalTmux = process.env.TMUX;
const originalTmuxPane = process.env.TMUX_PANE;
const originalStateDirectory = process.env.MULTI_PI_STATE_DIR;

afterEach(() => {
	if (originalTmux === undefined) delete process.env.TMUX;
	else process.env.TMUX = originalTmux;
	if (originalTmuxPane === undefined) delete process.env.TMUX_PANE;
	else process.env.TMUX_PANE = originalTmuxPane;
	if (originalStateDirectory === undefined) delete process.env.MULTI_PI_STATE_DIR;
	else process.env.MULTI_PI_STATE_DIR = originalStateDirectory;
});

describe("spawnTmuxPeer", () => {
	test("opens an unfocused interactive Pi pane with parent routing metadata", async () => {
		process.env.TMUX = "/tmp/tmux/default,1,0";
		process.env.TMUX_PANE = "%1";
		process.env.MULTI_PI_STATE_DIR = "/tmp/peer state";
		const invocations: Array<{ command: string; args: string[] }> = [];
		const result = await spawnTmuxPeer({
			prompt: "Review auth and report with pi-peer send.",
			parentSessionId: "parent-session",
			cwd: "/workspace/project",
			name: "auth-review",
			direction: "down",
			model: "sonnet:high",
		}, {
			async run(command, args) {
				invocations.push({ command, args });
				return { stdout: invocations.length === 1 ? "%4\n" : "" };
			},
		});

		expect(result).toEqual({ paneId: "%4" });
		expect(invocations).toHaveLength(2);
		expect(invocations[0].command).toBe("tmux");
		expect(invocations[0].args.slice(0, -2)).toEqual([
			"split-window", "-d", "-P", "-F", "#{pane_id}", "-c", "/workspace/project",
			"-t", "%1", "-v", "--",
		]);
		expect(invocations[0].args.at(-2)).toBe("sh");
		const launcherPath = invocations[0].args.at(-1)!;
		const launcher = readFileSync(launcherPath, "utf8");
		expect(launcher).toContain(`'PATH=${process.env.PATH}'`);
		expect(launcher).toContain("'MULTI_PI_STATE_DIR=/tmp/peer state'");
		expect(launcher).toContain("'PI_PEER_PARENT_SESSION_ID=parent-session'");
		expect(launcher).toContain("'PI_PEER_PARENT=parent-session'");
		expect(launcher).toContain("'PI_PEER_TASK_ID=auth-review'");
		expect(launcher).not.toContain("TMUX_PANE=");
		expect(launcher).toContain("'--model' 'sonnet:high'");
		expect(invocations[1]).toEqual({ command: "tmux", args: ["select-pane", "-t", "%4", "-T", "auth-review"] });
		rmSync(dirname(launcherPath), { recursive: true, force: true });
	});

	test("defaults to a right-hand pane and fails clearly outside tmux", async () => {
		process.env.TMUX = "/tmp/tmux/default,1,0";
		process.env.TMUX_PANE = "%1";
		const calls: string[][] = [];
		await spawnTmuxPeer({
			prompt: "task",
			parentSessionId: "parent",
			cwd: "/tmp",
			name: "worker",
		}, {
			async run(_command, args) {
				calls.push(args);
				if (args[0] === "list-panes") return { stdout: "%1\t0\t0\n" };
				return { stdout: args[0] === "split-window" ? "%2" : "" };
			},
		});
		expect(calls[1]).toContain("-h");
		expect(calls[2]).toEqual(["select-pane", "-t", "%2", "-T", "worker"]);
		rmSync(dirname(calls[1].at(-1)!), { recursive: true, force: true });

		delete process.env.TMUX;
		expect(spawnTmuxPeer({
			prompt: "task",
			parentSessionId: "parent",
			cwd: "/tmp",
			name: "worker",
		})).rejects.toThrow("inside tmux");
	});

	test("adds default peers below the bottom-most pane in the right column", async () => {
		process.env.TMUX = "/tmp/tmux/default,1,0";
		process.env.TMUX_PANE = "%1";
		const calls: string[][] = [];
		await spawnTmuxPeer({ prompt: "task", parentSessionId: "parent", cwd: "/tmp", name: "worker" }, {
			async run(_command, args) {
				calls.push(args);
				if (args[0] === "list-panes") return { stdout: "%1\t0\t0\n%2\t80\t0\n%3\t80\t20\n" };
				return { stdout: args[0] === "split-window" ? "%4" : "" };
			},
		});
		expect(calls[1]).toContain("-t");
		expect(calls[1]).toContain("%3");
		expect(calls[1]).toContain("-v");
		rmSync(dirname(calls[1].at(-1)!), { recursive: true, force: true });
	});
});
