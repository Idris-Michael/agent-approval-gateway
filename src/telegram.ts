// Telegram transport. Sends cards with Approve / Reject buttons and long-polls for taps, so
// it needs no public URL or webhook. Card text is sent as plain text (no parse_mode), so
// argument values can't inject formatting or links. The bot token is scrubbed from every
// error message, because a token in a log file is a token anyone with the logs can use.
import type { ApprovalTransport, Tap, TapResult } from "./gate.js";

type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) =>
  Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface TelegramOptions {
  token: string;
  fetch?: FetchLike;
  apiBase?: string;
}

interface TelegramReply<T> {
  ok: boolean;
  result?: T;
  description?: string;
  parameters?: { retry_after?: number };
}

interface CallbackQuery {
  id: string;
  data?: string;
  from: { id: number };
}

interface Update {
  update_id: number;
  callback_query?: CallbackQuery;
}

export class TelegramError extends Error {
  constructor(message: string, readonly retryAfterS?: number) {
    super(message);
    this.name = "TelegramError";
  }
}

function makeClient(opts: TelegramOptions) {
  if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(opts.token)) throw new Error("TELEGRAM_BOT_TOKEN is missing or not a bot token");
  const doFetch = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const base = `${opts.apiBase ?? "https://api.telegram.org"}/bot${opts.token}`;
  const scrub = (s: string): string => s.split(opts.token).join("<bot-token>");

  return {
    scrub,
    async call<T>(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
      let reply: TelegramReply<T>;
      try {
        const res = await doFetch(`${base}/${method}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal,
        });
        reply = (await res.json()) as TelegramReply<T>;
      } catch (e) {
        throw new TelegramError(scrub(`telegram ${method} request failed: ${e instanceof Error ? e.message : String(e)}`));
      }
      if (!reply.ok || reply.result === undefined) {
        throw new TelegramError(scrub(`telegram ${method} failed: ${reply.description ?? "unknown error"}`), reply.parameters?.retry_after);
      }
      return reply.result;
    },
  };
}

export interface TelegramTransport extends ApprovalTransport {
  /** Plain message to the approver chat, used for "task finished" notices. */
  notify: (text: string) => Promise<void>;
}

export function createTelegramTransport(opts: TelegramOptions & { chatId: string }): TelegramTransport {
  const client = makeClient(opts);
  return {
    async send(card) {
      const msg = await client.call<{ message_id: number }>("sendMessage", {
        chat_id: opts.chatId,
        text: card.text,
        reply_markup: {
          inline_keyboard: [[
            { text: "Approve", callback_data: card.approveData },
            { text: "Reject", callback_data: card.rejectData },
          ]],
        },
      });
      return String(msg.message_id);
    },
    // Editing without reply_markup removes the buttons, so a closed card can't be tapped again
    async edit(messageId, text) {
      await client.call("editMessageText", { chat_id: opts.chatId, message_id: Number(messageId), text });
    },
    async notify(text) {
      await client.call("sendMessage", { chat_id: opts.chatId, text });
    },
  };
}

export interface PollOptions extends TelegramOptions {
  onTap: (tap: Tap, ack: (message: string) => Promise<void>) => Promise<TapResult>;
  onError?: (message: string) => void;
  timeoutS?: number;
  /** Test hook: how long to wait after an error before polling again. */
  sleep?: (ms: number) => Promise<void>;
}

/** Long-polls getUpdates for button taps. Returns a stop function. */
export function startTelegramPolling(opts: PollOptions): () => void {
  const client = makeClient(opts);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const controller = new AbortController();
  let offset = 0;
  let backoffMs = 1000;
  let running = true;

  async function handle(q: CallbackQuery): Promise<void> {
    // Telegram accepts one answer per tap: the gate's ack if it claimed the card, otherwise the result
    let answered = false;
    const answer = async (text: string): Promise<void> => {
      if (answered) return;
      answered = true;
      await client.call("answerCallbackQuery", { callback_query_id: q.id, text }).catch((e: unknown) =>
        opts.onError?.(client.scrub(`answerCallbackQuery failed: ${(e as Error).message}`)));
    };
    const result = await opts.onTap({ data: q.data, fromId: q.from.id }, answer);
    await answer(result.message);
  }

  void (async () => {
    while (running) {
      try {
        const updates = await client.call<Update[]>(
          "getUpdates",
          { offset, timeout: opts.timeoutS ?? 25, allowed_updates: ["callback_query"] },
          controller.signal,
        );
        backoffMs = 1000;
        for (const u of updates) {
          offset = u.update_id + 1; // advance first, so a crashing tap is not replayed forever
          if (u.callback_query) {
            await handle(u.callback_query).catch((e: unknown) =>
              opts.onError?.(client.scrub(`tap handling failed: ${(e as Error).message}`)));
          }
        }
      } catch (e) {
        if (!running) break;
        const err = e as TelegramError;
        opts.onError?.(client.scrub(err.message));
        if (err.retryAfterS) {
          await sleep(err.retryAfterS * 1000); // Telegram said exactly how long; don't grow our own backoff
        } else {
          await sleep(backoffMs);
          backoffMs = Math.min(backoffMs * 2, 30_000);
        }
      }
    }
  })();

  return () => {
    running = false;
    controller.abort();
  };
}
