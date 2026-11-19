// The approval gate. Agents can only raise a card; the action runs when an approver taps
// Approve. Who may approve is checked by the tapper's own user id, not by which chat the
// tap came from, because chat membership is easy to widen by accident.
import crypto from "node:crypto";
import type { Policy } from "./policy.js";
import { callbackData, newApprovalId, requireSecret, verifyCallback, type Decision } from "./signing.js";
import type { Approval, ApprovalStore } from "./store.js";

export type GateErrorCode = "invalid_request" | "conflict" | "delivery_failed";

/** Request errors carry a code, so an HTTP layer can map them without parsing messages. */
export class GateError extends Error {
  constructor(readonly code: GateErrorCode, message: string) {
    super(message);
    this.name = "GateError";
  }
}

/** Receives the approved card, so it runs exactly the arguments the approver saw. */
export interface ApprovalHandler {
  approve: (card: Approval) => Promise<string>;
  reject: (card: Approval) => Promise<string>;
}

export interface ApprovalRequest {
  kind: string;
  refId: string;
  text: string;
  args?: Record<string, unknown>;
  /** A retried request with the same key returns the original card instead of sending another. */
  idempotencyKey?: string;
}

export interface ApprovalCard {
  id: string;
  text: string;
  approveData: string;
  rejectData: string;
}

/** Delivers cards to a person (Telegram, Slack, Teams, email link...). Returns the message id. */
export interface ApprovalTransport {
  send: (card: ApprovalCard) => Promise<string>;
  edit: (messageId: string, text: string) => Promise<void>;
}

export interface Tap {
  data: string | undefined;
  fromId: string | number;
}

export type TapStatus =
  | "not_authorised" | "invalid" | "unknown" | "already_decided" | "expired" | "no_handler"
  | "done" | "rejected" | "failed";

export interface TapResult {
  status: TapStatus;
  message: string;
}

export type GateEventType = "requested" | "send_failed" | "refused" | "expired" | "claimed" | "done" | "rejected" | "failed";

export interface GateEvent {
  type: GateEventType;
  at: number;
  approvalId?: string;
  kind?: string;
  refId?: string;
  actor?: string;
  detail?: string;
  /** SHA-256 of the approved arguments, so the audit log pins exactly what ran. */
  argsHash?: string;
}

export interface Logger {
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

export interface GateOptions {
  store: ApprovalStore;
  secret: string | undefined;
  /** Per-tool approvers and expiry. When set, it overrides approverIds and expiryMs per card. */
  policy?: Policy;
  approverIds?: ReadonlyArray<string | number>;
  transport: ApprovalTransport;
  handlers: Readonly<Record<string, ApprovalHandler>>;
  expiryMs?: number;
  maxCardChars?: number;
  now?: () => number;
  logger?: Logger;
  /** Called for every state change. The audit log subscribes here. Must not throw. */
  onEvent?: (e: GateEvent) => void;
}

export interface Gate {
  request: (input: ApprovalRequest) => Promise<Approval>;
  /** `ack` is called once this tap owns the run, before the handler starts (clears chat spinners). */
  handleTap: (tap: Tap, ack?: (message: string) => Promise<void>) => Promise<TapResult>;
  list: ApprovalStore["list"];
  get: ApprovalStore["get"];
}

export const DEFAULT_EXPIRY_MS = 72 * 3_600_000;
// Telegram caps a message at 4,096 chars; leave room for the outcome line added on close
export const DEFAULT_MAX_CARD_CHARS = 3_800;

const defaultLogger: Logger = {
  warn: (m) => console.warn(`[approval] ${m}`),
  error: (m) => console.error(`[approval] ${m}`),
};

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// Sorted keys, so the same arguments always give the same hash
const canonical = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(canonical)
    : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])]))
    : v;
export const hashArgs = (args: Record<string, unknown>): string =>
  crypto.createHash("sha256").update(JSON.stringify(canonical(args))).digest("hex");

export function createGate(opts: GateOptions): Gate {
  const secret = requireSecret(opts.secret);
  const { store, transport, handlers, policy } = opts;
  const defaultApprovers = new Set((opts.approverIds ?? []).map(String));
  if (!policy && defaultApprovers.size === 0) throw new Error("at least one approver id (or a policy) is required");
  const defaultExpiryMs = opts.expiryMs ?? DEFAULT_EXPIRY_MS;

  // Who may decide this kind of card, and how long it stays open
  const ruleFor = (kind: string): { approvers: Set<string>; expiryMs: number } => {
    if (!policy) return { approvers: defaultApprovers, expiryMs: defaultExpiryMs };
    const d = policy.decide(kind);
    if (d.action === "deny") throw new GateError("invalid_request", d.reason);
    if (d.action === "allow") throw new GateError("invalid_request", `tool "${kind}" does not need approval; call it directly`);
    return { approvers: new Set(d.approverIds), expiryMs: d.expiryMs };
  };
  const maxChars = opts.maxCardChars ?? DEFAULT_MAX_CARD_CHARS;
  const now = opts.now ?? Date.now;
  const log = opts.logger ?? defaultLogger;

  const emit = (e: Omit<GateEvent, "at">): void => {
    try {
      opts.onEvent?.({ ...e, at: now() });
    } catch (err) {
      log.error(`event listener failed: ${errorMessage(err)}`);
    }
  };

  // A failed edit must not undo a finished action, so it is logged, not thrown
  const closeCard = async (a: Approval, line: string): Promise<void> => {
    if (!a.messageId) return;
    await transport.edit(a.messageId, `${a.text}\n\n${line}`)
      .catch((e: unknown) => log.error(`card ${a.id} edit failed: ${errorMessage(e)}`));
  };

  /** Refuses rather than truncating: nobody should approve words they can't see. */
  async function request(input: ApprovalRequest): Promise<Approval> {
    const { expiryMs } = ruleFor(input.kind);
    if (input.idempotencyKey) {
      const existing = store.getByIdempotencyKey(input.idempotencyKey);
      if (existing) {
        if (existing.kind !== input.kind || hashArgs(existing.args) !== hashArgs(input.args ?? {})) {
          throw new GateError("conflict", `idempotency key "${input.idempotencyKey}" was already used for a different request`);
        }
        return existing;
      }
    }
    if (!handlers[input.kind]) throw new GateError("invalid_request", `no handler registered for kind "${input.kind}"`);
    if (input.text.length > maxChars) throw new GateError("invalid_request", `approval card too long (${input.text.length} chars, max ${maxChars})`);

    // Row first, then send: a tap can never arrive for a card the store doesn't know
    const createdAt = now();
    const row = store.insert({ ...input, id: newApprovalId(), createdAt, expiresAt: createdAt + expiryMs });
    const base = { approvalId: row.id, kind: row.kind, refId: row.refId, argsHash: hashArgs(row.args) };
    try {
      const messageId = await transport.send({
        id: row.id,
        text: row.text,
        approveData: callbackData(secret, row.id, "approve"),
        rejectData: callbackData(secret, row.id, "reject"),
      });
      store.setMessageId(row.id, messageId);
      emit({ type: "requested", ...base });
      return { ...row, messageId };
    } catch (e) {
      store.finish(row.id, "failed", `card not delivered: ${errorMessage(e)}`);
      emit({ type: "send_failed", ...base, detail: errorMessage(e) });
      throw new GateError("delivery_failed", `card not delivered: ${errorMessage(e)}`);
    }
  }

  async function run(card: Approval, decision: Decision, actor: string): Promise<TapResult> {
    const base = { approvalId: card.id, kind: card.kind, refId: card.refId, actor, argsHash: hashArgs(card.args) };
    try {
      const outcome = await handlers[card.kind]![decision](card);
      const status = decision === "approve" ? "done" : "rejected";
      store.finish(card.id, status, outcome);
      emit({ type: status, ...base, detail: outcome });
      await closeCard(card, `${decision === "approve" ? "Approved" : "Rejected"}: ${outcome}`);
      return { status, message: outcome };
    } catch (e) {
      // Terminal on purpose: a timed-out payment may still have gone through, so a retry
      // from the card could pay twice. A person checks and re-raises if needed.
      const msg = errorMessage(e);
      log.error(`${card.kind} ${card.refId} ${decision} failed: ${msg}`);
      store.finish(card.id, "failed", msg);
      emit({ type: "failed", ...base, detail: msg });
      await closeCard(card, `Failed: ${msg}\nNot retried. Check before raising it again.`);
      return { status: "failed", message: msg };
    }
  }

  async function handleTap(tap: Tap, ack?: (message: string) => Promise<void>): Promise<TapResult> {
    const actor = String(tap.fromId);
    const refuse = (detail: string, approvalId?: string): TapResult => {
      log.warn(`refused tap from user ${actor}: ${detail}`);
      emit({ type: "refused", actor, approvalId, detail });
      return { status: "not_authorised", message: "Not authorised" };
    };
    // Cheap pre-check before any crypto: is this user an approver for anything at all?
    const knownApprover = policy
      ? policy.tools.some((t) => { const d = policy.decide(t); return d.action === "require_approval" && d.approverIds.includes(actor); })
      : defaultApprovers.has(actor);
    if (!knownApprover) return refuse("not an approver");

    const verified = verifyCallback(secret, tap.data);
    if (!verified) {
      emit({ type: "refused", actor, detail: "invalid or forged button" });
      return { status: "invalid", message: "Invalid button" };
    }

    const card = store.get(verified.id);
    if (!card) return { status: "unknown", message: "Unknown card" };
    let allowed: Set<string>;
    try {
      allowed = ruleFor(card.kind).approvers;
    } catch (e) {
      return refuse(`policy no longer allows ${card.kind}: ${errorMessage(e)}`, card.id);
    }
    if (!allowed.has(actor)) return refuse(`not an approver for ${card.kind}`, card.id);
    if (card.status !== "pending") return { status: "already_decided", message: `Already ${card.status}` };
    if (now() > card.expiresAt) {
      if (store.expire(card.id)) {
        emit({ type: "expired", approvalId: card.id, kind: card.kind, refId: card.refId, actor });
        await closeCard(card, "Expired, not sent");
      }
      return { status: "expired", message: "Expired" };
    }
    if (!handlers[card.kind]) return { status: "no_handler", message: `No handler for ${card.kind}` };

    // The atomic claim is what makes execution exactly-once; the checks above are only for messages
    if (!store.claim(card.id, actor, now())) {
      const latest = store.get(card.id);
      return { status: "already_decided", message: `Already ${latest?.status ?? "decided"}` };
    }
    emit({ type: "claimed", approvalId: card.id, kind: card.kind, refId: card.refId, actor, detail: verified.decision, argsHash: hashArgs(card.args) });
    await ack?.(verified.decision === "approve" ? "Working..." : "Rejecting...")
      .catch((e: unknown) => log.error(`ack failed: ${errorMessage(e)}`));
    return run(card, verified.decision, actor);
  }

  return { request, handleTap, list: store.list, get: store.get };
}
