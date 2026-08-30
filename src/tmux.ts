import { createPeerLauncher, peerPaneTitle, removePeerLauncher } from "./launcher.ts";
import type { SpawnPeerInput } from "./mux.ts";
import { MAX_RIGHT_COLUMN_PEERS, PeerPaneCleanupError } from "./protocol.ts";
import { type CommandRunner, defaultCommandRunner } from "./zellij.ts";

export async function spawnTmuxPeer(
	input: SpawnPeerInput,
	runner: CommandRunner = defaultCommandRunner,
): Promise<{ paneId: string }> {
	if (!process.env.TMUX) {
		throw new Error("pi-peer spawn must run inside tmux");
	}
	let targetPane = process.env.TMUX_PANE;
	let direction: "right" | "down" = "right";
	if (targetPane) {
		const panes = (await runner.run("tmux", [
			"list-panes", "-t", targetPane, "-F", "#{pane_id}\t#{pane_left}\t#{pane_top}",
		])).stdout.trim().split("\n").map((line) => {
			const [id, left, top] = line.split("\t");
			return { id, left: Number(left), top: Number(top) };
		});
		const source = panes.find(({ id }) => id === targetPane);
		const rightColumn = source
			? panes.filter((pane) => pane.left > source.left).sort((a, b) => b.top - a.top)
			: [];
		const sourceColumn = source
			? panes.filter((pane) => pane.left === source.left && pane.top > source.top).sort((a, b) => b.top - a.top)
			: [];
		if (rightColumn.length >= MAX_RIGHT_COLUMN_PEERS) {
			targetPane = sourceColumn[0]?.id ?? source?.id;
			direction = "down";
		} else if (rightColumn[0]?.id) {
			targetPane = rightColumn[0].id;
			direction = "down";
		} else {
			direction = "right";
		}
	}
	const launcher = createPeerLauncher(input);
	const args = ["split-window", "-d", "-P", "-F", "#{pane_id}", "-c", input.cwd];
	if (targetPane) args.push("-t", targetPane);
	args.push(direction === "down" ? "-v" : "-h");
	args.push("--", "sh", launcher.path);
	try {
		const result = await runner.run("tmux", args);
		const paneId = result.stdout.trim();
		if (!paneId) throw new Error("tmux did not return the created pane ID");
		try {
			await runner.run("tmux", ["select-pane", "-t", paneId, "-T", peerPaneTitle(input)]);
			await runner.run("tmux", ["select-layout", "-E", "-t", paneId]);
		} catch (error) {
			try {
				await runner.run("tmux", ["kill-pane", "-t", paneId]);
			} catch (cleanupError) {
				throw new PeerPaneCleanupError(`tmux pane ${paneId} still exists after spawn setup failed`, { cause: cleanupError });
			}
			throw error;
		}
		return { paneId };
	} catch (error) {
		removePeerLauncher(launcher);
		throw error;
	}
}
