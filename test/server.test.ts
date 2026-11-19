// HTTP API tests. WHY:
// - an agent can't skip the policy: unlisted tools are 403, sensitive ones become a card
// - the card shows the arguments, so agent wording can't disguise what will run
// - keys are scoped: an agent key can't read the whole queue, a viewer key can't raise cards
// - bad input gets a clear 4xx, internal errors never leak detail, keys never reach the log
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type http from "node:http";
import { openAuditLog, verifyAudit } from "../src/audit.js";
import { createGate, type ApprovalCard } from "../src/gate.js";
import { parsePolicy } from "../src/policy.js";
import { createGatewayServer } from "../src/server.js";
import { callbackData } from "../src/signing.js";
import { openApprovalStore, type ApprovalStore } from "../src/store.js";

const SECRET = "test-secret-that-is-at-least-32-characters";
const AGENT_KEY = "agent-key-aaaaaaaaaaaaaaaaaaaaaaaa";
const VIEWER_KEY = "viewer-key-bbbbbbbbbbbbbbbbbbbbbbb";
const policy = parsePolicy({
  version: 1,
  approverGroups: { finance: ["1001"] },
  tools: {
    lookup_customer: { requiresApproval: false },
    issue_refund: { requiresApproval: true, approvers: ["finance"] },
  },
});

let dir: string;
let store: ApprovalStore;
let server: http.Server;
let base: string;
let sent: ApprovalCard[] = [];
let logs: Array<Record<string, unknown>> = [];
let failSend = false;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "server-"));
  store = openApprovalStore(path.join(dir, "a.db"));
  const auditFile = path.join(dir, "audit.jsonl");
  const audit = openAuditLog(auditFile);
  const gate = createGate({
    store, secret: SECRET, policy,
    transport: {
      send: async (c) => { if (failSend) throw new Error("chat API down"); sent.push(c); return String(sent.length); },
      edit: async () => {},
    },
    handlers: { issue_refund: { approve: async () => "Refund issued", reject: async () => "Declined" } },
    logger: { warn: () => {}, error: () => {} },
    onEvent: (e) => audit.append(e),
  });
  server = createGatewayServer({
    gate, policy, verifyAudit: () => verifyAudit(auditFile), rateLimitPerMinute: 1000,
    apiKeys: [{ name: "lender-agent", key: AGENT_KEY, scope: "agent" }, { name: "ops-console", key: VIEWER_KEY, scope: "viewer" }],
    log: (l) => logs.push(l),
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  (globalThis as Record<string, unknown>).__gate = gate;
});

after(async () => {
  await new Promise((r) => server.close(r));
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const call = (body: unknown, key = AGENT_KEY, headers: Record<string, string> = {}) =>
  fetch(`${base}/v1/tool-calls`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}`, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const get = (p: string, key = VIEWER_KEY) => fetch(`${base}${p}`, { headers: { authorization: `Bearer ${key}` } });

test("a tool not in the policy is refused with 403", async () => {
  const res = await call({ tool: "wire_money", args: { amountGbp: 1_000_000 } });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).decision, "deny");
});

test("a read-only tool is allowed straight away", async () => {
  const res = await call({ tool: "lookup_customer", args: { customerId: "C-1" } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { decision: "allow" });
});

test("a sensitive tool becomes a pending approval whose card is built from the arguments", async () => {
  const res = await call({ tool: "issue_refund", args: { amountGbp: 4000, customerId: "C-2" }, reason: "small goodwill refund" });
  assert.equal(res.status, 202);
  const body = await res.json();
  assert.equal(body.decision, "pending_approval");
  assert.equal(body.approval.status, "pending");
  const card = sent.at(-1)!.text;
  assert.match(card, /Amount Gbp: 4000/); // the real number is on the card...
  assert.ok(card.indexOf("4000") < card.indexOf("small goodwill")); // ...above the agent's wording
  assert.equal(JSON.stringify(body).includes("ap:"), false); // signed button data never leaves the gateway
});

test("the agent can poll its approval and sees the decision", async () => {
  const res = await call({ tool: "issue_refund", args: { amountGbp: 12, customerId: "C-3" } });
  const { approval } = await res.json();
  const gate = (globalThis as Record<string, unknown>).__gate as ReturnType<typeof createGate>;
  await gate.handleTap({ data: callbackData(SECRET, approval.id, "approve"), fromId: "1001" });
  const polled = await (await get(`/v1/approvals/${approval.id}`, AGENT_KEY)).json();
  assert.equal(polled.status, "done");
  assert.equal(polled.outcome, "Refund issued");
  assert.equal(polled.decidedBy, "1001");
});

test("a retried call with the same Idempotency-Key returns the same approval and sends one card", async () => {
  const before = sent.length;
  const body = { tool: "issue_refund", args: { amountGbp: 5, customerId: "C-4" } };
  const a = await (await call(body, AGENT_KEY, { "idempotency-key": "run-9:step-2" })).json();
  const b = await (await call(body, AGENT_KEY, { "idempotency-key": "run-9:step-2" })).json();
  assert.equal(a.approval.id, b.approval.id);
  assert.equal(sent.length, before + 1);
  const conflict = await call({ ...body, args: { amountGbp: 500, customerId: "C-4" } }, AGENT_KEY, { "idempotency-key": "run-9:step-2" });
  assert.equal(conflict.status, 409);
});

test("keys are scoped: agents can't list the queue, viewers can't raise cards, strangers get 401", async () => {
  assert.equal((await get("/v1/approvals", AGENT_KEY)).status, 403);
  assert.equal((await call({ tool: "issue_refund", args: {} }, VIEWER_KEY)).status, 403);
  assert.equal((await get("/v1/approvals", "not-a-real-key-ccccccccccccccc")).status, 401);
  assert.equal((await fetch(`${base}/v1/approvals`)).status, 401);
  assert.equal((await get("/v1/approvals?status=pending")).status, 200);
});

test("bad input gets a specific 4xx", async () => {
  assert.equal((await call("{not json")).status, 400);
  assert.equal((await call({ args: {} })).status, 400);
  assert.equal((await call({ tool: "issue_refund", args: [1, 2] })).status, 400);
  assert.equal((await call({ tool: "issue_refund", args: { note: "x".repeat(400) } })).status, 422);
  assert.equal((await call({ tool: "issue_refund" }, AGENT_KEY, { "idempotency-key": "has spaces" })).status, 400);
  assert.equal((await call({ tool: "issue_refund", args: { blob: "x".repeat(40_000) } })).status, 413);
  const wrongType = await fetch(`${base}/v1/tool-calls`, { method: "POST", headers: { authorization: `Bearer ${AGENT_KEY}` }, body: "tool=x" });
  assert.equal(wrongType.status, 415);
  assert.equal((await get("/v1/approvals?status=bogus")).status, 400);
  assert.equal((await get("/v1/approvals/zzz")).status, 404);
});

test("if the card can't be delivered the agent gets 502, not a silent pending", async () => {
  failSend = true;
  try {
    const res = await call({ tool: "issue_refund", args: { amountGbp: 1, customerId: "C-5" } });
    assert.equal(res.status, 502);
    assert.equal((await res.json()).code, "delivery_failed");
  } finally {
    failSend = false;
  }
});

test("the audit endpoint reports the chain as verified", async () => {
  const audit = await (await get("/v1/audit")).json();
  assert.equal(audit.ok, true);
  assert.ok(audit.entries > 0);
});

test("the console is served with a nonce CSP and security headers", async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  const csp = res.headers.get("content-security-policy") ?? "";
  const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
  assert.ok(nonce);
  assert.match(await res.text(), new RegExp(`<script nonce="${nonce!.replace(/[+/=]/g, "\\$&")}">`));
  assert.match(csp, /default-src 'none'/);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
});

test("request logs name the key but never contain the key itself", () => {
  const text = JSON.stringify(logs);
  assert.ok(text.includes("lender-agent"));
  assert.equal(text.includes(AGENT_KEY), false);
  assert.equal(text.includes(VIEWER_KEY), false);
});

test("short API keys are refused at start-up", () => {
  assert.throws(
    () => createGatewayServer({ gate: {} as never, policy, apiKeys: [{ name: "x", key: "short", scope: "agent" }] }),
    /at least 24/,
  );
});

test("the rate limit returns 429 with Retry-After", async () => {
  const limited = createGatewayServer({
    gate: {} as never, policy, rateLimitPerMinute: 2, log: () => {},
    apiKeys: [{ name: "v", key: VIEWER_KEY, scope: "viewer" }],
  });
  await new Promise<void>((r) => limited.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(limited.address() as AddressInfo).port}/v1/audit`;
  try {
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) statuses.push((await fetch(url, { headers: { authorization: `Bearer ${VIEWER_KEY}` } })).status);
    assert.deepEqual(statuses.slice(0, 2), [404, 404]); // audit not configured, but the request was allowed
    assert.equal(statuses[2], 429);
  } finally {
    await new Promise((r) => limited.close(r));
  }
});

test("the console hides the key form once logged in (hidden must beat the form's display rule)", async () => {
  const html = await (await fetch(`${base}/`)).text();
  assert.match(html, /\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/);
});
