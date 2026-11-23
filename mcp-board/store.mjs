/**
 * File-backed board store. Multiple MCP processes / Claude sessions share
 * the same JSON file under MCP_BOARD_PATH (default: ./.mcp-board/board.json).
 *
 * Writes take a lock file (holder pid + time; a dead holder's lock, or one
 * older than any write takes, is taken over) and replace the file atomically
 * (temp file + rename), so a reader never sees half a board and reads need no
 * lock.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const DEFAULT_DIR = process.env.MCP_BOARD_PATH
  ? path.resolve(process.env.MCP_BOARD_PATH)
  : path.resolve(process.cwd(), ".mcp-board");

const BOARD_FILE = path.join(DEFAULT_DIR, "board.json");
const LOCK_FILE = path.join(DEFAULT_DIR, "board.lock");
const STALE_LOCK_MS = 30_000;
const LOCK_TIMEOUT_MS = 10_000;

function emptyBoard() {
  return {
    version: 1,
    updated_at: new Date().toISOString(),
    plans: {},
    progress: [],
    state: {},
    validations: [],
    followups: [],
  };
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

function staleLock() {
  try {
    const [pid, at] = fs.readFileSync(LOCK_FILE, "utf8").split(" ").map(Number);
    return !alive(pid) || Date.now() - at > STALE_LOCK_MS;
  } catch {
    return true;
  }
}

function acquireLock() {
  fs.mkdirSync(DEFAULT_DIR, { recursive: true });
  const start = Date.now();
  while (true) {
    try {
      fs.writeFileSync(LOCK_FILE, `${process.pid} ${Date.now()}`, { flag: "wx" });
      return;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    if (staleLock()) {
      fs.rmSync(LOCK_FILE, { force: true });
      continue;
    }
    if (Date.now() - start > LOCK_TIMEOUT_MS)
      throw new Error(`board is locked by another process: ${LOCK_FILE}`);
    sleep(20);
  }
}

function releaseLock() {
  fs.rmSync(LOCK_FILE, { force: true });
}

function load() {
  return fs.existsSync(BOARD_FILE)
    ? JSON.parse(fs.readFileSync(BOARD_FILE, "utf8"))
    : emptyBoard();
}

/** Run fn on the board under the lock; write it back only if fn changed it. */
export function withBoard(fn) {
  acquireLock();
  try {
    const board = load();
    const before = JSON.stringify(board);
    const result = fn(board);
    if (JSON.stringify(board) !== before) {
      board.updated_at = new Date().toISOString();
      const tmp = `${BOARD_FILE}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(board, null, 2));
      fs.renameSync(tmp, BOARD_FILE);
    }
    return result;
  } finally {
    releaseLock();
  }
}

/** A snapshot of the board: no lock, no write. */
export function readBoard() {
  return load();
}

export function newId(prefix = "id") {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

export { BOARD_FILE, DEFAULT_DIR };
