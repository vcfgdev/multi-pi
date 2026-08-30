import { execFile } from "node:child_process";
import { createPeerLauncher, peerPaneTitle, removePeerLauncher } from "./launcher.ts";
import type { SpawnPeerInput } from "./mux.ts";
import { MAX_RIGHT_COLUMN_PEERS, PeerPaneCleanupError } from "./protocol.ts";

export interface CommandRunner {
	run(command: string, args: string[], options?: { env?: NodeJS.ProcessEnv }): Promise<{ stdout: string }>;
}

export const defaultCommandRunner: CommandRunner = {
	run: (command, args, options) => new Promise((resolve, reject) => {
		execFile(command, args, { maxBuffer: 1024 * 1024, ...options }, (error, stdout) => {
			if (error) reject(error);
			else resolve({ stdout });
		});
	}),
};

interface ZellijPane {
	id: number;
	is_plugin: boolean;
	is_floating: boolean;
	tab_id: number;
	pane_x: number;
	pane_y: number;
	pane_rows?: number;
}

async function listPanes(runner: CommandRunner): Promise<ZellijPane[]> {
	return JSON.parse((await runner.run("zellij", ["action", "list-panes", "--json"])).stdout) as ZellijPane[];
}

function panesInColumn(panes: ZellijPane[], sourceId: number, column: "source" | "right"): ZellijPane[] {
	const source = panes.find((pane) => !pane.is_plugin && pane.id === sourceId);
	if (!source) return [];
	return panes.filter((pane) => !pane.is_plugin && !pane.is_floating && pane.tab_id === source.tab_id
		&& (column === "right" ? pane.pane_x > source.pane_x : pane.pane_x === source.pane_x))
		.sort((a, b) => a.pane_y - b.pane_y);
}

async function balanceColumn(
	runner: CommandRunner,
	sourceId: number,
	column: "source" | "right",
	expectedPaneCount: number,
): Promise<void> {
	let columnPanes = panesInColumn(await listPanes(runner), sourceId, column);
	if (columnPanes.length < expectedPaneCount) throw new Error("Zellij did not return the created pane geometry");
	if (columnPanes.length < 2) return;
	if (columnPanes.some((pane) => pane.pane_rows === undefined)) throw new Error("Zellij did not return pane geometry for balancing");
	for (let index = 0; index < columnPanes.length - 1; index += 1) {
		const paneId = columnPanes[index]!.id;
		let previousDistance: number | undefined;
		let previousResize: "increase" | "decrease" | undefined;
		for (let attempt = 0; attempt < 25; attempt += 1) {
			columnPanes = panesInColumn(await listPanes(runner), sourceId, column);
			const pane = columnPanes.find((candidate) => candidate.id === paneId);
			if (!pane || pane.pane_rows === undefined || columnPanes.some((candidate) => candidate.pane_rows === undefined)) {
				throw new Error("Zellij did not return stable pane geometry while balancing");
			}
			const top = columnPanes[0]!.pane_y;
			const bottom = Math.max(...columnPanes.map((candidate) => candidate.pane_y + candidate.pane_rows!));
			const height = bottom - top;
			if (height <= 0) throw new Error("Zellij returned invalid pane geometry while balancing");
			const currentBoundary = pane.pane_y + pane.pane_rows;
			const targetBoundary = top + height * (index + 1) / columnPanes.length;
			const distance = Math.abs(targetBoundary - currentBoundary);
			if (previousDistance !== undefined && distance >= previousDistance) {
				if (distance > previousDistance && previousResize) {
					const inverse = previousResize === "increase" ? "decrease" : "increase";
					await runner.run("zellij", ["action", "resize", inverse, "down", "--pane-id", `terminal_${pane.id}`]);
				}
				break;
			}
			if (distance <= 1) break;
			const resize = currentBoundary < targetBoundary ? "increase" : "decrease";
			await runner.run("zellij", ["action", "resize", resize, "down", "--pane-id", `terminal_${pane.id}`]);
			previousDistance = distance;
			previousResize = resize;
		}
	}
	columnPanes = panesInColumn(await listPanes(runner), sourceId, column);
	if (columnPanes.some((pane) => pane.pane_rows === undefined)) throw new Error("Zellij did not return pane geometry after balancing");
	const heights = columnPanes.map((pane) => pane.pane_rows!);
	const tolerance = Math.ceil(heights.reduce((sum, height) => sum + height, 0) * 0.05) + 1;
	if (Math.max(...heights) - Math.min(...heights) > tolerance) throw new Error("Zellij could not balance peer panes");
}

export async function spawnZellijPeer(
	input: SpawnPeerInput,
	runner: CommandRunner = defaultCommandRunner,
): Promise<{ paneId: string }> {
	if ((!process.env.ZELLIJ && !process.env.ZELLIJ_SESSION_NAME) || !process.env.ZELLIJ_PANE_ID) {
		throw new Error("pi-peer spawn requires a Zellij 0.45+ pane");
	}
	const versionOutput = (await runner.run("zellij", ["--version"])).stdout.trim();
	const version = /zellij\s+(\d+)\.(\d+)(?:\.(\d+))?/.exec(versionOutput);
	if (!version || Number(version[1]) === 0 && Number(version[2]) < 45) {
		throw new Error("pi-peer spawn requires Zellij 0.45 or newer");
	}
	let anchorPaneId: number | undefined;
	let direction: "right" | "down" = "right";
	const panes = await listPanes(runner);
	const sourceId = Number(process.env.ZELLIJ_PANE_ID);
	const source = panes.find((pane) => !pane.is_plugin && pane.id === sourceId);
	const rightColumn = source
		? panes.filter((pane) => !pane.is_plugin && !pane.is_floating && pane.tab_id === source.tab_id && pane.pane_x > source.pane_x)
			.sort((a, b) => b.pane_y - a.pane_y)
		: [];
	const sourceColumn = source
		? panes.filter((pane) => !pane.is_plugin && !pane.is_floating && pane.tab_id === source.tab_id
			&& pane.pane_x === source.pane_x && pane.pane_y > source.pane_y)
			.sort((a, b) => b.pane_y - a.pane_y)
		: [];
	if (rightColumn.length >= MAX_RIGHT_COLUMN_PEERS) {
		anchorPaneId = sourceColumn[0]?.id ?? source?.id;
		direction = "down";
	} else if (rightColumn[0]) {
		anchorPaneId = rightColumn[0].id;
		direction = "down";
	}
	const launcher = createPeerLauncher(input);
	const args = ["run", "--no-focus", "--close-on-exit", "--cwd", input.cwd, "--name", peerPaneTitle(input)];
	args.push("--direction", direction);
	args.push("--", "sh", launcher.path);
	try {
		const result = await runner.run("zellij", args, anchorPaneId === undefined ? undefined : {
			env: { ...process.env, ZELLIJ_PANE_ID: String(anchorPaneId) },
		});
		const paneId = result.stdout.trim();
		if (!paneId) throw new Error("Zellij did not return the created pane ID; Zellij 0.45+ is required");
		try {
			const useRightColumn = rightColumn.length < MAX_RIGHT_COLUMN_PEERS;
			await balanceColumn(runner, sourceId, useRightColumn ? "right" : "source",
				useRightColumn ? rightColumn.length + 1 : sourceColumn.length + 2);
		} catch (error) {
			try {
				await runner.run("zellij", ["action", "close-pane", "--pane-id", paneId]);
			} catch (cleanupError) {
				throw new PeerPaneCleanupError(`Zellij pane ${paneId} still exists after balancing failed`, { cause: cleanupError });
			}
			throw error;
		}
		return { paneId };
	} catch (error) {
		removePeerLauncher(launcher);
		throw error;
	}
}
