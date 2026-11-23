# Plan pages: the convention for every plan on the board

Every plan on this board is also an HTML page that a person reads: `docs/<topic>/<slug>.html` in the
project, one self-contained file. The board's plan is the checklist; the page is the plan, with the
reasoning, the measurements and the decisions the steps leave out.

## Make one

1. `plan_doc_template` {path, title, brief}. The brief is the request, word for word, then anything
   already measured or decided. It goes into the page's leading comment.
2. Fill the page in. Replace every placeholder and keep the structure:
   - **Brief**: the comment before `<html>`. The request verbatim, then dated lines, newest last:
     `measured 22 Nov 2026: ...`, `DECIDED 22 Nov 2026: ...`, `BUILT ...`, `UPDATE ...`. It is the
     page's history; never delete a line from it, correct it with a later one. An HTML comment
     cannot hold two hyphens in a row, so a `--` in the request is written `- -`.
   - **Left panel**: contents, a `<nav>` linking every section. It is scroll-spied.
   - **Centre**: title, lede, status tags with absolute dates; then Summary (Today / What we found /
     Plan), Data flow, Process, Steps, Acceptance, What is verified, Limits and risks, Files, Open
     questions. Add sections the plan needs (alternatives, tooling, what an earlier attempt got wrong).
   - **Steps**: the same steps as `document_plan`, with the same titles, each ending in a
     "Done when" a validator can run.
   - **Right panel**: an `<aside>`, "At a glance": the key facts (paths, ports, commands), what is
     still to do, and the diagram legend.
   - **Diagrams**: inline SVG, at least a data flow and a process. Draw the real mechanism, not boxes
     for their own sake. Flows are marching dashes (`class="flow req|res|bad"`), tokens move along
     them (`animateMotion`), each diagram has `<title>` and `<desc>`, and colours come from the page's
     tokens so light, dark and print all work.
   - **Motion that stops**: the Pause button, and `prefers-reduced-motion` stops it.
   - **One file**: no external scripts, stylesheets or fonts.
3. `check_plan_doc` {path} until there are no E errors. Look at the W warnings too.
4. `document_plan` {..., doc: path}.

## Keep it current

- A new iteration edits the same page first: a dated UPDATE line in the brief, the sections that
  changed, the steps. Then `document_plan` {plan_id, ...}; the doc is kept.
- When the plan is done, write what was verified (from the validation) into "What is verified", and
  move the status tags. `get_board_summary` shows the page as `behind` until you do.
- Dates are absolute (22 Nov 2026), never "today" or "yesterday".

## Style

Plain, short sentences. Say what was measured, how, and when. A table where things compare, a
diagram where things move. Keep the decisions, what was rejected, and why. Tags: `ok`, `bad`, `unk`
(gap, not yet), `acc` (recommended).

## Rules (check_plan_doc)

E rules fail a page; W rules are advice.

{{RULES}}
