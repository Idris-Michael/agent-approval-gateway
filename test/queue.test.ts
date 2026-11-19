// Queue tests. WHY each one exists:
// - an approved action must not be lost to a restart, and must not run twice in parallel
// - an outage (provider down) waits and retries without burning attempts, but still ends after 24 h
// - a real failure is retried a few times, a fatal one stops at once
// - a task that crashes the process can't crash-loop forever across restarts
// - enqueuing the same job twice (retrying webhook, double click) creates one task
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openQueue, type Queue, type TaskEvent, type WorkerDeps } from "../src/queue.js";

class Outage extends Error {}
class Fatal extends Error {}

let dir: string;
let file: string;
let queue: Queue;
let clock: number;
let notes: Array<[TaskEvent, string]>;

const open = (): Queue => openQueue({ path: file, now: () => clock, retryMs: 1000, maxAttempts: 3, maxWaits: 4 });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "queue-"));
  file = path.join(dir, "queue.db");
  clock = 1_000_000;
  notes = [];
  queue = open();
});

afterEach(() => {
  queue.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const deps = (run: WorkerDeps["run"]): WorkerDeps => ({
  run,
  notify: async (_t, event, text) => { notes.push([event, text]); },
  isOutage: (e) => e instanceof Outage,
  isFatal: (e) => e instanceof Fatal,
});

test("tasks run oldest first and the result is stored", async () => {
  queue.enqueue("send_invoice", { n: 1 });
  queue.enqueue("send_invoice", { n: 2 });
  const seen: unknown[] = [];
  const d = deps(async (t) => { seen.push(t.payload); return "sent"; });
  while (await queue.processNext(d)) { /* drain */ }
  assert.deepEqual(seen, [{ n: 1 }, { n: 2 }]);
  assert.deepEqual(queue.list("done").map((t) => t.result), ["sent", "sent"]);
});

test("two workers on the same database never claim the same task", () => {
  const id = queue.enqueue("send_invoice", {});
  const other = open();
  try {
    const a = queue.claimNext();
    const b = other.claimNext();
    assert.equal(a?.id, id);
    assert.equal(b, null);
  } finally {
    other.close();
  }
});

test("same idempotency key twice creates one task", () => {
  const first = queue.enqueue("send_invoice", { n: 1 }, "invoice-42");
  const second = queue.enqueue("send_invoice", { n: 1 }, "invoice-42");
  assert.equal(first, second);
  assert.equal(queue.list().length, 1);
});

test("an outage waits without using an attempt, and tells a person only once", async () => {
  const id = queue.enqueue("send_invoice", {});
  const d = deps(async () => { throw new Outage("provider 503"); });
  await queue.processNext(d);
  clock += 1000;
  await queue.processNext(d);
  const t = queue.get(id)!;
  assert.equal(t.status, "queued");
  assert.equal(t.attempts, 0);
  assert.equal(t.waits, 2);
  assert.deepEqual(notes, [["waiting", "provider 503"]]);
});

test("a task that is not due yet is not claimed", async () => {
  queue.enqueue("send_invoice", {});
  await queue.processNext(deps(async () => { throw new Outage("down"); }));
  assert.equal(queue.claimNext(), null);
  clock += 1000;
  assert.notEqual(queue.claimNext(), null);
});

test("an outage that never ends still ends the task after the wait limit", async () => {
  const id = queue.enqueue("send_invoice", {});
  const d = deps(async () => { throw new Outage("down"); });
  for (let i = 0; i < 4; i++) {
    await queue.processNext(d);
    clock += 1000;
  }
  assert.equal(queue.get(id)?.status, "error");
  assert.match(queue.get(id)?.result ?? "", /Gave up after 4 waits/);
  assert.equal(notes.at(-1)?.[0], "failed");
});

test("a real failure is retried up to the attempt limit, then reported", async () => {
  const id = queue.enqueue("send_invoice", {});
  let calls = 0;
  const d = deps(async () => { calls++; throw new Error("bad response"); });
  for (let i = 0; i < 5; i++) {
    await queue.processNext(d);
    clock += 1000;
  }
  assert.equal(calls, 3);
  assert.equal(queue.get(id)?.status, "error");
  assert.deepEqual(notes, [["failed", "bad response"]]);
});

test("a fatal error stops at once instead of retrying", async () => {
  const id = queue.enqueue("send_invoice", {});
  await queue.processNext(deps(async () => { throw new Fatal("customer not found"); }));
  assert.equal(queue.get(id)?.status, "error");
  assert.equal(queue.get(id)?.attempts, 0);
});

test("a task caught mid-run by a crash is re-queued on restart", () => {
  const id = queue.enqueue("send_invoice", {});
  queue.claimNext(); // simulate: claimed, then the process died
  queue.close();
  queue = open();
  assert.equal(queue.recoverInterrupted(), 1);
  assert.equal(queue.get(id)?.status, "queued");
  assert.equal(queue.get(id)?.attempts, 1);
});

test("a task that crashes the process every time stops after the attempt limit", () => {
  const id = queue.enqueue("send_invoice", {});
  for (let i = 0; i < 3; i++) {
    queue.claimNext();
    queue.recoverInterrupted();
  }
  assert.equal(queue.get(id)?.status, "error");
  assert.match(queue.get(id)?.result ?? "", /interrupted by a restart/);
});

test("cancel only stops a task that has not started", () => {
  const a = queue.enqueue("send_invoice", {});
  const b = queue.enqueue("send_invoice", {});
  queue.claimNext(); // a is now in progress
  assert.equal(queue.cancel(a), false);
  assert.equal(queue.cancel(b), true);
  assert.equal(queue.get(b)?.status, "cancelled");
});

test("a broken notifier never fails the task", async () => {
  const id = queue.enqueue("send_invoice", {});
  const errors: string[] = [];
  await queue.processNext({
    run: async () => "sent",
    notify: async () => { throw new Error("chat down"); },
    onError: (m) => errors.push(m),
  });
  assert.equal(queue.get(id)?.status, "done");
  assert.match(errors[0] ?? "", /chat down/);
});

test("the worker recovers interrupted tasks on start and drains what is due", async () => {
  const id = queue.enqueue("send_invoice", {});
  queue.claimNext(); // interrupted before the restart
  const stop = queue.startWorker({ run: async () => "sent" }, 60_000);
  try {
    for (let i = 0; i < 50 && queue.get(id)?.status !== "done"; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(queue.get(id)?.status, "done");
  } finally {
    stop();
  }
});
