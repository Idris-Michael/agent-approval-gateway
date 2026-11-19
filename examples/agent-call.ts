// Plays the agent: asks the gateway whether it may run a tool, then waits for the decision.
// Usage: ENV_FILE=path/to/.env npx tsx examples/agent-call.ts issue_refund '{"amountGbp":40,"customerId":"C-1042"}' "reason"
if (process.env.ENV_FILE) process.loadEnvFile(process.env.ENV_FILE);

const base = process.env.GATEWAY_URL ?? `http://127.0.0.1:${process.env.PORT ?? 8787}`;
const key = process.env.AGENT_API_KEY;
if (!key) throw new Error("AGENT_API_KEY is not set");

const [tool = "issue_refund", argsJson = '{"amountGbp":40,"customerId":"C-1042"}', reason] = process.argv.slice(2);
const headers = { "content-type": "application/json", authorization: `Bearer ${key}` };
const out = (line: string): void => { process.stdout.write(`${line}\n`); };

const res = await fetch(`${base}/v1/tool-calls`, {
  method: "POST",
  headers: { ...headers, "idempotency-key": `demo-${Date.now()}` },
  body: JSON.stringify({ tool, args: JSON.parse(argsJson) as unknown, reason }),
});
const body = (await res.json()) as { decision?: string; reason?: string; error?: string; approval?: { id: string } };
out(`${res.status} ${body.decision ?? body.error}${body.reason ? `: ${body.reason}` : ""}`);
if (res.status !== 202 || !body.approval) process.exit(0);

out(`Waiting for a person to decide on approval ${body.approval.id}...`);
let announced = false;
for (;;) {
  await new Promise((r) => setTimeout(r, 2000));
  const a = (await (await fetch(`${base}/v1/approvals/${body.approval.id}`, { headers })).json()) as {
    status: string; outcome: string | null; decidedBy: string | null; execution: { status: string; result: string | null } | null;
  };
  if (a.status === "pending" || a.status === "executing") continue;
  if (!announced) out(`Decision: ${a.status} by ${a.decidedBy ?? "nobody"} (${a.outcome ?? ""})`);
  announced = true;
  if (a.status !== "done") break;
  if (a.execution && (a.execution.status === "done" || a.execution.status === "error")) {
    out(`Execution: ${a.execution.status}: ${a.execution.result ?? ""}`);
    break;
  }
}
