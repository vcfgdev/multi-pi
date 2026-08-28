import { execFile } from "node:child_process";
import { createPeerLauncher, peerPaneTitle, removePeerLauncher } from "./launcher.ts";

export interface CommandRunner {
	run(command: string, args: string[]): Promise<{ stdout: string }>;
}

export const defaultCommandRunner: CommandRunner = {
	run: (command, args) => new Promise((resolve, reject) => {
		execFile(command, args, { maxBuffer: 1024 * 1024 }, (error, stdout) => {
			if (error) reject(error);
			else resolve({ stdout });
		});
	}),
};

export interface SpawnPeerInput {
	prompt: string;
	parentSessionId?: string;
	cwd: string;
	name: string;
	direction?: "right" | "down";
	model?: string;
}

export async function spawnZellijPeer(
	input: SpawnPeerInput,
	runner: CommandRunner = defaultCommandRunner,
): Promise<{ paneId: string }> {
	if ((!process.env.ZELLIJ && !process.env.ZELLIJ_SESSION_NAME) || !process.env.ZELLIJ_PANE_ID) {
		throw new Error("pi-peer spawn requires a Zellij 0.45+ pane");
	}
	const versionOutput = (await runner.run("zellij", ["--version"])).stdout.trim();
	const version = /zellij\s+(\d+)\.(\d+)(?:\.(\d+))?/.exec(versionOutput);
	if (!version || Number(version[1]) === 0 && Number(version[2]) < 45) {
		throw new Error("pi-peer spawn requires Zellij 0.45 or newer");
	}
	const launcher = createPeerLauncher(input);
	const args = ["action", "new-pane", "--no-focus", "--close-on-exit", "--cwd", input.cwd, "--name", peerPaneTitle(input)];
	if (input.direction) args.push("--direction", input.direction);
	args.push("--", "sh", launcher.path);
	try {
		const result = await runner.run("zellij", args);
		const paneId = result.stdout.trim();
		if (!paneId) throw new Error("Zellij did not return the created pane ID; Zellij 0.45+ is required");
		return { paneId };
	} catch (error) {
		removePeerLauncher(launcher);
		throw error;
	}
}
