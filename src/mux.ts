import { spawnCmuxPeer } from "./cmux.ts";
import { spawnTmuxPeer } from "./tmux.ts";
import { spawnZellijPeer, type SpawnPeerInput } from "./zellij.ts";

export async function spawnPeer(input: SpawnPeerInput): Promise<{ paneId: string }> {
	if (process.env.CMUX_SOCKET_PATH && process.env.CMUX_WORKSPACE_ID && process.env.CMUX_SURFACE_ID) {
		return spawnCmuxPeer(input);
	}
	if (process.env.ZELLIJ || process.env.ZELLIJ_SESSION_NAME) return spawnZellijPeer(input);
	if (process.env.TMUX) return spawnTmuxPeer(input);
	throw new Error("pi-peer spawn requires cmux, Zellij, or tmux");
}
