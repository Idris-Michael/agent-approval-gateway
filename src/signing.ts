// Signed button payloads. Chat platforms limit button data (Telegram: 64 bytes), so the
// HMAC-SHA256 is cut to 16 hex chars (64 bits). Forging one by brute force needs ~2^63 tries
// against a server that rate-limits taps, which is far beyond reach for a 72-hour card.
import crypto from "node:crypto";

export type Decision = "approve" | "reject";

export const MIN_SECRET_CHARS = 32;
const SIG_CHARS = 16;
const CALLBACK_RX = /^ap:([0-9a-f]{16}):([ar]):([0-9a-f]{16})$/;

/** Fails loudly at start-up rather than signing with an empty or guessable key. */
export function requireSecret(secret: string | undefined): string {
  if (!secret) throw new Error("APPROVAL_HMAC_SECRET is not set");
  if (secret.length < MIN_SECRET_CHARS) {
    throw new Error(`APPROVAL_HMAC_SECRET must be at least ${MIN_SECRET_CHARS} characters`);
  }
  return secret;
}

export const newApprovalId = (): string => crypto.randomBytes(8).toString("hex");

// The decision is inside the signed message, so a reject button can't be replayed as approve.
const sign = (secret: string, id: string, decision: Decision): string =>
  crypto.createHmac("sha256", secret).update(`${id}:${decision}`).digest("hex").slice(0, SIG_CHARS);

export const callbackData = (secret: string, id: string, decision: Decision): string =>
  `ap:${id}:${decision === "approve" ? "a" : "r"}:${sign(secret, id, decision)}`;

export interface VerifiedCallback {
  id: string;
  decision: Decision;
}

/** Returns null for anything malformed or wrongly signed. Never throws on input. */
export function verifyCallback(secret: string, data: string | undefined): VerifiedCallback | null {
  const match = CALLBACK_RX.exec(data ?? "");
  if (!match) return null;
  const [, id, code, sig] = match as unknown as [string, string, string, string];
  const decision: Decision = code === "a" ? "approve" : "reject";
  const expected = Buffer.from(sign(secret, id, decision));
  const given = Buffer.from(sig);
  // Constant-time compare so response timing doesn't leak how many characters matched
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  return { id, decision };
}
