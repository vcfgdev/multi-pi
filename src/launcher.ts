import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpawnPeerInput } from "./zellij.ts";

const LAUNCHER_PREFIX = "pi-peer-launch-";
const STALE_LAUNCHER_MS = 60 * 60 * 1_000;
const EXCLUDED_ENVIRONMENT = new Set([
	"_",
	"COLORTERM",
	"ITERM_SESSION_ID",
	"OLDPWD",
	"PI_PEER_PARENT",
	"PI_PEER_PARENT_SESSION_ID",
	"PI_PEER_RESERVATION_ID",
	"PI_PEER_TASK_ID",
	"PI_SESSION_ID",
	"PI_SESSION_FILE",
	"PI_PROVIDER",
	"PI_MODEL",
	"PI_REASONING_LEVEL",
	"PWD",
	"SHLVL",
	"TERM",
	"TERM_PROGRAM",
	"TERM_SESSION_ID",
	"TMUX",
	"TMUX_PANE",
]);

export interface PeerLauncher {
	directory: string;
	path: string;
	shellCommand: string;
}

export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function peerPaneTitle(input: Pick<SpawnPeerInput, "name">): string {
	return input.name;
}

function shouldInheritEnvironment(name: string): boolean {
	return !EXCLUDED_ENVIRONMENT.has(name)
		&& !name.startsWith("CMUX_")
		&& !name.startsWith("TMUX")
		&& !name.startsWith("WEZTERM_")
		&& !name.startsWith("ZELLIJ");
}

function cleanupStaleLaunchers(now = Date.now()): void {
	for (const name of readdirSync(tmpdir())) {
		if (!name.startsWith(LAUNCHER_PREFIX)) continue;
		const path = join(tmpdir(), name);
		try {
			if (now - statSync(path).mtimeMs > STALE_LAUNCHER_MS) rmSync(path, { recursive: true, force: true });
		} catch {
			// Another launcher may be removing itself.
		}
	}
}

export function createPeerLauncher(input: SpawnPeerInput): PeerLauncher {
	cleanupStaleLaunchers();
	const directory = mkdtempSync(join(tmpdir(), LAUNCHER_PREFIX));
	const path = join(directory, "launch.sh");
	const inherited = Object.entries(process.env)
		.filter((entry): entry is [string, string] => entry[1] !== undefined && shouldInheritEnvironment(entry[0]))
		.map(([name, value]) => `${name}=${value}`);
	const command = [
		"env",
		"-u", "PI_SESSION_ID",
		"-u", "PI_SESSION_FILE",
		"-u", "PI_PROVIDER",
		"-u", "PI_MODEL",
		"-u", "PI_REASONING_LEVEL",
		"-u", "PI_PEER_PARENT",
		"-u", "PI_PEER_PARENT_SESSION_ID",
		"-u", "PI_PEER_RESERVATION_ID",
		"-u", "PI_PEER_TASK_ID",
		...inherited,
		...(input.parentSessionId ? [
			`PI_PEER_PARENT_SESSION_ID=${input.parentSessionId}`,
			`PI_PEER_PARENT=${input.parentSessionId}`,
			`PI_PEER_TASK_ID=${input.name}`,
			...(input.reservationId ? [`PI_PEER_RESERVATION_ID=${input.reservationId}`] : []),
		] : []),
		"pi",
		"--name",
		input.name,
		...(input.model ? ["--model", input.model] : []),
		"--",
		input.prompt,
	].map(shellQuote).join(" ");
	writeFileSync(path, [
		"#!/bin/sh",
		`rm -- ${shellQuote(path)}`,
		`rmdir -- ${shellQuote(directory)}`,
		`cd ${shellQuote(input.cwd)} || exit 1`,
		`exec ${command}`,
		"",
	].join("\n"), { mode: 0o700 });
	return { directory, path, shellCommand: `sh ${shellQuote(path)}` };
}

export function removePeerLauncher(launcher: PeerLauncher): void {
	rmSync(launcher.directory, { recursive: true, force: true });
}
