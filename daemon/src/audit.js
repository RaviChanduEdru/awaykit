/**
 * awaykit audit log — an append-only local record of every approval decision.
 *
 * "What did I approve while I was away?" Each decision (approve / deny / aborted)
 * is written as one JSON line to ~/.awaykit/audit.log. Local-only, never sent
 * anywhere. Best-effort: auditing must never break the approval flow.
 */

import { appendFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const CONFIG_DIR = process.env.AWAYKIT_HOME || join(homedir(), ".awaykit");
const AUDIT_PATH = join(CONFIG_DIR, "audit.log");

/** Append one decision to the append-only log. Never throws. */
export function appendAudit(entry) {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    appendFileSync(AUDIT_PATH, JSON.stringify({ ts: Date.now(), ...entry }) + "\n");
  } catch { /* auditing must never break the approval flow */ }
}

/** Read the most recent audit entries (chronological, newest last). */
export function readAudit(limit = 100) {
  try {
    if (!existsSync(AUDIT_PATH)) return [];
    const lines = readFileSync(AUDIT_PATH, "utf8").split("\n").filter(Boolean);
    return lines.slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch {
    return [];
  }
}

export function auditPath() { return AUDIT_PATH; }
