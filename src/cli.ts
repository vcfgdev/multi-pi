#!/usr/bin/env node

import {
	MAX_DIRECT_PEERS,
	MAX_MESSAGE_LENGTH,
	PeerEndpoint,
	publicPeer,
	type PeerDelivery,
	type PeerMessageKind,
	type PeerRegistration,
	type PeerSender,
} from "./protocol.ts";
import { closePeerPane, spawnPeer } from "./mux.ts";
import type { SpawnPeerInput } from "./zellij.ts";

const HELP = `pi-peer — coordinate interactive Pi sessions

Usage:
  pi-peer spawn --name <name> [options] [--prompt <text>]
  pi-peer list [--json]
  pi-peer inspect <peer> [--limit <records>] [--json]
  pi-peer send [peer] --kind <kind> [options] [--message <text>]
  pi-peer close <peer> [--json]
  pi-peer close --all [--json]

Use "pi-peer <command> --help" for command details. Prompts and messages may be
provided on stdin. A peer launched outside Pi starts as an independent root.`;

const COMMAND_HELP: Record<string, string> = {
	spawn: `Usage: pi-peer spawn --name <name> [options] [--prompt <text>]

Open a full interactive Pi session in a neighboring cmux, Zellij, or tmux pane.
When run from Pi's Bash tool, the current PI_SESSION_ID becomes the direct parent.
By default, peers form a vertical column to the right of the current pane.
Each session may have at most ${MAX_DIRECT_PEERS} live direct peers.

Options:
  --name <name>          Pane and Pi session name (required)
  --cwd <directory>     Working directory (default: current directory)
  --direction <value>   right or down
  --model <model>       Pi model selector
  --prompt <text>       Initial task; otherwise read stdin
  --json                Print a JSON result`,
	list: `Usage: pi-peer list [--json]

List live Pi sessions published by the pi-peer runtime extension.`,
	inspect: `Usage: pi-peer inspect <peer> [--limit <records>] [--json]

Show one live peer's status and bounded active-branch transcript. A peer may be
selected by exact name, session/endpoint ID, or an unambiguous ID prefix.

Options:
  --limit <records>      Transcript records, 1–100 (default: 20)
  --json                 Print a JSON result`,
	send: `Usage: pi-peer send [peer] --kind <kind> [options] [--message <text>]

Queue a message for a live Pi session. In a delegated session, omit peer to send
to its parent. The message is read from stdin when --message is omitted.

Options:
  --kind <kind>          question, status, result, or steer (required)
  --delivery <mode>      steer or followUp
  --task-id <id>         Task correlation ID (defaults to current peer task)
  --message <text>       Message body; otherwise read stdin
  --json                 Print a JSON result`,
	close: `Usage: pi-peer close <peer> [--json]
       pi-peer close --all [--json]

Close one or all live direct peers and their terminal panes. Roots, siblings,
and unrelated panes cannot be closed.

Options:
  --all                 Close all live direct peers
  --json                Print a JSON result`,
};

interface CliEndpoint {
	list(): PeerRegistration[];
	reserveDirectPeer(parentSessionId: string): string;
	releasePeerReservation(id: string): void;
	resolve(target: string): PeerRegistration;
	sendFrom(sender: PeerSender, input: {
		target: string;
		message: string;
		kind: PeerMessageKind;
		delivery?: PeerDelivery;
		taskId?: string;
	}): { id: string; kind: PeerMessageKind; delivery: PeerDelivery };
}

export interface CliDependencies {
	env?: NodeJS.ProcessEnv;
	cwd?: () => string;
	readStdin?: () => Promise<string>;
	spawn?: (input: SpawnPeerInput) => Promise<{ paneId: string }>;
	close?: (peer: PeerRegistration) => Promise<void>;
	endpoint?: CliEndpoint;
	stdout?: (text: string) => void;
	stderr?: (text: string) => void;
}

interface ParsedArguments {
	flags: Map<string, string | true>;
	positionals: string[];
}

function parseArguments(args: string[], valued: Set<string>, boolean = new Set<string>()): ParsedArguments {
	const flags = new Map<string, string | true>();
	const positionals: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index]!;
		if (!argument.startsWith("--")) {
			positionals.push(argument);
			continue;
		}
		if (argument === "--help" || argument === "--json" || boolean.has(argument.slice(2))) {
			flags.set(argument.slice(2), true);
			continue;
		}
		const name = argument.slice(2);
		if (!valued.has(name)) throw new Error(`Unknown option: ${argument}`);
		const value = args[index + 1];
		if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
		flags.set(name, value);
		index += 1;
	}
	return { flags, positionals };
}

function flag(arguments_: ParsedArguments, name: string): string | undefined {
	const value = arguments_.flags.get(name);
	return typeof value === "string" ? value : undefined;
}

function jsonFlag(arguments_: ParsedArguments): boolean {
	return arguments_.flags.get("json") === true;
}

function requireText(value: string | undefined, description: string, maxLength: number): string {
	if (!value?.trim()) throw new Error(`${description} is required`);
	if (value.length > maxLength) throw new Error(`${description} exceeds ${maxLength} characters`);
	return value;
}

function currentParent(env: NodeJS.ProcessEnv): string | undefined {
	return env.PI_PEER_PARENT_SESSION_ID ?? env.PI_PEER_PARENT;
}

function output(value: unknown, human: string, json: boolean, write: (text: string) => void): void {
	write(json ? `${JSON.stringify(value, undefined, 2)}\n` : `${human}\n`);
}

function inspection(peer: PeerRegistration, limit: number) {
	const transcript = peer.transcript.slice(-limit);
	const truncated = transcript.some((record) => record.truncated);
	return {
		peer: publicPeer(peer),
		transcript,
		cursor: peer.transcriptCursor,
		bounded: peer.transcript.length >= 100,
		truncated,
		...(truncated ? { note: "Only this inspection snapshot is truncated; wait for the complete pi-peer send result." } : {}),
	};
}

function humanInspection(result: ReturnType<typeof inspection>): string {
	const peer = result.peer;
	const header = `${peer.name ?? peer.sessionId}  ${peer.activity}${peer.activeTools.length ? ` (${peer.activeTools.join(", ")})` : ""}`;
	const transcript = result.transcript.map((record) => `[${record.role}] ${record.text}`).join("\n\n");
	return transcript ? `${header}\n\n${transcript}` : `${header}\n\nNo transcript records.`;
}

async function readStandardInput(): Promise<string> {
	if (process.stdin.isTTY) return "";
	process.stdin.setEncoding("utf8");
	let content = "";
	for await (const chunk of process.stdin) content += chunk;
	return content;
}

export async function runCli(args: string[], dependencies: CliDependencies = {}): Promise<number> {
	const env = dependencies.env ?? process.env;
	const cwd = dependencies.cwd ?? process.cwd;
	const readStdin = dependencies.readStdin ?? readStandardInput;
	const spawn = dependencies.spawn ?? spawnPeer;
	const close = dependencies.close ?? closePeerPane;
	let endpoint = dependencies.endpoint;
	const getEndpoint = () => endpoint ??= new PeerEndpoint();
	const stdout = dependencies.stdout ?? ((text) => process.stdout.write(text));
	const stderr = dependencies.stderr ?? ((text) => process.stderr.write(text));
	const [command, ...commandArgs] = args;

	try {
		if (!command || command === "--help" || command === "-h" || command === "help") {
			stdout(`${HELP}\n`);
			return 0;
		}
		if (!Object.hasOwn(COMMAND_HELP, command)) throw new Error(`Unknown command: ${command}`);

		switch (command) {
			case "spawn": {
				const parsed = parseArguments(commandArgs, new Set(["name", "cwd", "direction", "model", "prompt"]));
				if (parsed.flags.has("help")) {
					stdout(`${COMMAND_HELP.spawn}\n`);
					return 0;
				}
				if (parsed.positionals.length) throw new Error("pi-peer spawn accepts the task through --prompt or stdin");
				const name = requireText(flag(parsed, "name"), "--name", 80);
				if (/[\r\n]/.test(name)) throw new Error("--name cannot contain a newline");
				const direction = flag(parsed, "direction") as "right" | "down" | undefined;
				if (direction && direction !== "right" && direction !== "down") throw new Error("--direction must be right or down");
				const prompt = requireText(flag(parsed, "prompt") ?? await readStdin(), "A prompt via --prompt or stdin", MAX_MESSAGE_LENGTH);
				const reservationId = env.PI_SESSION_ID ? getEndpoint().reserveDirectPeer(env.PI_SESSION_ID) : undefined;
				let result: { paneId: string };
				try {
					result = await spawn({
						prompt,
						name,
						cwd: flag(parsed, "cwd") ?? cwd(),
						...(direction ? { direction } : {}),
						...(flag(parsed, "model") ? { model: flag(parsed, "model") } : {}),
						...(env.PI_SESSION_ID ? { parentSessionId: env.PI_SESSION_ID } : {}),
						...(reservationId ? { reservationId } : {}),
					});
				} catch (error) {
					if (reservationId) getEndpoint().releasePeerReservation(reservationId);
					throw error;
				}
				const value = { spawned: true, paneId: result.paneId, name, root: !env.PI_SESSION_ID };
				output(value, `Spawned ${name} in pane ${result.paneId}${value.root ? " as an independent root" : ""}.`, jsonFlag(parsed), stdout);
				return 0;
			}
			case "list": {
				const parsed = parseArguments(commandArgs, new Set());
				if (parsed.flags.has("help")) {
					stdout(`${COMMAND_HELP.list}\n`);
					return 0;
				}
				if (parsed.positionals.length) throw new Error("pi-peer list takes no arguments");
				const peers = getEndpoint().list().map(publicPeer);
				const human = peers.length
					? peers.map((peer) => `${peer.name ?? peer.sessionId}\t${peer.role}\t${peer.activity}\t${peer.cwd}`).join("\n")
					: "No live Pi peers.";
				output({ peers }, human, jsonFlag(parsed), stdout);
				return 0;
			}
			case "inspect": {
				const parsed = parseArguments(commandArgs, new Set(["limit"]));
				if (parsed.flags.has("help")) {
					stdout(`${COMMAND_HELP.inspect}\n`);
					return 0;
				}
				if (parsed.positionals.length !== 1) throw new Error("pi-peer inspect requires one peer name or ID");
				const rawLimit = flag(parsed, "limit") ?? "20";
				const limit = Number(rawLimit);
				if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("--limit must be an integer from 1 to 100");
				const result = inspection(getEndpoint().resolve(parsed.positionals[0]!), limit);
				output(result, humanInspection(result), jsonFlag(parsed), stdout);
				return 0;
			}
			case "send": {
				const parsed = parseArguments(commandArgs, new Set(["kind", "delivery", "task-id", "message"]));
				if (parsed.flags.has("help")) {
					stdout(`${COMMAND_HELP.send}\n`);
					return 0;
				}
				if (parsed.positionals.length > 1) throw new Error("pi-peer send accepts at most one peer name or ID");
				const target = parsed.positionals[0] ?? currentParent(env);
				if (!target) throw new Error("pi-peer send requires a peer outside a delegated session");
				const kind = flag(parsed, "kind") as PeerMessageKind | undefined;
				if (!kind || !["question", "status", "result", "steer"].includes(kind)) {
					throw new Error("--kind must be question, status, result, or steer");
				}
				const delivery = flag(parsed, "delivery") as PeerDelivery | undefined;
				if (delivery && delivery !== "steer" && delivery !== "followUp") throw new Error("--delivery must be steer or followUp");
				const message = requireText(flag(parsed, "message") ?? await readStdin(), "A message via --message or stdin", MAX_MESSAGE_LENGTH);
				const sessionId = env.PI_SESSION_ID;
				if (!sessionId) throw new Error("pi-peer send must run from a live Pi session");
				const sender = getEndpoint().list().find((peer) => peer.sessionId === sessionId);
				if (!sender) throw new Error(`Current Pi session is not registered yet: ${sessionId}`);
				const replyingToParent = currentParent(env) === target;
				const envelope = getEndpoint().sendFrom(sender, {
					target,
					kind,
					message,
					...(flag(parsed, "task-id") ?? env.PI_PEER_TASK_ID ? { taskId: flag(parsed, "task-id") ?? env.PI_PEER_TASK_ID } : {}),
					...(delivery ? { delivery } : replyingToParent ? { delivery: "steer" } : {}),
				});
				const value = { queued: true, acknowledged: false, messageId: envelope.id, target, kind: envelope.kind, delivery: envelope.delivery };
				output(value, `Queued ${envelope.kind} for ${target} (${envelope.id}).`, jsonFlag(parsed), stdout);
				return 0;
			}
			case "close": {
				const parsed = parseArguments(commandArgs, new Set(), new Set(["all"]));
				if (parsed.flags.has("help")) {
					stdout(`${COMMAND_HELP.close}\n`);
					return 0;
				}
				const all = parsed.flags.has("all");
				if (all && parsed.positionals.length) throw new Error("pi-peer close --all does not accept a peer");
				if (!all && parsed.positionals.length !== 1) throw new Error("pi-peer close requires one peer name or ID, or --all");
				const sessionId = env.PI_SESSION_ID;
				if (!sessionId) throw new Error("pi-peer close must run from a live Pi session");
				let peers: PeerRegistration[];
				if (all) {
					peers = [...new Map(getEndpoint().list()
						.filter((peer) => peer.parentSessionId === sessionId)
						.map((peer) => [`${peer.mux?.kind}:${peer.mux?.session ?? ""}:${peer.mux?.paneId ?? peer.endpointId}`, peer])).values()];
				} else {
					const peer = getEndpoint().resolve(parsed.positionals[0]!);
					if (peer.parentSessionId !== sessionId) {
						throw new Error(`Can only close a direct peer of the current session: ${parsed.positionals[0]}`);
					}
					peers = [peer];
				}
				const missingPane = peers.find((peer) => !peer.mux?.paneId);
				if (missingPane) throw new Error(`Peer has no live terminal pane: ${missingPane.sessionName ?? missingPane.sessionId}`);
				await Promise.all(peers.map((peer) => close(peer)));
				const closed = peers.map((peer) => ({
					sessionId: peer.sessionId,
					...(peer.sessionName ? { name: peer.sessionName } : {}),
					paneId: peer.mux?.paneId,
				}));
				output(
					{ closed },
					closed.length === 0 ? "No live direct peers to close." : `Closed ${closed.length} peer pane${closed.length === 1 ? "" : "s"}.`,
					jsonFlag(parsed),
					stdout,
				);
				return 0;
			}
		}
		return 0;
	} catch (error) {
		stderr(`pi-peer: ${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
}

if (import.meta.main) process.exitCode = await runCli(process.argv.slice(2));
