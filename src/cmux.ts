import { createPeerLauncher, peerPaneTitle, removePeerLauncher } from "./launcher.ts";
import { type CommandRunner, defaultCommandRunner, type SpawnPeerInput } from "./zellij.ts";

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
		const parameters = {
			workspace_id: workspace,
			surface_id: sourceSurface,
			direction: input.direction ?? "right",
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
