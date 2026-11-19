// Approval records in SQLite (Node's built-in node:sqlite). Every state change is a single
// conditional UPDATE, so two processes tapping the same card cannot both win the claim.
import { DatabaseSync } from "node:sqlite";

export type ApprovalStatus = "pending" | "executing" | "done" | "rejected" | "failed" | "expired";

export interface Approval {
  id: string;
  kind: string;
  refId: string;
  /** The exact arguments that run if approved. The card is rendered from these. */
  args: Record<string, unknown>;
  idempotencyKey: string | null;
  text: string;
  messageId: string | null;
  status: ApprovalStatus;
  createdAt: number;
  expiresAt: number;
  decidedBy: string | null;
  outcome: string | null;
}

export interface NewApproval {
  id: string;
  kind: string;
  refId: string;
  args?: Record<string, unknown>;
  idempotencyKey?: string;
  text: string;
  createdAt: number;
  expiresAt: number;
}

interface Row {
  id: string;
  kind: string;
  ref_id: string;
  args: string;
  idempotency_key: string | null;
  text: string;
  message_id: string | null;
  status: ApprovalStatus;
  created_at: number;
  expires_at: number;
  decided_by: string | null;
  outcome: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS approvals (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  ref_id      TEXT NOT NULL,
  args        TEXT NOT NULL DEFAULT '{}',
  idempotency_key TEXT UNIQUE,
  text        TEXT NOT NULL,
  message_id  TEXT,
  status      TEXT NOT NULL CHECK (status IN ('pending','executing','done','rejected','failed','expired')),
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  decided_by  TEXT,
  outcome     TEXT
);
CREATE INDEX IF NOT EXISTS approvals_status ON approvals (status, created_at);`;

const toApproval = (r: Row): Approval => ({
  id: r.id,
  kind: r.kind,
  refId: r.ref_id,
  args: JSON.parse(r.args) as Record<string, unknown>,
  idempotencyKey: r.idempotency_key,
  text: r.text,
  messageId: r.message_id,
  status: r.status,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  decidedBy: r.decided_by,
  outcome: r.outcome,
});

export interface ApprovalStore {
  insert(a: NewApproval): Approval;
  get(id: string): Approval | null;
  getByIdempotencyKey(key: string): Approval | null;
  list(status?: ApprovalStatus): Approval[];
  setMessageId(id: string, messageId: string): void;
  /** pending → executing, only if not expired. True means this caller owns the run. */
  claim(id: string, decidedBy: string, now: number): boolean;
  /** pending → expired. True if this call made the change. */
  expire(id: string): boolean;
  /** executing → done | rejected | failed. Also used for pending → failed when a card can't be sent. */
  finish(id: string, status: "done" | "rejected" | "failed", outcome: string): void;
  close(): void;
}

export function openApprovalStore(path: string): ApprovalStore {
  const db = new DatabaseSync(path);
  // WAL lets the HTTP service read while a worker writes; busy_timeout waits instead of failing on a lock
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);

  const insertStmt = db.prepare(
    `INSERT INTO approvals (id, kind, ref_id, args, idempotency_key, text, status, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
  );
  const getStmt = db.prepare("SELECT * FROM approvals WHERE id = ?");
  const byKeyStmt = db.prepare("SELECT * FROM approvals WHERE idempotency_key = ?");
  const listAll = db.prepare("SELECT * FROM approvals ORDER BY created_at DESC");
  const listByStatus = db.prepare("SELECT * FROM approvals WHERE status = ? ORDER BY created_at DESC");
  const setMessageStmt = db.prepare("UPDATE approvals SET message_id = ? WHERE id = ?");
  const claimStmt = db.prepare(
    `UPDATE approvals SET status = 'executing', decided_by = ?
     WHERE id = ? AND status = 'pending' AND expires_at >= ?`,
  );
  const expireStmt = db.prepare("UPDATE approvals SET status = 'expired' WHERE id = ? AND status = 'pending'");
  const finishStmt = db.prepare(
    `UPDATE approvals SET status = ?, outcome = ? WHERE id = ? AND status IN ('executing', 'pending')`,
  );

  const get = (id: string): Approval | null => {
    const row = getStmt.get(id) as Row | undefined;
    return row ? toApproval(row) : null;
  };

  return {
    insert(a) {
      insertStmt.run(a.id, a.kind, a.refId, JSON.stringify(a.args ?? {}), a.idempotencyKey ?? null, a.text, a.createdAt, a.expiresAt);
      const row = get(a.id);
      if (!row) throw new Error(`approval ${a.id} was not stored`);
      return row;
    },
    get,
    getByIdempotencyKey(key) {
      const row = byKeyStmt.get(key) as Row | undefined;
      return row ? toApproval(row) : null;
    },
    list(status) {
      const rows = (status ? listByStatus.all(status) : listAll.all()) as unknown as Row[];
      return rows.map(toApproval);
    },
    setMessageId(id, messageId) {
      setMessageStmt.run(messageId, id);
    },
    claim(id, decidedBy, now) {
      return Number(claimStmt.run(decidedBy, id, now).changes) === 1;
    },
    expire(id) {
      return Number(expireStmt.run(id).changes) === 1;
    },
    finish(id, status, outcome) {
      finishStmt.run(status, outcome, id);
    },
    close() {
      db.close();
    },
  };
}
