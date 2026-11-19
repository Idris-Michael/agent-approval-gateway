// HTTP API in front of the gate. Agents send every tool call here before running it; the
// policy answers allow / deny / pending approval. Built on node:http with no framework, so
// every control (auth, scopes, limits, headers) is visible in this one file.
import crypto from "node:crypto";
import http from "node:http";
import type { VerifyResult } from "./audit.js";
import { renderCard } from "./card.js";
import { consolePage } from "./console.js";
import { GateError, type Gate } from "./gate.js";
import type { Policy } from "./policy.js";
import type { Approval, ApprovalStatus } from "./store.js";

export type Scope = "agent" | "viewer";

export interface ApiKey {
  name: string;
  key: string;
  scope: Scope;
}

export interface ServerOptions {
  gate: Gate;
  policy: Policy;
  apiKeys: ApiKey[];
  verifyAudit?: () => VerifyResult;
  rateLimitPerMinute?: number;
  now?: () => number;
  /** One structured line per request. Keys are logged by name, never by value. */
  log?: (line: Record<string, unknown>) => void;
}

const MIN_KEY_CHARS = 24;
const MAX_BODY_BYTES = 32 * 1024;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9:_.-]{1,128}$/;
const STATUSES: ReadonlySet<string> = new Set(["pending", "executing", "done", "rejected", "failed", "expired"]);

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const digest = (s: string): Buffer => crypto.createHash("sha256").update(s).digest();

/** Public shape of an approval. The signed button data never leaves the gateway. */
export const approvalView = (a: Approval) => ({
  id: a.id,
  tool: a.kind,
  refId: a.refId,
  args: a.args,
  card: a.text,
  status: a.status,
  outcome: a.outcome,
  decidedBy: a.decidedBy,
  createdAt: new Date(a.createdAt).toISOString(),
  expiresAt: new Date(a.expiresAt).toISOString(),
});

interface ToolCallBody {
  tool: string;
  args: Record<string, unknown>;
  reason?: string;
  refId?: string;
}

function parseToolCall(raw: unknown): ToolCallBody {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new HttpError(400, "body must be a JSON object");
  const b = raw as Record<string, unknown>;
  if (typeof b.tool !== "string" || b.tool.length === 0) throw new HttpError(400, "tool is required");
  const args = b.args ?? {};
  if (typeof args !== "object" || args === null || Array.isArray(args)) throw new HttpError(400, "args must be an object");
  if (b.reason !== undefined && typeof b.reason !== "string") throw new HttpError(400, "reason must be a string");
  if (b.refId !== undefined && (typeof b.refId !== "string" || b.refId.length > 100)) throw new HttpError(400, "refId must be a string of at most 100 chars");
  return { tool: b.tool, args: args as Record<string, unknown>, reason: b.reason as string | undefined, refId: b.refId as string | undefined };
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const type = req.headers["content-type"] ?? "";
  if (!type.startsWith("application/json")) throw new HttpError(415, "content-type must be application/json");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, `body larger than ${MAX_BODY_BYTES} bytes`);
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf-8")) as unknown;
  } catch {
    throw new HttpError(400, "body is not valid JSON");
  }
}

const GATE_ERROR_STATUS: Record<GateError["code"], number> = { invalid_request: 422, conflict: 409, delivery_failed: 502 };

export function createGatewayServer(opts: ServerOptions): http.Server {
  if (opts.apiKeys.length === 0) throw new Error("at least one API key is required");
  for (const k of opts.apiKeys) {
    if (k.key.length < MIN_KEY_CHARS) throw new Error(`API key "${k.name}" must be at least ${MIN_KEY_CHARS} characters`);
  }
  const keys = opts.apiKeys.map((k) => ({ ...k, hash: digest(k.key) }));
  const now = opts.now ?? Date.now;
  const limit = opts.rateLimitPerMinute ?? 60;
  const windows = new Map<string, { start: number; count: number }>();
  const log = opts.log ?? ((line) => process.stdout.write(`${JSON.stringify(line)}\n`));

  // Compare hashes, so the comparison is constant-time and lengths always match
  const authenticate = (req: http.IncomingMessage): (typeof keys)[number] | null => {
    const header = req.headers.authorization ?? "";
    if (!header.startsWith("Bearer ")) return null;
    const given = digest(header.slice(7));
    return keys.find((k) => crypto.timingSafeEqual(k.hash, given)) ?? null;
  };

  const authorise = (req: http.IncomingMessage, scopes: Scope[]): (typeof keys)[number] => {
    const key = authenticate(req);
    if (!key) throw new HttpError(401, "missing or unknown API key");
    if (!scopes.includes(key.scope)) throw new HttpError(403, `this key's scope (${key.scope}) cannot do that`);
    const t = now();
    const w = windows.get(key.name);
    if (!w || t - w.start >= 60_000) windows.set(key.name, { start: t, count: 1 });
    else if (++w.count > limit) throw new HttpError(429, "rate limit exceeded");
    return key;
  };

  async function route(req: http.IncomingMessage, url: URL, res: http.ServerResponse, ctx: { key?: string }): Promise<[number, unknown]> {
    const { pathname } = url;
    if (req.method === "GET" && pathname === "/healthz") return [200, { ok: true }];

    if (req.method === "GET" && pathname === "/") {
      const nonce = crypto.randomBytes(16).toString("base64");
      res.setHeader("content-security-policy", `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
      res.setHeader("content-type", "text/html; charset=utf-8");
      return [200, consolePage(nonce)];
    }

    if (req.method === "POST" && pathname === "/v1/tool-calls") {
      ctx.key = authorise(req, ["agent"]).name;
      const idem = req.headers["idempotency-key"];
      if (idem !== undefined && (typeof idem !== "string" || !IDEMPOTENCY_KEY.test(idem))) {
        throw new HttpError(400, "Idempotency-Key must be 1-128 chars of A-Z a-z 0-9 : _ . -");
      }
      const body = parseToolCall(await readJson(req));
      const decision = opts.policy.decide(body.tool);
      if (decision.action === "deny") return [403, { decision: "deny", reason: decision.reason }];
      if (decision.action === "allow") return [200, { decision: "allow" }];
      let text: string;
      try {
        text = renderCard(body.tool, body.args, body.reason);
      } catch (e) {
        throw new HttpError(422, (e as Error).message);
      }
      const approval = await opts.gate.request({
        kind: body.tool,
        refId: body.refId ?? idem ?? crypto.randomUUID(),
        text,
        args: body.args,
        idempotencyKey: idem,
      });
      return [202, { decision: "pending_approval", approval: approvalView(approval) }];
    }

    const one = /^\/v1\/approvals\/([0-9a-f]{16})$/.exec(pathname);
    if (req.method === "GET" && one) {
      ctx.key = authorise(req, ["agent", "viewer"]).name;
      const a = opts.gate.get(one[1]!);
      if (!a) throw new HttpError(404, "approval not found");
      return [200, approvalView(a)];
    }

    if (req.method === "GET" && pathname === "/v1/approvals") {
      ctx.key = authorise(req, ["viewer"]).name;
      const status = url.searchParams.get("status");
      if (status !== null && !STATUSES.has(status)) throw new HttpError(400, "unknown status filter");
      const rows = opts.gate.list((status ?? undefined) as ApprovalStatus | undefined).slice(0, 200);
      return [200, { approvals: rows.map(approvalView) }];
    }

    if (req.method === "GET" && pathname === "/v1/audit") {
      ctx.key = authorise(req, ["viewer"]).name;
      if (!opts.verifyAudit) throw new HttpError(404, "audit log not configured");
      return [200, opts.verifyAudit()];
    }

    throw new HttpError(404, "not found");
  }

  return http.createServer((req, res) => {
    const started = now();
    const requestId = crypto.randomUUID();
    const url = new URL(req.url ?? "/", "http://localhost");
    const ctx: { key?: string } = {};
    res.setHeader("x-request-id", requestId);
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("cache-control", "no-store");
    res.setHeader("referrer-policy", "no-referrer");

    const send = (status: number, body: unknown, error?: string): void => {
      if (typeof body === "string") {
        res.writeHead(status).end(body);
      } else {
        res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
      }
      log({ ts: new Date(started).toISOString(), requestId, method: req.method, path: url.pathname, status, ms: now() - started, key: ctx.key, error });
    };

    route(req, url, res, ctx)
      .then(([status, body]) => send(status, body))
      .catch((e: unknown) => {
        if (e instanceof HttpError) {
          if (e.status === 429) res.setHeader("retry-after", "60");
          send(e.status, { error: e.message }, e.message);
        } else if (e instanceof GateError) {
          send(GATE_ERROR_STATUS[e.code], { error: e.message, code: e.code }, e.message);
        } else {
          // Internal detail goes to the log, not to the caller
          send(500, { error: "internal error", requestId }, e instanceof Error ? e.message : String(e));
        }
      });
  });
}
