#!/usr/bin/env node
/**
 * End-to-end check: starts server.mjs on fresh boards in a temp directory,
 * speaks MCP over stdio as Claude Code does (one JSON message per line), and
 * runs planner → orchestrator → validator through the tools, with a hook that
 * refuses one `done` and gives a follow-up a ref. Then the plan pages: the
 * template, the check, document_plan in warn mode (the default) and, on a
 * second server, in require mode; and the rules against every page in
 * ../docs, when there is one. Exits non-zero on failure.
 *   node smoke.mjs
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkPlanDoc } from "./plandoc.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-board-smoke-"));
const repo = path.join(tmp, "repo");
fs.mkdirSync(path.join(repo, "docs", "smoke"), { recursive: true });
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

const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("MCP_BOARD_")));
const servers = [];

function start(env) {
  const server = spawn(process.execPath, [path.join(HERE, "server.mjs")], {
    env: { ...clean, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  servers.push(server);
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
      setTimeout(() => reject(new Error(`no reply to ${method}`)), 15_000).unref();
    });
  }
  async function tool(name, args) {
    const r = (await rpc("tools/call", { name, arguments: args })).result;
    return { error: !!r.isError, data: JSON.parse(r.content[0].text) };
  }
  async function init() {
    const r = await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "smoke", version: "0" },
    });
    server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    return r.result;
  }
  return { rpc, tool, init };
}

const rules = (list) => list.map((m) => m.slice(0, 2));

try {
  const boardA = path.join(tmp, "a");
  const { rpc, tool, init } = start({
    MCP_BOARD_PATH: boardA,
    MCP_BOARD_HOOK: `${process.execPath} ${hook}`,
    MCP_BOARD_DOCS_ROOT: repo,
  });
  const initA = await init();
  assert.equal(initA.protocolVersion, "2025-06-18");
  assert.match(initA.instructions, /plan_doc_template/, "1: the instructions carry the page rule");
  assert.match(initA.instructions, /\bdoc\b/);

  const tools = (await rpc("tools/list", {})).result.tools;
  const names = tools.map((t) => t.name);
  for (const n of ["report_progress", "get_board_summary", "plan_doc_template", "check_plan_doc"]) assert.ok(names.includes(n), n);
  assert.match(tools.find((t) => t.name === "document_plan").description, /pass doc/);
  const prompts = (await rpc("prompts/list", {}, { framed: true })).result.prompts.map((p) => p.name);
  assert.deepEqual(prompts, ["orchestrator", "plan_doc", "planner", "validator"]);
  const got = (await rpc("prompts/get", { name: "orchestrator" })).result;
  assert.match(got.messages[0].content.text, /Orchestrator/);
  const planDocPrompt = (await rpc("prompts/get", { name: "plan_doc" })).result.messages[0].content.text;
  assert.match(planDocPrompt, /\*\*E1\*\*/, "the plan_doc prompt lists the rules");
  assert.doesNotMatch(planDocPrompt, /\{\{RULES\}\}/);

  // ── The board as before; the plans have no page, so warn mode reminds. ──
  const first = await tool("document_plan", {
    title: "Smoke",
    goal: "verify board",
    steps: [{ id: "s1", title: "one" }, { id: "s2", title: "two" }],
    acceptance: ["both done"],
  });
  const plan = first.data.plan_id;
  assert.equal(first.error, false, "6: warn records a plan without a page");
  assert.equal(first.data.plan_doc.status, "missing");
  assert.match(first.data.plan_doc.next, /plan_doc_template/);
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
  assert.equal(p.page.status, "missing");
  assert.equal((await tool("resolve_followup", { followup_id: fu.followup_id, resolution: "yes" })).data.status, "resolved");
  assert.equal((await tool("resolve_followup", { followup_id: fu.followup_id, resolution: "again" })).error, true);

  // Replacing the plan keeps step statuses.
  await tool("document_plan", { plan_id: plan, title: "Smoke", goal: "verify board", steps: [{ id: "s1", title: "one" }, { id: "s2", title: "two" }, { id: "s3", title: "three" }] });
  p = (await tool("get_plan", { plan_id: plan })).data;
  assert.deepEqual(p.steps.map((s) => s.status), ["done", "pending", "pending"]);

  const boardFile = path.join(boardA, "board.json");
  let before = fs.statSync(boardFile).mtimeMs;
  await tool("get_board_summary", {});
  assert.equal(fs.statSync(boardFile).mtimeMs, before, "reads do not write the board");

  assert.equal((await tool("submit_validation", { plan_id: plan, passed: true, summary: "pass" })).data.passed, true);
  assert.equal((await tool("get_plan", { plan_id: plan })).data.status, "done");
  assert.equal((await rpc("nope/method", {})).error.code, -32601);
  assert.equal(fs.readFileSync(path.join(tmp, "hook.log"), "utf8").trim().split("\n").length, 6, "the hook saw every write but the double resolve");

  // ── Plan pages ──
  const brief = "- make the board smoke-test its pages --> and keep going\n- a second line";
  const made = await tool("plan_doc_template", { path: "docs/smoke/plan.html", title: "Smoke <plan>", brief });
  assert.equal(made.error, false, JSON.stringify(made.data));
  assert.equal(made.data.path, path.join("docs", "smoke", "plan.html"));
  const pagePath = path.join(repo, "docs", "smoke", "plan.html");
  let html = fs.readFileSync(pagePath, "utf8");
  assert.match(html, /<title>Smoke &lt;plan&gt;/, "3: the title is escaped");
  assert.equal(html.slice(0, html.indexOf("<html")).split("-->").length, 2, "3: a --> in the brief cannot end the comment");
  assert.match((await tool("plan_doc_template", { path: "docs/smoke/plan.html", title: "x", brief: "y" })).data.error, /exists/);
  assert.match((await tool("plan_doc_template", { path: "../x.html", title: "x", brief: "y" })).data.error, /outside the docs root/);
  assert.match((await tool("plan_doc_template", { path: "docs/x.md", title: "x", brief: "y" })).data.error, /\.html/);

  const fresh = (await tool("check_plan_doc", { path: "docs/smoke/plan.html" })).data;
  assert.equal(fresh.ok, true, `4: the starter page passes: ${fresh.errors}`);
  assert.deepEqual(fresh.warnings, []);

  fs.writeFileSync(
    path.join(repo, "docs", "smoke", "chat.html"),
    "<!doctype html><html><head><title>Chat plan</title></head><body><h1>Plan</h1><p>Do it.</p></body></html>",
  );
  const chat = (await tool("check_plan_doc", { path: "docs/smoke/chat.html" })).data;
  assert.deepEqual(rules(chat.errors), ["E2", "E3", "E4", "E5", "E6"], "5: a chat-style page fails");
  assert.ok(chat.rules.length >= 14);

  const failing = await tool("document_plan", { title: "Chat", goal: "g", steps: [{ title: "one" }], doc: "docs/smoke/chat.html" });
  assert.equal(failing.error, false, "7: warn records a plan whose page fails");
  assert.equal(failing.data.plan_doc.status, "failing");
  assert.match(failing.data.plan_doc.next, /Fix the page/);
  let summary = (await tool("get_board_summary", { plan_id: failing.data.plan_id })).data;
  assert.equal(summary.plans[0].page.status, "failing");
  assert.equal(summary.plan_doc_mode, "warn");
  assert.equal(summary.docs_root, repo);

  const titled = [{ id: "a", title: "Stand up the smoke page" }];
  const paged = await tool("document_plan", { title: "Paged", goal: "g", steps: titled, acceptance: ["x"], doc: "docs/smoke/plan.html" });
  const paid = paged.data.plan_id;
  assert.equal(paged.data.plan_doc.status, "ok");
  assert.deepEqual(rules(paged.data.plan_doc.warnings), ["W8"], "9: a step title missing from the page");
  const item = paged.data.plan.acceptance.at(-1);
  assert.match(item, /^plan page docs\/smoke\/plan\.html passes check_plan_doc/);

  const twoSteps = [...titled, { id: "b", title: "Check it twice" }];
  let replaced = (await tool("document_plan", { plan_id: paid, title: "Paged", goal: "g", steps: twoSteps, acceptance: ["x", item] })).data;
  assert.equal(replaced.plan.doc.path, path.join("docs", "smoke", "plan.html"), "a replace keeps the doc");
  assert.ok(rules(replaced.plan_doc.warnings).includes("W7"), "9: new steps, same page");
  assert.equal(replaced.plan.acceptance.filter((a) => a.startsWith("plan page ")).length, 1, "8: the page item appears once");

  html = fs.readFileSync(pagePath, "utf8").replace("First step title", "Stand up the smoke page").replace("Second step title", "Check it twice");
  fs.writeFileSync(pagePath, html);
  replaced = (await tool("document_plan", { plan_id: paid, title: "Paged", goal: "g", steps: twoSteps })).data;
  assert.deepEqual(replaced.plan_doc.warnings, [], "the page now names both steps");

  await tool("submit_validation", { plan_id: paid, passed: true, summary: "pass" });
  summary = (await tool("get_board_summary", { plan_id: paid })).data;
  assert.equal(summary.plans[0].page.status, "behind", "10: validated, page untouched");
  fs.writeFileSync(pagePath, html.replace("<em>Nothing yet.</em>", "<em>Verified 22 Nov 2026 by the smoke test.</em>"));
  before = fs.statSync(boardFile).mtimeMs;
  summary = (await tool("get_board_summary", { plan_id: paid })).data;
  assert.equal(summary.plans[0].page.status, "ok", "10: the page was updated after validation");
  assert.equal(summary.plans[0].page.changed, true);
  assert.equal(fs.statSync(boardFile).mtimeMs, before, "11: reading pages does not write the board");
  const listed = (await tool("list_plans", {})).data.plans.find((x) => x.plan_id === paid);
  assert.equal(listed.page, "ok");

  // ── require, on a second server with a prompts folder of its own ──
  const promptsB = path.join(tmp, "prompts-b");
  fs.mkdirSync(promptsB);
  fs.writeFileSync(path.join(promptsB, "PLANNER.md"), "# Planner, project style\n\nPlan.\n");
  const boardB = path.join(tmp, "b");
  const b = start({ MCP_BOARD_PATH: boardB, MCP_BOARD_DOCS_ROOT: repo, MCP_BOARD_PLAN_DOC: "require", MCP_BOARD_PROMPTS: promptsB });
  assert.match((await b.init()).instructions, /refuses a plan without a passing page/);
  assert.deepEqual(
    (await b.rpc("prompts/list", {})).result.prompts.map((x) => x.name),
    ["plan_doc", "planner"],
    "2: plan_doc is served beside a project's own prompts",
  );
  const noDoc = await b.tool("document_plan", { title: "R", goal: "g", steps: [{ title: "one" }] });
  assert.equal(noDoc.error, true, "8: require refuses a plan without a page");
  assert.match(noDoc.data.error, /plan page required .* Nothing was recorded/);
  assert.equal(fs.existsSync(path.join(boardB, "board.json")), false, "8: nothing was written");
  const badDoc = await b.tool("document_plan", { title: "R", goal: "g", steps: [{ title: "one" }], doc: "docs/smoke/chat.html" });
  assert.match(badDoc.data.error, /chat\.html: E2/);
  const goodDoc = await b.tool("document_plan", { title: "R", goal: "g", steps: twoSteps, doc: "docs/smoke/plan.html" });
  assert.equal(goodDoc.error, false);
  assert.equal(goodDoc.data.plan_doc.status, "ok");
  const byPlan = (await b.tool("check_plan_doc", { plan_id: goodDoc.data.plan_id })).data;
  assert.equal(byPlan.ok, true);
  assert.equal(byPlan.changed_since_recorded, false);

  // ── 12: the rules hold for the pages that set the convention ──
  const docsDir = path.join(HERE, "..", "docs");
  const pages = fs.existsSync(docsDir)
    ? fs.readdirSync(docsDir, { recursive: true }).filter((f) => f.endsWith(".html")).map((f) => path.join(docsDir, f))
    : [];
  for (const page of pages) {
    const r = checkPlanDoc(fs.readFileSync(page, "utf8"));
    assert.deepEqual(r.errors, [], `${path.relative(docsDir, page)} fails the rules it set`);
  }

  console.log(
    `smoke: OK (handshake, tools, prompts, hook refusal and ref, follow-ups, plan replace, lock-free reads, ` +
      `plan pages: template, check, warn, require, W7/W8, behind; ${pages.length} page(s) in ../docs pass)`,
  );
} catch (e) {
  console.error(`smoke: FAILED: ${e.stack || e.message}`);
  process.exitCode = 1;
} finally {
  for (const s of servers) s.stdin.end();
  fs.rmSync(tmp, { recursive: true, force: true });
}
