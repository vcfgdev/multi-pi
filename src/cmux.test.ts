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
			direction: "down",
			model: "sonnet:high",
		}, {
			async run(command, args) {
				invocations.push({ command, args });
				if (args[0] === "rpc") {
					const parameters = JSON.parse(args[2]);
					launcherPath = parameters.initial_command.match(/^sh '([^']+)'$/)?.[1];
				}
				return {
					stdout: args[0] === "rpc"
						? JSON.stringify({ result: { surface_id: "surface:2" } })
						: "",
				};
			},
		});

		expect(result).toEqual({ paneId: "surface:2" });
		expect(invocations).toHaveLength(2);
		expect(invocations[0].command).toBe("cmux");
		expect(invocations[0].args.slice(0, 2)).toEqual(["rpc", "surface.split"]);
		expect(JSON.parse(invocations[0].args[2])).toMatchObject({
			workspace_id: "workspace:1",
			surface_id: "surface:1",
			direction: "down",
			type: "terminal",
			working_directory: "/workspace/project",
			focus: false,
		});
		expect(invocations[1]).toEqual({ command: "cmux", args: ["rename-tab", "--surface", "surface:2", "auth-review"] });
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
});
