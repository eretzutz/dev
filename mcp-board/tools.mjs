/**
 * The board's tools: their MCP schemas and handlers, shared by the stdio
 * server (server.mjs) and the CLI (cli.mjs call).
 *
 * MCP_BOARD_HOOK, when set, is a command (split on whitespace, run without a
 * shell) that sees every report_progress, request_followup, resolve_followup
 * and submit_validation before the board records it. It gets
 * {tool, args, plan, step, followup} as JSON on stdin. Exit 0 accepts: its
 * stdout is kept on the record as `hook` (a JSON object's `note`, and its
 * `ref` on a follow-up). Any other exit refuses: nothing is recorded and the
 * caller gets the hook's message. A project uses it to tie the board to its
 * own source of truth.
 *
 * Every plan also has a page: an HTML file in the project's plan-page
 * convention (plandoc.mjs). document_plan takes its path as `doc`, checks it,
 * and keeps the result; MCP_BOARD_PLAN_DOC says whether a plan without a
 * passing page is recorded with a reminder (warn, the default), refused
 * (require), or not looked at (off).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import {
  DOCS_ROOT,
  PLAN_DOC_MODE,
  PLAN_DOC_MODE_PROBLEM,
  RULES,
  inspectDoc,
  resolveDoc,
  sha256,
  showPath,
  writePlanDoc,
} from "./plandoc.mjs";
import { INSTRUCTIONS, prompts } from "./prompts.mjs";
import { BOARD_FILE, newId, readBoard, withBoard } from "./store.mjs";

// ─── Tool definitions (MCP schema) ─────────────────────────────────────────

export const STEP_STATUSES = [
  "pending",
  "started",
  "working",
  "blocked",
  "done",
  "failed",
  "skipped",
];
export const PROGRESS_STATUSES = STEP_STATUSES.slice(1);

const PAGE_RULE =
  " Every plan has a page: pass doc, the path of its HTML page (plan_doc_template writes a starter page, check_plan_doc checks it).";
const PAGE_SENTENCE = {
  off: "",
  warn: `${PAGE_RULE} Without a passing page the plan is still recorded, and the result says what is missing.`,
  require: `${PAGE_RULE} Without a passing page this tool refuses the plan and records nothing.`,
}[PLAN_DOC_MODE];

export const TOOLS = [
  {
    name: "document_plan",
    description: `Planner: create or replace a structured implementation plan. Returns plan_id. Call this before any implementation work. Replacing a plan keeps the status of every step whose id is unchanged.${PAGE_SENTENCE}`,
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short plan title" },
        goal: { type: "string", description: "Overall goal / acceptance criteria" },
        steps: {
          type: "array",
          description: "Ordered steps",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Optional step id (auto if omitted)" },
              title: { type: "string" },
              detail: { type: "string" },
              owner: {
                type: "string",
                description: "Suggested role: orchestrator | subagent | human",
              },
              status: {
                type: "string",
                enum: STEP_STATUSES,
                description: "Initial status (default: the existing step's, else pending)",
              },
            },
            required: ["title"],
          },
        },
        acceptance: {
          type: "array",
          items: { type: "string" },
          description: "Acceptance criteria the validator must check",
        },
        plan_id: {
          type: "string",
          description: "If set, replace an existing plan with this id",
        },
        doc: {
          type: "string",
          description:
            "The plan's HTML page, e.g. docs/<topic>/<slug>.html, relative to the docs root (get_board_summary shows it). On a replace, omit it to keep the page already recorded.",
        },
        metadata: { type: "object", description: "Arbitrary extra fields" },
      },
      required: ["title", "goal", "steps"],
    },
  },
  {
    name: "plan_doc_template",
    description:
      "Planner: start a plan's HTML page from the board's template, in this project's plan-page convention (the request verbatim in a leading comment, a left contents nav, a right at-a-glance panel, animated data-flow and process diagrams). Writes a new file only. Fill it in, check_plan_doc it, then pass its path as doc to document_plan. get_prompt {name: \"plan_doc\"} has the convention.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Where to write it, e.g. docs/<topic>/<slug>.html, relative to the docs root",
        },
        title: { type: "string", description: "The plan's title" },
        brief: {
          type: "string",
          description:
            "The request, word for word, then anything measured or decided; kept in the page's leading comment",
        },
        lede: { type: "string", description: "One paragraph: what the plan changes, and why" },
      },
      required: ["path", "title", "brief"],
    },
  },
  {
    name: "check_plan_doc",
    description:
      "Check a plan's HTML page against the plan-page convention: E rules must pass, W rules are advice. Give path, or plan_id to check the page that plan records (with its step titles). Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "The page, relative to the docs root" },
        plan_id: { type: "string", description: "Check the page this plan records" },
      },
    },
  },
  {
    name: "get_plan",
    description: "Load a plan by plan_id (full document including status).",
    inputSchema: {
      type: "object",
      properties: {
        plan_id: { type: "string" },
      },
      required: ["plan_id"],
    },
  },
  {
    name: "list_plans",
    description: "List plans, optionally filtered by status.",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["draft", "active", "in_progress", "validating", "done", "blocked", "cancelled"],
          description: "Filter by status; omit for all",
        },
      },
    },
  },
  {
    name: "update_plan_status",
    description:
      "Set plan lifecycle status: draft | active | in_progress | validating | done | blocked | cancelled.",
    inputSchema: {
      type: "object",
      properties: {
        plan_id: { type: "string" },
        status: {
          type: "string",
          enum: ["draft", "active", "in_progress", "validating", "done", "blocked", "cancelled"],
        },
        note: { type: "string" },
      },
      required: ["plan_id", "status"],
    },
  },
  {
    name: "report_progress",
    description:
      "Orchestrator / workers: append a progress event for a plan step. Use frequently so the validator and planner can see live state. A project hook may refuse an event (for example `done` without evidence): nothing is recorded and the error says why.",
    inputSchema: {
      type: "object",
      properties: {
        plan_id: { type: "string" },
        step_id: { type: "string", description: "Step id from the plan" },
        agent: {
          type: "string",
          description: "Who is reporting (e.g. orchestrator, worker-auth, claude-session-2)",
        },
        status: {
          type: "string",
          enum: PROGRESS_STATUSES,
        },
        message: { type: "string", description: "Human-readable update" },
        evidence: {
          type: "string",
          description: "Paths, PR links, test output summary, commit sha, etc.",
        },
        percent: {
          type: "number",
          description: "Optional 0-100 completion for this step",
        },
      },
      required: ["plan_id", "agent", "status", "message"],
    },
  },
  {
    name: "list_progress",
    description: "List progress events for a plan (newest last). Optional step_id filter.",
    inputSchema: {
      type: "object",
      properties: {
        plan_id: { type: "string" },
        step_id: { type: "string" },
        limit: { type: "number", description: "Max events to return (default 50)" },
      },
      required: ["plan_id"],
    },
  },
  {
    name: "set_state",
    description:
      "Write a key/value into shared board state scoped to a plan (or global if plan_id omitted). Use for facts the next iteration needs.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string" },
        value: {
          description: "Any JSON-serializable value",
        },
        plan_id: {
          type: "string",
          description: "Scope to this plan; omit for global state",
        },
        agent: { type: "string" },
      },
      required: ["key", "value"],
    },
  },
  {
    name: "get_state",
    description: "Read a state key (plan-scoped or global).",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string" },
        plan_id: { type: "string" },
      },
      required: ["key"],
    },
  },
  {
    name: "list_state",
    description: "List all state keys for a plan (or global).",
    inputSchema: {
      type: "object",
      properties: {
        plan_id: {
          type: "string",
          description: "Omit for global keys only",
        },
      },
    },
  },
  {
    name: "submit_validation",
    description:
      "Validator: record verification of the whole plan result. pass=false should usually be paired with request_followup.",
    inputSchema: {
      type: "object",
      properties: {
        plan_id: { type: "string" },
        passed: { type: "boolean" },
        findings: {
          type: "array",
          items: {
            type: "object",
            properties: {
              severity: {
                type: "string",
                enum: ["info", "warning", "error"],
              },
              message: { type: "string" },
              location: { type: "string" },
            },
            required: ["severity", "message"],
          },
        },
        summary: { type: "string" },
        agent: { type: "string" },
      },
      required: ["plan_id", "passed", "summary"],
    },
  },
  {
    name: "list_validations",
    description: "List validation records for a plan.",
    inputSchema: {
      type: "object",
      properties: {
        plan_id: { type: "string" },
      },
      required: ["plan_id"],
    },
  },
  {
    name: "request_followup",
    description:
      "Open a follow-up for the planner (a question, failed validation, blocked work, new scope). Planner should list_followups and resolve it, or document the next plan iteration. Only priority `blocking` sets the plan blocked; otherwise keep working on the rest.",
    inputSchema: {
      type: "object",
      properties: {
        plan_id: { type: "string" },
        reason: { type: "string" },
        step_id: { type: "string", description: "The step it is about, if any" },
        suggested_actions: {
          type: "array",
          items: { type: "string" },
        },
        priority: {
          type: "string",
          enum: ["low", "normal", "high", "urgent", "blocking"],
        },
        agent: { type: "string" },
      },
      required: ["plan_id", "reason"],
    },
  },
  {
    name: "list_followups",
    description: "List follow-ups. Default: open only.",
    inputSchema: {
      type: "object",
      properties: {
        plan_id: { type: "string" },
        status: {
          type: "string",
          enum: ["open", "resolved", "all"],
        },
      },
    },
  },
  {
    name: "resolve_followup",
    description: "Mark a follow-up resolved (usually after planner documented next iteration).",
    inputSchema: {
      type: "object",
      properties: {
        followup_id: { type: "string" },
        resolution: { type: "string" },
        agent: { type: "string" },
      },
      required: ["followup_id", "resolution"],
    },
  },
  {
    name: "get_prompt",
    description:
      'A role\'s instructions, or the plan-page convention, as text: the board\'s MCP prompts, for clients that do not offer them. Start a session as a role with get_prompt {name: "planner" | "orchestrator" | "validator"} and follow it; "plan_doc" is the convention for plan pages. Without name, lists them.',
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "planner, orchestrator, validator, plan_doc, or a project prompt's name" },
      },
    },
  },
  {
    name: "get_board_summary",
    description:
      "Single snapshot for any role: the board's instructions, active plans with their pages, latest progress, open follow-ups, recent validations. Call at session start.",
    inputSchema: {
      type: "object",
      properties: {
        plan_id: {
          type: "string",
          description: "Focus on one plan; omit for all active work",
        },
      },
    },
  },
];

// ─── Hook ───────────────────────────────────────────────────────────────────

const HOOK = (process.env.MCP_BOARD_HOOK ?? "").trim().split(/\s+/).filter(Boolean);

export class Refused extends Error {}

/** Ask the project hook; returns {hook, ref} to keep on the record, or throws Refused. */
function runHook(payload) {
  if (!HOOK.length) return {};
  let out;
  try {
    out = execFileSync(HOOK[0], HOOK.slice(1), {
      input: JSON.stringify(payload),
      encoding: "utf8",
      timeout: Number(process.env.MCP_BOARD_HOOK_TIMEOUT_MS ?? 120_000),
      stdio: ["pipe", "pipe", "pipe"],
      cwd: process.env.MCP_BOARD_HOOK_CWD || undefined,
    }).trim();
  } catch (e) {
    const why = [e.stderr, e.stdout].map((x) => String(x ?? "").trim()).filter(Boolean).join("\n");
    throw new Refused(`refused by the board hook: ${why || e.message}`);
  }
  try {
    const j = JSON.parse(out);
    if (j && typeof j === "object") return { hook: j.note ?? null, ref: j.ref ?? null };
  } catch {
    /* plain text */
  }
  return { hook: out || null, ref: null };
}

// ─── Tool handlers ──────────────────────────────────────────────────────────

function ok(data) {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

function err(message) {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: message }, null, 2) }],
    isError: true,
  };
}

function stateKey(planId, key) {
  return planId ? `plan:${planId}:${key}` : `global:${key}`;
}

const now = () => new Date().toISOString();

function requirePlan(board, planId) {
  const plan = board.plans[planId];
  if (!plan) throw new Refused(`plan not found: ${planId}`);
  return plan;
}

// ─── Plan pages ─────────────────────────────────────────────────────────────

const NEXT_MISSING =
  'Write this plan as a page: plan_doc_template {path: "docs/<topic>/<slug>.html", title, brief: the request word for word}, fill it in (get_prompt {name: "plan_doc"} has the convention), check_plan_doc {path}, then document_plan again with plan_id and doc.';
const NEXT_FIX =
  "Fix the page (the errors above), check_plan_doc {path} until it passes, then document_plan again with plan_id (the doc is kept).";
const PAGE_ITEM = /^plan page \S+ passes check_plan_doc\b/;
const pageItem = (p) => `plan page ${p} passes check_plan_doc and says what was built`;

/** What document_plan's result says about the page. */
function pageAnswer(page) {
  const mode = PLAN_DOC_MODE;
  if (!page) return { status: "missing", mode, next: NEXT_MISSING };
  const answer = { status: page.ok ? "ok" : "failing", mode, path: page.path, errors: page.errors, warnings: page.warnings };
  if (!page.exists)
    return {
      ...answer,
      next: `Write it first: plan_doc_template {path: "${page.path}", title, brief}, fill it in, check_plan_doc, then document_plan again with plan_id.`,
    };
  return page.ok ? answer : { ...answer, next: NEXT_FIX };
}

function refusal(page) {
  const head = "plan page required (MCP_BOARD_PLAN_DOC=require)";
  if (!page)
    return `${head}: pass doc, the path of this plan's HTML page. Start one with plan_doc_template {path: "docs/<topic>/<slug>.html", title, brief: the request word for word}, fill it in (get_prompt {name: "plan_doc"}), check_plan_doc {path}, then document_plan again with doc. Nothing was recorded.`;
  return `${head}: ${page.exists ? `${page.path}: ` : ""}${page.errors.join("; ")}. Nothing was recorded.`;
}

/** The page as it is now, for the reads: null when pages are off and the plan has none. */
function pageNow(plan) {
  if (PLAN_DOC_MODE === "off") return plan.doc?.path ? { path: plan.doc.path } : null;
  if (!plan.doc?.path) return { status: "missing", next: "plan_doc_template, then document_plan with plan_id and doc" };
  const page = inspectDoc(plan.doc.path, { steps: plan.steps.map((s) => s.title) });
  if (!page.exists) return { path: page.path, status: "failing", errors: page.errors };
  const behind = plan.status === "done" && plan.doc.validated_sha256 === page.sha256;
  return {
    path: page.path,
    status: !page.ok ? "failing" : behind ? "behind" : "ok",
    changed: page.sha256 !== plan.doc.sha256,
    errors: page.errors,
    warnings: page.warnings,
    ...(behind ? { next: "validated, and the page has not changed since: write what was verified into it" } : {}),
  };
}

function pageSha(p) {
  try {
    return sha256(fs.readFileSync(resolveDoc(p), "utf8"));
  } catch {
    return null;
  }
}

const handlers = {
  document_plan(args) {
    const prior = args.plan_id ? readBoard().plans[args.plan_id] : undefined;
    const doc = args.doc || prior?.doc?.path || null;
    const titled = (args.steps || []).map((s, i) => ({ id: s.id || `step_${i + 1}`, title: s.title }));
    const page =
      PLAN_DOC_MODE === "off" || !doc
        ? null
        : inspectDoc(doc, {
            steps: titled.map((s) => s.title),
            previousSha: prior?.doc?.sha256 ?? null,
            stepsChanged:
              !!prior && JSON.stringify(titled) !== JSON.stringify(prior.steps.map((s) => ({ id: s.id, title: s.title }))),
          });
    if (PLAN_DOC_MODE === "require" && !page?.ok) throw new Refused(refusal(page));
    return withBoard((board) => {
      const planId = args.plan_id || newId("plan");
      const old = board.plans[planId];
      const oldStatus = new Map((old?.steps ?? []).map((s) => [s.id, s]));
      const steps = (args.steps || []).map((s, i) => {
        const id = s.id || `step_${i + 1}`;
        const prev = oldStatus.get(id);
        return {
          id,
          title: s.title,
          detail: s.detail || "",
          owner: s.owner || "orchestrator",
          status: s.status || prev?.status || "pending",
          ...(prev?.percent != null ? { percent: prev.percent } : {}),
        };
      });
      const acceptance = args.acceptance || [];
      const plan = {
        plan_id: planId,
        title: args.title,
        goal: args.goal,
        steps,
        acceptance: page ? [...acceptance.filter((a) => !PAGE_ITEM.test(a)), pageItem(page.path)] : acceptance,
        ...(doc
          ? {
              doc: page
                ? {
                    path: page.path,
                    sha256: page.sha256 ?? null,
                    checked_at: now(),
                    errors: page.errors,
                    warnings: page.warnings,
                  }
                : { path: showPath(resolveDoc(doc)) },
            }
          : {}),
        metadata: args.metadata || {},
        status: old?.status || "active",
        created_at: old?.created_at || now(),
        updated_at: now(),
      };
      board.plans[planId] = plan;
      return ok({ plan_id: planId, plan, ...(PLAN_DOC_MODE === "off" ? {} : { plan_doc: pageAnswer(page) }) });
    });
  },

  plan_doc_template(args) {
    for (const k of ["path", "title", "brief"])
      if (typeof args[k] !== "string" || !args[k].trim()) throw new Refused(`${k} is required`);
    const page = writePlanDoc(args.path, { title: args.title, brief: args.brief, lede: args.lede });
    return ok({
      ...page,
      written: true,
      rules: RULES,
      next: `Fill in ${page.path}: replace every placeholder (lede, summary, both diagrams, the steps with the titles you will give document_plan, acceptance, files, open questions), keeping the brief, both panels and the motion. Then check_plan_doc {path: "${page.path}"}, then document_plan {..., doc: "${page.path}"}.`,
    });
  },

  check_plan_doc(args) {
    const plan = args.plan_id ? requirePlan(readBoard(), args.plan_id) : null;
    const p = args.path || plan?.doc?.path;
    if (!p) throw new Refused(plan ? `plan ${plan.plan_id} has no page yet. ${NEXT_MISSING}` : "give path, or plan_id");
    const page = inspectDoc(p, { steps: plan ? plan.steps.map((s) => s.title) : [] });
    return ok({
      ...page,
      ...(plan?.doc?.sha256 ? { changed_since_recorded: page.sha256 !== plan.doc.sha256 } : {}),
      ...(page.ok ? {} : { rules: RULES }),
    });
  },

  get_plan(args) {
    const plan = readBoard().plans[args.plan_id];
    return plan ? ok({ ...plan, page: pageNow(plan) }) : err(`plan not found: ${args.plan_id}`);
  },

  list_plans(args) {
    let plans = Object.values(readBoard().plans);
    if (args.status) plans = plans.filter((p) => p.status === args.status);
    plans.sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
    return ok({
      count: plans.length,
      plans: plans.map((p) => ({
        plan_id: p.plan_id,
        title: p.title,
        status: p.status,
        steps: p.steps.length,
        doc: p.doc?.path ?? null,
        page: pageNow(p)?.status ?? null,
        updated_at: p.updated_at,
      })),
    });
  },

  update_plan_status(args) {
    return withBoard((board) => {
      const plan = requirePlan(board, args.plan_id);
      plan.status = args.status;
      plan.updated_at = now();
      if (args.note) plan.status_note = args.note;
      return ok({ plan_id: plan.plan_id, status: plan.status });
    });
  },

  report_progress(args) {
    const snapshot = readBoard();
    const plan = requirePlan(snapshot, args.plan_id);
    const step = args.step_id ? plan.steps.find((s) => s.id === args.step_id) ?? null : null;
    const { hook } = runHook({ tool: "report_progress", args, plan, step });
    return withBoard((board) => {
      const plan = requirePlan(board, args.plan_id);
      const event = {
        event_id: newId("prog"),
        plan_id: args.plan_id,
        step_id: args.step_id || null,
        agent: args.agent,
        status: args.status,
        message: args.message,
        evidence: args.evidence || null,
        percent: args.percent ?? null,
        ...(hook ? { hook } : {}),
        at: now(),
      };
      board.progress.push(event);
      const step = args.step_id ? plan.steps.find((s) => s.id === args.step_id) : null;
      if (step) {
        step.status = args.status;
        if (args.percent != null) step.percent = args.percent;
      }
      if (["started", "working"].includes(args.status) && ["active", "draft"].includes(plan.status))
        plan.status = "in_progress";
      plan.updated_at = now();
      return ok(event);
    });
  },

  list_progress(args) {
    let events = readBoard().progress.filter((e) => e.plan_id === args.plan_id);
    if (args.step_id) events = events.filter((e) => e.step_id === args.step_id);
    events = events.slice(-(args.limit || 50));
    return ok({ count: events.length, events });
  },

  set_state(args) {
    return withBoard((board) => {
      board.state[stateKey(args.plan_id, args.key)] = {
        key: args.key,
        plan_id: args.plan_id || null,
        value: args.value,
        agent: args.agent || null,
        updated_at: now(),
      };
      return ok({ key: args.key, plan_id: args.plan_id || null, stored: true });
    });
  },

  get_state(args) {
    const entry = readBoard().state[stateKey(args.plan_id, args.key)];
    return entry ? ok(entry) : err(`state key not found: ${args.key}`);
  },

  list_state(args) {
    const prefix = args.plan_id ? `plan:${args.plan_id}:` : "global:";
    const entries = Object.entries(readBoard().state)
      .filter(([k]) => k.startsWith(prefix))
      .map(([, v]) => v);
    return ok({ count: entries.length, entries });
  },

  submit_validation(args) {
    const plan = requirePlan(readBoard(), args.plan_id);
    const { hook } = runHook({ tool: "submit_validation", args, plan });
    const validatedSha = args.passed && plan.doc?.path ? pageSha(plan.doc.path) : null;
    return withBoard((board) => {
      const plan = requirePlan(board, args.plan_id);
      if (validatedSha && plan.doc) {
        plan.doc.validated_sha256 = validatedSha;
        plan.doc.validated_at = now();
      }
      const record = {
        validation_id: newId("val"),
        plan_id: args.plan_id,
        passed: !!args.passed,
        findings: args.findings || [],
        summary: args.summary,
        agent: args.agent || "validator",
        ...(hook ? { hook } : {}),
        at: now(),
      };
      board.validations.push(record);
      plan.status = args.passed ? "done" : "blocked";
      plan.updated_at = now();
      return ok(record);
    });
  },

  list_validations(args) {
    const records = readBoard().validations.filter((v) => v.plan_id === args.plan_id);
    return ok({ count: records.length, validations: records });
  },

  request_followup(args) {
    const plan = requirePlan(readBoard(), args.plan_id);
    const { hook, ref } = runHook({ tool: "request_followup", args, plan });
    return withBoard((board) => {
      const plan = requirePlan(board, args.plan_id);
      const fu = {
        followup_id: newId("fu"),
        plan_id: args.plan_id,
        step_id: args.step_id || null,
        reason: args.reason,
        suggested_actions: args.suggested_actions || [],
        priority: args.priority || "normal",
        agent: args.agent || null,
        status: "open",
        ...(ref ? { ref } : {}),
        ...(hook ? { hook } : {}),
        created_at: now(),
        resolved_at: null,
        resolution: null,
      };
      board.followups.push(fu);
      if (fu.priority === "blocking") plan.status = "blocked";
      plan.updated_at = now();
      return ok(fu);
    });
  },

  list_followups(args) {
    let list = readBoard().followups;
    if (args.plan_id) list = list.filter((f) => f.plan_id === args.plan_id);
    const status = args.status || "open";
    if (status !== "all") list = list.filter((f) => f.status === status);
    return ok({ count: list.length, followups: list });
  },

  resolve_followup(args) {
    const followup = readBoard().followups.find((f) => f.followup_id === args.followup_id);
    if (!followup) return err(`followup not found: ${args.followup_id}`);
    if (followup.status === "resolved") return err(`followup already resolved: ${args.followup_id}`);
    const { hook } = runHook({ tool: "resolve_followup", args, followup });
    return withBoard((board) => {
      const fu = board.followups.find((f) => f.followup_id === args.followup_id);
      fu.status = "resolved";
      fu.resolution = args.resolution;
      fu.resolved_at = now();
      fu.resolved_by = args.agent || null;
      if (hook) fu.resolve_hook = hook;
      return ok(fu);
    });
  },

  get_prompt(args) {
    const all = prompts();
    if (!args.name) return ok({ prompts: all.map(({ name, description }) => ({ name, description })) });
    const p = all.find((x) => x.name === String(args.name).toLowerCase());
    if (!p) throw new Refused(`unknown prompt: ${args.name} (have: ${all.map((x) => x.name).join(", ")})`);
    return ok({ name: p.name, description: p.description, text: p.text });
  },

  get_board_summary(args) {
    const board = readBoard();
    const active = ["active", "in_progress", "validating", "blocked", "draft"];
    const planIds = args.plan_id
      ? [args.plan_id]
      : Object.keys(board.plans).filter((id) => active.includes(board.plans[id].status));
    const mine = (x) => !args.plan_id || x.plan_id === args.plan_id;
    return ok({
      instructions: INSTRUCTIONS,
      board_path: BOARD_FILE,
      updated_at: board.updated_at,
      hook: HOOK.length ? HOOK.join(" ") : null,
      docs_root: DOCS_ROOT,
      plan_doc_mode: PLAN_DOC_MODE,
      ...(PLAN_DOC_MODE_PROBLEM ? { plan_doc_mode_problem: PLAN_DOC_MODE_PROBLEM } : {}),
      plans: planIds
        .map((id) => board.plans[id])
        .filter(Boolean)
        .map((p) => ({
          plan_id: p.plan_id,
          title: p.title,
          status: p.status,
          status_note: p.status_note,
          goal: p.goal,
          steps: p.steps.map((s) => ({ id: s.id, title: s.title, status: s.status, percent: s.percent })),
          acceptance: p.acceptance,
          page: pageNow(p),
        })),
      recent_progress: board.progress.filter(mine).slice(-20),
      open_followups: board.followups.filter((f) => f.status === "open" && mine(f)),
      recently_resolved_followups: board.followups.filter((f) => f.status === "resolved" && mine(f)).slice(-5),
      recent_validations: board.validations.filter(mine).slice(-10),
    });
  },
};

/** Run one tool; a refusal or a bad call comes back as an MCP error result. */
export function callTool(name, args = {}) {
  const handler = handlers[name];
  if (!handler) return err(`unknown tool: ${name}`);
  try {
    return handler(args);
  } catch (e) {
    return err(e?.message || String(e));
  }
}
