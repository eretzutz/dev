/**
 * What the board tells a session about its job: the instructions sent at
 * initialize, and the role prompts in MCP_BOARD_PROMPTS (default ./prompts),
 * one per *.md, named after the file (ORCHESTRATOR.md → "orchestrator"), plus
 * the built-in "plan_doc" (conventions/PLAN_DOC.md) unless that folder has its
 * own.
 *
 * Clients differ in what they show the model. Claude Code keeps the
 * instructions in every session's system prompt and offers the prompts as
 * /mcp__board__<name>; Copilot CLI leaves out the instructions of servers it
 * has not allowlisted and does not document MCP prompts. Every client shows
 * tools, so get_board_summary repeats the instructions and get_prompt serves
 * the prompts.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONVENTION_FILE, PLAN_DOC_MODE, RULES } from "./plandoc.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PROMPTS_DIR = path.resolve(process.env.MCP_BOARD_PROMPTS || path.join(HERE, "prompts"));

export const INSTRUCTIONS = [
  'A shared board for planner, orchestrator and validator sessions; get_prompt {name: "planner" | "orchestrator" | "validator"} gives a role its instructions. Call get_board_summary at the start of a session and after every event; report through the tools, not only in chat.',
  ...(PLAN_DOC_MODE === "off"
    ? []
    : [
        'Planner: every plan is also an HTML page, docs/<topic>/<slug>.html, in this project\'s convention: the request verbatim in a leading comment, a left contents nav, a right at-a-glance panel, animated data-flow and process diagrams. Start it with plan_doc_template, check it with check_plan_doc, and pass its path as doc to document_plan; get_prompt {name: "plan_doc"} has the details.',
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

/** Every prompt, read fresh: [{name, description, text}], by name. */
export function prompts() {
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
