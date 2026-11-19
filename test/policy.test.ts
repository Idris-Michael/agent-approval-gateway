// Policy tests. WHY:
// - default-deny: a tool the policy doesn't name is refused, so a hallucinated tool can't run
// - a broken policy fails at start-up with the exact location, never half-loads
// - per-tool approvers mean the ops lead can't approve a refund meant for finance
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadPolicy, parsePolicy } from "../src/policy.js";
import { createGate } from "../src/gate.js";
import { callbackData } from "../src/signing.js";
import { openApprovalStore } from "../src/store.js";

const valid = {
  version: 1,
  approverGroups: { finance: ["1001"], ops: ["2002"] },
  tools: {
    lookup_customer: { requiresApproval: false },
    issue_refund: { requiresApproval: true, approvers: ["finance"], expiryHours: 24 },
    send_invoice: { requiresApproval: true, approvers: ["finance", "ops"] },
  },
};

test("tools not in the policy are denied", () => {
  const d = parsePolicy(valid).decide("delete_all_customers");
  assert.equal(d.action, "deny");
});

test("read-only tools are allowed without approval", () => {
  assert.deepEqual(parsePolicy(valid).decide("lookup_customer"), { action: "allow" });
});

test("approval rules resolve groups to user ids and use the tool's own expiry", () => {
  const p = parsePolicy(valid);
  assert.deepEqual(p.decide("issue_refund"), { action: "require_approval", approverIds: ["1001"], expiryMs: 24 * 3_600_000 });
  const invoice = p.decide("send_invoice");
  assert.equal(invoice.action, "require_approval");
  if (invoice.action === "require_approval") {
    assert.deepEqual(invoice.approverIds.sort(), ["1001", "2002"]);
    assert.equal(invoice.expiryMs, 72 * 3_600_000);
  }
});

test("invalid policies fail loudly and say where", () => {
  const cases: Array<[unknown, RegExp]> = [
    [{ ...valid, version: 2 }, /version must be 1/],
    [{ ...valid, tools: {} }, /at least one tool/],
    [{ ...valid, tools: { issue_refund: { requiresApproval: true } } }, /issue_refund: approvers/],
    [{ ...valid, tools: { issue_refund: { requiresApproval: true, approvers: ["nobody"] } } }, /unknown approver group "nobody"/],
    [{ ...valid, tools: { issue_refund: { requiresApproval: "yes" } } }, /requiresApproval must be true or false/],
    [{ ...valid, tools: { lookup: { requiresApproval: false, approvers: ["finance"] } } }, /approvers set on a tool that needs no approval/],
    [{ ...valid, tools: { "Issue Refund": { requiresApproval: false } } }, /lower_snake_case/],
    [{ ...valid, tools: { issue_refund: { requiresApproval: true, approvers: ["finance"], expiryHours: 0 } } }, /expiryHours/],
    [{ ...valid, approverGroups: { finance: [] } }, /non-empty list/],
  ];
  for (const [raw, message] of cases) assert.throws(() => parsePolicy(raw), message);
});

test("the example policy in the repo is valid", () => {
  const env = { FINANCE_APPROVER_ID: "1001", OPS_APPROVER_ID: "2002" };
  const p = loadPolicy(path.join(import.meta.dirname, "..", "examples", "policy.json"), env);
  assert.deepEqual(p.decide("issue_refund"), { action: "require_approval", approverIds: ["1001"], expiryMs: 24 * 3_600_000 });
});

test("approver ids can come from the environment, and a missing one fails loudly", () => {
  const raw = { version: 1, approverGroups: { finance: ["env:FIN_ID"] }, tools: { issue_refund: { requiresApproval: true, approvers: ["finance"] } } };
  const d = parsePolicy(raw, { FIN_ID: "4242" }).decide("issue_refund");
  assert.equal(d.action === "require_approval" && d.approverIds[0], "4242");
  assert.throws(() => parsePolicy(raw, {}), /FIN_ID is not set/);
});

test("an unreadable or non-JSON policy file fails loudly", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "policy-"));
  try {
    assert.throws(() => loadPolicy(path.join(dir, "missing.json")), /could not be read/);
    fs.writeFileSync(path.join(dir, "bad.json"), "{nope");
    assert.throws(() => loadPolicy(path.join(dir, "bad.json")), /not valid JSON/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("with a policy, the gate refuses the wrong approver and unlisted or approval-free tools", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "policy-gate-"));
  const store = openApprovalStore(path.join(dir, "a.db"));
  const secret = "test-secret-that-is-at-least-32-characters";
  const ran: string[] = [];
  const handler = { approve: async (c: { refId: string }) => { ran.push(c.refId); return "ok"; }, reject: async () => "no" };
  try {
    const gate = createGate({
      store, secret, policy: parsePolicy(valid),
      transport: { send: async () => "1", edit: async () => {} },
      handlers: { issue_refund: handler, lookup_customer: handler, wire_money: handler },
      logger: { warn: () => {}, error: () => {} },
    });
    await assert.rejects(gate.request({ kind: "wire_money", refId: "x", text: "t" }), /not in the policy/);
    await assert.rejects(gate.request({ kind: "lookup_customer", refId: "x", text: "t" }), /does not need approval/);

    const card = await gate.request({ kind: "issue_refund", refId: "R-1", text: "Refund" });
    assert.equal(card.expiresAt - card.createdAt, 24 * 3_600_000);
    const data = callbackData(secret, card.id, "approve");
    assert.equal((await gate.handleTap({ data, fromId: "2002" })).status, "not_authorised"); // ops, not finance
    assert.equal((await gate.handleTap({ data, fromId: "3003" })).status, "not_authorised"); // nobody
    assert.deepEqual(ran, []);
    assert.equal((await gate.handleTap({ data, fromId: "1001" })).status, "done");
    assert.deepEqual(ran, ["R-1"]);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
