// Wires the parts into one running gateway: policy → gate → Telegram → queue → executors,
// with every gate event written to the audit log. Config comes from the environment and is
// checked in full before anything starts, so a missing secret stops start-up, not a payment.
import path from "node:path";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import { openAuditLog, verifyAudit } from "./audit.js";
import { createGate, type ApprovalHandler, type Logger } from "./gate.js";
import { loadPolicy } from "./policy.js";
import { openQueue } from "./queue.js";
import { createGatewayServer } from "./server.js";
import { openApprovalStore } from "./store.js";
import { createTelegramTransport, startTelegramPolling } from "./telegram.js";

/** Runs an approved action against the real system. Receives the approved arguments only. */
export type Executor = (args: Record<string, unknown>, ctx: { idempotencyKey: string }) => Promise<string>;

export interface GatewayConfig {
  telegramToken: string;
  approverChatId: string;
  hmacSecret: string;
  agentApiKey: string;
  viewerApiKey: string;
  policyPath: string;
  dataDir: string;
  port: number;
  host: string;
  /** Optional: a self-hosted Telegram Bot API server, or a fake one in tests. */
  telegramApiBase?: string;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const missing: string[] = [];
  const need = (name: string): string => {
    const v = env[name];
    if (!v) missing.push(name);
    return v ?? "";
  };
  const config: GatewayConfig = {
    telegramToken: need("TELEGRAM_BOT_TOKEN"),
    approverChatId: need("APPROVER_CHAT_ID"),
    hmacSecret: need("APPROVAL_HMAC_SECRET"),
    agentApiKey: need("AGENT_API_KEY"),
    viewerApiKey: need("VIEWER_API_KEY"),
    policyPath: env.POLICY_PATH ?? "examples/policy.json",
    dataDir: env.DATA_DIR ?? "data",
    port: Number(env.PORT ?? 8787),
    host: env.HOST ?? "127.0.0.1",
    telegramApiBase: env.TELEGRAM_API_BASE,
  };
  if (missing.length) throw new Error(`missing environment variables: ${missing.join(", ")}`);
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) throw new Error("PORT must be a port number");
  return config;
}

export interface RunningGateway {
  url: string;
  close: () => Promise<void>;
}

const consoleLogger: Logger = {
  warn: (m) => process.stderr.write(`${JSON.stringify({ level: "warn", msg: m })}\n`),
  error: (m) => process.stderr.write(`${JSON.stringify({ level: "error", msg: m })}\n`),
};

export async function startGateway(config: GatewayConfig, executors: Record<string, Executor>, logger = consoleLogger): Promise<RunningGateway> {
  const policy = loadPolicy(config.policyPath);
  for (const tool of policy.tools) {
    if (policy.decide(tool).action === "require_approval" && !executors[tool]) {
      throw new Error(`policy requires approval for "${tool}" but no executor is registered for it`);
    }
  }
  fs.mkdirSync(config.dataDir, { recursive: true });
  const store = openApprovalStore(path.join(config.dataDir, "approvals.db"));
  const queue = openQueue({ path: path.join(config.dataDir, "queue.db") });
  const auditPath = path.join(config.dataDir, "audit.jsonl");
  const audit = openAuditLog(auditPath);
  const telegram = createTelegramTransport({ token: config.telegramToken, chatId: config.approverChatId, apiBase: config.telegramApiBase });

  // Approve puts the exact approved arguments on the durable queue; the approval id is the
  // idempotency key, so even a duplicated approval can only ever create one task
  const handlers: Record<string, ApprovalHandler> = {};
  for (const tool of Object.keys(executors)) {
    handlers[tool] = {
      approve: async (card) => {
        const taskId = queue.enqueue(card.kind, card.args, `approval:${card.id}`);
        return `queued as task ${taskId}`;
      },
      reject: async () => "declined by approver, nothing was run",
    };
  }

  const gate = createGate({
    store, policy, secret: config.hmacSecret, transport: telegram, handlers, logger,
    onEvent: (e) => audit.append(e),
  });

  const stopPolling = startTelegramPolling({
    token: config.telegramToken,
    apiBase: config.telegramApiBase,
    onTap: (tap, ack) => gate.handleTap(tap, ack),
    onError: (m) => logger.error(m),
  });

  const stopWorker = queue.startWorker({
    run: async (task) => {
      const execute = executors[task.kind];
      if (!execute) throw new Error(`no executor for ${task.kind}`);
      return execute(task.payload as Record<string, unknown>, { idempotencyKey: task.idempotencyKey ?? `task:${task.id}` });
    },
    notify: async (task, event, text) => {
      const label = { done: "Done", waiting: "Waiting (provider unavailable), will retry", failed: "Failed" }[event];
      await telegram.notify(`${label}: ${task.kind} (task ${task.id})\n${text}`);
    },
    onError: (m) => logger.error(m),
  }, 2_000);

  const server = createGatewayServer({
    gate, policy,
    apiKeys: [
      { name: "agent", key: config.agentApiKey, scope: "agent" },
      { name: "viewer", key: config.viewerApiKey, scope: "viewer" },
    ],
    verifyAudit: () => verifyAudit(auditPath),
    executionFor: (id) => {
      const t = queue.getByIdempotencyKey(`approval:${id}`);
      return t ? { status: t.status, result: t.result } : null;
    },
  });
  await new Promise<void>((resolve) => server.listen(config.port, config.host, resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://${config.host}:${port}`,
    close: async () => {
      stopPolling();
      stopWorker();
      await new Promise((r) => server.close(r));
      queue.close();
      store.close();
    },
  };
}
