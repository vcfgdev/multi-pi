import { createPeerLauncher, peerPaneTitle, removePeerLauncher } from "./launcher.ts";
import type { SpawnPeerInput } from "./mux.ts";
import { MAX_RIGHT_COLUMN_PEERS, PeerPaneCleanupError } from "./protocol.ts";
import { type CommandRunner, defaultCommandRunner } from "./zellij.ts";

const MINIMUM_CMUX_VERSION = [0, 64, 11] as const;

function supportedCmuxVersion(output: string): boolean {
	const match = /^cmux (\d+)\.(\d+)\.(\d+)/.exec(output.trim());
	if (!match) return false;
	const version = match.slice(1).map(Number);
	for (let index = 0; index < MINIMUM_CMUX_VERSION.length; index += 1) {
		if (version[index]! > MINIMUM_CMUX_VERSION[index]!) return true;
		if (version[index]! < MINIMUM_CMUX_VERSION[index]!) return false;
	}
	return true;
}

export async function spawnCmuxPeer(
	input: SpawnPeerInput,
	runner: CommandRunner = defaultCommandRunner,
): Promise<{ paneId: string }> {
	const workspace = process.env.CMUX_WORKSPACE_ID;
	const sourceSurface = process.env.CMUX_SURFACE_ID;
	if (!process.env.CMUX_SOCKET_PATH || !workspace || !sourceSurface) {
		throw new Error("pi-peer spawn must run inside a cmux surface");
	}
	const version = (await runner.run("cmux", ["--version"])).stdout;
	if (!supportedCmuxVersion(version)) throw new Error("pi-peer spawn requires cmux 0.64.11 or newer");

	const launcher = createPeerLauncher(input);
	try {
		let source = sourceSurface;
		const surfacesResponse = JSON.parse((await runner.run("cmux", [
			"rpc", "surface.list", JSON.stringify({ workspace_id: workspace }),
		])).stdout) as { surfaces?: Array<Record<string, unknown>>; result?: { surfaces?: Array<Record<string, unknown>> } };
		const panesResponse = JSON.parse((await runner.run("cmux", [
			"rpc", "pane.list", JSON.stringify({ workspace_id: workspace }),
		])).stdout) as { panes?: Array<Record<string, unknown>>; result?: { panes?: Array<Record<string, unknown>> } };
		const surfaces = surfacesResponse.surfaces ?? surfacesResponse.result?.surfaces ?? [];
		const panes = panesResponse.panes ?? panesResponse.result?.panes ?? [];
		const sourcePaneRef = surfaces.find((surface) => surface.ref === sourceSurface || surface.id === sourceSurface)?.pane_ref;
		const sourcePane = panes.find((pane) => pane.ref === sourcePaneRef || pane.id === sourcePaneRef);
		const sourceFrame = sourcePane?.pixel_frame as { x?: number; y?: number } | undefined;
		const rightColumn = typeof sourceFrame?.x === "number"
			? panes.filter((pane) => {
				const frame = pane.pixel_frame as { x?: number } | undefined;
				return typeof frame?.x === "number" && frame.x > sourceFrame.x!;
			}).sort((a, b) => {
				const aFrame = a.pixel_frame as { y?: number } | undefined;
				const bFrame = b.pixel_frame as { y?: number } | undefined;
				return (bFrame?.y ?? 0) - (aFrame?.y ?? 0);
			})
			: [];
		const sourceColumn = typeof sourceFrame?.x === "number" && typeof sourceFrame.y === "number"
			? panes.filter((pane) => {
				const frame = pane.pixel_frame as { x?: number; y?: number } | undefined;
				return frame !== undefined && frame.x === sourceFrame.x
					&& typeof frame.y === "number" && frame.y > sourceFrame.y!;
			}).sort((a, b) => {
				const aFrame = a.pixel_frame as { y?: number } | undefined;
				const bFrame = b.pixel_frame as { y?: number } | undefined;
				return (bFrame?.y ?? 0) - (aFrame?.y ?? 0);
			})
			: [];
		const rightColumnHasRoom = rightColumn.length < MAX_RIGHT_COLUMN_PEERS;
		const anchor = rightColumnHasRoom ? rightColumn[0] : sourceColumn[0] ?? sourcePane;
		const direction = rightColumnHasRoom && !anchor ? "right" : "down";
		if (anchor) {
			const selectedSurface = anchor.selected_surface_ref ?? anchor.selected_surface_id;
			if (typeof selectedSurface === "string") source = selectedSurface;
		}
		const parameters = {
			workspace_id: workspace,
			surface_id: source,
			direction,
			type: "terminal",
			working_directory: input.cwd,
			initial_command: launcher.shellCommand,
			focus: false,
		};
		const result = await runner.run("cmux", ["rpc", "surface.split", JSON.stringify(parameters)]);
		let output: unknown;
		try {
			output = JSON.parse(result.stdout);
		} catch {
			throw new Error("cmux returned an invalid response when creating the split");
		}
		const response = output && typeof output === "object" ? output as Record<string, unknown> : {};
		const record = response.result && typeof response.result === "object"
			? response.result as Record<string, unknown>
			: response;
		const paneId = typeof record.surface_ref === "string"
			? record.surface_ref
			: typeof record.surface_id === "string" ? record.surface_id : undefined;
		if (!paneId) throw new Error("cmux did not return the created surface ID");

		try {
			await runner.run("cmux", ["rename-tab", "--surface", paneId, peerPaneTitle(input)]);
			const equalized = await runner.run("cmux", [
				"rpc", "workspace.equalize_splits", JSON.stringify({ workspace_id: workspace, orientation: "vertical" }),
			]);
			if (direction === "down") {
				const response = JSON.parse(equalized.stdout) as { equalized?: boolean; result?: { equalized?: boolean } };
				if ((response.result?.equalized ?? response.equalized) !== true) throw new Error("cmux could not equalize peer panes");
			}
		} catch (error) {
			try {
				await runner.run("cmux", ["close-surface", "--workspace", workspace, "--surface", paneId]);
			} catch (cleanupError) {
				throw new PeerPaneCleanupError(`cmux pane ${paneId} still exists after spawn setup failed`, { cause: cleanupError });
			}
			throw error;
		}
		return { paneId };
	} catch (error) {
		removePeerLauncher(launcher);
		throw error;
	}
}
