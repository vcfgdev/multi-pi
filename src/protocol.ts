import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	fstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { MAX_RECORD_TEXT, MAX_TRANSCRIPT_RECORDS, type PeerTranscriptRecord } from "./transcript.ts";

export const PEER_PROTOCOL_VERSION = 2;
export const PEER_HEARTBEAT_MS = 5_000;
export const PEER_STALE_MS = 20_000;
export const MAX_MESSAGE_LENGTH = 50_000;
export const MAX_REGISTRATION_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_ENVELOPE_FILE_BYTES = 256 * 1024;
export const MAX_DIRECT_PEERS = 7;
export const MAX_RIGHT_COLUMN_PEERS = 4;
const PEER_RESERVATION_STALE_MS = 60_000;
const PEER_RESERVATION_MAX_BYTES = 4 * 1024;
const PEER_RESERVATION_LOCK_STALE_MS = 10_000;

export class PeerPaneCleanupError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "PeerPaneCleanupError";
	}
}

export type PeerActivity = "idle" | "thinking" | "tool";
export type PeerMessageKind = "question" | "status" | "result" | "steer";
export type PeerDelivery = "followUp" | "steer";

export interface PeerRegistration {
	version: typeof PEER_PROTOCOL_VERSION;
	endpointId: string;
	sessionId: string;
	sessionName?: string;
	pid: number;
	cwd: string;
	workspace: string;
	model?: string;
	startedAt: string;
	heartbeatAt: string;
	activity: PeerActivity;
	activeTools: string[];
	context?: { tokens: number | null; contextWindow: number; percent: number | null };
	parentSessionId?: string;
	taskId?: string;
	mux?: { kind: "cmux" | "zellij" | "tmux"; session?: string; paneId?: string };
	transcript: PeerTranscriptRecord[];
	transcriptCursor?: string;
}

export interface PeerEnvelope {
	version: typeof PEER_PROTOCOL_VERSION;
	id: string;
	targetSessionId: string;
	targetEndpointId: string;
	from: {
		sessionId: string;
		sessionName?: string;
	};
	kind: PeerMessageKind;
	delivery: PeerDelivery;
	message: string;
	taskId?: string;
	sentAt: string;
}

export interface PeerPublication {
	sessionId: string;
	sessionName?: string;
	cwd: string;
	model?: string;
	activity: PeerActivity;
	activeTools: string[];
	context?: PeerRegistration["context"];
	parentSessionId?: string;
	taskId?: string;
	mux?: PeerRegistration["mux"];
	transcript: PeerTranscriptRecord[];
	transcriptCursor?: string;
}

export interface PeerSender {
	sessionId: string;
	sessionName?: string;
}

interface PeerReservation {
	id: string;
	parentSessionId: string;
	createdAt: string;
}

export function defaultPeerStateRoot(): string {
	if (process.env.PI_PEER_STATE_DIR) return process.env.PI_PEER_STATE_DIR;
	if (process.env.MULTI_PI_STATE_DIR) return process.env.MULTI_PI_STATE_DIR;
	const stateHome = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
	return join(stateHome, "pi-peer");
}

export function publicPeer(peer: PeerRegistration) {
	return {
		sessionId: peer.sessionId,
		...(peer.sessionName ? { name: peer.sessionName } : {}),
		role: peer.parentSessionId ? "peer" as const : "root" as const,
		cwd: peer.cwd,
		...(peer.model ? { model: peer.model } : {}),
		activity: peer.activity,
		activeTools: peer.activeTools,
		heartbeatAt: peer.heartbeatAt,
		...(peer.context ? { context: peer.context } : {}),
		...(peer.parentSessionId ? { parentSessionId: peer.parentSessionId } : {}),
		...(peer.taskId ? { taskId: peer.taskId } : {}),
		...(peer.mux ? { mux: peer.mux } : {}),
	};
}

function ensurePrivateDirectory(path: string): void {
	mkdirSync(path, { recursive: true, mode: 0o700 });
	chmodSync(path, 0o700);
}

function writeAtomic(path: string, value: unknown, pid: number, maxBytes: number): void {
	const content = `${JSON.stringify(value)}\n`;
	if (Buffer.byteLength(content) > maxBytes) throw new Error(`Peer state exceeds ${maxBytes} bytes`);
	const temporaryPath = `${path}.${pid}.${randomUUID()}.tmp`;
	writeFileSync(temporaryPath, content, { mode: 0o600 });
	chmodSync(temporaryPath, 0o600);
	renameSync(temporaryPath, path);
}

function readJsonBounded(path: string, maxBytes: number): unknown {
	const descriptor = openSync(path, "r");
	try {
		const size = fstatSync(descriptor).size;
		if (size > maxBytes) throw new Error(`Peer state exceeds ${maxBytes} bytes`);
		const buffer = Buffer.alloc(size);
		let offset = 0;
		while (offset < size) {
			const read = readSync(descriptor, buffer, offset, size - offset, offset);
			if (read === 0) break;
			offset += read;
		}
		return JSON.parse(buffer.subarray(0, offset).toString("utf8"));
	} finally {
		closeSync(descriptor);
	}
}

function isEndpointId(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9-]{36}$/.test(value);
}

function isRegistration(value: unknown): value is PeerRegistration {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<PeerRegistration>;
	return record.version === PEER_PROTOCOL_VERSION
		&& isEndpointId(record.endpointId)
		&& typeof record.sessionId === "string" && record.sessionId.length > 0 && record.sessionId.length <= 512
		&& Number.isInteger(record.pid) && record.pid! > 0
		&& typeof record.heartbeatAt === "string"
		&& Array.isArray(record.transcript) && record.transcript.length <= MAX_TRANSCRIPT_RECORDS
		&& record.transcript.every((item) => item && typeof item === "object"
			&& typeof item.sequence === "number" && typeof item.role === "string"
			&& typeof item.text === "string" && item.text.length <= MAX_RECORD_TEXT + 64);
}

function isEnvelope(value: unknown, sessionId: string): value is PeerEnvelope {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<PeerEnvelope>;
	return record.version === PEER_PROTOCOL_VERSION
		&& isEndpointId(record.id)
		&& record.targetSessionId === sessionId
		&& isEndpointId(record.targetEndpointId)
		&& typeof record.from?.sessionId === "string"
		&& ["question", "status", "result", "steer"].includes(String(record.kind))
		&& ["followUp", "steer"].includes(String(record.delivery))
		&& typeof record.message === "string"
		&& record.message.length <= MAX_MESSAGE_LENGTH
		&& typeof record.sentAt === "string";
}

function pidIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function registrationFilename(sessionId: string, pid: number, endpointId: string): string {
	const digest = createHash("sha256").update(sessionId).digest("hex").slice(0, 20);
	return `${digest}-${pid}-${endpointId}.json`;
}

function sessionDirectoryName(sessionId: string): string {
	return createHash("sha256").update(sessionId).digest("hex");
}

export class PeerEndpoint {
	readonly endpointId: string;
	private readonly pid: number;
	private readonly now: () => Date;
	private readonly sessionsDirectory: string;
	private readonly inboxesDirectory: string;
	private readonly reservationsDirectory: string;
	private readonly reservationLock: string;
	private registrationPath?: string;
	private registration?: PeerRegistration;
	private readonly startedAt: string;
	private readonly activeClaims = new Set<string>();
	private removalRequested = false;

	constructor(
		root = defaultPeerStateRoot(),
		pid = process.pid,
		now: () => Date = () => new Date(),
		endpointId = randomUUID(),
	) {
		this.pid = pid;
		this.now = now;
		this.endpointId = endpointId;
		this.sessionsDirectory = join(root, "sessions");
		this.inboxesDirectory = join(root, "inboxes");
		this.reservationsDirectory = join(root, "reservations");
		this.reservationLock = join(root, "reservations.lock");
		this.startedAt = now().toISOString();
		ensurePrivateDirectory(root);
		ensurePrivateDirectory(this.sessionsDirectory);
		ensurePrivateDirectory(this.inboxesDirectory);
		ensurePrivateDirectory(this.reservationsDirectory);
	}

	reserveDirectPeer(parentSessionId: string): string {
		return this.withReservationLock(() => {
			const now = this.now().getTime();
			const pending = new Set<string>();
			for (const file of readdirSync(this.reservationsDirectory)) {
				if (!file.endsWith(".json")) continue;
				const path = join(this.reservationsDirectory, file);
				try {
					const reservation = readJsonBounded(path, PEER_RESERVATION_MAX_BYTES) as Partial<PeerReservation>;
					const createdAt = typeof reservation.createdAt === "string" ? Date.parse(reservation.createdAt) : Number.NaN;
					if (typeof reservation.id !== "string" || typeof reservation.parentSessionId !== "string"
						|| !Number.isFinite(createdAt) || now - createdAt > PEER_RESERVATION_STALE_MS) {
						rmSync(path, { force: true });
						continue;
					}
					if (reservation.parentSessionId === parentSessionId) pending.add(reservation.id);
				} catch {
					rmSync(path, { force: true });
				}
			}
			const live = new Set(this.list()
				.filter((peer) => peer.parentSessionId === parentSessionId)
				.map((peer) => peer.sessionId));
			if (live.size + pending.size >= MAX_DIRECT_PEERS) {
				throw new Error(`A Pi session may have at most ${MAX_DIRECT_PEERS} live direct peers`);
			}
			const reservation: PeerReservation = {
				id: randomUUID(),
				parentSessionId,
				createdAt: this.now().toISOString(),
			};
			writeAtomic(
				join(this.reservationsDirectory, `${reservation.id}.json`),
				reservation,
				this.pid,
				PEER_RESERVATION_MAX_BYTES,
			);
			return reservation.id;
		});
	}

	releasePeerReservation(id: string): void {
		if (!isEndpointId(id)) return;
		rmSync(join(this.reservationsDirectory, `${id}.json`), { force: true });
	}

	publish(publication: PeerPublication): PeerRegistration {
		const nextPath = join(
			this.sessionsDirectory,
			registrationFilename(publication.sessionId, this.pid, this.endpointId),
		);
		if (this.registrationPath && this.registrationPath !== nextPath) rmSync(this.registrationPath, { force: true });
		this.registrationPath = nextPath;
		this.registration = {
			version: PEER_PROTOCOL_VERSION,
			endpointId: this.endpointId,
			sessionId: publication.sessionId,
			...(publication.sessionName ? { sessionName: publication.sessionName } : {}),
			pid: this.pid,
			cwd: publication.cwd,
			workspace: basename(publication.cwd) || publication.cwd,
			...(publication.model ? { model: publication.model } : {}),
			startedAt: this.startedAt,
			heartbeatAt: this.now().toISOString(),
			activity: publication.activity,
			activeTools: [...new Set(publication.activeTools)],
			...(publication.context ? { context: publication.context } : {}),
			...(publication.parentSessionId ? { parentSessionId: publication.parentSessionId } : {}),
			...(publication.taskId ? { taskId: publication.taskId } : {}),
			...(publication.mux ? { mux: publication.mux } : {}),
			transcript: publication.transcript,
			...(publication.transcriptCursor ? { transcriptCursor: publication.transcriptCursor } : {}),
		};
		ensurePrivateDirectory(this.inboxDirectory(publication.sessionId));
		writeAtomic(nextPath, this.registration, this.pid, MAX_REGISTRATION_FILE_BYTES);
		return this.registration;
	}

	heartbeat(): void {
		if (!this.registration || !this.registrationPath) return;
		this.registration = { ...this.registration, heartbeatAt: this.now().toISOString() };
		writeAtomic(this.registrationPath, this.registration, this.pid, MAX_REGISTRATION_FILE_BYTES);
	}

	list(): PeerRegistration[] {
		if (!existsSync(this.sessionsDirectory)) return [];
		const now = this.now().getTime();
		const registrations: PeerRegistration[] = [];
		for (const file of readdirSync(this.sessionsDirectory)) {
			if (!file.endsWith(".json")) continue;
			const path = join(this.sessionsDirectory, file);
			try {
				const registration = readJsonBounded(path, MAX_REGISTRATION_FILE_BYTES);
				if (!isRegistration(registration)) continue;
				const fresh = now - Date.parse(registration.heartbeatAt) <= PEER_STALE_MS;
				if (fresh && pidIsAlive(registration.pid)) registrations.push(registration);
			} catch {
				// Ignore incomplete, malformed, or concurrently removed registrations.
			}
		}
		return registrations.sort((left, right) =>
			left.startedAt.localeCompare(right.startedAt)
			|| left.sessionId.localeCompare(right.sessionId)
			|| left.endpointId.localeCompare(right.endpointId));
	}

	resolve(target: string): PeerRegistration {
		const peers = this.list();
		const exactId = peers.filter((peer) => peer.sessionId === target || peer.endpointId === target);
		if (exactId.length === 1) return exactId[0];
		const normalized = target.toLowerCase();
		const exactName = peers.filter((peer) => peer.sessionName?.toLowerCase() === normalized);
		if (exactName.length === 1) return exactName[0];
		const prefix = peers.filter((peer) => peer.sessionId.startsWith(target) || peer.endpointId.startsWith(target));
		if (prefix.length === 1) return prefix[0];
		if (exactId.length + exactName.length + prefix.length > 1) {
			throw new Error(`Peer target is ambiguous: ${target}`);
		}
		throw new Error(`Live peer not found: ${target}`);
	}

	send(input: {
		target: string;
		message: string;
		kind: PeerMessageKind;
		delivery?: PeerDelivery;
		taskId?: string;
	}): PeerEnvelope {
		if (!this.registration) throw new Error("Current Pi session is not registered yet");
		return this.sendFrom(this.registration, input);
	}

	sendFrom(sender: PeerSender, input: {
		target: string;
		message: string;
		kind: PeerMessageKind;
		delivery?: PeerDelivery;
		taskId?: string;
	}): PeerEnvelope {
		if (input.message.length > MAX_MESSAGE_LENGTH) {
			throw new Error(`Peer message exceeds ${MAX_MESSAGE_LENGTH} characters`);
		}
		const target = this.resolve(input.target);
		const envelope: PeerEnvelope = {
			version: PEER_PROTOCOL_VERSION,
			id: randomUUID(),
			targetSessionId: target.sessionId,
			targetEndpointId: target.endpointId,
			from: {
				sessionId: sender.sessionId,
				...(sender.sessionName ? { sessionName: sender.sessionName } : {}),
			},
			kind: input.kind,
			delivery: input.delivery ?? (input.kind === "steer" ? "steer" : "followUp"),
			message: input.message,
			...(input.taskId ? { taskId: input.taskId } : {}),
			sentAt: this.now().toISOString(),
		};
		const inbox = this.inboxDirectory(target.sessionId);
		ensurePrivateDirectory(inbox);
		writeAtomic(
			join(inbox, `${envelope.sentAt.replaceAll(":", "-")}-${envelope.id}.json`),
			envelope,
			this.pid,
			MAX_ENVELOPE_FILE_BYTES,
		);
		return envelope;
	}

	async receive(handler: (envelope: PeerEnvelope) => Promise<void> | void): Promise<number> {
		if (!this.registration || this.removalRequested) return 0;
		const sessionId = this.registration.sessionId;
		const inbox = this.inboxDirectory(sessionId);
		if (!existsSync(inbox)) return 0;
		this.recoverClaims(inbox);
		let received = 0;
		for (const file of readdirSync(inbox).filter((name) => name.endsWith(".json")).sort()) {
			if (this.removalRequested) break;
			const path = join(inbox, file);
			const claim = `${path}.${this.pid}.${this.endpointId}.claim`;
			let claimed = false;
			try {
				renameSync(path, claim);
				claimed = true;
				this.activeClaims.add(claim);
				let envelope: unknown;
				try {
					envelope = readJsonBounded(claim, MAX_ENVELOPE_FILE_BYTES);
				} catch {
					rmSync(claim, { force: true });
					continue;
				}
				if (!isEnvelope(envelope, sessionId)) {
					rmSync(claim, { force: true });
					continue;
				}
				await handler(envelope);
				rmSync(claim, { force: true });
				received += 1;
			} catch {
				try {
					if (claimed && existsSync(claim)) renameSync(claim, path);
				} catch {
					// A later poll recovers an inactive claim, including one owned by this endpoint.
				}
			} finally {
				if (claimed) this.activeClaims.delete(claim);
				if (this.removalRequested && this.activeClaims.size === 0) this.finishRemoval();
			}
		}
		return received;
	}

	remove(): void {
		this.removalRequested = true;
		if (this.activeClaims.size === 0) this.finishRemoval();
	}

	private recoverClaims(inbox: string): void {
		const liveEndpoints = new Set(this.list().map((peer) => `${peer.pid}:${peer.endpointId}`));
		const currentEndpoint = `${this.pid}:${this.endpointId}`;
		for (const file of readdirSync(inbox).filter((name) => name.endsWith(".claim"))) {
			const match = /^(.*\.json)\.(\d+)\.([a-f0-9-]{36})\.claim$/.exec(file);
			if (!match) continue;
			const claim = join(inbox, file);
			const owner = `${match[2]}:${match[3]}`;
			if (this.activeClaims.has(claim) || owner !== currentEndpoint && liveEndpoints.has(owner)) continue;
			const pending = join(inbox, match[1]);
			try {
				if (existsSync(pending)) rmSync(claim, { force: true });
				else renameSync(claim, pending);
			} catch {
				// Another receiver may have recovered the claim.
			}
		}
	}

	private finishRemoval(): void {
		if (this.registrationPath) rmSync(this.registrationPath, { force: true });
		this.registrationPath = undefined;
		this.registration = undefined;
	}

	private inboxDirectory(sessionId: string): string {
		return join(this.inboxesDirectory, sessionDirectoryName(sessionId));
	}

	private withReservationLock<T>(operation: () => T): T {
		const sleeper = new Int32Array(new SharedArrayBuffer(4));
		for (let attempt = 0; attempt < 100; attempt += 1) {
			try {
				mkdirSync(this.reservationLock, { mode: 0o700 });
				try {
					return operation();
				} finally {
					rmSync(this.reservationLock, { recursive: true, force: true });
				}
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				try {
					if (this.now().getTime() - statSync(this.reservationLock).mtimeMs > PEER_RESERVATION_LOCK_STALE_MS) {
						rmSync(this.reservationLock, { recursive: true, force: true });
						continue;
					}
				} catch {
					continue;
				}
				Atomics.wait(sleeper, 0, 0, 10);
			}
		}
		throw new Error("Timed out reserving a Pi peer slot");
	}
}
