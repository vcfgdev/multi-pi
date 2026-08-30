import { createPeerLauncher, peerPaneTitle, removePeerLauncher } from "./launcher.ts";
import type { SpawnPeerInput } from "./mux.ts";
import { type CommandRunner, defaultCommandRunner } from "./zellij.ts";

export async function spawnCmuxPeer(
	input: SpawnPeerInput,
	runner: CommandRunner = defaultCommandRunner,
): Promise<{ paneId: string }> {
	const workspace = process.env.CMUX_WORKSPACE_ID;
	const sourceSurface = process.env.CMUX_SURFACE_ID;
	if (!process.env.CMUX_SOCKET_PATH || !workspace || !sourceSurface) {
		throw new Error("pi-peer spawn must run inside a cmux surface");
	}

	const launcher = createPeerLauncher(input);
	try {
		let source = sourceSurface;
		let direction = input.direction;
		if (!direction) {
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
			const sourceFrame = sourcePane?.pixel_frame as { x?: number } | undefined;
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
			const anchor = rightColumn[0];
			if (anchor) {
				const selectedSurface = anchor.selected_surface_ref ?? anchor.selected_surface_id;
				if (typeof selectedSurface === "string") source = selectedSurface;
				direction = "down";
			} else {
				direction = "right";
			}
		}
		const parameters = {
			workspace_id: workspace,
			surface_id: source,
			direction: direction ?? "right",
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

		await runner.run("cmux", ["rename-tab", "--surface", paneId, peerPaneTitle(input)]);
		return { paneId };
	} catch (error) {
		removePeerLauncher(launcher);
		throw error;
	}
}
