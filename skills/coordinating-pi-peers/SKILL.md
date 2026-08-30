---
name: coordinating-pi-peers
description: Coordinates independently steerable Pi sessions in visible terminal panes. Use when work should be delegated in parallel, when inspecting, messaging, or closing a live Pi peer, or when returning a delegated result to a parent session.
compatibility: Requires the pi-peer CLI and Pi running inside cmux, Zellij 0.45+, or tmux for spawning.
---

# Coordinating Pi peers

Use Pi's Bash tool to run `pi-peer`. Run `pi-peer <command> --help` for exact
syntax instead of guessing flags.

Spawn a peer only for independently steerable work. Give it a concise name and
a self-contained task with scope, constraints, expected evidence, and return
shape. Provide long prompts on stdin rather than constructing fragile shell
quoting.

Put `pi-peer` options before `--` and Pi options after it. Include `bash` in a
restricted tool set so the peer can report with `pi-peer send`:

```sh
pi-peer spawn --name auth-review --cwd "$PWD" -- \
  --model sonnet:high --tools read,bash,grep --skill ./skills/review <<'EOF'
Review authentication changes and return verified findings.
EOF
```

`pi-peer` rejects Pi flags that replace the peer's identity or interactive
lifecycle.

The available operations are:

- `pi-peer spawn`: open a full interactive Pi session in a neighboring pane;
- `pi-peer list`: list live sessions and lifecycle status;
- `pi-peer inspect`: read bounded recent progress;
- `pi-peer send`: send a question, status, result, or steering instruction;
- `pi-peer close`: close one or all direct peers and their panes.

Spawned peers remain available for human steering. Do not poll them. Finish the
current turn and let results arrive through the runtime inbox. Inspect once when
a progress check is necessary, and remind an idle peer once if it still owes a
result.

When asked to close peers, use `pi-peer close <peer>` or `pi-peer close --all`.
Only direct children of the current session can be closed.

When this session was delegated, send essential questions and the final result
back with `pi-peer send --kind question` or `pi-peer send --kind result`; the
parent target is inferred. Normal assistant responses remain only in this pane.
