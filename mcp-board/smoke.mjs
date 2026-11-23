#!/usr/bin/env node
/**
 * End-to-end check: starts server.mjs on a fresh board in a temp directory,
 * speaks MCP over stdio as Claude Code does (one JSON message per line), and
 * runs planner → orchestrator → validator through the tools, with a hook that
 * refuses one `done` and gives a follow-up a ref. Exits non-zero on failure.
 *   node smoke.mjs
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-board-smoke-"));
const hook = path.join(tmp, "hook.mjs");
fs.writeFileSync(
  hook,
  `import fs from "node:fs";
const p = JSON.parse(fs.readFileSync(0, "utf8"));
fs.appendFileSync(${JSON.stringify(path.join(tmp, "hook.log"))}, p.tool + "\\n");
if (p.tool === "report_progress" && p.args.status === "done" && p.args.step_id === "s2") {
  console.error("s2 has no evidence yet");
  process.exit(1);
}
if (p.tool === "request_followup") console.log(JSON.stringify({ ref: "q1", note: "asked as q1" }));
else console.log("ok " + p.tool);
`,
);

const server = spawn(process.execPath, [path.join(HERE, "server.mjs")], {
  env: { ...process.env, MCP_BOARD_PATH: tmp, MCP_BOARD_HOOK: `${process.execPath} ${hook}` },
  stdio: ["pipe", "pipe", "pipe"],
});

const pending = new Map();
let out = "";
server.stdout.on("data", (d) => {
  out += d;
  let nl;
  while ((nl = out.indexOf("\n")) !== -1) {
    const line = out.slice(0, nl);
    out = out.slice(nl + 1);
    assert.doesNotMatch(line, /^Content-Length/i, "replies must be one JSON message per line");
    const msg = JSON.parse(line);
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
  }
});

let nextId = 1;
function rpc(method, params, { framed = false } = {}) {
  const id = nextId++;
  const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
  server.stdin.write(framed ? `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}` : `${body}\n`);
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    setTimeout(() => reject(new Error(`no reply to ${method}`)), 15_000);
  });
}

async function tool(name, args) {
  const r = (await rpc("tools/call", { name, arguments: args })).result;
  return { error: !!r.isError, data: JSON.parse(r.content[0].text) };
}

try {
  const init = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0" },
  });
  assert.equal(init.result.protocolVersion, "2025-06-18");
  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

  const tools = (await rpc("tools/list", {})).result.tools.map((t) => t.name);
  assert.ok(tools.includes("report_progress") && tools.includes("get_board_summary"));
  const prompts = (await rpc("prompts/list", {}, { framed: true })).result.prompts.map((p) => p.name);
  assert.deepEqual(prompts, ["orchestrator", "planner", "validator"]);
  const got = (await rpc("prompts/get", { name: "orchestrator" })).result;
  assert.match(got.messages[0].content.text, /Orchestrator/);

  const plan = (
    await tool("document_plan", {
      title: "Smoke",
      goal: "verify board",
      steps: [{ id: "s1", title: "one" }, { id: "s2", title: "two" }],
      acceptance: ["both done"],
    })
  ).data.plan_id;
  assert.equal((await tool("report_progress", { plan_id: plan, step_id: "s1", agent: "o", status: "started", message: "go" })).error, false);
  const done1 = await tool("report_progress", { plan_id: plan, step_id: "s1", agent: "o", status: "done", message: "done", evidence: "x" });
  assert.equal(done1.data.hook, "ok report_progress");

  const refused = await tool("report_progress", { plan_id: plan, step_id: "s2", agent: "o", status: "done", message: "claimed" });
  assert.equal(refused.error, true);
  assert.match(refused.data.error, /s2 has no evidence yet/);

  const fu = (await tool("request_followup", { plan_id: plan, step_id: "s2", reason: "may I?", priority: "normal" })).data;
  assert.equal(fu.ref, "q1");
  let p = (await tool("get_plan", { plan_id: plan })).data;
  assert.equal(p.status, "in_progress", "a normal follow-up does not block the plan");
  assert.deepEqual(p.steps.map((s) => s.status), ["done", "pending"], "a refused event changes nothing");
  assert.equal((await tool("resolve_followup", { followup_id: fu.followup_id, resolution: "yes" })).data.status, "resolved");
  assert.equal((await tool("resolve_followup", { followup_id: fu.followup_id, resolution: "again" })).error, true);

  // Replacing the plan keeps step statuses.
  await tool("document_plan", { plan_id: plan, title: "Smoke", goal: "verify board", steps: [{ id: "s1", title: "one" }, { id: "s2", title: "two" }, { id: "s3", title: "three" }] });
  p = (await tool("get_plan", { plan_id: plan })).data;
  assert.deepEqual(p.steps.map((s) => s.status), ["done", "pending", "pending"]);

  const before = fs.statSync(path.join(tmp, "board.json")).mtimeMs;
  await tool("get_board_summary", {});
  assert.equal(fs.statSync(path.join(tmp, "board.json")).mtimeMs, before, "reads do not write the board");

  assert.equal((await tool("submit_validation", { plan_id: plan, passed: true, summary: "pass" })).data.passed, true);
  assert.equal((await tool("get_plan", { plan_id: plan })).data.status, "done");
  assert.equal((await rpc("nope/method", {})).error.code, -32601);
  assert.equal(fs.readFileSync(path.join(tmp, "hook.log"), "utf8").trim().split("\n").length, 6, "the hook saw every write but the double resolve");
  console.log("smoke: OK (handshake, tools, prompts, hook refusal and ref, follow-ups, plan replace, lock-free reads)");
} catch (e) {
  console.error(`smoke: FAILED: ${e.stack || e.message}`);
  process.exitCode = 1;
} finally {
  server.stdin.end();
  fs.rmSync(tmp, { recursive: true, force: true });
}
