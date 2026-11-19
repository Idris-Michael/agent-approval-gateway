// Approval gate tests. WHY each one exists:
// - only a named approver can decide; chat membership is not trusted
// - a forged or decision-swapped button never executes
// - a double tap (or two processes) runs the action once; a crash mid-run never re-fires
// - stale cards expire; pending cards survive a restart
// - a failed action is terminal and visible, never silently retried
// - a card the approver can't fully read is refused, not cut
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGate, hashArgs, type Gate, type GateEvent } from "../src/gate.js";
import { callbackData } from "../src/signing.js";
import { openApprovalStore, type ApprovalStore } from "../src/store.js";

const APPROVER = "1001";
const SECRET = "test-secret-that-is-at-least-32-characters";
const QUIET = { warn: () => {}, error: () => {} };

let dir: string;
let dbPath: string;
let store: ApprovalStore;
let gate: Gate;
let ran: string[];
let edits: string[];
let events: GateEvent[];
let boom: boolean;
let clock: number;

function makeGate(s: ApprovalStore, sendFails = false): Gate {
  return createGate({
    store: s,
    secret: SECRET,
    approverIds: [APPROVER],
    transport: {
      send: async () => { if (sendFails) throw new Error("chat API down"); return "77"; },
      edit: async (_id, text) => { edits.push(text); },
    },
    handlers: {
      issue_refund: {
        approve: async (c) => { if (boom) throw new Error("payments API down"); ran.push(`approve:${c.refId}`); return "Refund issued"; },
        reject: async (c) => { ran.push(`reject:${c.refId}`); return "Refund declined"; },
      },
    },
    now: () => clock,
    logger: QUIET,
    onEvent: (e) => events.push(e),
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-"));
  dbPath = path.join(dir, "approvals.db");
  store = openApprovalStore(dbPath);
  ran = []; edits = []; events = []; boom = false; clock = 1_700_000_000_000;
  gate = makeGate(store);
});

afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const card = () => gate.request({ kind: "issue_refund", refId: "R-101", text: "Refund £40 to customer 101" });
const tap = (data: string, fromId: string | number = APPROVER) => gate.handleTap({ data, fromId });
const approve = (id: string) => callbackData(SECRET, id, "approve");
const reject = (id: string) => callbackData(SECRET, id, "reject");

test("approver tap runs the action once and closes the card", async () => {
  const { id } = await card();
  const result = await tap(approve(id));
  assert.equal(result.status, "done");
  assert.deepEqual(ran, ["approve:R-101"]);
  assert.equal(gate.get(id)?.status, "done");
  assert.equal(gate.get(id)?.decidedBy, APPROVER);
  assert.match(edits[0]!, /Refund issued/);
});

test("reject runs the reject handler, never approve", async () => {
  const { id } = await card();
  await tap(reject(id));
  assert.deepEqual(ran, ["reject:R-101"]);
  assert.equal(gate.get(id)?.status, "rejected");
});

test("someone in the chat who is not an approver cannot decide, even with a valid button", async () => {
  const { id } = await card();
  const result = await tap(approve(id), "999");
  assert.equal(result.status, "not_authorised");
  assert.deepEqual(ran, []);
  assert.equal(gate.get(id)?.status, "pending");
});

test("forged signature is refused", async () => {
  const { id } = await card();
  const result = await tap(`ap:${id}:a:0000000000000000`);
  assert.equal(result.status, "invalid");
  assert.deepEqual(ran, []);
});

test("a reject signature cannot be replayed as approve", async () => {
  const { id } = await card();
  const sig = reject(id).split(":")[3];
  assert.equal((await tap(`ap:${id}:a:${sig}`)).status, "invalid");
  assert.deepEqual(ran, []);
});

test("a signature from one card does not work on another", async () => {
  const a = await card();
  const b = await card();
  const sigA = approve(a.id).split(":")[3];
  assert.equal((await tap(`ap:${b.id}:a:${sigA}`)).status, "invalid");
  assert.deepEqual(ran, []);
});

test("a button signed with a different secret is refused", async () => {
  const { id } = await card();
  const foreign = callbackData("another-secret-that-is-at-least-32-chars", id, "approve");
  assert.equal((await tap(foreign)).status, "invalid");
});

test("malformed button data never throws", async () => {
  for (const data of ["", "ap:nonsense", "ap:zz:a:zz", `ap:${"a".repeat(16)}:x:${"0".repeat(16)}`]) {
    assert.equal((await tap(data)).status, "invalid");
  }
  assert.equal((await gate.handleTap({ data: undefined, fromId: APPROVER })).status, "invalid");
  assert.deepEqual(ran, []);
});

test("double tap runs the action once", async () => {
  const { id } = await card();
  const results = await Promise.all([tap(approve(id)), tap(approve(id))]);
  assert.deepEqual(ran, ["approve:R-101"]);
  assert.deepEqual(results.map((r) => r.status).sort(), ["already_decided", "done"]);
});

test("two processes on the same database cannot both claim a card", async () => {
  const { id } = await card();
  const second = openApprovalStore(dbPath);
  try {
    const gate2 = makeGate(second);
    const results = await Promise.all([tap(approve(id)), gate2.handleTap({ data: approve(id), fromId: APPROVER })]);
    assert.equal(ran.length, 1);
    assert.deepEqual(results.map((r) => r.status).sort(), ["already_decided", "done"]);
  } finally {
    second.close();
  }
});

test("expired card refuses to execute and is closed", async () => {
  const { id } = await card();
  clock += 72 * 3_600_000 + 1;
  const result = await tap(approve(id));
  assert.equal(result.status, "expired");
  assert.deepEqual(ran, []);
  assert.equal(gate.get(id)?.status, "expired");
  assert.match(edits[0]!, /Expired/);
});

test("pending card survives a restart: state is in the database, not memory", async () => {
  const { id } = await card();
  store.close();
  store = openApprovalStore(dbPath);
  gate = makeGate(store);
  assert.equal(gate.get(id)?.status, "pending");
  await tap(approve(id));
  assert.deepEqual(ran, ["approve:R-101"]);
});

test("a crash mid-run leaves the card executing, so it cannot fire again after restart", async () => {
  const { id } = await card();
  assert.ok(store.claim(id, APPROVER, clock)); // simulate: claimed, then the process died
  store.close();
  store = openApprovalStore(dbPath);
  gate = makeGate(store);
  assert.equal((await tap(approve(id))).status, "already_decided");
  assert.deepEqual(ran, []);
});

test("failed action is terminal, shown on the card, and not retried by a second tap", async () => {
  boom = true;
  const { id } = await card();
  assert.equal((await tap(approve(id))).status, "failed");
  assert.equal(gate.get(id)?.status, "failed");
  assert.match(edits[0]!, /payments API down/);
  boom = false;
  await tap(approve(id));
  assert.deepEqual(ran, []);
});

test("a card too long to show in full is refused, not cut", async () => {
  await assert.rejects(gate.request({ kind: "issue_refund", refId: "1", text: "x".repeat(4000) }), /too long/);
  assert.deepEqual(gate.list(), []);
});

test("a card for an action with no handler is refused when raised, not when tapped", async () => {
  await assert.rejects(gate.request({ kind: "delete_account", refId: "1", text: "Delete" }), /no handler/);
});

test("if the card can't be delivered, the row is marked failed, never left pending", async () => {
  const failing = makeGate(store, true);
  await assert.rejects(failing.request({ kind: "issue_refund", refId: "R-9", text: "Refund" }), /chat API down/);
  const [row] = gate.list();
  assert.equal(row?.status, "failed");
  assert.match(row?.outcome ?? "", /not delivered/);
});

test("missing or short secret fails loudly at start-up", () => {
  const base = { store, approverIds: [APPROVER], transport: { send: async () => "1", edit: async () => {} }, handlers: {} };
  assert.throws(() => createGate({ ...base, secret: undefined }), /APPROVAL_HMAC_SECRET is not set/);
  assert.throws(() => createGate({ ...base, secret: "short" }), /at least 32/);
});

test("no approvers configured fails loudly instead of letting nobody (or everybody) approve", () => {
  assert.throws(
    () => createGate({ store, secret: SECRET, approverIds: [], transport: { send: async () => "1", edit: async () => {} }, handlers: {} }),
    /approver/,
  );
});

test("every decision emits an event with who did it, for the audit log", async () => {
  const { id } = await card();
  await tap(approve(id), "999");
  await tap(approve(id));
  assert.deepEqual(events.map((e) => e.type), ["requested", "refused", "claimed", "done"]);
  assert.equal(events.at(-1)?.actor, APPROVER);
});

test("the handler receives exactly the arguments stored with the approved card", async () => {
  let seen: unknown;
  const g = createGate({
    store, secret: SECRET, approverIds: [APPROVER], logger: QUIET,
    transport: { send: async () => "1", edit: async () => {} },
    handlers: { issue_refund: { approve: async (c) => { seen = c.args; return "ok"; }, reject: async () => "no" } },
  });
  const c = await g.request({ kind: "issue_refund", refId: "R-7", text: "Refund £40", args: { amountGbp: 40, customerId: "C-7" } });
  await g.handleTap({ data: approve(c.id), fromId: APPROVER });
  assert.deepEqual(seen, { amountGbp: 40, customerId: "C-7" });
});

test("a retried request with the same idempotency key returns the first card and sends nothing new", async () => {
  const req = { kind: "issue_refund", refId: "R-8", text: "Refund", args: { amountGbp: 10 }, idempotencyKey: "agent-run-1:step-3" };
  const first = await gate.request(req);
  const second = await gate.request(req);
  assert.equal(second.id, first.id);
  assert.equal(gate.list().length, 1);
});

test("reusing an idempotency key for different arguments is refused, not silently merged", async () => {
  await gate.request({ kind: "issue_refund", refId: "R-9", text: "Refund", args: { amountGbp: 10 }, idempotencyKey: "k1" });
  await assert.rejects(
    gate.request({ kind: "issue_refund", refId: "R-9", text: "Refund", args: { amountGbp: 4000 }, idempotencyKey: "k1" }),
    /already used for a different request/,
  );
});

test("the audit events pin a hash of the approved arguments", async () => {
  const c = await gate.request({ kind: "issue_refund", refId: "R-10", text: "Refund", args: { b: 2, a: 1 } });
  await tap(approve(c.id));
  const hashes = events.filter((e) => e.approvalId === c.id).map((e) => e.argsHash);
  assert.equal(new Set(hashes).size, 1);
  assert.equal(hashes[0], hashArgs({ a: 1, b: 2 })); // key order does not change the hash
});

test("a card nobody taps still expires when read, so a waiting agent is not left hanging", async () => {
  const { id } = await card();
  clock += 72 * 3_600_000 + 1;
  assert.equal(gate.get(id)?.status, "expired");
  assert.equal(gate.list("pending").length, 0);
  assert.match(edits[0] ?? "", /Expired/);
  assert.equal(events.filter((e) => e.type === "expired").length, 1);
  assert.equal(gate.get(id)?.status, "expired"); // second read: no duplicate event
  assert.equal(events.filter((e) => e.type === "expired").length, 1);
  assert.equal((await tap(approve(id))).status, "already_decided");
  assert.deepEqual(ran, []);
});
