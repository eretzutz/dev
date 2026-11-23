# mcp-board

Shared **plan / progress / state / validation** board for multiple Claude Code, Copilot CLI (or any MCP) sessions. Every plan also has a **page**: an HTML file a person reads, in the project's plan-page convention.

Agents do not coordinate only through chat. They call tools:

| Role | Primary tools |
|------|----------------|
| Planner | `plan_doc_template`, `check_plan_doc`, `document_plan`, `list_followups`, `resolve_followup`, `update_plan_status` |
| Orchestrator | `get_plan`, `report_progress`, `set_state`, `request_followup` |
| Validator | `list_progress`, `check_plan_doc`, `submit_validation`, `request_followup` |

Persistence: `MCP_BOARD_PATH/board.json` (default `./.mcp-board/board.json`). Writes are file-locked and atomic, so concurrent sessions on one machine are safe; reads take no lock and never write.

## Install / run

No npm dependencies. Node 18+.

```bash
# from this directory
node server.mjs                       # stdio MCP server (Claude Code spawns this)
node cli.mjs summary                  # human view of the board
node cli.mjs call get_board_summary   # any tool from a shell (JSON args, or - for stdin)
node cli.mjs check-doc docs/x/y.html  # check plan pages; exit 1 on an E error
node cli.mjs new-doc docs/x/y.html "Title" "the request"   # start a plan page
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

## Copilot CLI and other MCP clients

The board is a plain stdio MCP server, so any client can use it. Copilot CLI reads the same `.mcp.json` from the project (once the folder is trusted); `"type": "stdio"` suits both it and Claude Code, and setting the docs root makes plan pages land in the project whatever directory the client starts the server in:

```json
{
  "mcpServers": {
    "board": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/mcp-board/server.mjs"],
      "env": {
        "MCP_BOARD_PATH": "/absolute/path/to/your-repo/.mcp-board",
        "MCP_BOARD_DOCS_ROOT": "/absolute/path/to/your-repo"
      }
    }
  }
}
```

(`copilot mcp add board --env MCP_BOARD_PATH=… --env MCP_BOARD_DOCS_ROOT=… -- node …/server.mjs` does the same in the user config, which every project shares.)

Clients differ in what they pass to the model, so the board says everything that matters through its tools too:

| How the model learns it | Claude Code | Copilot CLI | Any MCP client |
|-------------------------|-------------|-------------|----------------|
| The server's `initialize` instructions | system prompt, every turn | only for allowlisted servers, or with `--allow-all-mcp-server-instructions` | varies |
| Role prompts as MCP prompts | `/mcp__board__planner` | not documented | varies |
| `get_prompt {name}`: the same prompts, as a tool | yes | yes | yes |
| `get_board_summary`'s `instructions`: the same instructions | yes | yes | yes |
| `document_plan`'s description and result: the page rule | yes | yes | yes |

So in Copilot CLI a role session starts with:

```bash
copilot -i 'Be the planner on the board: call its get_prompt tool with {"name": "planner"} and follow it.'
```

and `orchestrator` or `validator` likewise. Without a role, asking for a plan "on the board" is enough: the tools lead to the page.

A request that doesn't mention the board reaches none of this. For that, put the rule in the project's `AGENTS.md` (Copilot CLI, Codex and others read it; Claude Code reads `CLAUDE.md`, which can import it with `@AGENTS.md`), for example:

```markdown
Implementation plans go on the board (MCP server `board`): every plan is an HTML page,
docs/<topic>/<slug>.html. Call get_prompt {name: "planner"} and follow it.
```

## Suggested session setup

The role prompts are served as MCP prompts, so in Claude Code each session starts with one command:

1. Terminal A — Planner: `/mcp__board__planner`
2. Terminal B — Orchestrator: `/mcp__board__orchestrator`
3. Terminal C — Validator: `/mcp__board__validator`

They come from `prompts/*.md`, or from `MCP_BOARD_PROMPTS` when a project has its own (the file name, lower-cased, is the prompt's name). All three use the same repo (or worktrees) and the same board. A fourth, `/mcp__board__plan_doc`, is the plan-page convention (`conventions/PLAN_DOC.md`); it is served beside a project's own prompts too, unless that folder has a `PLAN_DOC.md` of its own. The `get_prompt` tool serves the same prompts to clients that don't offer MCP prompts (below).

## Workflow

```
Planner:  get_board_summary → plan_doc_template → (fill in the page) → check_plan_doc
          → document_plan {doc} → update_plan_status(active)
Orchestrator: get_plan (read the page) → report_progress* → set_state* → update_plan_status(validating)
Validator: get_plan + list_progress + check_plan_doc → submit_validation
  if fail → request_followup
Planner:  list_followups → (edit the same page) → resolve_followup / document_plan (next iteration)
```

## Plan pages

A plan on the board is a checklist. Its page is the plan a person reads: `docs/<topic>/<slug>.html`, one self-contained file, with the request kept word for word in a leading comment, a left contents nav, a right at-a-glance panel, and animated data-flow and process diagrams. The convention is the one set by this repo's `../docs` pages; `conventions/PLAN_DOC.md` says it in words and `plandoc.mjs` checks it:

| Rule | The page has |
|------|--------------|
| E1 | `<!doctype html>` and a `<title>` naming the plan |
| E2 | the brief: a comment before `<html>` with the request verbatim, then dated lines |
| E3 | left panel: a `<nav>` with 3+ links, each to an id on the page |
| E4 | right panel: an `<aside>` outside that nav |
| E5 | an inline SVG diagram that moves (SMIL or CSS keyframes) |
| E6 | `prefers-reduced-motion` |
| W1–W6 | dark mode, a pause button, diagram titles, a data flow and a process, no external files, absolute dates |
| W7 | the page changed when the plan's steps did |
| W8 | every step title on the board appears in the page |

E rules fail a page; W rules are advice. Class names don't matter: the rules look for features.

- `plan_doc_template {path, title, brief}` writes `templates/plan.html`, filled in, to a new file under the docs root. It never overwrites.
- `check_plan_doc {path | plan_id}` runs the rules. Read-only.
- `document_plan {…, doc}` checks the page and keeps `doc` (path, sha256, errors, warnings) on the plan, adds one acceptance item (`plan page … passes check_plan_doc and says what was built`), and answers with `plan_doc`: `missing`, `failing` (with `next`) or `ok`. A replace without `doc` keeps the page.
- `MCP_BOARD_PLAN_DOC`: `warn` (default) records every plan and says what is missing; `require` refuses a plan without a passing page and records nothing; `off` ignores pages.
- `get_plan`, `list_plans` and `get_board_summary` show each plan's `page` as it is now: `missing`, `failing`, `ok`, or `behind` (validated, and the page not touched since). `submit_validation` remembers the page's hash for that.

Why the server says it, not only the planner prompt: a role prompt is read once, when someone runs it, and is summarized away by `/compact`; projects with their own `MCP_BOARD_PROMPTS` never see the default one. The server's `initialize` instructions, which Claude Code keeps in every session's system prompt, carry the rule instead, and `document_plan`'s description and result repeat it at the moment a plan is recorded. Clients that leave the instructions out (Copilot CLI, unless told otherwise) get them in `get_board_summary`'s result.

## A project's own source of truth: the hook

`MCP_BOARD_HOOK` is a command (split on whitespace, no shell) that sees every `report_progress`, `request_followup`, `resolve_followup` and `submit_validation` **before** the board records it. It gets `{tool, args, plan, step, followup}` as JSON on stdin.

- Exit 0 accepts. Its stdout is kept on the record as `hook`; if it prints a JSON object, its `note` is kept, and a follow-up also keeps its `ref` (an id in the project's own system).
- Any other exit refuses. Nothing is recorded, and the caller's error carries the hook's stderr/stdout.

So a project can refuse `done` until its evidence exists, mirror events into its own ledger, or give questions the ids its reports use. Without a hook, the board records whatever it is told.

## Tool reference (short)

- **document_plan** — create/replace plan (`title`, `goal`, `steps[]`, `acceptance[]`, `doc`); replacing keeps the status of steps whose id is unchanged, and the page; a step may carry an initial `status`
- **plan_doc_template / check_plan_doc** — start a plan page; check one (by path or plan)
- **get_plan / list_plans / update_plan_status**
- **report_progress** — step events (`started|working|blocked|done|failed|skipped`)
- **set_state / get_state / list_state** — key/value facts (plan-scoped or global)
- **submit_validation / list_validations**
- **request_followup / list_followups / resolve_followup** — only priority `blocking` sets the plan `blocked`
- **get_board_summary** — start-of-session snapshot: the board's instructions, then plans with their pages, open and recently resolved follow-ups
- **get_prompt** — a role prompt or `plan_doc` by `name`, or the list without one; for clients without MCP prompts

## Env

| Variable | Meaning |
|----------|---------|
| `MCP_BOARD_PATH` | Directory for `board.json` (created if missing) |
| `MCP_BOARD_HOOK` | Command that may refuse or annotate writes (above) |
| `MCP_BOARD_HOOK_CWD` | Working directory for the hook |
| `MCP_BOARD_HOOK_TIMEOUT_MS` | Hook timeout (default 120000) |
| `MCP_BOARD_PROMPTS` | Directory of role prompts (default `./prompts`) |
| `MCP_BOARD_PLAN_DOC` | `warn` (default), `require` or `off`: what `document_plan` does with a plan that has no passing page |
| `MCP_BOARD_DOCS_ROOT` | What a page's path is relative to (default `MCP_BOARD_HOOK_CWD`, else the working directory); `get_board_summary` shows it |

## Changes in 1.3.0

- For clients other than Claude Code: `get_prompt` serves the role prompts and `plan_doc` as a tool, and `get_board_summary` starts with the server's instructions. Copilot CLI leaves out the instructions of servers it hasn't allowlisted, and doesn't document MCP prompts.
- The instructions, `plan_doc_template` and `document_plan`'s reminders point to `get_prompt {name: "plan_doc"}` rather than to the prompt.
- The prompts and instructions moved from `server.mjs` to `prompts.mjs`, shared with the tools.

## Changes in 1.2.0

- Plan pages: `plandoc.mjs` (the rules), `templates/plan.html` (a starter page that passes them), `conventions/PLAN_DOC.md` (prompt `plan_doc`).
- `document_plan` takes `doc`; `MCP_BOARD_PLAN_DOC` (`warn` by default) decides what happens without a passing page. New tools `plan_doc_template` and `check_plan_doc`; `cli.mjs check-doc` and `new-doc`.
- The server's instructions name the page, so a planner that never ran its role prompt, or ran `/compact`, still knows.
- Reads show each plan's `page`; `submit_validation` remembers the page's hash, so a page not updated after validation shows as `behind`.

## Changes in 1.1.0

- Replies are one JSON message per line, as MCP's stdio transport requires. 1.0.0 sent `Content-Length:` frames, which Claude Code can't read, so it never connected. Content-Length input is still accepted.
- `initialize` agrees on the client's protocol version and advertises prompts.
- Reads no longer rewrite the board. Writes are atomic, and a dead process's lock is taken over at once instead of after a 5 s wait.
- The hook, `cli.mjs call`, step statuses kept across `document_plan`, and follow-ups that don't block the plan unless they say so.
