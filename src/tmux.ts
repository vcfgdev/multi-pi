import { createPeerLauncher, peerPaneTitle, removePeerLauncher } from "./launcher.ts";
import { type CommandRunner, defaultCommandRunner, type SpawnPeerInput } from "./zellij.ts";

export async function spawnTmuxPeer(
	input: SpawnPeerInput,
	runner: CommandRunner = defaultCommandRunner,
): Promise<{ paneId: string }> {
	if (!process.env.TMUX) {
		throw new Error("pi-peer spawn must run inside tmux");
	}
	const launcher = createPeerLauncher(input);
	const args = ["split-window", "-d", "-P", "-F", "#{pane_id}", "-c", input.cwd];
	if (process.env.TMUX_PANE) args.push("-t", process.env.TMUX_PANE);
	args.push(input.direction === "down" ? "-v" : "-h");
	args.push("--", "sh", launcher.path);
	try {
		const result = await runner.run("tmux", args);
		const paneId = result.stdout.trim();
		if (!paneId) throw new Error("tmux did not return the created pane ID");
		await runner.run("tmux", ["select-pane", "-t", paneId, "-T", peerPaneTitle(input)]);
		return { paneId };
	} catch (error) {
		removePeerLauncher(launcher);
		throw error;
	}
}
