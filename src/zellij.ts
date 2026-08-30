import { execFile } from "node:child_process";
import { createPeerLauncher, peerPaneTitle, removePeerLauncher } from "./launcher.ts";
import type { SpawnPeerInput } from "./mux.ts";

export interface CommandRunner {
	run(command: string, args: string[], options?: { env?: NodeJS.ProcessEnv }): Promise<{ stdout: string }>;
}

export const defaultCommandRunner: CommandRunner = {
	run: (command, args, options) => new Promise((resolve, reject) => {
		execFile(command, args, { maxBuffer: 1024 * 1024, ...options }, (error, stdout) => {
			if (error) reject(error);
			else resolve({ stdout });
		});
	}),
};

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
	let anchorPaneId: number | undefined;
	let direction: "right" | "down" = "right";
	const panes = JSON.parse((await runner.run("zellij", ["action", "list-panes", "--json"])).stdout) as Array<{
		id: number;
		is_plugin: boolean;
		is_floating: boolean;
		tab_id: number;
		pane_x: number;
		pane_y: number;
	}>;
	const sourceId = Number(process.env.ZELLIJ_PANE_ID);
	const source = panes.find((pane) => !pane.is_plugin && pane.id === sourceId);
	const rightColumn = source
		? panes.filter((pane) => !pane.is_plugin && !pane.is_floating && pane.tab_id === source.tab_id && pane.pane_x > source.pane_x)
			.sort((a, b) => b.pane_y - a.pane_y)
		: [];
	if (rightColumn[0]) {
		anchorPaneId = rightColumn[0].id;
		direction = "down";
	}
	const launcher = createPeerLauncher(input);
	const args = ["action", "new-pane", "--no-focus", "--close-on-exit", "--cwd", input.cwd, "--name", peerPaneTitle(input)];
	args.push("--direction", direction);
	args.push("--", "sh", launcher.path);
	try {
		const result = await runner.run("zellij", args, anchorPaneId === undefined ? undefined : {
			env: { ...process.env, ZELLIJ_PANE_ID: String(anchorPaneId) },
		});
		const paneId = result.stdout.trim();
		if (!paneId) throw new Error("Zellij did not return the created pane ID; Zellij 0.45+ is required");
		return { paneId };
	} catch (error) {
		removePeerLauncher(launcher);
		throw error;
	}
}
