import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { delimiter, resolve } from "node:path";
import {
	PEER_HEARTBEAT_MS,
	PeerEndpoint,
	type PeerActivity,
	type PeerEnvelope,
	type PeerPublication,
	type PeerRegistration,
} from "../src/protocol.ts";
import { contextMessages, normalizeTranscript } from "../src/transcript.ts";

const INBOX_POLL_MS = 250;
const PEER_WIDGET_ID = "multi-pi";
const PEER_WIDGET_OFFLINE_MS = 20_000;
const PEER_WIDGET_SPINNER_MS = 80;
const PEER_WIDGET_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const PEER_LINEAGE_ENTRY = "multi-pi-lineage";

interface PeerLineage {
	version: 1;
	parentSessionId: string;
	taskId?: string;
}

interface PeerEndpointLike {
	publish(publication: PeerPublication): PeerRegistration;
	list(): PeerRegistration[];
	receive(handler: (envelope: PeerEnvelope) => Promise<void> | void): Promise<number>;
	remove(): void;
}

export interface MultiPiDependencies {
	endpoint?: PeerEndpointLike;
	now?: () => number;
}

function modelName(ctx: ExtensionContext): string | undefined {
	return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
}

function muxIdentity(): PeerPublication["mux"] | undefined {
	if (process.env.CMUX_SOCKET_PATH) {
		return {
			kind: "cmux",
			...(process.env.CMUX_WORKSPACE_ID ? { session: process.env.CMUX_WORKSPACE_ID } : {}),
			...(process.env.CMUX_SURFACE_ID ? { paneId: process.env.CMUX_SURFACE_ID } : {}),
		};
	}
	if (process.env.ZELLIJ || process.env.ZELLIJ_SESSION_NAME) {
		return {
			kind: "zellij",
			...(process.env.ZELLIJ_SESSION_NAME ? { session: process.env.ZELLIJ_SESSION_NAME } : {}),
			...(process.env.ZELLIJ_PANE_ID ? { paneId: process.env.ZELLIJ_PANE_ID } : {}),
		};
	}
	if (process.env.TMUX) {
		return {
			kind: "tmux",
			...(process.env.TMUX_PANE ? { paneId: process.env.TMUX_PANE } : {}),
		};
	}
	return undefined;
}

function inboundPrompt(envelope: PeerEnvelope, guidance?: string): string {
	const sender = envelope.from.sessionName
		? `${envelope.from.sessionName} (${envelope.from.sessionId})`
		: envelope.from.sessionId;
	return [
		"---",
		`[Pi peer ${envelope.kind}]`,
		`Message: ${envelope.id}`,
		`From: ${sender}`,
		...(envelope.taskId ? [`Task: ${envelope.taskId}`] : []),
		"---",
		envelope.message,
		...(guidance ? ["", "[Peer coordination]", guidance] : []),
	].join("\n");
}

function formatElapsed(startedAt: string, now: number): string {
	const totalMinutes = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 60_000));
	if (totalMinutes < 1) return "<1m";
	const days = Math.floor(totalMinutes / (24 * 60));
	const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
	const minutes = totalMinutes % 60;
	return [days ? `${days}d` : "", hours ? `${hours}h` : "", minutes ? `${minutes}m` : ""].join("");
}

function borderedLine(left: string, right: string, width: number, accent: (text: string) => string): string {
	if (width <= 0) return "";
	if (width === 1) return accent("│");
	const contentWidth = width - 2;
	const rightWidth = visibleWidth(right);
	if (rightWidth >= contentWidth) {
		const truncated = truncateToWidth(right, contentWidth);
		return `${accent("│")}${truncated}${" ".repeat(contentWidth - visibleWidth(truncated))}${accent("│")}`;
	}
	const truncated = truncateToWidth(left, contentWidth - rightWidth);
	const padding = contentWidth - visibleWidth(truncated) - rightWidth;
	return `${accent("│")}${truncated}${" ".repeat(padding)}${right}${accent("│")}`;
}

function borderedTop(title: string, info: string, width: number, accent: (text: string) => string): string {
	if (width <= 0) return "";
	if (width === 1) return accent("╭");
	const innerWidth = width - 2;
	const titlePart = `─ ${title} `;
	const infoPart = ` ${info} ─`;
	const content = `${titlePart}${"─".repeat(Math.max(0, innerWidth - titlePart.length - infoPart.length))}${infoPart}`
		.slice(0, innerWidth)
		.padEnd(innerWidth, "─");
	return accent(`╭${content}╮`);
}

function borderedBottom(width: number, accent: (text: string) => string): string {
	if (width <= 0) return "";
	if (width === 1) return accent("╰");
	return accent(`╰${"─".repeat(width - 2)}╯`);
}

function peerStatus(peer: PeerRegistration, offline: boolean, spinner: string): string {
	if (offline) return " offline ";
	if (peer.activity === "tool") {
		const tools = peer.activeTools.slice(0, 3).join(", ");
		return tools ? ` ${spinner} running · ${tools} ` : ` ${spinner} running · tool `;
	}
	return peer.activity === "thinking" ? ` ${spinner} thinking ` : " idle ";
}

function renderPeerWidgetLines(
	children: Array<{ peer: PeerRegistration; missingSince?: number }>,
	width: number,
	now: number,
	spinner: string,
	accent: (text: string) => string,
): string[] {
	const count = children.length;
	const lines = [borderedTop("Peers", `${count} ${count === 1 ? "peer" : "peers"}`, width, accent)];
	for (const { peer, missingSince } of children) {
		const elapsed = formatElapsed(peer.startedAt, now);
		const name = peer.sessionName ?? peer.sessionId.slice(0, 8);
		lines.push(borderedLine(` age ${elapsed}  ${name} `, peerStatus(peer, missingSince !== undefined, accent(spinner)), width, accent));
	}
	lines.push(borderedBottom(width, accent));
	return lines;
}

function boundedLineageString(value: unknown, maxLength: number): string | undefined {
	return typeof value === "string"
		&& value.length > 0
		&& value.length <= maxLength
		&& !/[\r\n]/.test(value)
		? value
		: undefined;
}

function parseLineage(value: unknown): PeerLineage | undefined {
	if (!value || typeof value !== "object") return undefined;
	const data = value as Record<string, unknown>;
	const parentSessionId = boundedLineageString(data.parentSessionId, 200);
	if (data.version !== 1 || !parentSessionId) return undefined;
	const taskId = boundedLineageString(data.taskId, 200);
	return { version: 1, parentSessionId, ...(taskId ? { taskId } : {}) };
}

function persistedLineage(ctx: ExtensionContext): PeerLineage | undefined {
	const entries = ctx.sessionManager.getEntries();
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry.type !== "custom" || entry.customType !== PEER_LINEAGE_ENTRY) continue;
		const lineage = parseLineage(entry.data);
		if (lineage) return lineage;
	}
	return undefined;
}

function environmentLineage(): PeerLineage | undefined {
	return parseLineage({
		version: 1,
		parentSessionId: process.env.PI_PEER_PARENT_SESSION_ID ?? process.env.PI_PEER_PARENT,
		taskId: process.env.PI_PEER_TASK_ID,
	});
}

function exposeLineage(lineage: PeerLineage | undefined): void {
	if (!lineage) {
		delete process.env.PI_PEER_PARENT_SESSION_ID;
		delete process.env.PI_PEER_PARENT;
		delete process.env.PI_PEER_TASK_ID;
		return;
	}
	process.env.PI_PEER_PARENT_SESSION_ID = lineage.parentSessionId;
	process.env.PI_PEER_PARENT = lineage.parentSessionId;
	if (lineage.taskId) process.env.PI_PEER_TASK_ID = lineage.taskId;
	else delete process.env.PI_PEER_TASK_ID;
}

function exposeCli(): void {
	const binDirectory = resolve(import.meta.dirname, "..", "bin");
	const path = process.env.PATH?.split(delimiter) ?? [];
	if (!path.includes(binDirectory)) process.env.PATH = [binDirectory, ...path].join(delimiter);
}

export default function multiPi(pi: ExtensionAPI, dependencies: MultiPiDependencies = {}): void {
	exposeCli();
	const endpoint = dependencies.endpoint ?? new PeerEndpoint();
	const now = dependencies.now ?? Date.now;
	const activeTools = new Map<string, string>();
	let activity: PeerActivity = "idle";
	let lineage: PeerLineage | undefined;
	let currentContext: ExtensionContext | undefined;
	let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
	let inboxTimer: ReturnType<typeof setInterval> | undefined;
	let transcriptTimer: ReturnType<typeof setTimeout> | undefined;
	let widgetSpinnerTimer: ReturnType<typeof setInterval> | undefined;
	let widgetSpinnerFrame = 0;
	let requestWidgetRender: (() => void) | undefined;
	let receiveTask: Promise<void> | undefined;
	const derivedPeers = new Map<string, { peer: PeerRegistration; missingSince?: number }>();

	function stopWidgetSpinner(): void {
		if (widgetSpinnerTimer) clearInterval(widgetSpinnerTimer);
		widgetSpinnerTimer = undefined;
		widgetSpinnerFrame = 0;
		requestWidgetRender = undefined;
	}

	function startWidgetSpinner(): void {
		if (widgetSpinnerTimer) return;
		widgetSpinnerTimer = setInterval(() => {
			widgetSpinnerFrame = (widgetSpinnerFrame + 1) % PEER_WIDGET_SPINNER_FRAMES.length;
			requestWidgetRender?.();
		}, PEER_WIDGET_SPINNER_MS);
		widgetSpinnerTimer.unref?.();
	}

	function renderPeerWidget(ctx: ExtensionContext): void {
		const currentSessionId = ctx.sessionManager.getSessionId();
		const liveChildren = endpoint.list().filter((peer) => peer.parentSessionId === currentSessionId);
		const liveSessionIds = new Set(liveChildren.map((peer) => peer.sessionId));
		const renderedAt = now();
		for (const peer of liveChildren) derivedPeers.set(peer.sessionId, { peer });
		for (const [sessionId, child] of derivedPeers) {
			if (liveSessionIds.has(sessionId)) continue;
			if (child.missingSince === undefined) child.missingSince = renderedAt;
			else if (renderedAt - child.missingSince >= PEER_WIDGET_OFFLINE_MS) derivedPeers.delete(sessionId);
		}

		const children = [...derivedPeers.values()].sort((left, right) =>
			left.peer.startedAt.localeCompare(right.peer.startedAt));
		if (children.length === 0) {
			stopWidgetSpinner();
			ctx.ui.setWidget(PEER_WIDGET_ID, undefined);
			return;
		}
		if (children.some(({ peer, missingSince }) => missingSince === undefined && peer.activity !== "idle")) {
			startWidgetSpinner();
		} else {
			stopWidgetSpinner();
		}
		ctx.ui.setWidget(PEER_WIDGET_ID, (tui, theme) => ({
			invalidate() {},
			render(width: number) {
				requestWidgetRender = () => tui.requestRender();
				return renderPeerWidgetLines(
					children,
					width,
					now(),
					PEER_WIDGET_SPINNER_FRAMES[widgetSpinnerFrame]!,
					(text) => theme.fg("accent", text),
				);
			},
		}), { placement: "aboveEditor" });
	}

	function restoreLineage(ctx: ExtensionContext, reason: "startup" | "reload" | "new" | "resume" | "fork"): void {
		const stored = persistedLineage(ctx);
		lineage = stored;
		if (!stored && reason === "startup") {
			const inherited = environmentLineage();
			if (inherited) {
				lineage = inherited;
				pi.appendEntry(PEER_LINEAGE_ENTRY, inherited);
			}
		}
		exposeLineage(lineage);
	}

	function publication(ctx: ExtensionContext): PeerPublication {
		const usage = ctx.getContextUsage();
		const messages = contextMessages(ctx.sessionManager.buildContextEntries());
		return {
			sessionId: ctx.sessionManager.getSessionId(),
			sessionName: ctx.sessionManager.getSessionName(),
			cwd: ctx.cwd,
			model: modelName(ctx),
			activity,
			activeTools: [...activeTools.values()],
			...(usage ? { context: usage } : {}),
			...(lineage ? { parentSessionId: lineage.parentSessionId } : {}),
			...(lineage?.taskId ? { taskId: lineage.taskId } : {}),
			...(muxIdentity() ? { mux: muxIdentity() } : {}),
			transcript: normalizeTranscript(messages),
			...(ctx.sessionManager.getLeafId() ? { transcriptCursor: ctx.sessionManager.getLeafId()! } : {}),
		};
	}

	function publish(ctx: ExtensionContext): void {
		currentContext = ctx;
		try {
			endpoint.publish(publication(ctx));
		} catch {
			// Presence publication must never break the interactive session.
		}
		renderPeerWidget(ctx);
	}

	function publishAfterPersistence(ctx: ExtensionContext): void {
		if (transcriptTimer) clearTimeout(transcriptTimer);
		transcriptTimer = setTimeout(() => {
			transcriptTimer = undefined;
			publish(ctx);
		}, 0);
		transcriptTimer.unref?.();
	}

	function receiveMessages(): Promise<void> {
		if (receiveTask) return receiveTask;
		receiveTask = endpoint.receive(async (envelope) => {
			const hasOtherChildren = envelope.kind === "result"
				&& [...derivedPeers.values()].some(({ peer, missingSince }) =>
					missingSince === undefined && peer.sessionId !== envelope.from.sessionId);
			await pi.sendUserMessage(
				inboundPrompt(
					envelope,
					hasOtherChildren
						? "Other spawned peers are live. If they still owe results, inspect each once with pi-peer, remind an idle peer once with pi-peer send, and do not poll."
						: undefined,
				),
				{ deliverAs: envelope.delivery },
			);
		}).then(() => undefined).finally(() => {
			receiveTask = undefined;
		});
		return receiveTask;
	}

	function startTimers(ctx: ExtensionContext): void {
		if (!heartbeatTimer) {
			heartbeatTimer = setInterval(() => {
				if (currentContext) publish(currentContext);
			}, PEER_HEARTBEAT_MS);
			heartbeatTimer.unref?.();
		}
		if (!inboxTimer) {
			inboxTimer = setInterval(() => void receiveMessages(), INBOX_POLL_MS);
			inboxTimer.unref?.();
		}
		publish(ctx);
		void receiveMessages();
	}

	pi.on("before_agent_start", async (event, ctx) => {
		const currentLineage = lineage;
		if (!currentLineage) return;
		const parent = currentLineage.parentSessionId;
		const task = currentLineage.taskId;
		return {
			systemPrompt: `${event.systemPrompt}\n\nYou are an interactive Pi peer delegated by session ${parent}.${task ? ` Task ID: ${task}.` : ""}\nUse pi-peer send for essential questions and final results; normal responses stay in this pane. Remain available for human steering.`,
		};
	});

	pi.on("session_start", async (event, ctx) => {
		activity = "idle";
		activeTools.clear();
		derivedPeers.clear();
		restoreLineage(ctx, event.reason);
		startTimers(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		derivedPeers.clear();
		publish(ctx);
	});

	pi.on("agent_start", async (_event, ctx) => {
		activity = "thinking";
		publish(ctx);
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		activeTools.set(event.toolCallId, event.toolName);
		activity = "tool";
		publish(ctx);
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		activeTools.delete(event.toolCallId);
		activity = activeTools.size > 0 ? "tool" : "thinking";
		publishAfterPersistence(ctx);
	});

	pi.on("message_end", async (_event, ctx) => publishAfterPersistence(ctx));

	pi.on("model_select", async (_event, ctx) => publish(ctx));

	pi.on("agent_settled", async (_event, ctx) => {
		activity = "idle";
		activeTools.clear();
		publishAfterPersistence(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (inboxTimer) clearInterval(inboxTimer);
		inboxTimer = undefined;
		await receiveTask;
		if (heartbeatTimer) clearInterval(heartbeatTimer);
		if (transcriptTimer) clearTimeout(transcriptTimer);
		stopWidgetSpinner();
		heartbeatTimer = undefined;
		transcriptTimer = undefined;
		lineage = undefined;
		currentContext = undefined;
		derivedPeers.clear();
		ctx.ui.setWidget(PEER_WIDGET_ID, undefined);
		endpoint.remove();
	});
}
