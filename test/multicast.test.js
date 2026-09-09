import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Store } from "../src/store.js";
import { startServer } from "../src/server.js";
import { Client } from "../src/client.js";
const exec = promisify(execFile);
async function until(fn) {
  const end = Date.now() + 5000;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error("Timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}
function seed(s) {
  const a = s.createParticipant({ name: "A", kind: "codex" });
  const b = s.createParticipant({ name: "B", kind: "codex" });
  const topic = s.createTopic({ title: "批量", goal: "独立投递" });
  s.join(topic.id, a.id);
  s.join(topic.id, b.id);
  return { a, b, topic };
}

test("batch saves once, normalizes recipients, and isolates every delivery and acknowledgement", () => {
  const s = new Store(":memory:");
  try {
    const { a, b, topic } = seed(s);
    const request = {
      as: "human",
      body: "群发",
      to: [b.id, a.id, a.id],
      requestId: "batch",
    };
    const msg = s.post(topic.id, request);
    assert.equal(msg.recipients.length, 2);
    assert.equal(s.read(topic.id).messages.length, 1);
    assert.equal(s.post(topic.id, { ...request, to: [a.id, b.id] }).id, msg.id);
    s.delivery(msg.id, a.id);
    s.delivery(msg.id, b.id, "unreachable");
    assert.ok(s.inbox(a.id).notifications[0].notified_at);
    assert.equal(s.inbox(a.id).notifications[0].error, null);
    assert.equal(s.inbox(b.id).notifications[0].notified_at, null);
    assert.equal(s.inbox(b.id).notifications[0].error, "unreachable");
    s.ack(topic.id, a.id, msg.id);
    assert.equal(s.inbox(a.id).notifications.length, 0);
    assert.equal(s.inbox(b.id).notifications.length, 1);
    assert.equal(
      s.message(msg.id).recipients.find((r) => r.recipient_id === b.id).ack_at,
      null,
    );
    assert.throws(() => s.delivery(msg.id, "human"), /不是此消息/);
    assert.throws(
      () => s.post(topic.id, { ...request, to: [a.id] }),
      /409|requestId/,
    );
    assert.throws(
      () =>
        s.post(topic.id, {
          ...request,
          requestId: "bad",
          to: [a.id, "missing"],
        }),
      /不存在/,
    );
    assert.throws(
      () =>
        s.post(topic.id, {
          ...request,
          requestId: "self",
          to: [a.id, "human"],
        }),
      /自己/,
    );
    assert.equal(s.read(topic.id).messages.length, 1);
  } finally {
    s.close();
  }
});

test("broadcast freezes the send-time membership; retries never include later joiners", () => {
  const s = new Store(":memory:");
  try {
    const { a, b, topic } = seed(s);
    const request = {
      as: a.id,
      body: "全体",
      broadcast: true,
      requestId: "broadcast",
    };
    const msg = s.post(topic.id, request);
    assert.deepEqual(
      msg.recipients.map((r) => r.recipient_id).sort(),
      ["human", b.id].sort(),
    );
    const late = s.createParticipant({ name: "late" });
    s.join(topic.id, late.id);
    assert.equal(s.post(topic.id, request).id, msg.id);
    assert.equal(s.inbox(late.id).notifications.length, 0);
    assert.equal(s.read(topic.id).messages[0].id, msg.id);
    assert.throws(
      () => s.post(topic.id, { ...request, to: [b.id] }),
      /不能同时/,
    );
    assert.throws(
      () =>
        s.post(topic.id, { ...request, broadcast: false, to: ["human", b.id] }),
      /requestId/,
    );
    const empty = s.createTopic({ title: "独自", goal: "只有发送者" });
    const first = s.post(empty.id, {
      as: "human",
      body: "hello",
      broadcast: true,
      requestId: "empty",
    });
    assert.equal(first.broadcast, true);
    assert.deepEqual(first.recipients, []);
  } finally {
    s.close();
  }
});

test("legacy single-recipient database migrates receipts and supports new batch sends after restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mailbox-multicast-")),
    path = join(dir, "legacy.db");
  let s;
  try {
    const db = new DatabaseSync(path);
    db.exec(`
      CREATE TABLE participants(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,kind TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT 'old');
      CREATE TABLE topics(id TEXT PRIMARY KEY,title TEXT NOT NULL,goal TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'open',created_at TEXT NOT NULL DEFAULT 'old');
      CREATE TABLE members(topic_id TEXT REFERENCES topics(id),participant_id TEXT REFERENCES participants(id),read_through INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(topic_id,participant_id));
      CREATE TABLE messages(id INTEGER PRIMARY KEY AUTOINCREMENT,topic_id TEXT NOT NULL REFERENCES topics(id),author_id TEXT NOT NULL REFERENCES participants(id),body TEXT NOT NULL,reply_to INTEGER REFERENCES messages(id),to_id TEXT REFERENCES participants(id),request_id TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT 'old',UNIQUE(author_id,request_id));
      CREATE TABLE deliveries(message_id INTEGER PRIMARY KEY REFERENCES messages(id),recipient_id TEXT NOT NULL REFERENCES participants(id),notified_at TEXT,ack_at TEXT,error TEXT);
      CREATE INDEX deliveries_recipient ON deliveries(recipient_id,message_id);
      INSERT INTO participants(id,name,kind) VALUES ('human','我','human'),('a','A','codex'),('b','B','claude');
      INSERT INTO topics(id,title,goal) VALUES ('t','old','history');
      INSERT INTO members VALUES ('t','human',0),('t','a',1),('t','b',0);
      INSERT INTO messages(id,topic_id,author_id,body,to_id,request_id) VALUES (1,'t','human','old1','a','old1'),(2,'t','human','old2','b','old2');
      INSERT INTO deliveries VALUES (1,'a','sent','read',NULL),(2,'b',NULL,NULL,'offline');`);
    db.close();
    s = new Store(path);
    assert.equal(s.message(1).to_id, "a");
    assert.equal(s.message(1).ack_at, "read");
    assert.equal(s.inbox("b").notifications[0].error, "offline");
    assert.equal(
      s.post("t", { as: "human", body: "old1", to: "a", requestId: "old1" }).id,
      1,
    );
    const batch = s.post("t", {
      as: "human",
      body: "new",
      to: ["a", "b"],
      requestId: "new",
    });
    s.close();
    s = new Store(path);
    assert.equal(s.message(batch.id).recipients.length, 2);
    assert.deepEqual(s.db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    s?.close();
    assert.equal(dirname(dir), resolve(tmpdir()));
    assert.ok(basename(dir).startsWith("mailbox-multicast-"));
    await rm(dir, { recursive: true });
  }
});

test("actual CLI batch and broadcast feed separate native routes; one failure does not block another", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mailbox-multicast-"));
  const app = await startServer({ port: 0, dbPath: ":memory:" }),
    client = new Client(app.url);
  try {
    const { a, b, topic } = seed(app.store);
    const program = join(dir, "queue.mjs");
    await writeFile(
      program,
      "if(process.argv.includes('offline')){console.error('offline');process.exit(1)}console.log('queued')",
    );
    for (const [p, thread] of [
      [a, "online"],
      [b, "offline"],
    ])
      await client.request(`/api/topics/${topic.id}/members`, {
        as: p.id,
        notification: { thread, agentBin: program },
      });
    const run = async (...args) =>
      JSON.parse(
        (
          await exec(
            process.execPath,
            [resolve("bin/mailbox.js"), "--url", app.url, ...args],
            { timeout: 10000 },
          )
        ).stdout,
      );
    const batch = await run(
      "post",
      topic.id,
      "--as",
      "human",
      "--body",
      "batch",
      "--to",
      a.id,
      "--to",
      b.id,
    );
    await until(async () => {
      const page = await client.request(`/api/topics/${topic.id}/messages`);
      return (
        page.messages[0].recipients.some((r) => r.notified_at) &&
        page.messages[0].recipients.some((r) => r.error)
      );
    });
    await client.request(`/api/topics/${topic.id}/ack`, {
      as: a.id,
      through: batch.id,
    });
    assert.equal(
      (await client.request(`/api/inbox?as=${b.id}`)).notifications[0].id,
      batch.id,
    );
    const all = await run(
      "post",
      topic.id,
      "--as",
      "human",
      "--body",
      "broadcast",
      "--broadcast",
    );
    assert.equal(all.broadcast, true);
    assert.equal(all.recipients.length, 2);
    assert.equal(
      (await client.request(`/api/topics/${topic.id}/messages`)).messages
        .length,
      2,
    );
  } finally {
    await app.close();
    assert.equal(dirname(dir), resolve(tmpdir()));
    assert.ok(basename(dir).startsWith("mailbox-multicast-"));
    await rm(dir, { recursive: true });
  }
});
