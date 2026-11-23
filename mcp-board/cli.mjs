#!/usr/bin/env node
/**
 * The board from a shell:
 *   node cli.mjs summary                  plans, steps, pages, open follow-ups
 *   node cli.mjs raw | path               the whole board / its file
 *   node cli.mjs call <tool> [JSON|-]     run one tool (- reads the JSON from stdin),
 *                                         with the same hook as the MCP server
 *   node cli.mjs check-doc PATH...        check plan pages; exit 1 on an E error
 *   node cli.mjs new-doc PATH TITLE [BRIEF|-]
 *                                         start a plan page from the template
 * Paths given to check-doc and new-doc are relative to this shell's directory.
 */
import fs from "node:fs";
import path from "node:path";
import { inspectDoc } from "./plandoc.mjs";
import { BOARD_FILE, readBoard } from "./store.mjs";
import { callTool } from "./tools.mjs";

const [cmd = "summary", ...rest] = process.argv.slice(2);
const USAGE =
  "usage: node cli.mjs [summary|raw|path|call <tool> [JSON|-]|check-doc PATH...|new-doc PATH TITLE [BRIEF|-]]";

function print(x) {
  process.stdout.write(`${typeof x === "string" ? x : JSON.stringify(x, null, 2)}\n`);
}

switch (cmd) {
  case "path":
    print(BOARD_FILE);
    break;
  case "raw":
    print(readBoard());
    break;
  case "summary": {
    const board = readBoard();
    print({
      path: BOARD_FILE,
      updated_at: board.updated_at,
      plans: Object.values(board.plans).map((p) => ({
        plan_id: p.plan_id,
        title: p.title,
        status: p.status,
        doc: p.doc?.path ?? null,
        steps: p.steps.map((s) => `${s.id}:${s.status}`),
      })),
      progress_events: board.progress.length,
      open_followups: board.followups
        .filter((f) => f.status === "open")
        .map((f) => `${f.followup_id}${f.ref ? ` (${f.ref})` : ""}: ${f.reason}`),
      validations: board.validations.length,
    });
    break;
  }
  case "call": {
    const [tool, json] = rest;
    if (!tool) {
      console.error("usage: node cli.mjs call <tool> [JSON|-]");
      process.exit(2);
    }
    const args = JSON.parse(json === "-" ? fs.readFileSync(0, "utf8") : json || "{}");
    const result = callTool(tool, args);
    print(result.content.map((c) => c.text).join("\n"));
    process.exitCode = result.isError ? 1 : 0;
    break;
  }
  case "check-doc": {
    if (!rest.length) {
      console.error("usage: node cli.mjs check-doc PATH...");
      process.exit(2);
    }
    let failed = 0;
    for (const p of rest) {
      const page = inspectDoc(path.resolve(p));
      if (!page.ok) failed++;
      const counts = [
        page.errors.length && `${page.errors.length} error(s)`,
        page.warnings.length && `${page.warnings.length} warning(s)`,
      ].filter(Boolean);
      print(`${p}: ${counts.length ? counts.join(", ") : "ok"}`);
      for (const line of [...page.errors, ...page.warnings]) print(`  ${line}`);
    }
    process.exitCode = failed ? 1 : 0;
    break;
  }
  case "new-doc": {
    const [p, title, brief] = rest;
    if (!p || !title) {
      console.error("usage: node cli.mjs new-doc PATH TITLE [BRIEF|-]");
      process.exit(2);
    }
    const result = callTool("plan_doc_template", {
      path: path.resolve(p),
      title,
      brief: brief === "-" ? fs.readFileSync(0, "utf8") : brief || "TODO: the request, word for word",
    });
    print(result.content.map((c) => c.text).join("\n"));
    process.exitCode = result.isError ? 1 : 0;
    break;
  }
  default:
    console.error(USAGE);
    process.exitCode = 2;
}
