// Argument schema tests. WHY: in a live run the agent sent snake_case arguments while a payments
// executor read camelCase. The card looked right, the approver approved, and the stub "refunded"
// £undefined to customer undefined. The gateway must refuse a call whose arguments don't match
// the tool's contract before anyone is asked to approve it, and enforce limits as policy.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { parseArgSchema, validateArgs } from "../src/argSchema.js";
import { createGate } from "../src/gate.js";
import { loadPolicy } from "../src/policy.js";
import { createGatewayServer } from "../src/server.js";
import { openApprovalStore } from "../src/store.js";

const schema = parseArgSchema({
  customer_id: { type: "string", maxLength: 20 },
  amount_gbp: { type: "number", min: 0.01, max: 500 },
  reason_code: { type: "string", enum: ["duplicate_charge", "goodwill"] },
  note: { type: "string", required: false },
  count: "integer",
}, "t");

const good = { customer_id: "C-1042", amount_gbp: 40, reason_code: "duplicate_charge", count: 1 };

test("valid arguments pass", () => {
  assert.deepEqual(validateArgs(schema, good), []);
  assert.deepEqual(validateArgs(schema, { ...good, note: "fine" }), []);
});

test("the live-run bug: camelCase names are rejected, naming both the stray and the missing fields", () => {
  const problems = validateArgs(schema, { customerId: "C-1042", amountGbp: 40, reason_code: "duplicate_charge", count: 1 });
  assert.ok(problems.some((p) => p.includes('unexpected argument "customerId"')));
  assert.ok(problems.some((p) => p.includes('missing required argument "customer_id"')));
  assert.ok(problems.some((p) => p.includes('missing required argument "amount_gbp"')));
});

test("types, limits, enums and lengths are enforced", () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ ...good, amount_gbp: "40" }, /"amount_gbp" must be a number/],
    [{ ...good, amount_gbp: 4000 }, /at most 500/],
    [{ ...good, amount_gbp: 0 }, /at least 0.01/],
    [{ ...good, amount_gbp: Number.NaN }, /must be a number/],
    [{ ...good, reason_code: "because" }, /must be one of duplicate_charge, goodwill/],
    [{ ...good, customer_id: "C".repeat(21) }, /at most 20 characters/],
    [{ ...good, count: 1.5 }, /must be a integer/],
    [{ ...good, customer_id: null }, /missing required argument "customer_id"/],
  ];
  for (const [args, message] of cases) assert.match(validateArgs(schema, args).join("; "), message);
});

test("a malformed schema fails at start-up with its location", () => {
  const cases: Array<[unknown, RegExp]> = [
    [{}, /at least one argument/],
    [{ AmountGbp: "number" }, /lower_snake_case/],
    [{ a: "money" }, /type must be one of/],
    [{ a: { type: "string", max: 5 } }, /max needs a numeric type/],
    [{ a: { type: "number", enum: ["x"] } }, /enum needs a string type/],
    [{ a: { type: "string", maxLength: 0 } }, /maxLength needs/],
    [{ a: { type: "string", required: "yes" } }, /required must be true or false/],
  ];
  for (const [raw, message] of cases) assert.throws(() => parseArgSchema(raw, "policy.tools.x.args"), message);
});

test("through the API, mismatched arguments get 422 and no card is ever sent", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "args-"));
  const store = openApprovalStore(path.join(dir, "a.db"));
  const policy = loadPolicy(path.join(import.meta.dirname, "..", "examples", "policy.json"), { FINANCE_APPROVER_ID: "1001", OPS_APPROVER_ID: "2002" });
  let cards = 0;
  const gate = createGate({
    store, policy, secret: "test-secret-that-is-at-least-32-characters",
    transport: { send: async () => { cards++; return "1"; }, edit: async () => {} },
    handlers: { issue_refund: { approve: async () => "ok", reject: async () => "no" } },
    logger: { warn: () => {}, error: () => {} },
  });
  const key = "agent-key-aaaaaaaaaaaaaaaaaaaaaaaa";
  const server = createGatewayServer({ gate, policy, apiKeys: [{ name: "a", key, scope: "agent" }], log: () => {} });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/tool-calls`;
  const post = (args: unknown) => fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ tool: "issue_refund", args }),
  });
  try {
    const camel = await post({ customerId: "C-1042", amountGbp: 40, reasonCode: "duplicate_charge" });
    assert.equal(camel.status, 422);
    assert.ok(((await camel.json()) as { problems: string[] }).problems.length >= 3);
    assert.equal((await post({ customer_id: "C-1042", amount_gbp: 4000, reason_code: "goodwill" })).status, 422); // over the £500 limit
    assert.equal(cards, 0);
    assert.equal((await post({ customer_id: "C-1042", amount_gbp: 40, reason_code: "duplicate_charge" })).status, 202);
    assert.equal(cards, 1);
  } finally {
    await new Promise((r) => server.close(r));
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the gate enforces the schema too, for callers that use the library directly", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "args-gate-"));
  const store = openApprovalStore(path.join(dir, "a.db"));
  try {
    const policy = loadPolicy(path.join(import.meta.dirname, "..", "examples", "policy.json"), { FINANCE_APPROVER_ID: "1", OPS_APPROVER_ID: "2" });
    const gate = createGate({
      store, policy, secret: "test-secret-that-is-at-least-32-characters",
      transport: { send: async () => "1", edit: async () => {} },
      handlers: { issue_refund: { approve: async () => "ok", reject: async () => "no" } },
    });
    await assert.rejects(gate.request({ kind: "issue_refund", refId: "r", text: "t", args: { amountGbp: 40 } }), /arguments rejected/);
    assert.equal(gate.list().length, 0);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
