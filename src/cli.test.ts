import { describe, expect, test } from "bun:test";
import { runCli, type CliDependencies } from "./cli.ts";
import type { PeerRegistration } from "./protocol.ts";

function registration(overrides: Partial<PeerRegistration> = {}): PeerRegistration {
	return {
		version: 2,
		endpointId: "11111111-1111-4111-8111-111111111111",
		sessionId: "current-session",
		sessionName: "Current",
		pid: process.pid,
		cwd: "/workspace/project",
		workspace: "project",
		startedAt: "2026-08-28T10:00:00Z",
		heartbeatAt: "2026-08-28T10:00:01Z",
		activity: "idle",
		activeTools: [],
		transcript: [],
		...overrides,
	};
}

function harness(environment: NodeJS.ProcessEnv = {}) {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const spawned: unknown[] = [];
	const sent: unknown[] = [];
	const current = registration();
	const reviewer = registration({
		endpointId: "22222222-2222-4222-8222-222222222222",
		sessionId: "review-session",
		sessionName: "Reviewer",
		activity: "thinking",
		parentSessionId: "current-session",
		transcript: [{ sequence: 1, role: "assistant", text: "Checking auth." }],
	});
	const dependencies: CliDependencies = {
		env: environment,
		cwd: () => "/workspace/project",
		readStdin: async () => "stdin body",
		spawn: async (input) => { spawned.push(input); return { paneId: "pane-9" }; },
		endpoint: {
			list: () => [current, reviewer],
			resolve: (target) => target.toLowerCase() === "reviewer" ? reviewer : current,
			sendFrom(sender, input) {
				sent.push({ sender, input });
				return { id: "message-1", kind: input.kind, delivery: input.delivery ?? "followUp" };
			},
		},
		stdout: (text) => stdout.push(text),
		stderr: (text) => stderr.push(text),
	};
	return { dependencies, stdout, stderr, spawned, sent };
}

describe("pi-peer CLI", () => {
	test("progressively discloses global and command help", async () => {
		const first = harness();
		expect(await runCli(["--help"], first.dependencies)).toBe(0);
		expect(first.stdout.join("")).toContain("pi-peer <command> --help");
		expect(first.stdout.join("")).not.toContain("--task-id");

		const second = harness();
		expect(await runCli(["send", "--help"], second.dependencies)).toBe(0);
		expect(second.stdout.join("")).toContain("--task-id");
	});

	test("spawns a direct child from PI_SESSION_ID and a root outside Pi", async () => {
		const nested = harness({ PI_SESSION_ID: "caller-session" });
		expect(await runCli([
			"spawn", "--name", "auth-review", "--direction", "right", "--model", "sonnet:high",
		], nested.dependencies)).toBe(0);
		expect(nested.spawned).toEqual([{
			prompt: "stdin body",
			name: "auth-review",
			cwd: "/workspace/project",
			direction: "right",
			model: "sonnet:high",
			parentSessionId: "caller-session",
		}]);

		const root = harness({});
		expect(await runCli(["spawn", "--name", "independent", "--prompt", "task", "--json"], root.dependencies)).toBe(0);
		expect(root.spawned).toEqual([{ prompt: "task", name: "independent", cwd: "/workspace/project" }]);
		expect(JSON.parse(root.stdout.join(""))).toMatchObject({ root: true, name: "independent" });
	});

	test("lists and inspects bounded peer state", async () => {
		const listed = harness();
		expect(await runCli(["list", "--json"], listed.dependencies)).toBe(0);
		expect(JSON.parse(listed.stdout.join("")).peers).toHaveLength(2);

		const inspected = harness();
		expect(await runCli(["inspect", "Reviewer", "--limit", "1", "--json"], inspected.dependencies)).toBe(0);
		expect(JSON.parse(inspected.stdout.join(""))).toMatchObject({
			peer: { name: "Reviewer", role: "peer", activity: "thinking" },
			transcript: [{ text: "Checking auth." }],
		});
	});

	test("sends to the persisted direct parent with caller identity and task metadata", async () => {
		const test = harness({
			PI_SESSION_ID: "current-session",
			PI_PEER_PARENT_SESSION_ID: "parent-session",
			PI_PEER_PARENT: "stale-parent",
			PI_PEER_TASK_ID: "task-7",
		});
		expect(await runCli(["send", "--kind", "result", "--json"], test.dependencies)).toBe(0);
		expect(test.sent).toEqual([{
			sender: expect.objectContaining({ sessionId: "current-session", sessionName: "Current" }),
			input: {
				target: "parent-session",
				kind: "result",
				message: "stdin body",
				taskId: "task-7",
				delivery: "steer",
			},
		}]);
		expect(JSON.parse(test.stdout.join(""))).toMatchObject({ queued: true, delivery: "steer" });

		const legacy = harness({ PI_SESSION_ID: "current-session", PI_PEER_PARENT: "legacy-parent" });
		expect(await runCli(["send", "--kind", "status", "--message", "Still working"], legacy.dependencies)).toBe(0);
		expect(legacy.sent).toEqual([{
			sender: expect.objectContaining({ sessionId: "current-session" }),
			input: { target: "legacy-parent", kind: "status", message: "Still working", delivery: "steer" },
		}]);
	});

	test("reports actionable argument errors", async () => {
		const test = harness();
		expect(await runCli(["spawn", "--name", "worker", "--direction", "left"], test.dependencies)).toBe(1);
		expect(test.stderr.join("")).toContain("--direction must be right or down");
	});
});
