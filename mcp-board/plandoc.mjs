/**
 * Plan pages: the HTML page every plan has, in the convention of the pages
 * that set it (docs/omlx/shared-model-host.html and its siblings). The rules
 * check features, not class names, because those pages differ in markup.
 * Errors (E) make a page fail; warnings (W) are advice.
 *
 * MCP_BOARD_PLAN_DOC   off | warn (default) | require: what document_plan does
 *                      with a plan that has no passing page.
 * MCP_BOARD_DOCS_ROOT  what a page's relative path is resolved against
 *                      (default: MCP_BOARD_HOOK_CWD, else the working directory).
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const TEMPLATE_FILE = path.join(HERE, "templates", "plan.html");
export const CONVENTION_FILE = path.join(HERE, "conventions", "PLAN_DOC.md");

const MODES = ["off", "warn", "require"];
const asked = (process.env.MCP_BOARD_PLAN_DOC ?? "").trim().toLowerCase();
export const PLAN_DOC_MODE = MODES.includes(asked) ? asked : "warn";
export const PLAN_DOC_MODE_PROBLEM =
  asked && !MODES.includes(asked) ? `MCP_BOARD_PLAN_DOC=${asked} is not off, warn or require; using warn` : null;

export const DOCS_ROOT = path.resolve(
  process.env.MCP_BOARD_DOCS_ROOT || process.env.MCP_BOARD_HOOK_CWD || process.cwd(),
);

export const RULES = [
  "E1 <!doctype html> at the top, and a <title> that names the plan",
  "E2 the brief: a comment before <html> that keeps the request word for word, then dated lines (measured, DECIDED, BUILT, UPDATE)",
  "E3 left panel: a <nav> with 3 or more links to sections of the page, each to an id that exists",
  "E4 right panel: an <aside> (at a glance: key facts, still to do, legend) that does not hold that nav",
  "E5 an inline <svg> diagram (viewBox 200 or more wide) that moves: <animate>/<animateMotion>, or CSS @keyframes",
  "E6 prefers-reduced-motion stops the motion",
  "W1 light and dark: prefers-color-scheme: dark",
  "W2 a button that pauses the diagrams",
  "W3 every diagram has a <title> or aria-label",
  "W4 a data-flow and a process diagram or section",
  "W5 self-contained: no external scripts, stylesheets or fonts",
  "W6 absolute dates, like 22 Nov 2026",
  "W7 the page changes when the plan's steps do",
  "W8 every step title on the board appears in the page",
];

// ─── Paths ──────────────────────────────────────────────────────────────────

export const sha256 = (s) => createHash("sha256").update(s).digest("hex");

export function resolveDoc(p) {
  return path.resolve(DOCS_ROOT, p);
}

function inside(root, abs) {
  const rel = path.relative(root, abs);
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** A page's path as the board keeps it: relative to the docs root when inside it. */
export function showPath(abs) {
  return inside(DOCS_ROOT, abs) ? path.relative(DOCS_ROOT, abs) : abs;
}

// ─── Text ───────────────────────────────────────────────────────────────────

const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "'", lsquo: "'",
  rdquo: '"', ldquo: '"', mdash: "-", ndash: "-", hellip: "...", middot: "·", rarr: "→", larr: "←",
};

function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] !== "#") return ENTITIES[e.toLowerCase()] ?? m;
    const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    try {
      return String.fromCodePoint(n);
    } catch {
      return m;
    }
  });
}

/** Lower-case words for matching: entities decoded, quotes and dashes plain, spaces collapsed. */
function norm(s) {
  return decode(s)
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

const strip = (s) => decode(s.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();

/** The page's visible words: no comments, scripts, styles or tags. */
function pageText(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style)[\s>][\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ");
}

const blocks = (html, tag) =>
  [...html.matchAll(new RegExp(`<${tag}[\\s>][\\s\\S]*?<\\/${tag}>`, "gi"))].map((m) => m[0]);

function anchors(s) {
  return [...s.matchAll(/href\s*=\s*["']#([^"']+)["']/gi)].map((m) => {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return m[1];
    }
  });
}

function hostOf(url) {
  try {
    return new URL(url.startsWith("//") ? `https:${url}` : url).host;
  } catch {
    return url;
  }
}

// ─── The check ──────────────────────────────────────────────────────────────

/**
 * Check one page. `steps` (titles) feeds W8; `previousSha` and `stepsChanged`
 * feed W7. Returns {ok, errors, warnings, sha256, facts}.
 */
export function checkPlanDoc(html, { steps = [], previousSha = null, stepsChanged = false } = {}) {
  const errors = [];
  const warnings = [];
  const sha = sha256(html);
  const bodyAt = html.search(/<body[\s>]/i);
  const head = bodyAt >= 0 ? html.slice(0, bodyAt) : html;
  const htmlAt = html.search(/<html[\s>]/i);
  const lead = htmlAt > 0 ? html.slice(0, htmlAt) : "";

  // E1
  if (!/^﻿?\s*(<!--[\s\S]*?-->\s*)*<!doctype html\s*>/i.test(html))
    errors.push("E1 no <!doctype html> at the top (the brief comment may come before it)");
  const title = strip(head.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
  if (title.length < 4 || /\{\{[A-Z_]+\}\}/.test(title)) errors.push("E1 no <title> that names the plan");

  // E2
  const brief = [...lead.matchAll(/<!--([\s\S]*?)-->/g)].map((m) => m[1].trim()).find((t) => t.length >= 40);
  if (!brief)
    errors.push("E2 no brief: a comment before <html> that keeps the request word for word, then dated lines");
  else if (/\{\{[A-Z_]+\}\}/.test(brief)) errors.push("E2 the brief still holds a {{PLACEHOLDER}}");

  // E3
  const ids = new Set([...html.matchAll(/\sid\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]));
  const nav = blocks(html, "nav").find((n) => anchors(n).length >= 3) ?? null;
  if (!nav) errors.push('E3 no left panel: a <nav> with 3 or more links to sections of the page (href="#id")');
  else {
    const dead = [...new Set(anchors(nav).filter((id) => !ids.has(id)))];
    if (dead.length)
      errors.push(`E3 the contents link to ids that are not on the page: ${dead.slice(0, 5).map((d) => `#${d}`).join(", ")}`);
  }

  // E4
  if (!blocks(html, "aside").some((a) => !nav || !a.includes(nav)))
    errors.push("E4 no right panel: an <aside> (at a glance) outside the contents nav");

  // E5
  const diagrams = blocks(html, "svg").filter((s) => {
    const open = s.match(/^<svg[^>]*>/i)?.[0] ?? "";
    const vb = open.match(/viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+[\d.]+/i);
    return vb && Number(vb[1]) >= 200;
  });
  const smil = diagrams.some((s) => /<(animate|animateMotion|animateTransform|set)[\s>/]/i.test(s));
  const css = /@keyframes\s/i.test(html) && /animation(-name)?\s*:\s*(?!none\b)[\w-]/i.test(html);
  if (!diagrams.length) errors.push("E5 no diagram: an inline <svg> with a viewBox 200 or more wide");
  else if (!smil && !css)
    errors.push("E5 the diagrams do not move: no <animate>/<animateMotion> and no CSS @keyframes animation");

  // E6
  if (!/prefers-reduced-motion/i.test(html)) errors.push("E6 nothing stops the motion: no prefers-reduced-motion rule");

  // W1-W6
  if (!/prefers-color-scheme\s*:\s*dark/i.test(html)) warnings.push("W1 no dark mode: no prefers-color-scheme: dark rule");
  if (!/<button[^>]*>[^<]*(pause|play|motion|animation)/i.test(html) && !/pauseAnimations|animation-play-state/i.test(html))
    warnings.push("W2 no control that pauses the diagrams");
  const unlabeled = diagrams.filter((s) => !/<title[\s>]/i.test(s) && !/^<svg[^>]*aria-label/i.test(s)).length;
  if (unlabeled) warnings.push(`W3 ${unlabeled} diagram(s) without a <title> or aria-label`);
  const labels = [
    ...ids,
    ...[...html.matchAll(/<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/gi)].map((m) => strip(m[1])),
    ...[...html.matchAll(/aria-label\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]),
    ...diagrams.flatMap((s) => [...s.matchAll(/<title[^>]*>([\s\S]*?)<\/title>/gi)].map((m) => strip(m[1]))),
  ].join(" | ");
  const views = [];
  if (!/flow/i.test(labels)) views.push("data flow");
  if (!/process|phase|\bsteps?\b|\border\b|roadmap|sequence|lifecycle/i.test(labels)) views.push("process");
  if (views.length) warnings.push(`W4 no ${views.join(" and no ")} section or diagram`);
  const external = [
    ...[...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']((?:https?:)?\/\/[^"']+)/gi)].map((m) => m[1]),
    ...[...html.matchAll(/<link\b[^>]*>/gi)]
      .map((m) => m[0])
      .filter((t) => /rel\s*=\s*["'][^"']*stylesheet/i.test(t))
      .map((t) => t.match(/href\s*=\s*["']((?:https?:)?\/\/[^"']+)/i)?.[1])
      .filter(Boolean),
    ...[...html.matchAll(/@import\s+(?:url\()?["']?((?:https?:)?\/\/[^"')\s;]+)/gi)].map((m) => m[1]),
  ];
  if (external.length)
    warnings.push(`W5 not self-contained: loads ${external.length} external file(s), e.g. from ${hostOf(external[0])}`);
  const MON = "(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*";
  if (!new RegExp(`\\b\\d{1,2} ${MON} (19|20)\\d\\d\\b|\\b${MON} \\d{1,2}, (19|20)\\d\\d\\b`).test(html))
    warnings.push("W6 no absolute date, such as 22 Nov 2026");

  // W7, W8: against the plan on the board
  if (stepsChanged && previousSha && previousSha === sha)
    warnings.push("W7 the steps changed but the page did not: update it (a dated UPDATE line in the brief, the steps)");
  if (steps.length) {
    const text = norm(pageText(html));
    const absent = steps.filter((t) => t && !text.includes(norm(t)));
    if (absent.length)
      warnings.push(
        `W8 ${absent.length} step title(s) not in the page: ${absent.slice(0, 5).map((t) => JSON.stringify(t)).join(", ")}`,
      );
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    sha256: sha,
    facts: {
      title,
      bytes: Buffer.byteLength(html),
      sections: nav ? anchors(nav).length : 0,
      diagrams: diagrams.length,
      animated: smil || css,
      brief: brief ? brief.split("\n")[0].replace(/^-\s*/, "").slice(0, 160) : null,
    },
  };
}

/** Check the page at a path (relative to the docs root). Never throws for a missing file. */
export function inspectDoc(p, opts) {
  const absolute = resolveDoc(p);
  const shown = showPath(absolute);
  let html;
  try {
    html = fs.readFileSync(absolute, "utf8");
  } catch (e) {
    const why = e.code === "ENOENT" ? "no such file" : e.message;
    return { path: shown, absolute, exists: false, ok: false, errors: [`no page at ${shown}: ${why}`], warnings: [] };
  }
  return { path: shown, absolute, exists: true, ...checkPlanDoc(html, opts) };
}

// ─── The starter page ───────────────────────────────────────────────────────

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const formatDate = (d = new Date()) => `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;

const escapeHtml = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The brief as comment lines: "- " bullets, and no "--" that could end the comment. */
function briefLines(brief) {
  let t = String(brief).replace(/\r\n?/g, "\n").trim();
  while (t.includes("--")) t = t.replace(/--/g, "- -");
  return t
    .split("\n")
    .map((l, i) => (i === 0 && !l.startsWith("-") ? `- ${l}` : i > 0 && l.trim() && !l.startsWith("-") ? `  ${l}` : l))
    .join("\n");
}

export function renderTemplate({ title, brief, lede, date = formatDate() }) {
  const values = {
    TITLE: escapeHtml(title),
    BRIEF: briefLines(brief),
    DATE: escapeHtml(date),
    LEDE: escapeHtml(
      lede || "One paragraph: what this plan changes, for whom, and why now. Say what is true today and what will be true after.",
    ),
  };
  return fs
    .readFileSync(TEMPLATE_FILE, "utf8")
    .replace(/\{\{(TITLE|BRIEF|DATE|LEDE)\}\}/g, (_, k) => values[k]);
}

/** Write a new starter page; refuses an existing file and a path outside the docs root. */
export function writePlanDoc(p, fields) {
  const absolute = resolveDoc(p);
  if (!inside(DOCS_ROOT, absolute)) throw new Error(`${p} is outside the docs root ${DOCS_ROOT}`);
  if (!/\.html$/i.test(absolute)) throw new Error(`${p}: a plan page is an .html file`);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const realRoot = fs.realpathSync(DOCS_ROOT);
  const realDir = fs.realpathSync(path.dirname(absolute));
  if (realDir !== realRoot && !inside(realRoot, realDir)) throw new Error(`${p} resolves outside the docs root ${DOCS_ROOT}`);
  const html = renderTemplate(fields);
  try {
    fs.writeFileSync(absolute, html, { flag: "wx" });
  } catch (e) {
    if (e.code === "EEXIST") throw new Error(`${showPath(absolute)} exists: edit it instead of starting over`);
    throw e;
  }
  return { path: showPath(absolute), absolute, bytes: Buffer.byteLength(html) };
}
