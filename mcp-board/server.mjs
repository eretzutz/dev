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
 * "orchestrator"; in Claude Code, /mcp__board__orchestrator).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BOARD_FILE } from "./store.mjs";
import { TOOLS, callTool } from "./tools.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_INFO = { name: "mcp-board", version: "1.1.0" };
const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const PROMPTS_DIR = path.resolve(process.env.MCP_BOARD_PROMPTS || path.join(HERE, "prompts"));
const INSTRUCTIONS =
  "A shared board for planner, orchestrator and validator sessions. Call get_board_summary at the start of a session and after every event; report through the tools, not only in chat.";

function prompts() {
  if (!fs.existsSync(PROMPTS_DIR)) return [];
  return fs
    .readdirSync(PROMPTS_DIR)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => {
      const text = fs.readFileSync(path.join(PROMPTS_DIR, f), "utf8");
      const title = text.match(/^#\s+(.+)$/m)?.[1] ?? f;
      return { name: f.slice(0, -3).toLowerCase(), description: title, text };
    });
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

process.stderr.write(`mcp-board on stdio (board: ${BOARD_FILE}, prompts: ${PROMPTS_DIR})\n`);
