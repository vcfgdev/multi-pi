import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createPeerLauncher, removePeerLauncher } from "./launcher.ts";

const names = [
	"PI_SESSION_ID",
	"PI_SESSION_FILE",
	"PI_PROVIDER",
	"PI_MODEL",
	"PI_REASONING_LEVEL",
	"PI_PEER_PARENT_SESSION_ID",
	"PI_PEER_PARENT",
	"PI_PEER_TASK_ID",
	"TMUX_SESSION_NAME",
] as const;
const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));

afterEach(() => {
	for (const name of names) {
		const value = original[name];
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
});

describe("createPeerLauncher", () => {
	test("removes caller metadata and assigns only the direct child lineage", () => {
		process.env.PI_SESSION_ID = "caller";
		process.env.PI_SESSION_FILE = "/tmp/caller.jsonl";
		process.env.PI_PROVIDER = "anthropic";
		process.env.PI_MODEL = "caller-model";
		process.env.PI_REASONING_LEVEL = "high";
		process.env.PI_PEER_PARENT_SESSION_ID = "grandparent";
		process.env.PI_PEER_PARENT = "legacy-grandparent";
		process.env.PI_PEER_TASK_ID = "caller-task";
		process.env.TMUX_SESSION_NAME = "caller-mux-session";
		const launcher = createPeerLauncher({
			prompt: "child task",
			parentSessionId: "caller",
			cwd: "/workspace/project",
			name: "child-task",
		});
		const script = readFileSync(launcher.path, "utf8");
		expect(script).toContain("'PI_PEER_PARENT_SESSION_ID=caller'");
		expect(script).toContain("'PI_PEER_PARENT=caller'");
		expect(script).toContain("'PI_PEER_TASK_ID=child-task'");
		expect(script).not.toContain("grandparent");
		expect(script).not.toContain("caller-model");
		expect(script).not.toContain("/tmp/caller.jsonl");
		expect(script).not.toContain("caller-mux-session");
		removePeerLauncher(launcher);
	});

	test("does not invent lineage for a root session", () => {
		const launcher = createPeerLauncher({ prompt: "root task", cwd: "/tmp", name: "root" });
		const command = readFileSync(launcher.path, "utf8").split("exec ")[1]!;
		expect(command).not.toContain("PI_PEER_PARENT_SESSION_ID=");
		expect(command).not.toContain("PI_PEER_PARENT=");
		expect(command).not.toContain("PI_PEER_TASK_ID=");
		removePeerLauncher(launcher);
	});
});
