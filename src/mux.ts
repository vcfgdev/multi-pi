import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnCmuxPeer } from "./cmux.ts";
import { spawnTmuxPeer } from "./tmux.ts";
import { defaultPeerStateRoot, type PeerRegistration } from "./protocol.ts";
import { defaultCommandRunner, spawnZellijPeer, type CommandRunner } from "./zellij.ts";

const PLACEMENT_LOCK_STALE_MS = 2 * 60_000;
const PLACEMENT_LOCK_WAIT_MS = 100;
const PLACEMENT_LOCK_ATTEMPTS = 600;

export interface SpawnPeerInput {
	prompt: string;
	parentSessionId?: string;
	cwd: string;
	name: string;
	piArgs?: string[];
	reservationId?: string;
}

function pidIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export async function withPlacementLock<T>(operation: () => Promise<T>): Promise<T> {
	const root = defaultPeerStateRoot();
	mkdirSync(root, { recursive: true, mode: 0o700 });
	const lock = join(root, "placement.lock");
	for (let attempt = 0; attempt < PLACEMENT_LOCK_ATTEMPTS; attempt += 1) {
		let acquired = false;
		try {
			mkdirSync(lock, { mode: 0o700 });
			acquired = true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			try {
				const owner = Number(readFileSync(join(lock, "pid"), "utf8").trim());
				if (Number.isInteger(owner) && owner > 0 && !pidIsAlive(owner)) {
					rmSync(lock, { recursive: true, force: true });
					continue;
				}
			} catch {
				if (Date.now() - statSync(lock).mtimeMs > PLACEMENT_LOCK_STALE_MS) {
					rmSync(lock, { recursive: true, force: true });
					continue;
				}
			}
			await new Promise((resolve) => setTimeout(resolve, PLACEMENT_LOCK_WAIT_MS));
		}
		if (acquired) {
			try {
				writeFileSync(join(lock, "pid"), `${process.pid}\n`, { mode: 0o600 });
				return await operation();
			} finally {
				rmSync(lock, { recursive: true, force: true });
			}
		}
	}
	throw new Error("Timed out waiting to place a Pi peer pane");
}

export async function spawnPeer(input: SpawnPeerInput): Promise<{ paneId: string }> {
	return withPlacementLock(async () => {
		if (process.env.CMUX_SOCKET_PATH && process.env.CMUX_WORKSPACE_ID && process.env.CMUX_SURFACE_ID) {
			return spawnCmuxPeer(input);
		}
		if (process.env.ZELLIJ || process.env.ZELLIJ_SESSION_NAME) return spawnZellijPeer(input);
		if (process.env.TMUX) return spawnTmuxPeer(input);
		throw new Error("pi-peer spawn requires cmux, Zellij, or tmux");
	});
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
