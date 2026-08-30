import { spawnCmuxPeer } from "./cmux.ts";
import { spawnTmuxPeer } from "./tmux.ts";
import type { PeerRegistration } from "./protocol.ts";
import { defaultCommandRunner, spawnZellijPeer, type CommandRunner } from "./zellij.ts";

export interface SpawnPeerInput {
	prompt: string;
	parentSessionId?: string;
	cwd: string;
	name: string;
	direction?: "right" | "down";
	model?: string;
	piArgs?: string[];
	reservationId?: string;
}

export async function spawnPeer(input: SpawnPeerInput): Promise<{ paneId: string }> {
	if (process.env.CMUX_SOCKET_PATH && process.env.CMUX_WORKSPACE_ID && process.env.CMUX_SURFACE_ID) {
		return spawnCmuxPeer(input);
	}
	if (process.env.ZELLIJ || process.env.ZELLIJ_SESSION_NAME) return spawnZellijPeer(input);
	if (process.env.TMUX) return spawnTmuxPeer(input);
	throw new Error("pi-peer spawn requires cmux, Zellij, or tmux");
}

export async function closePeerPane(
	peer: PeerRegistration,
	runner: CommandRunner = defaultCommandRunner,
): Promise<void> {
	const mux = peer.mux;
	if (!mux?.paneId) throw new Error(`Peer has no live terminal pane: ${peer.sessionName ?? peer.sessionId}`);
	if (mux.kind === "cmux") {
		const args = ["close-surface"];
		if (mux.session) args.push("--workspace", mux.session);
		args.push("--surface", mux.paneId);
		await runner.run("cmux", args);
		return;
	}
	if (mux.kind === "zellij") {
		const args = mux.session ? ["--session", mux.session] : [];
		args.push("action", "close-pane", "--pane-id", mux.paneId);
		await runner.run("zellij", args);
		return;
	}
	await runner.run("tmux", ["kill-pane", "-t", mux.paneId]);
}
