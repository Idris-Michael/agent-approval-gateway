// End-to-end: the real gateway (policy, gate, queue worker, audit log, HTTP API, Telegram
// polling) against a fake Telegram Bot API on localhost. WHY: the unit tests prove each part;
// this proves they are wired together, from tool call to card to tap to one execution.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { configFromEnv, startGateway, type GatewayConfig } from "../src/index.js";

const TOKEN = "123456:ABCdefGhIJKlmnoPQRstuVWXyz0123456789";
const APPROVER = 1001;

interface FakeTelegram {
  url: string;
  sent: Array<{ chat_id: string; text: string; reply_markup?: { inline_keyboard: Array<Array<{ callback_data: string }>> } }>;
  answers: string[];
  tap: (fromId: number, data: string) => void;
  close: () => Promise<void>;
}

async function fakeTelegram(): Promise<FakeTelegram> {
  const sent: FakeTelegram["sent"] = [];
  const answers: string[] = [];
  const queue: unknown[] = [];
  let updateId = 1;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => { body += c.toString(); });
    req.on("end", () => {
      const method = (req.url ?? "").split("/").pop();
      const json = body ? (JSON.parse(body) as Record<string, unknown>) : {};
      const reply = (result: unknown): void => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ ok: true, result })); };
      if (!(req.url ?? "").startsWith(`/bot${TOKEN}/`)) { res.statusCode = 401; res.end(JSON.stringify({ ok: false, description: "Unauthorized" })); return; }
      if (method === "sendMessage") { sent.push(json as FakeTelegram["sent"][number]); reply({ message_id: sent.length }); return; }
      if (method === "getUpdates") { setTimeout(() => reply(queue.splice(0)), queue.length ? 0 : 50); return; }
      if (method === "answerCallbackQuery") { answers.push(String(json.text)); reply(true); return; }
      reply(true); // editMessageText
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    sent,
    answers,
    tap: (fromId, data) => { queue.push({ update_id: updateId++, callback_query: { id: `q${updateId}`, data, from: { id: fromId } } }); },
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

const until = async (cond: () => boolean, ms = 8000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
  assert.ok(cond(), "condition not reached in time");
};

test("config from the environment lists every missing variable at once", () => {
  assert.throws(() => configFromEnv({}), /TELEGRAM_BOT_TOKEN, APPROVER_CHAT_ID, APPROVAL_HMAC_SECRET, AGENT_API_KEY, VIEWER_API_KEY/);
  const base = { TELEGRAM_BOT_TOKEN: TOKEN, APPROVER_CHAT_ID: "1", APPROVAL_HMAC_SECRET: "s", AGENT_API_KEY: "a", VIEWER_API_KEY: "v" };
  assert.throws(() => configFromEnv({ ...base, PORT: "99999" }), /PORT/);
  assert.equal(configFromEnv(base).port, 8787);
});

test("start-up refuses a policy tool that needs approval but has no executor", async () => {
  process.env.FINANCE_APPROVER_ID = String(APPROVER);
  process.env.OPS_APPROVER_ID = "2002";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "app-"));
  try {
    const config: GatewayConfig = {
      telegramToken: TOKEN, approverChatId: "1", hmacSecret: "x".repeat(32), agentApiKey: "a".repeat(24), viewerApiKey: "v".repeat(24),
      policyPath: "examples/policy.json", dataDir: dir, port: 0, host: "127.0.0.1",
    };
    await assert.rejects(startGateway(config, { issue_refund: async () => "ok" }), /"send_invoice" but no executor/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("tool call → card on the approver's phone → tap → runs once → audit verifies", async () => {
  process.env.FINANCE_APPROVER_ID = String(APPROVER);
  process.env.OPS_APPROVER_ID = "2002";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "app-"));
  const telegram = await fakeTelegram();
  const ran: unknown[] = [];
  const agentKey = "agent-key-aaaaaaaaaaaaaaaaaaaaaaaa";
  const viewerKey = "viewer-key-bbbbbbbbbbbbbbbbbbbbbbb";
  const gateway = await startGateway({
    telegramToken: TOKEN, approverChatId: String(APPROVER), hmacSecret: "s".repeat(40), agentApiKey: agentKey, viewerApiKey: viewerKey,
    policyPath: "examples/policy.json", dataDir: dir, port: 0, host: "127.0.0.1", telegramApiBase: telegram.url,
  }, {
    issue_refund: async (args, { idempotencyKey }) => { ran.push({ args, idempotencyKey }); return "Refund RF-1 issued"; },
    send_invoice: async () => "Invoice sent",
  }, { warn: () => {}, error: () => {} });

  try {
    const res = await fetch(`${gateway.url}/v1/tool-calls`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${agentKey}` },
      body: JSON.stringify({ tool: "issue_refund", args: { customer_id: "C-1042", amount_gbp: 40, reason_code: "duplicate_charge" }, reason: "charged twice" }),
    });
    assert.equal(res.status, 202);
    const { approval } = (await res.json()) as { approval: { id: string } };

    await until(() => telegram.sent.length === 1);
    const card = telegram.sent[0]!;
    assert.match(card.text, /Amount gbp: 40/);
    const [approveBtn] = card.reply_markup!.inline_keyboard[0]!;

    telegram.tap(999, approveBtn!.callback_data); // someone else in the chat
    await until(() => telegram.answers.length === 1);
    assert.equal(telegram.answers[0], "Not authorised");

    telegram.tap(APPROVER, approveBtn!.callback_data);
    telegram.tap(APPROVER, approveBtn!.callback_data); // double tap
    await until(() => ran.length === 1 && telegram.sent.some((m) => m.text.startsWith("Done:")));
    assert.deepEqual(ran, [{ args: { customer_id: "C-1042", amount_gbp: 40, reason_code: "duplicate_charge" }, idempotencyKey: `approval:${approval.id}` }]);

    const view = (await (await fetch(`${gateway.url}/v1/approvals/${approval.id}`, { headers: { authorization: `Bearer ${agentKey}` } })).json()) as {
      status: string; decidedBy: string; execution: { status: string; result: string };
    };
    assert.equal(view.status, "done");
    assert.equal(view.decidedBy, String(APPROVER));
    assert.deepEqual(view.execution, { status: "done", result: "Refund RF-1 issued" });

    const audit = (await (await fetch(`${gateway.url}/v1/audit`, { headers: { authorization: `Bearer ${viewerKey}` } })).json()) as { ok: boolean; entries: number };
    assert.equal(audit.ok, true);
    assert.equal(audit.entries, 4); // requested, refused, claimed, done
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(ran.length, 1); // the double tap never ran it again
  } finally {
    await gateway.close();
    await telegram.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
