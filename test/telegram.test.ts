// Telegram transport tests, against a fake Bot API (no network). WHY:
// - card text goes out as plain text, so argument values can't inject links or formatting
// - closing a card removes its buttons, so it can't be tapped again
// - each tap is answered exactly once (Telegram rejects a second answer)
// - a tap that crashes the handler is not replayed forever
// - the bot token never appears in an error message
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTelegramTransport, startTelegramPolling } from "../src/telegram.js";
import type { TapResult } from "../src/gate.js";

const TOKEN = "123456:ABCdefGhIJKlmnoPQRstuVWXyz0123456789";

interface Call { method: string; body: Record<string, unknown> }

function fakeApi(handler: (method: string, body: Record<string, unknown>) => unknown) {
  const calls: Call[] = [];
  const fetch = async (url: string, init?: { body?: string }) => {
    // Yield to the event loop like real network I/O; an instant fake would starve the timers
    await new Promise((r) => setImmediate(r));
    const method = url.split("/").pop()!;
    const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
    calls.push({ method, body });
    const reply = handler(method, body);
    return { ok: true, status: 200, json: async () => reply };
  };
  return { calls, fetch };
}

const until = async (cond: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(cond(), "condition not reached");
};

test("cards go out as plain text with Approve and Reject buttons", async () => {
  const api = fakeApi(() => ({ ok: true, result: { message_id: 55 } }));
  const t = createTelegramTransport({ token: TOKEN, chatId: "1001", fetch: api.fetch });
  const id = await t.send({ id: "a", text: "Refund <b>£40</b>", approveData: "ap:x:a:y", rejectData: "ap:x:r:y" });
  assert.equal(id, "55");
  const body = api.calls[0]!.body;
  assert.equal(body.parse_mode, undefined);
  assert.equal(body.text, "Refund <b>£40</b>");
  assert.deepEqual(body.reply_markup, {
    inline_keyboard: [[{ text: "Approve", callback_data: "ap:x:a:y" }, { text: "Reject", callback_data: "ap:x:r:y" }]],
  });
});

test("editing a card removes its buttons", async () => {
  const api = fakeApi(() => ({ ok: true, result: true }));
  const t = createTelegramTransport({ token: TOKEN, chatId: "1001", fetch: api.fetch });
  await t.edit("55", "Approved");
  assert.equal(api.calls[0]!.method, "editMessageText");
  assert.equal(api.calls[0]!.body.reply_markup, undefined);
});

test("the bot token never appears in error messages", async () => {
  const leaky = async (url: string) => { throw new Error(`connect ECONNREFUSED ${url}`); };
  const t = createTelegramTransport({ token: TOKEN, chatId: "1", fetch: leaky });
  await assert.rejects(t.notify("hi"), (e: Error) => !e.message.includes(TOKEN) && e.message.includes("<bot-token>"));
  const api = fakeApi(() => ({ ok: false, description: `Unauthorized for bot${TOKEN}` }));
  const t2 = createTelegramTransport({ token: TOKEN, chatId: "1", fetch: api.fetch });
  await assert.rejects(t2.notify("hi"), (e: Error) => !e.message.includes(TOKEN));
});

test("a malformed token is refused at start-up", () => {
  assert.throws(() => createTelegramTransport({ token: "", chatId: "1" }), /TELEGRAM_BOT_TOKEN/);
  assert.throws(() => createTelegramTransport({ token: "not-a-token", chatId: "1" }), /TELEGRAM_BOT_TOKEN/);
});

test("polling hands taps to the gate and answers each tap exactly once", async () => {
  let served = false;
  const api = fakeApi((method) => {
    if (method === "getUpdates") {
      if (served) return { ok: true, result: [] };
      served = true;
      return { ok: true, result: [
        { update_id: 10, callback_query: { id: "q1", data: "ap:claim", from: { id: 1001 } } },
        { update_id: 11, callback_query: { id: "q2", data: "ap:refuse", from: { id: 999 } } },
      ] };
    }
    return { ok: true, result: true };
  });
  const taps: string[] = [];
  const stop = startTelegramPolling({
    token: TOKEN, fetch: api.fetch, timeoutS: 0,
    onTap: async (tap, ack): Promise<TapResult> => {
      taps.push(`${tap.fromId}:${tap.data}`);
      if (tap.data === "ap:claim") { await ack("Working..."); return { status: "done", message: "Refund issued" }; }
      return { status: "not_authorised", message: "Not authorised" };
    },
  });
  try {
    await until(() => api.calls.filter((c) => c.method === "answerCallbackQuery").length === 2);
    assert.deepEqual(taps, ["1001:ap:claim", "999:ap:refuse"]);
    const answers = api.calls.filter((c) => c.method === "answerCallbackQuery").map((c) => [c.body.callback_query_id, c.body.text]);
    assert.deepEqual(answers, [["q1", "Working..."], ["q2", "Not authorised"]]);
    const second = api.calls.filter((c) => c.method === "getUpdates")[1];
    if (second) assert.equal(second.body.offset, 12); // both updates acknowledged
  } finally {
    stop();
  }
});

test("a tap that crashes the handler is skipped, not replayed forever", async () => {
  let n = 0;
  const api = fakeApi((method) => {
    if (method !== "getUpdates") return { ok: true, result: true };
    n++;
    return { ok: true, result: n === 1 ? [{ update_id: 7, callback_query: { id: "q", data: "x", from: { id: 1 } } }] : [] };
  });
  const errors: string[] = [];
  let taps = 0;
  const stop = startTelegramPolling({
    token: TOKEN, fetch: api.fetch, timeoutS: 0, onError: (m) => errors.push(m),
    onTap: async () => { taps++; throw new Error("boom"); },
  });
  try {
    await until(() => n >= 3);
    assert.equal(taps, 1);
    assert.match(errors[0] ?? "", /boom/);
    assert.equal(api.calls.filter((c) => c.method === "getUpdates")[1]!.body.offset, 8);
  } finally {
    stop();
  }
});

test("polling backs off on errors and honours Telegram's retry_after", async () => {
  let n = 0;
  const waits: number[] = [];
  const api = fakeApi(() => {
    n++;
    return n === 1 ? { ok: false, description: "Too Many Requests", parameters: { retry_after: 3 } }
      : n === 2 ? { ok: false, description: "Bad Gateway" }
      : { ok: true, result: [] };
  });
  const stop = startTelegramPolling({
    token: TOKEN, fetch: api.fetch, timeoutS: 0, onError: () => {},
    onTap: async () => ({ status: "done", message: "" }),
    sleep: async (ms) => { waits.push(ms); },
  });
  try {
    await until(() => n >= 3);
    assert.deepEqual(waits.slice(0, 2), [3000, 1000]);
  } finally {
    stop();
  }
});
