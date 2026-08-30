import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { spawnCmuxPeer } from "./cmux.ts";

const originalEnvironment = {
	socket: process.env.CMUX_SOCKET_PATH,
	workspace: process.env.CMUX_WORKSPACE_ID,
	surface: process.env.CMUX_SURFACE_ID,
};

afterEach(() => {
	for (const [name, value] of Object.entries({
		CMUX_SOCKET_PATH: originalEnvironment.socket,
		CMUX_WORKSPACE_ID: originalEnvironment.workspace,
		CMUX_SURFACE_ID: originalEnvironment.surface,
	})) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
});

describe("spawnCmuxPeer", () => {
	test("opens an unfocused interactive Pi surface with parent routing metadata", async () => {
		process.env.CMUX_SOCKET_PATH = "/tmp/cmux.sock";
		process.env.CMUX_WORKSPACE_ID = "workspace:1";
		process.env.CMUX_SURFACE_ID = "surface:1";
		const invocations: Array<{ command: string; args: string[] }> = [];
		let launcherPath: string | undefined;
		const result = await spawnCmuxPeer({
			prompt: "Review auth; preserve 'quotes' and report with pi-peer send.",
			parentSessionId: "parent-session",
			cwd: "/workspace/project",
			name: "auth-review",
			piArgs: ["--model", "sonnet:high"],
		}, {
			async run(command, args) {
				invocations.push({ command, args });
				if (args[1] === "surface.list") return { stdout: JSON.stringify({ surfaces: [
					{ ref: "surface:1", pane_ref: "pane:1" },
				] }) };
				if (args[1] === "pane.list") return { stdout: JSON.stringify({ panes: [
					{ ref: "pane:1", pixel_frame: { x: 0, y: 0 }, selected_surface_ref: "surface:1" },
				] }) };
				if (args[1] === "surface.split") {
					const parameters = JSON.parse(args[2]);
					launcherPath = parameters.initial_command.match(/^sh '([^']+)'$/)?.[1];
					return { stdout: JSON.stringify({ result: { surface_id: "surface:2" } }) };
				}
				return { stdout: "" };
			},
		});

		expect(result).toEqual({ paneId: "surface:2" });
		expect(invocations).toHaveLength(4);
		expect(invocations[2].command).toBe("cmux");
		expect(invocations[2].args.slice(0, 2)).toEqual(["rpc", "surface.split"]);
		expect(JSON.parse(invocations[2].args[2])).toMatchObject({
			workspace_id: "workspace:1",
			surface_id: "surface:1",
			direction: "right",
			type: "terminal",
			working_directory: "/workspace/project",
			focus: false,
		});
		expect(invocations[3]).toEqual({ command: "cmux", args: ["rename-tab", "--surface", "surface:2", "auth-review"] });
		expect(invocations.flatMap(({ args }) => args)).not.toContain("send");
		expect(launcherPath).toBeDefined();
		const launcher = readFileSync(launcherPath!, "utf8");
		expect(launcher).toContain(`'PATH=${process.env.PATH}'`);
		expect(launcher).toContain("'PI_PEER_PARENT=parent-session'");
		expect(launcher).toContain("'PI_PEER_TASK_ID=auth-review'");
		expect(launcher).toContain("'--model' 'sonnet:high'");
		expect(launcher).toContain("'Review auth; preserve '\\''quotes'\\'' and report with pi-peer send.'");
		expect(launcher).not.toContain("CMUX_SURFACE_ID=");
		expect(launcher).toContain("cd '/workspace/project' || exit 1");
		expect(existsSync(launcherPath!)).toBe(true);
		rmSync(dirname(launcherPath!), { recursive: true, force: true });
	});

	test("fails clearly outside cmux", async () => {
		delete process.env.CMUX_SOCKET_PATH;
		delete process.env.CMUX_WORKSPACE_ID;
		delete process.env.CMUX_SURFACE_ID;
		expect(spawnCmuxPeer({
			prompt: "task",
			parentSessionId: "parent",
			cwd: "/tmp",
			name: "worker",
		})).rejects.toThrow("inside a cmux surface");
	});

	test("adds default peers below the bottom-most pane in the right column", async () => {
		process.env.CMUX_SOCKET_PATH = "/tmp/cmux.sock";
		process.env.CMUX_WORKSPACE_ID = "workspace:1";
		process.env.CMUX_SURFACE_ID = "surface:1";
		const calls: string[][] = [];
		await spawnCmuxPeer({ prompt: "task", parentSessionId: "parent", cwd: "/tmp", name: "worker" }, {
			async run(_command, args) {
				calls.push(args);
				if (args[1] === "surface.list") return { stdout: JSON.stringify({ surfaces: [
					{ ref: "surface:1", pane_ref: "pane:1" },
				] }) };
				if (args[1] === "pane.list") return { stdout: JSON.stringify({ panes: [
					{ ref: "pane:1", pixel_frame: { x: 0, y: 0 }, selected_surface_ref: "surface:1" },
					{ ref: "pane:2", pixel_frame: { x: 800, y: 0 }, selected_surface_ref: "surface:2" },
					{ ref: "pane:3", pixel_frame: { x: 800, y: 400 }, selected_surface_ref: "surface:3" },
				] }) };
				return { stdout: args[1] === "surface.split" ? JSON.stringify({ result: { surface_ref: "surface:4" } }) : "" };
			},
		});
		expect(JSON.parse(calls[2][2])).toMatchObject({ surface_id: "surface:3", direction: "down", focus: false });
		const launcherPath = JSON.parse(calls[2][2]).initial_command.match(/^sh '([^']+)'$/)?.[1];
		rmSync(dirname(launcherPath), { recursive: true, force: true });
	});
});
