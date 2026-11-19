// Tamper-evident audit log: append-only JSON Lines where each entry carries the SHA-256 of
// the previous one. Editing, inserting or deleting any line breaks every hash after it.
// Limit: cutting lines off the end leaves a valid shorter chain, so the latest head hash
// should also be kept somewhere the writer can't change (WORM storage, a daily chat post).
import crypto from "node:crypto";
import fs from "node:fs";
import type { GateEvent } from "./gate.js";

export interface AuditEntry extends GateEvent {
  seq: number;
  prevHash: string;
  hash: string;
}

export interface AuditLog {
  append: (event: GateEvent) => AuditEntry;
  head: () => { seq: number; hash: string };
}

export type VerifyResult =
  | { ok: true; entries: number; headHash: string }
  | { ok: false; entries: number; brokenAtLine: number; reason: string };

export const GENESIS_HASH = "0".repeat(64);

// Fixed key order, so the same entry always hashes the same way
const FIELDS = ["seq", "at", "type", "approvalId", "kind", "refId", "actor", "detail", "argsHash", "prevHash"] as const;

export function hashEntry(entry: Omit<AuditEntry, "hash">): string {
  const canonical = JSON.stringify(FIELDS.map((f) => entry[f] ?? null));
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

function readLines(path: string): string[] {
  if (!fs.existsSync(path)) return [];
  return fs.readFileSync(path, "utf-8").split("\n").filter((l) => l.length > 0);
}

export function verifyAudit(path: string): VerifyResult {
  const lines = readLines(path);
  let prevHash = GENESIS_HASH;
  for (const [i, line] of lines.entries()) {
    const lineNo = i + 1;
    let entry: AuditEntry;
    try {
      entry = JSON.parse(line) as AuditEntry;
    } catch {
      return { ok: false, entries: lines.length, brokenAtLine: lineNo, reason: "line is not valid JSON" };
    }
    if (entry.seq !== lineNo) return { ok: false, entries: lines.length, brokenAtLine: lineNo, reason: `expected seq ${lineNo}, found ${entry.seq}` };
    if (entry.prevHash !== prevHash) return { ok: false, entries: lines.length, brokenAtLine: lineNo, reason: "previous-hash link broken (line removed or reordered)" };
    const { hash, ...rest } = entry;
    if (hashEntry(rest) !== hash) return { ok: false, entries: lines.length, brokenAtLine: lineNo, reason: "content does not match its hash (line edited)" };
    prevHash = hash;
  }
  return { ok: true, entries: lines.length, headHash: prevHash };
}

/** Refuses to open a log that already fails verification, so new entries never extend a forged chain. */
export function openAuditLog(path: string): AuditLog {
  const check = verifyAudit(path);
  if (!check.ok) throw new Error(`audit log ${path} failed verification at line ${check.brokenAtLine}: ${check.reason}`);
  let seq = check.entries;
  let prevHash = check.headHash;

  return {
    append(event) {
      const base = {
        seq: seq + 1,
        at: event.at,
        type: event.type,
        approvalId: event.approvalId,
        kind: event.kind,
        refId: event.refId,
        actor: event.actor,
        detail: event.detail,
        argsHash: event.argsHash,
        prevHash,
      };
      const entry: AuditEntry = { ...base, hash: hashEntry(base) };
      // Synchronous append keeps entries in order within one process; one writer per log file
      fs.appendFileSync(path, `${JSON.stringify(entry)}\n`);
      seq = entry.seq;
      prevHash = entry.hash;
      return entry;
    },
    head: () => ({ seq, hash: prevHash }),
  };
}
