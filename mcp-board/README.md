# mcp-board

Shared **plan / progress / state / validation** board for multiple Claude Code (or any MCP) sessions.

Agents do not coordinate only through chat. They call tools:

| Role | Primary tools |
|------|----------------|
| Planner | `document_plan`, `list_followups`, `resolve_followup`, `update_plan_status` |
| Orchestrator | `get_plan`, `report_progress`, `set_state`, `request_followup` |
| Validator | `list_progress`, `submit_validation`, `request_followup` |

Persistence: `MCP_BOARD_PATH/board.json` (default `./.mcp-board/board.json`). Writes are file-locked and atomic, so concurrent sessions on one machine are safe; reads take no lock and never write.

## Install / run

No npm dependencies. Node 18+.

```bash
# from this directory
node server.mjs                       # stdio MCP server (Claude Code spawns this)
node cli.mjs summary                  # human view of the board
node cli.mjs call get_board_summary   # any tool from a shell (JSON args, or - for stdin)
node smoke.mjs                        # end-to-end check over stdio (npm test)
```

## Claude Code config

Per project, without a checked-in file (`-s local` keeps it in `~/.claude.json` for this directory):

```bash
claude mcp add board -s local \
  -e MCP_BOARD_PATH=/absolute/path/to/your-repo/.mcp-board \
  -- node /absolute/path/to/mcp-board/server.mjs
claude mcp list        # board: … ✓ Connected
```

or a project `.mcp.json` / user `~/.claude.json`:

```json
{
  "mcpServers": {
    "board": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-board/server.mjs"],
      "env": {
        "MCP_BOARD_PATH": "/absolute/path/to/your-repo/.mcp-board"
      }
    }
  }
}
```

Point **every** role session at the **same** `MCP_BOARD_PATH` so they share one board. A session loads its MCP servers when it starts: restart a running session after adding the server. Sub-agents it spawns get the same tools.

## Suggested session setup

The role prompts are served as MCP prompts, so in Claude Code each session starts with one command:

1. Terminal A — Planner: `/mcp__board__planner`
2. Terminal B — Orchestrator: `/mcp__board__orchestrator`
3. Terminal C — Validator: `/mcp__board__validator`

They come from `prompts/*.md`, or from `MCP_BOARD_PROMPTS` when a project has its own (the file name, lower-cased, is the prompt's name). All three use the same repo (or worktrees) and the same board.

## Workflow

```
Planner:  get_board_summary → document_plan → update_plan_status(active)
Orchestrator: get_plan → report_progress* → set_state* → update_plan_status(validating)
Validator: get_plan + list_progress → submit_validation
  if fail → request_followup
Planner:  list_followups → resolve_followup / document_plan (next iteration)
```

## A project's own source of truth: the hook

`MCP_BOARD_HOOK` is a command (split on whitespace, no shell) that sees every `report_progress`, `request_followup`, `resolve_followup` and `submit_validation` **before** the board records it. It gets `{tool, args, plan, step, followup}` as JSON on stdin.

- Exit 0 accepts. Its stdout is kept on the record as `hook`; if it prints a JSON object, its `note` is kept, and a follow-up also keeps its `ref` (an id in the project's own system).
- Any other exit refuses. Nothing is recorded, and the caller's error carries the hook's stderr/stdout.

So a project can refuse `done` until its evidence exists, mirror events into its own ledger, or give questions the ids its reports use. Without a hook, the board records whatever it is told.

## Tool reference (short)

- **document_plan** — create/replace plan (`title`, `goal`, `steps[]`, `acceptance[]`); replacing keeps the status of steps whose id is unchanged; a step may carry an initial `status`
- **get_plan / list_plans / update_plan_status**
- **report_progress** — step events (`started|working|blocked|done|failed|skipped`)
- **set_state / get_state / list_state** — key/value facts (plan-scoped or global)
- **submit_validation / list_validations**
- **request_followup / list_followups / resolve_followup** — only priority `blocking` sets the plan `blocked`
- **get_board_summary** — start-of-session snapshot, with open and recently resolved follow-ups

## Env

| Variable | Meaning |
|----------|---------|
| `MCP_BOARD_PATH` | Directory for `board.json` (created if missing) |
| `MCP_BOARD_HOOK` | Command that may refuse or annotate writes (above) |
| `MCP_BOARD_HOOK_CWD` | Working directory for the hook |
| `MCP_BOARD_HOOK_TIMEOUT_MS` | Hook timeout (default 120000) |
| `MCP_BOARD_PROMPTS` | Directory of role prompts (default `./prompts`) |

## Changes in 1.1.0

- Replies are one JSON message per line, as MCP's stdio transport requires. 1.0.0 sent `Content-Length:` frames, which Claude Code can't read, so it never connected. Content-Length input is still accepted.
- `initialize` agrees on the client's protocol version and advertises prompts.
- Reads no longer rewrite the board. Writes are atomic, and a dead process's lock is taken over at once instead of after a 5 s wait.
- The hook, `cli.mjs call`, step statuses kept across `document_plan`, and follow-ups that don't block the plan unless they say so.
