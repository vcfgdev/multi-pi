import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultPeerStateRoot, PeerEndpoint, PEER_STALE_MS } from "./protocol.ts";

const roots: string[] = [];
const originalPeerStateDirectory = process.env.PI_PEER_STATE_DIR;
const originalLegacyStateDirectory = process.env.MULTI_PI_STATE_DIR;

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	if (originalPeerStateDirectory === undefined) delete process.env.PI_PEER_STATE_DIR;
	else process.env.PI_PEER_STATE_DIR = originalPeerStateDirectory;
	if (originalLegacyStateDirectory === undefined) delete process.env.MULTI_PI_STATE_DIR;
	else process.env.MULTI_PI_STATE_DIR = originalLegacyStateDirectory;
});

function root(): string {
	const path = mkdtempSync(join(tmpdir(), "multi-pi-"));
	roots.push(path);
	return path;
}

function publication(sessionId: string, name: string) {
	return {
		sessionId,
		sessionName: name,
		cwd: "/workspace/example",
		model: "anthropic/sonnet",
		activity: "idle" as const,
		activeTools: [],
		transcript: [{ sequence: 1, role: "user", text: `Task for ${name}` }],
		transcriptCursor: `${sessionId}-leaf`,
	};
}

function inbox(root: string, sessionId: string): string {
	return join(root, "inboxes", createHash("sha256").update(sessionId).digest("hex"));
}

describe("PeerEndpoint", () => {
	test("prefers the renamed shared state variable and accepts the legacy alias", () => {
		delete process.env.PI_PEER_STATE_DIR;
		process.env.MULTI_PI_STATE_DIR = "/tmp/legacy-peer-state";
		expect(defaultPeerStateRoot()).toBe("/tmp/legacy-peer-state");
		process.env.PI_PEER_STATE_DIR = "/tmp/current-peer-state";
		expect(defaultPeerStateRoot()).toBe("/tmp/current-peer-state");
	});

	test("publishes live private registrations and resolves IDs, prefixes, and names", () => {
		const stateRoot = root();
		const first = new PeerEndpoint(stateRoot, process.pid, () => new Date("2026-08-27T10:00:00Z"), "11111111-1111-4111-8111-111111111111");
		const second = new PeerEndpoint(stateRoot, process.pid, () => new Date("2026-08-27T10:00:00Z"), "22222222-2222-4222-8222-222222222222");
		first.publish(publication("session-alpha", "Planner"));
		second.publish(publication("session-beta", "Worker"));

		expect(first.list().map((peer) => peer.sessionId)).toEqual(["session-alpha", "session-beta"]);
		expect(first.resolve("session-beta").sessionName).toBe("Worker");
		expect(first.resolve("session-b").sessionName).toBe("Worker");
		expect(first.resolve("worker").sessionId).toBe("session-beta");
		expect(statSync(stateRoot).mode & 0o777).toBe(0o700);
		const registration = first.list()[0];
		expect(registration.transcriptCursor).toBe("session-alpha-leaf");
	});

	test("queues and processes an addressed envelope once on the happy path", async () => {
		const stateRoot = root();
		const first = new PeerEndpoint(stateRoot, process.pid, undefined, "11111111-1111-4111-8111-111111111111");
		const second = new PeerEndpoint(stateRoot, process.pid, undefined, "22222222-2222-4222-8222-222222222222");
		first.publish(publication("session-alpha", "Planner"));
		second.publish(publication("session-beta", "Worker"));

		const sent = first.send({
			target: "Worker",
			kind: "result",
			message: "Authentication uses the shared verifier.",
			taskId: "auth-review",
		});
		const received: unknown[] = [];
		const targetInbox = inbox(stateRoot, "session-beta");
		expect(await second.receive((message) => {
			received.push(message);
			const files = readdirSync(targetInbox);
			expect(files).toHaveLength(1);
			expect(files[0]).toEndWith(`.${process.pid}.22222222-2222-4222-8222-222222222222.claim`);
		})).toBe(1);
		expect(await second.receive((message) => { received.push(message); })).toBe(0);
		expect(received).toEqual([sent]);
		expect(readdirSync(targetInbox)).toEqual([]);
		expect(readdirSync(stateRoot).sort()).toEqual(["inboxes", "reservations", "sessions"]);
		expect(sent.from).toEqual({ sessionId: "session-alpha", sessionName: "Planner" });
		expect(sent.delivery).toBe("followUp");
		expect(first.send({
			target: "Worker",
			kind: "steer",
			message: "Focus on the shared verifier.",
		}).delivery).toBe("steer");
	});

	test("atomically reserves the seventh direct-peer slot while another peer starts", async () => {
		const stateRoot = root();
		for (let index = 0; index < 6; index += 1) {
			const peer = new PeerEndpoint(stateRoot, process.pid, undefined, `${index}1111111-1111-4111-8111-111111111111`);
			peer.publish({
				...publication(`peer-${index}`, `Peer ${index}`),
				parentSessionId: "parent-session",
			});
		}
		const endpoint = new PeerEndpoint(stateRoot);
		const attempts = await Promise.allSettled([
			Promise.resolve().then(() => endpoint.reserveDirectPeer("parent-session")),
			Promise.resolve().then(() => endpoint.reserveDirectPeer("parent-session")),
		]);
		expect(attempts.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
		expect(attempts.filter(({ status }) => status === "rejected")).toHaveLength(1);
		const reservation = attempts.find((attempt) => attempt.status === "fulfilled") as PromiseFulfilledResult<string>;
		endpoint.releasePeerReservation(reservation.value);
		expect(endpoint.reserveDirectPeer("parent-session")).toBeString();
	});

	test("requeues handler failures and recovers claims from dead endpoints", async () => {
		const stateRoot = root();
		const first = new PeerEndpoint(stateRoot, process.pid, undefined, "11111111-1111-4111-8111-111111111111");
		const second = new PeerEndpoint(stateRoot, process.pid, undefined, "22222222-2222-4222-8222-222222222222");
		first.publish(publication("session-alpha", "Planner"));
		second.publish(publication("session-beta", "Worker"));
		const sent = first.send({ target: "Worker", kind: "result", message: "recover me" });

		expect(await second.receive(() => { throw new Error("not accepted"); })).toBe(0);
		const pendingDirectory = inbox(stateRoot, "session-beta");
		const pending = readdirSync(pendingDirectory).find((file) => file.endsWith(".json"));
		expect(pending).toBeDefined();
		renameSync(
			join(pendingDirectory, pending!),
			join(pendingDirectory, `${pending}.99999999.33333333-3333-4333-8333-333333333333.claim`),
		);

		const received: unknown[] = [];
		expect(await second.receive((message) => { received.push(message); })).toBe(1);
		expect(received).toEqual([sent]);
	});

	test("recovers inactive claims owned by the current endpoint", async () => {
		const stateRoot = root();
		const first = new PeerEndpoint(stateRoot, process.pid, undefined, "11111111-1111-4111-8111-111111111111");
		const second = new PeerEndpoint(stateRoot, process.pid, undefined, "22222222-2222-4222-8222-222222222222");
		first.publish(publication("session-alpha", "Planner"));
		second.publish(publication("session-beta", "Worker"));
		const sent = first.send({ target: "Worker", kind: "result", message: "retry my rollback" });
		const pendingDirectory = inbox(stateRoot, "session-beta");
		const pending = readdirSync(pendingDirectory).find((file) => file.endsWith(".json"))!;
		renameSync(
			join(pendingDirectory, pending),
			join(pendingDirectory, `${pending}.${process.pid}.22222222-2222-4222-8222-222222222222.claim`),
		);

		const received: unknown[] = [];
		expect(await second.receive((message) => { received.push(message); })).toBe(1);
		expect(received).toEqual([sent]);
		expect(readdirSync(pendingDirectory)).toEqual([]);
	});

	test("keeps registration ownership until an active claim settles during removal", async () => {
		const stateRoot = root();
		const first = new PeerEndpoint(stateRoot, process.pid, undefined, "11111111-1111-4111-8111-111111111111");
		const second = new PeerEndpoint(stateRoot, process.pid, undefined, "22222222-2222-4222-8222-222222222222");
		first.publish(publication("session-alpha", "Planner"));
		second.publish(publication("session-beta", "Worker"));
		first.send({ target: "Worker", kind: "result", message: "finish before removal" });
		let accept!: () => void;
		const accepting = new Promise<void>((resolve) => { accept = resolve; });
		let claimed!: () => void;
		const claimCreated = new Promise<void>((resolve) => { claimed = resolve; });
		const receiving = second.receive(async () => {
			claimed();
			await accepting;
		});
		await claimCreated;

		second.remove();
		expect(first.list().some((peer) => peer.sessionId === "session-beta")).toBeTrue();
		accept();
		expect(await receiving).toBe(1);
		expect(first.list().some((peer) => peer.sessionId === "session-beta")).toBeFalse();
		expect(readdirSync(inbox(stateRoot, "session-beta"))).toEqual([]);
	});

	test("preserves queued mail across clean shutdown and resumed session endpoints", async () => {
		const stateRoot = root();
		const first = new PeerEndpoint(stateRoot, process.pid, undefined, "11111111-1111-4111-8111-111111111111");
		const second = new PeerEndpoint(stateRoot, process.pid, undefined, "22222222-2222-4222-8222-222222222222");
		first.publish(publication("session-alpha", "Planner"));
		second.publish(publication("session-beta", "Worker"));
		const sent = first.send({ target: "Worker", kind: "result", message: "survive restart" });
		second.remove();

		const resumed = new PeerEndpoint(stateRoot, process.pid, undefined, "33333333-3333-4333-8333-333333333333");
		resumed.publish(publication("session-beta", "Worker"));
		const received: unknown[] = [];
		expect(await resumed.receive((message) => { received.push(message); })).toBe(1);
		expect(received).toEqual([sent]);
	});

	test("does not report stale registrations", () => {
		const stateRoot = root();
		let now = new Date("2026-08-27T10:00:00Z");
		const endpoint = new PeerEndpoint(stateRoot, process.pid, () => now, "11111111-1111-4111-8111-111111111111");
		endpoint.publish(publication("session-alpha", "Planner"));
		expect(endpoint.list()).toHaveLength(1);
		now = new Date(now.getTime() + PEER_STALE_MS + 1);
		expect(endpoint.list()).toHaveLength(0);
	});

	test("discards malformed inbox records instead of retrying them forever", async () => {
		const stateRoot = root();
		const endpointId = "11111111-1111-4111-8111-111111111111";
		const endpoint = new PeerEndpoint(stateRoot, process.pid, undefined, endpointId);
		endpoint.publish(publication("session-alpha", "Planner"));
		const endpointInbox = inbox(stateRoot, "session-alpha");
		writeFileSync(join(endpointInbox, "malformed.json"), "not json");
		expect(await endpoint.receive(() => { throw new Error("must not run"); })).toBe(0);
		expect(readdirSync(endpointInbox)).toEqual([]);
	});

	test("ignores oversized registration and envelope files before parsing", async () => {
		const stateRoot = root();
		const endpoint = new PeerEndpoint(stateRoot, process.pid, undefined, "11111111-1111-4111-8111-111111111111");
		endpoint.publish(publication("session-alpha", "Planner"));
		writeFileSync(join(stateRoot, "sessions", "oversized.json"), "x".repeat(2 * 1024 * 1024 + 1));
		expect(endpoint.list()).toHaveLength(1);

		const endpointInbox = inbox(stateRoot, "session-alpha");
		writeFileSync(join(endpointInbox, "oversized.json"), "x".repeat(256 * 1024 + 1));
		expect(await endpoint.receive(() => { throw new Error("must not run"); })).toBe(0);
		expect(readdirSync(endpointInbox)).toEqual([]);
	});

	test("rejects ambiguous names", () => {
		const stateRoot = root();
		const first = new PeerEndpoint(stateRoot, process.pid, undefined, "11111111-1111-4111-8111-111111111111");
		const second = new PeerEndpoint(stateRoot, process.pid, undefined, "22222222-2222-4222-8222-222222222222");
		first.publish(publication("session-alpha", "Worker"));
		second.publish(publication("session-beta", "Worker"));
		expect(() => first.resolve("Worker")).toThrow("ambiguous");
	});
});
