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
 */
import { execFileSync } from "node:child_process";
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

export const TOOLS = [
  {
    name: "document_plan",
    description:
      "Planner: create or replace a structured implementation plan. Returns plan_id. Call this before any implementation work. Replacing a plan keeps the status of every step whose id is unchanged.",
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
        metadata: { type: "object", description: "Arbitrary extra fields" },
      },
      required: ["title", "goal", "steps"],
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
    name: "get_board_summary",
    description:
      "Single snapshot for any role: active plans, latest progress, open follow-ups, recent validations. Call at session start.",
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

const handlers = {
  document_plan(args) {
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
      const plan = {
        plan_id: planId,
        title: args.title,
        goal: args.goal,
        steps,
        acceptance: args.acceptance || [],
        metadata: args.metadata || {},
        status: old?.status || "active",
        created_at: old?.created_at || now(),
        updated_at: now(),
      };
      board.plans[planId] = plan;
      return ok({ plan_id: planId, plan });
    });
  },

  get_plan(args) {
    const plan = readBoard().plans[args.plan_id];
    return plan ? ok(plan) : err(`plan not found: ${args.plan_id}`);
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
    return withBoard((board) => {
      const plan = requirePlan(board, args.plan_id);
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

  get_board_summary(args) {
    const board = readBoard();
    const active = ["active", "in_progress", "validating", "blocked", "draft"];
    const planIds = args.plan_id
      ? [args.plan_id]
      : Object.keys(board.plans).filter((id) => active.includes(board.plans[id].status));
    const mine = (x) => !args.plan_id || x.plan_id === args.plan_id;
    return ok({
      board_path: BOARD_FILE,
      updated_at: board.updated_at,
      hook: HOOK.length ? HOOK.join(" ") : null,
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
