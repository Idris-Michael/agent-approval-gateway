// Store tests. WHY: exactly-once execution rests on the claim being one conditional UPDATE.
// These tests drive two separate connections through the read-then-claim race directly,
// because the gate-level tests can't force that interleaving inside one event loop.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openApprovalStore } from "../src/store.js";

function withTwoConnections(fn: (a: ReturnType<typeof openApprovalStore>, b: ReturnType<typeof openApprovalStore>) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "store-"));
  const file = path.join(dir, "approvals.db");
  const a = openApprovalStore(file);
  const b = openApprovalStore(file);
  try {
    fn(a, b);
  } finally {
    a.close();
    b.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const row = { id: "0123456789abcdef", kind: "issue_refund", refId: "R-1", text: "Refund", createdAt: 1000, expiresAt: 5000 };

test("both connections see pending, both try to claim: exactly one wins", () => {
  withTwoConnections((a, b) => {
    a.insert(row);
    assert.equal(a.get(row.id)?.status, "pending");
    assert.equal(b.get(row.id)?.status, "pending");
    const wins = [a.claim(row.id, "1001", 2000), b.claim(row.id, "1002", 2000)];
    assert.deepEqual(wins, [true, false]);
    assert.equal(b.get(row.id)?.decidedBy, "1001");
  });
});

test("an expired card cannot be claimed even if nobody has marked it expired yet", () => {
  withTwoConnections((a) => {
    a.insert(row);
    assert.equal(a.claim(row.id, "1001", 5001), false);
    assert.equal(a.get(row.id)?.status, "pending");
  });
});

test("expire only moves a pending card, never a finished one", () => {
  withTwoConnections((a, b) => {
    a.insert(row);
    a.claim(row.id, "1001", 2000);
    a.finish(row.id, "done", "ok");
    assert.equal(b.expire(row.id), false);
    assert.equal(b.get(row.id)?.status, "done");
  });
});

test("finish cannot reopen or overwrite a decided card", () => {
  withTwoConnections((a) => {
    a.insert(row);
    a.claim(row.id, "1001", 2000);
    a.finish(row.id, "done", "first");
    a.finish(row.id, "failed", "second");
    assert.equal(a.get(row.id)?.status, "done");
    assert.equal(a.get(row.id)?.outcome, "first");
  });
});

test("the database rejects an unknown status rather than storing it", () => {
  withTwoConnections((a) => {
    a.insert(row);
    assert.throws(() => a.finish(row.id, "bogus" as "done", "x"), /CHECK constraint/);
  });
});
