// Durable job queue in SQLite. Approved actions run here, so they survive restarts and
// provider outages. Delivery is at-least-once: a task interrupted by a crash runs again,
// so handlers must be safe to repeat (use the idempotency key with the downstream API).
import { DatabaseSync } from "node:sqlite";

export type TaskStatus = "queued" | "in_progress" | "done" | "error" | "cancelled";

export interface Task {
  id: number;
  kind: string;
  payload: unknown;
  idempotencyKey: string | null;
  status: TaskStatus;
  result: string | null;
  attempts: number;
  waits: number;
  nextAttemptAt: number;
  createdAt: number;
  updatedAt: number;
}

interface Row {
  id: number;
  kind: string;
  payload: string;
  idempotency_key: string | null;
  status: TaskStatus;
  result: string | null;
  attempts: number;
  waits: number;
  next_attempt_at: number;
  created_at: number;
  updated_at: number;
}

export type TaskEvent = "done" | "waiting" | "failed";

export interface WorkerDeps {
  run: (task: Task) => Promise<string>;
  /** Reports progress to a person. A failure here is logged and never fails the task. */
  notify?: (task: Task, event: TaskEvent, text: string) => Promise<void>;
  /** Provider down or rate-limited: wait and retry without using up an attempt. */
  isOutage?: (error: unknown) => boolean;
  /** Retrying can't help (bad input, permission denied): stop now. */
  isFatal?: (error: unknown) => boolean;
  onError?: (message: string) => void;
}

export interface QueueOptions {
  path: string;
  maxAttempts?: number;
  retryMs?: number;
  /** Outage waits before giving up. 288 × 5 min = 24 hours, so a task that can never run still ends. */
  maxWaits?: number;
  now?: () => number;
}

export interface Queue {
  /** Same idempotency key twice returns the first task's id instead of adding a duplicate. */
  enqueue: (kind: string, payload: unknown, idempotencyKey?: string) => number;
  claimNext: () => Task | null;
  recoverInterrupted: () => number;
  cancel: (id: number) => boolean;
  get: (id: number) => Task | null;
  getByIdempotencyKey: (key: string) => Task | null;
  list: (status?: TaskStatus) => Task[];
  processNext: (deps: WorkerDeps) => Promise<boolean>;
  startWorker: (deps: WorkerDeps, pollMs?: number) => () => void;
  close: () => void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  kind             TEXT NOT NULL,
  payload          TEXT NOT NULL,
  idempotency_key  TEXT UNIQUE,
  status           TEXT NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued','in_progress','done','error','cancelled')),
  result           TEXT,
  attempts         INTEGER NOT NULL DEFAULT 0,
  waits            INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_due ON tasks (status, next_attempt_at, id);`;

const toTask = (r: Row): Task => ({
  id: r.id,
  kind: r.kind,
  payload: JSON.parse(r.payload) as unknown,
  idempotencyKey: r.idempotency_key,
  status: r.status,
  result: r.result,
  attempts: r.attempts,
  waits: r.waits,
  nextAttemptAt: r.next_attempt_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function openQueue(opts: QueueOptions): Queue {
  const maxAttempts = opts.maxAttempts ?? 3;
  const retryMs = opts.retryMs ?? 5 * 60_000;
  const maxWaits = opts.maxWaits ?? 288;
  const now = opts.now ?? Date.now;

  const db = new DatabaseSync(opts.path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);

  const insert = db.prepare(
    `INSERT INTO tasks (kind, payload, idempotency_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (idempotency_key) DO NOTHING`,
  );
  const byKey = db.prepare("SELECT id FROM tasks WHERE idempotency_key = ?");
  const byId = db.prepare("SELECT * FROM tasks WHERE id = ?");
  const rowByKey = db.prepare("SELECT * FROM tasks WHERE idempotency_key = ?");
  // One statement picks and claims, so two workers can never take the same task
  const claim = db.prepare(
    `UPDATE tasks SET status = 'in_progress', updated_at = ?
     WHERE id = (SELECT id FROM tasks WHERE status = 'queued' AND next_attempt_at <= ? ORDER BY id LIMIT 1)
     RETURNING *`,
  );
  const requeueAttempt = db.prepare(
    "UPDATE tasks SET status = 'queued', attempts = attempts + 1, next_attempt_at = ?, updated_at = ? WHERE id = ?",
  );
  const requeueWait = db.prepare(
    "UPDATE tasks SET status = 'queued', waits = waits + 1, next_attempt_at = ?, updated_at = ? WHERE id = ?",
  );
  const finish = db.prepare("UPDATE tasks SET status = ?, result = ?, updated_at = ? WHERE id = ?");
  // Each recovery counts as an attempt, so a task that crashes the process can't loop across restarts
  const recover = db.prepare(
    `UPDATE tasks
     SET attempts = attempts + 1,
         status = CASE WHEN attempts + 1 >= ? THEN 'error' ELSE 'queued' END,
         result = CASE WHEN attempts + 1 >= ? THEN 'Stopped: interrupted by a restart on every attempt.' ELSE result END,
         updated_at = ?
     WHERE status = 'in_progress'`,
  );
  const cancelStmt = db.prepare("UPDATE tasks SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'queued'");
  const listAll = db.prepare("SELECT * FROM tasks ORDER BY id DESC");
  const listByStatus = db.prepare("SELECT * FROM tasks WHERE status = ? ORDER BY id DESC");

  const get = (id: number): Task | null => {
    const row = byId.get(id) as Row | undefined;
    return row ? toTask(row) : null;
  };

  function enqueue(kind: string, payload: unknown, idempotencyKey?: string): number {
    const t = now();
    const res = insert.run(kind, JSON.stringify(payload ?? null), idempotencyKey ?? null, t, t);
    if (Number(res.changes) === 1) return Number(res.lastInsertRowid);
    const existing = byKey.get(idempotencyKey ?? null) as { id: number } | undefined;
    if (!existing) throw new Error(`task with key ${idempotencyKey} was neither inserted nor found`);
    return existing.id;
  }

  function claimNext(): Task | null {
    const t = now();
    const row = claim.get(t, t) as Row | undefined;
    return row ? toTask(row) : null;
  }

  async function processNext(deps: WorkerDeps): Promise<boolean> {
    const task = claimNext();
    if (!task) return false;
    const report = async (event: TaskEvent, text: string): Promise<void> => {
      try {
        await deps.notify?.(task, event, text);
      } catch (e) {
        deps.onError?.(`could not report task ${task.id}: ${errorMessage(e)}`);
      }
    };
    try {
      const result = await deps.run(task);
      finish.run("done", result, now(), task.id);
      await report("done", result);
    } catch (e) {
      const message = errorMessage(e);
      const outage = deps.isOutage?.(e) ?? false;
      if (outage && task.waits + 1 >= maxWaits) {
        const reason = `Gave up after ${maxWaits} waits. Last error: ${message}`;
        finish.run("error", reason, now(), task.id);
        await report("failed", reason);
      } else if (outage) {
        requeueWait.run(now() + retryMs, now(), task.id);
        if (task.waits === 0) await report("waiting", message); // tell a person once, not every 5 minutes
      } else if (task.attempts + 1 >= maxAttempts || deps.isFatal?.(e)) {
        finish.run("error", message, now(), task.id);
        await report("failed", message);
      } else {
        requeueAttempt.run(now() + retryMs, now(), task.id);
      }
    }
    return true;
  }

  /** One task at a time, so a shared rate limit or a local model is never hit in parallel. */
  function startWorker(deps: WorkerDeps, pollMs = 15_000): () => void {
    const recovered = Number(recover.run(maxAttempts, maxAttempts, now()).changes);
    if (recovered) deps.onError?.(`re-queued ${recovered} task(s) interrupted by a restart`);
    let busy = false;
    const tick = async (): Promise<void> => {
      if (busy) return;
      busy = true;
      try {
        while (await processNext(deps)) { /* drain everything due */ }
      } catch (e) {
        deps.onError?.(`worker tick failed: ${errorMessage(e)}`);
      } finally {
        busy = false;
      }
    };
    const timer = setInterval(() => { void tick(); }, pollMs);
    timer.unref();
    void tick();
    return () => clearInterval(timer);
  }

  return {
    enqueue,
    claimNext,
    recoverInterrupted: () => Number(recover.run(maxAttempts, maxAttempts, now()).changes),
    cancel: (id) => Number(cancelStmt.run(now(), id).changes) === 1,
    get,
    getByIdempotencyKey: (key) => {
      const row = rowByKey.get(key) as Row | undefined;
      return row ? toTask(row) : null;
    },
    list: (status) => ((status ? listByStatus.all(status) : listAll.all()) as unknown as Row[]).map(toTask),
    processNext,
    startWorker,
    close: () => db.close(),
  };
}
