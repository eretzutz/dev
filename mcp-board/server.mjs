#!/usr/bin/env node
/**
 * MCP Board — shared plan / progress / state / validation board for
 * multi-session Claude Code (and any MCP client).
 *
 * Transport: MCP stdio — one JSON-RPC message per line on stdin and stdout
 * (LSP-style Content-Length frames are also accepted on input).
 * Persistence: MCP_BOARD_PATH/board.json (default ./.mcp-board).
 * Tools: tools.mjs. Prompts: the role files in MCP_BOARD_PROMPTS (default
 * ./prompts), one per *.md, named after the file (ORCHESTRATOR.md →
 * "orchestrator"; in Claude Code, /mcp__board__orchestrator), plus the
 * built-in "plan_doc" (conventions/PLAN_DOC.md) unless that folder has its own.
 *
 * The instructions sent at initialize carry the plan-page rule, because
 * Claude Code keeps them in every session's system prompt: unlike a role
 * prompt, they are there whether or not the session ran one, and after
 * /compact.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONVENTION_FILE, DOCS_ROOT, PLAN_DOC_MODE, RULES } from "./plandoc.mjs";
import { BOARD_FILE } from "./store.mjs";
import { TOOLS, callTool } from "./tools.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_INFO = { name: "mcp-board", version: "1.2.0" };
const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const PROMPTS_DIR = path.resolve(process.env.MCP_BOARD_PROMPTS || path.join(HERE, "prompts"));
const INSTRUCTIONS = [
  "A shared board for planner, orchestrator and validator sessions. Call get_board_summary at the start of a session and after every event; report through the tools, not only in chat.",
  ...(PLAN_DOC_MODE === "off"
    ? []
    : [
        "Planner: every plan is also an HTML page, docs/<topic>/<slug>.html, in this project's convention: the request verbatim in a leading comment, a left contents nav, a right at-a-glance panel, animated data-flow and process diagrams. Start it with plan_doc_template, check it with check_plan_doc, and pass its path as doc to document_plan; prompt plan_doc has the details.",
        ...(PLAN_DOC_MODE === "require" ? ["document_plan refuses a plan without a passing page."] : []),
        "Orchestrator and validator: get_plan gives the page; read it.",
      ]),
].join(" ");

function builtinPlanDoc() {
  const text = fs
    .readFileSync(CONVENTION_FILE, "utf8")
    .replace("{{RULES}}", RULES.map((r) => `- **${r.slice(0, 2)}** ${r.slice(3)}`).join("\n"));
  return { name: "plan_doc", description: text.match(/^#\s+(.+)$/m)?.[1] ?? "plan_doc", text };
}

function prompts() {
  const own = !fs.existsSync(PROMPTS_DIR)
    ? []
    : fs
        .readdirSync(PROMPTS_DIR)
        .filter((f) => f.endsWith(".md"))
        .map((f) => {
          const text = fs.readFileSync(path.join(PROMPTS_DIR, f), "utf8");
          const title = text.match(/^#\s+(.+)$/m)?.[1] ?? f;
          return { name: f.slice(0, -3).toLowerCase(), description: title, text };
        });
  if (!own.some((p) => p.name === "plan_doc")) own.push(builtinPlanDoc());
  return own.sort((a, b) => (a.name < b.name ? -1 : 1));
}

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

function handleMessage(msg) {
  const { id, method, params } = msg;
  if (method === undefined) return; // a response to nothing we sent
  switch (method) {
    case "initialize": {
      const asked = params?.protocolVersion;
      reply(id, {
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: {}, prompts: {} },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
      return;
    }
    case "ping":
      reply(id, {});
      return;
    case "tools/list":
      reply(id, { tools: TOOLS });
      return;
    case "tools/call":
      reply(id, callTool(params?.name, params?.arguments || {}));
      return;
    case "prompts/list":
      reply(id, { prompts: prompts().map(({ name, description }) => ({ name, description })) });
      return;
    case "prompts/get": {
      const p = prompts().find((x) => x.name === params?.name);
      if (!p) return fail(id, -32602, `unknown prompt: ${params?.name}`);
      reply(id, {
        description: p.description,
        messages: [{ role: "user", content: { type: "text", text: p.text } }],
      });
      return;
    }
    default:
      if (method.startsWith("notifications/") || id === undefined) return;
      fail(id, -32601, `Method not found: ${method}`);
  }
}

function dispatch(text) {
  let msg;
  try {
    msg = JSON.parse(text);
  } catch (e) {
    process.stderr.write(`mcp-board: unparseable message: ${e.message}\n`);
    return fail(null, -32700, "Parse error");
  }
  for (const m of Array.isArray(msg) ? msg : [msg]) handleMessage(m);
}

let buffer = Buffer.alloc(0);

function processBuffer() {
  while (buffer.length) {
    if (buffer.subarray(0, 15).toString("utf8").toLowerCase() === "content-length:") {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const len = Number(/content-length:\s*(\d+)/i.exec(buffer.subarray(0, headerEnd).toString("utf8"))?.[1]);
      const start = headerEnd + 4;
      if (buffer.length < start + len) return;
      const body = buffer.subarray(start, start + len).toString("utf8");
      buffer = buffer.subarray(start + len);
      dispatch(body);
      continue;
    }
    const nl = buffer.indexOf("\n");
    if (nl === -1) return;
    const line = buffer.subarray(0, nl).toString("utf8").trim();
    buffer = buffer.subarray(nl + 1);
    if (line) dispatch(line);
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  processBuffer();
});
process.stdin.on("end", () => process.exit(0));

process.stderr.write(
  `mcp-board on stdio (board: ${BOARD_FILE}, prompts: ${PROMPTS_DIR}, plan pages: ${PLAN_DOC_MODE}, docs root: ${DOCS_ROOT})\n`,
);
