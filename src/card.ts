// Builds the approval card from the tool name and its arguments. The agent's own words are
// shown only as a labelled "reason", below the facts, so a misleading summary can't hide
// what will actually run. Output is plain text; transports must not parse it as markup.

const MAX_VALUE_CHARS = 300;
const MAX_REASON_CHARS = 500;

const humanise = (key: string): string =>
  key.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());

function formatValue(v: unknown): string {
  const text = typeof v === "string" ? v : JSON.stringify(v);
  // Long values are refused rather than cut, so nothing is approved unseen
  if (text.length > MAX_VALUE_CHARS) throw new Error(`argument value too long to show on a card (${text.length} chars)`);
  return text;
}

export function renderCard(tool: string, args: Record<string, unknown>, reason?: string): string {
  if (reason !== undefined && reason.length > MAX_REASON_CHARS) {
    throw new Error(`reason too long (${reason.length} chars, max ${MAX_REASON_CHARS})`);
  }
  const lines = [`Approval needed: ${humanise(tool)}`, ""];
  for (const key of Object.keys(args).sort()) lines.push(`${humanise(key)}: ${formatValue(args[key])}`);
  if (Object.keys(args).length === 0) lines.push("(no arguments)");
  if (reason) lines.push("", `Agent's reason: ${reason}`);
  return lines.join("\n");
}
