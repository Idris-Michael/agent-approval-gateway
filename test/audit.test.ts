// Audit log tests. WHY: an auditor must be able to show that the record of who approved what
// has not been changed. Any edit, deletion or reorder must be detected and located, and the
// service must refuse to keep writing onto a log that has already been tampered with.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hashEntry, openAuditLog, verifyAudit, type AuditEntry } from "../src/audit.js";
import { createGate } from "../src/gate.js";
import { callbackData } from "../src/signing.js";
import { openApprovalStore } from "../src/store.js";

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-"));
  file = path.join(dir, "audit.jsonl");
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function writeThree(): void {
  const log = openAuditLog(file);
  log.append({ type: "requested", at: 1, approvalId: "a1", kind: "issue_refund", refId: "R-1" });
  log.append({ type: "claimed", at: 2, approvalId: "a1", actor: "1001", detail: "approve" });
  log.append({ type: "done", at: 3, approvalId: "a1", actor: "1001", detail: "Refund issued" });
}

const lines = (): string[] => fs.readFileSync(file, "utf-8").trimEnd().split("\n");
const save = (rows: string[]): void => fs.writeFileSync(file, `${rows.join("\n")}\n`);

test("an untouched log verifies", () => {
  writeThree();
  const r = verifyAudit(file);
  assert.equal(r.ok, true);
  assert.equal(r.entries, 3);
});

test("an empty or missing log verifies as empty", () => {
  assert.deepEqual(verifyAudit(file), { ok: true, entries: 0, headHash: "0".repeat(64) });
});

test("editing one field in one line is detected at that line", () => {
  writeThree();
  const rows = lines();
  rows[1] = rows[1]!.replace('"actor":"1001"', '"actor":"9999"');
  save(rows);
  const r = verifyAudit(file);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.brokenAtLine, 2);
    assert.match(r.reason, /edited/);
  }
});

test("deleting a line in the middle is detected", () => {
  writeThree();
  const rows = lines();
  save([rows[0]!, rows[2]!]);
  const r = verifyAudit(file);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.brokenAtLine, 2);
});

test("an edit with a correctly recomputed hash still fails, because the next line links to the old hash", () => {
  writeThree();
  const rows = lines().map((l) => JSON.parse(l) as AuditEntry);
  const { hash: _old, ...rest } = { ...rows[0]!, refId: "R-999" };
  rows[0] = { ...rest, hash: hashEntry(rest) }; // attacker fixes this line's hash, but not the chain after it
  save(rows.map((r) => JSON.stringify(r)));
  const r = verifyAudit(file);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.brokenAtLine, 2);
    assert.match(r.reason, /link broken/);
  }
});

test("the service refuses to append to a tampered log", () => {
  writeThree();
  const rows = lines();
  rows[2] = rows[2]!.replace("Refund issued", "Refund declined");
  save(rows);
  assert.throws(() => openAuditLog(file), /failed verification at line 3/);
});

test("reopening a valid log continues the same chain", () => {
  writeThree();
  const log = openAuditLog(file);
  assert.equal(log.head().seq, 3);
  log.append({ type: "requested", at: 4, approvalId: "a2" });
  const r = verifyAudit(file);
  assert.equal(r.ok, true);
  assert.equal(r.entries, 4);
});

test("wired to the gate, every decision lands in the log with who made it", async () => {
  const store = openApprovalStore(path.join(dir, "a.db"));
  const log = openAuditLog(file);
  const secret = "test-secret-that-is-at-least-32-characters";
  try {
    const gate = createGate({
      store, secret, approverIds: ["1001"],
      transport: { send: async () => "1", edit: async () => {} },
      handlers: { issue_refund: { approve: async () => "Refund issued", reject: async () => "no" } },
      logger: { warn: () => {}, error: () => {} },
      onEvent: (e) => log.append(e),
    });
    const card = await gate.request({ kind: "issue_refund", refId: "R-1", text: "Refund" });
    await gate.handleTap({ data: callbackData(secret, card.id, "approve"), fromId: "666" });
    await gate.handleTap({ data: callbackData(secret, card.id, "approve"), fromId: "1001" });
    const entries = lines().map((l) => JSON.parse(l) as { type: string; actor?: string });
    assert.deepEqual(entries.map((e) => e.type), ["requested", "refused", "claimed", "done"]);
    assert.equal(entries[1]!.actor, "666");
    assert.equal(entries[3]!.actor, "1001");
    assert.equal(verifyAudit(file).ok, true);
  } finally {
    store.close();
  }
});
