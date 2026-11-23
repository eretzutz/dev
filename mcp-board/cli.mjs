#!/usr/bin/env node
/**
 * The board from a shell:
 *   node cli.mjs summary              plans, steps, open follow-ups
 *   node cli.mjs raw | path           the whole board / its file
 *   node cli.mjs call <tool> [JSON|-] run one tool (- reads the JSON from stdin),
 *                                     with the same hook as the MCP server
 */
import fs from "node:fs";
import { BOARD_FILE, readBoard } from "./store.mjs";
import { callTool } from "./tools.mjs";

const [cmd = "summary", ...rest] = process.argv.slice(2);

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
  default:
    console.error("usage: node cli.mjs [summary|raw|path|call <tool> [JSON|-]]");
    process.exitCode = 2;
}
