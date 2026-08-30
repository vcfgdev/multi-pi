import { afterEach, describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import multiPi from "../extensions/index.ts";
import type { PeerEnvelope, PeerPublication, PeerRegistration } from "./protocol.ts";

const lineageVariables = ["PI_PEER_PARENT_SESSION_ID", "PI_PEER_PARENT", "PI_PEER_RESERVATION_ID", "PI_PEER_TASK_ID"] as const;
const originalEnvironment = Object.fromEntries(lineageVariables.map((name) => [name, process.env[name]]));

afterEach(() => {
	for (const name of lineageVariables) {
		const value = originalEnvironment[name];
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
});

function registration(overrides: Partial<PeerRegistration> = {}): PeerRegistration {
	return {
		version: 2,
		endpointId: "22222222-2222-4222-8222-222222222222",
		sessionId: "target-session",
		sessionName: "Reviewer",
		pid: process.pid,
		cwd: "/workspace/project",
		workspace: "project",
		startedAt: "2026-08-27T10:00:00Z",
		heartbeatAt: "2026-08-27T10:00:01Z",
		activity: "idle",
		activeTools: [],
		parentSessionId: "current-session",
		transcript: [{ sequence: 1, role: "assistant", text: "Review complete" }],
		...overrides,
	};
}

describe("multi-pi runtime extension", () => {
	test("registers no tools while publishing presence, delivering mail, and showing child status", async () => {
		process.env.PI_PEER_PARENT_SESSION_ID = "parent-session";
		process.env.PI_PEER_PARENT = "legacy-parent";
		process.env.PI_PEER_RESERVATION_ID = "33333333-3333-4333-8333-333333333333";
		process.env.PI_PEER_TASK_ID = "task-7";
		const handlers = new Map<string, (event: any, ctx: any) => Promise<any>>();
		const publications: PeerPublication[] = [];
		const userMessages: Array<{ content: string; options: unknown }> = [];
		const appendedEntries: Array<{ customType: string; data: unknown }> = [];
		type WidgetFactory = (
			tui: { requestRender(): void },
			theme: { fg(color: string, text: string): string },
		) => { render(width: number): string[] };
		const widgets = new Map<string, WidgetFactory | undefined>();
		const widgetOptions = new Map<string, unknown>();
		let receiver: ((envelope: PeerEnvelope) => Promise<void> | void) | undefined;
		let removed = false;
		const releasedReservations: string[] = [];
		let widgetRenderRequests = 0;
		let widgetNow = Date.parse("2026-08-27T10:01:00Z");
		let entries: any[] = [{ type: "message", message: { role: "user", content: "Initial task" } }];
		const child = registration();
		let listedPeers = [child];
		const endpoint = {
			publish(publication: PeerPublication) {
				publications.push(structuredClone(publication));
				return registration({ sessionId: publication.sessionId, transcript: publication.transcript });
			},
			list: () => listedPeers,
			async receive(handler: (envelope: PeerEnvelope) => Promise<void> | void) {
				receiver = handler;
				return 0;
			},
			releasePeerReservation(id: string) { releasedReservations.push(id); },
			remove() { removed = true; },
		};
		const pi = {
			registerTool() { throw new Error("runtime extension must not register tools"); },
			on(name: string, handler: (event: any, ctx: any) => Promise<any>) { handlers.set(name, handler); },
			sendUserMessage(content: string, options: unknown) { userMessages.push({ content, options }); },
			appendEntry(customType: string, data: unknown) {
				appendedEntries.push({ customType, data });
				entries.push({ type: "custom", customType, data });
			},
		};
		const ctx = {
			cwd: "/workspace/project",
			model: { provider: "anthropic", id: "sonnet" },
			ui: {
				setWidget(id: string, content: WidgetFactory | undefined, options?: unknown) {
					widgets.set(id, content);
					widgetOptions.set(id, options);
				},
			},
			getContextUsage: () => ({ tokens: 100, contextWindow: 1000, percent: 10 }),
			sessionManager: {
				getSessionId: () => "current-session",
				getSessionName: () => "Current",
				getLeafId: () => "current-leaf",
				getEntries: () => entries,
				buildContextEntries: () => entries,
			},
		};
		multiPi(pi as never, { endpoint, now: () => widgetNow });
		const emit = async (name: string, event: any = {}) => handlers.get(name)?.(event, ctx);
		const renderWidget = (width = 48) => widgets.get("multi-pi")?.(
			{ requestRender: () => { widgetRenderRequests += 1; } },
			{ fg: (_color, text) => text },
		).render(width);

		await emit("session_start", { reason: "startup" });
		expect(publications.at(-1)).toMatchObject({
			sessionId: "current-session",
			activity: "idle",
			parentSessionId: "parent-session",
			taskId: "task-7",
			transcript: [{ role: "user", text: "Initial task" }],
		});
		expect(appendedEntries).toEqual([{
			customType: "multi-pi-lineage",
			data: { version: 1, parentSessionId: "parent-session", taskId: "task-7" },
		}]);
		expect(process.env.PI_PEER_PARENT_SESSION_ID).toBe("parent-session");
		expect(process.env.PI_PEER_PARENT).toBe("parent-session");
		expect(releasedReservations).toEqual(["33333333-3333-4333-8333-333333333333"]);
		expect(process.env.PI_PEER_RESERVATION_ID).toBeUndefined();
		expect(typeof widgets.get("multi-pi")).toBe("function");
		expect(widgetOptions.get("multi-pi")).toEqual({ placement: "aboveEditor" });
		const idleWidget = renderWidget()!;
		expect(idleWidget).toHaveLength(3);
		expect(idleWidget[0]).toContain("─ Peers ");
		expect(idleWidget[1]).toContain(" age 1m  Reviewer ");
		expect(idleWidget[1]).toEndWith(" idle │");

		child.activity = "thinking";
		await emit("agent_start");
		const thinkingWidget = renderWidget()!;
		expect(thinkingWidget[1]).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] thinking │$/);
		await Bun.sleep(100);
		expect(widgetRenderRequests).toBeGreaterThan(0);
		child.activity = "tool";
		child.activeTools = ["read"];
		await emit("tool_execution_start", { toolCallId: "read-1", toolName: "read" });
		expect(publications.at(-1)).toMatchObject({ activity: "tool", activeTools: ["read"] });
		expect(renderWidget()![1]).toEndWith(" running · read │");
		expect(renderWidget(12)!.every((line) => visibleWidth(line) === 12)).toBeTrue();
		await receiver?.({
			version: 2,
			id: "incoming-1",
			targetSessionId: "current-session",
			targetEndpointId: "11111111-1111-4111-8111-111111111111",
			from: { sessionId: "sender", sessionName: "Planner" },
			kind: "question",
			delivery: "followUp",
			message: "Which verifier is active?",
			taskId: "Planner",
			sentAt: "2026-08-27T10:00:03Z",
		});
		expect(userMessages.at(-1)).toEqual({
			content: "---\nKind: pi-peer-question\nFrom: \"Planner (sender)\"\n---\nWhich verifier is active?",
			options: { deliverAs: "followUp" },
		});
		await receiver?.({
			version: 2,
			id: "incoming-2",
			targetSessionId: "current-session",
			targetEndpointId: "11111111-1111-4111-8111-111111111111",
			from: { sessionId: "sender", sessionName: "Planner" },
			kind: "result",
			delivery: "steer",
			message: "The refresh path is safe.",
			taskId: "task-7",
			sentAt: "2026-08-27T10:00:04Z",
		});
		expect(userMessages.at(-1)).toEqual({
			content: "---\nKind: pi-peer-result\nFrom: \"Planner (sender)\"\nTaskID: \"task-7\"\nPeerStatus: \"alive (Reviewer)\"\n---\nThe refresh path is safe.",
			options: { deliverAs: "steer" },
		});
		const guidance = await emit("before_agent_start", { systemPrompt: "base" });
		expect(guidance.systemPrompt).toContain("delegated by session parent-session");
		expect(guidance.systemPrompt).toContain("Use pi-peer send");

		entries = [...entries, { type: "message", message: { role: "assistant", content: "Found it." } }];
		await emit("message_end");
		await Bun.sleep(5);
		expect(publications.at(-1)?.transcript.at(-1)?.text).toBe("Found it.");

		listedPeers = [];
		await emit("model_select");
		expect(renderWidget()![1]).toEndWith(" offline │");
		widgetNow += 20_001;
		await emit("model_select");
		expect(widgets.get("multi-pi")).toBeUndefined();
		await emit("session_shutdown");
		expect(widgets.get("multi-pi")).toBeUndefined();
		expect(removed).toBeTrue();
	});

	test("accepts legacy-only parent lineage at child startup", async () => {
		delete process.env.PI_PEER_PARENT_SESSION_ID;
		process.env.PI_PEER_PARENT = "legacy-parent";
		process.env.PI_PEER_TASK_ID = "legacy-task";
		const handlers = new Map<string, (event: any, ctx: any) => Promise<any>>();
		const publications: PeerPublication[] = [];
		const appended: unknown[] = [];
		const pi = {
			registerTool() { throw new Error("runtime extension must not register tools"); },
			on(name: string, handler: (event: any, ctx: any) => Promise<any>) { handlers.set(name, handler); },
			sendUserMessage() {},
			appendEntry(_customType: string, data: unknown) { appended.push(data); },
		};
		const endpoint = {
			publish(publication: PeerPublication) {
				publications.push(structuredClone(publication));
				return registration();
			},
			list: () => [],
			async receive() { return 0; },
			remove() {},
		};
		const ctx = {
			cwd: "/workspace/project",
			model: undefined,
			ui: { setWidget() {} },
			getContextUsage: () => undefined,
			sessionManager: {
				getSessionId: () => "legacy-child",
				getSessionName: () => "Legacy child",
				getLeafId: () => undefined,
				getEntries: () => [],
				buildContextEntries: () => [],
			},
		};
		multiPi(pi as never, { endpoint });
		await handlers.get("session_start")?.({ reason: "startup" }, ctx);
		expect(publications.at(-1)).toMatchObject({ parentSessionId: "legacy-parent", taskId: "legacy-task" });
		expect(appended).toEqual([{ version: 1, parentSessionId: "legacy-parent", taskId: "legacy-task" }]);
		expect(process.env.PI_PEER_PARENT_SESSION_ID as string | undefined).toBe("legacy-parent");
		await handlers.get("session_shutdown")?.({}, ctx);
	});

	test("restores persisted lineage and clears stale lineage for a new root session", async () => {
		process.env.PI_PEER_PARENT_SESSION_ID = "stale-parent";
		process.env.PI_PEER_PARENT = "stale-legacy-parent";
		process.env.PI_PEER_TASK_ID = "stale-task";
		const handlers = new Map<string, (event: any, ctx: any) => Promise<any>>();
		const publications: PeerPublication[] = [];
		const entries: any[] = [{
			type: "custom",
			customType: "multi-pi-lineage",
			data: { version: 1, parentSessionId: "persisted-parent", taskId: "persisted-task" },
		}];
		const pi = {
			registerTool() { throw new Error("runtime extension must not register tools"); },
			on(name: string, handler: (event: any, ctx: any) => Promise<any>) { handlers.set(name, handler); },
			sendUserMessage() {},
			appendEntry() { throw new Error("resume must not append lineage"); },
		};
		const endpoint = {
			publish(publication: PeerPublication) {
				publications.push(structuredClone(publication));
				return registration();
			},
			list: () => [],
			async receive() { return 0; },
			remove() {},
		};
		const ctx = {
			cwd: "/workspace/project",
			model: undefined,
			ui: { setWidget() {} },
			getContextUsage: () => undefined,
			sessionManager: {
				getSessionId: () => "resumed-session",
				getSessionName: () => "Resumed",
				getLeafId: () => undefined,
				getEntries: () => entries,
				buildContextEntries: () => entries,
			},
		};
		multiPi(pi as never, { endpoint });
		const emit = async (name: string, event: any = {}) => handlers.get(name)?.(event, ctx);

		await emit("session_start", { reason: "resume" });
		expect(publications.at(-1)).toMatchObject({ parentSessionId: "persisted-parent", taskId: "persisted-task" });
		expect(process.env.PI_PEER_PARENT_SESSION_ID).toBe("persisted-parent");
		await emit("session_start", { reason: "fork" });
		expect(publications.at(-1)).toMatchObject({ parentSessionId: "persisted-parent", taskId: "persisted-task" });
		entries.length = 0;
		await emit("session_start", { reason: "new" });
		expect(publications.at(-1)).not.toHaveProperty("parentSessionId");
		expect(process.env.PI_PEER_PARENT_SESSION_ID).toBeUndefined();
		expect(process.env.PI_PEER_PARENT).toBeUndefined();
		expect(process.env.PI_PEER_TASK_ID).toBeUndefined();
		expect(await emit("before_agent_start", { systemPrompt: "base" })).toBeUndefined();
		await emit("session_shutdown");
	});
});
