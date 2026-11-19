// Demo: the gateway in front of a fictional lender's payments system ("Northgate Lending" is
// made up). The payments API here is a stub that records calls in memory; swap the executors
// for real API clients. Run: ENV_FILE=path/to/.env npm run demo
import { configFromEnv, startGateway, type Executor } from "../src/index.js";

if (process.env.ENV_FILE) process.loadEnvFile(process.env.ENV_FILE);

const issued = new Map<string, string>();

// The idempotency key is passed to the payments API, so a retried task can't refund twice
const issueRefund: Executor = async (args, { idempotencyKey }) => {
  const existing = issued.get(idempotencyKey);
  if (existing) return `already issued as ${existing} (duplicate ignored)`;
  const ref = `RF-${Math.floor(Math.random() * 90_000 + 10_000)}`;
  issued.set(idempotencyKey, ref);
  return `Refund ${ref} issued: £${String(args.amountGbp)} to customer ${String(args.customerId)}`;
};

const sendInvoice: Executor = async (args) =>
  `Invoice sent to ${String(args.customerId)} for £${String(args.amountGbp)}`;

const gateway = await startGateway(configFromEnv(), { issue_refund: issueRefund, send_invoice: sendInvoice });
process.stdout.write(`Approval gateway listening on ${gateway.url}\nConsole: ${gateway.url}/\n`);

const shutdown = (): void => {
  void gateway.close().then(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
