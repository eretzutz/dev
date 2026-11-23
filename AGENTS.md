# Agents in this repo

## Implementation plans are HTML pages

Every implementation plan written here is one self-contained HTML page,
`docs/<topic>/<slug>.html`, in the convention of the pages already in `docs/`
(for example `docs/mcp-board/plan-pages.html`): the request word for word in a
comment before `<html>`, then dated lines (measured, DECIDED, BUILT, UPDATE); a
left contents nav; a right at-a-glance panel; animated SVG data-flow and process
diagrams that stop for `prefers-reduced-motion`; light and dark. Do not write
the plan only in chat or as Markdown.

- The convention in full: `mcp-board/conventions/PLAN_DOC.md`.
- Start a page: `node mcp-board/cli.mjs new-doc docs/<topic>/<slug>.html "Title" "the request, word for word"`,
  then replace every placeholder.
- Check it until there are no E errors: `node mcp-board/cli.mjs check-doc docs/<topic>/<slug>.html`.
- A later iteration edits the same page: add a dated UPDATE line to the brief, never delete one.
- If the `board` MCP server is connected, use its tools instead: `get_prompt {name: "planner"}`,
  `plan_doc_template`, `check_plan_doc`, then `document_plan` with `doc`.

## mcp-board

After changing anything in `mcp-board/`, run `node mcp-board/smoke.mjs`. It also checks every
page in `docs/` against the rules.
