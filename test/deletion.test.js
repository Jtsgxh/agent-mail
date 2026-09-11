import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Store } from "../src/store.js";
import { startServer } from "../src/server.js";
import { Client } from "../src/client.js";

const exec = promisify(execFile);
async function temp(t) {
  const dir = await mkdtemp(join(tmpdir(), "mailbox-delete-"));
  t.after(async () => {
    assert.equal(dirname(dir), resolve(tmpdir()));
    assert.ok(basename(dir).startsWith("mailbox-delete-"));
    await rm(dir, { recursive: true });
  });
  return dir;
}
async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("Timed out");
    await new Promise((r) => setTimeout(r, 15));
  }
}

test("topic deletion removes all dependent rows and persists without affecting another topic", async (t) => {
  const path = join(await temp(t), "mailbox.db");
  let store = new Store(path);
  try {
    const project = store.createProject({ name: "保留项目" });
    const topic = store.createTopic({ title: "删除", goal: "全部清理", project: project.id });
    const other = store.createTopic({ title: "保留", goal: "继续讨论", project: project.id });
    const agent = store.createParticipant({ name: "共享身份" });
    for (const id of [topic.id, other.id]) store.join(id, agent.id);
    const first = store.post(topic.id, {
      as: "human", to: agent.id, body: "第一条", requestId: "first",
    });
    store.delivery(first.id, agent.id);
    store.ack(topic.id, agent.id, first.id);
    store.post(topic.id, {
      as: agent.id, to: "human", body: "回复", replyTo: first.id, requestId: "reply",
    });
    const retained = store.post(other.id, {
      as: "human", to: agent.id, body: "保留通知", requestId: "retained",
    });
    store.ack(other.id, "human", retained.id);
    const session = store.reserveSession(topic.id, { kind: "codex", as: "human", cwd: dirname(path) });
    store.updateSession(topic.id, "codex", { nativeId: "existing-host-session", launchStatus: "submitted" });
    store.setStatus(topic.id, "closed");
    const before = { members: store.members(other.id), message: store.message(retained.id), participants: store.participants() };
    assert.deepEqual(store.deleteTopic(topic.id), { id: topic.id, title: topic.title, deleted: true });
    store.close();
    store = new Store(path);
    assert.deepEqual(store.participants(), before.participants);
    assert.equal(store.participant(session.participant_id).kind, "codex");
    assert.deepEqual(store.members(other.id), before.members);
    assert.deepEqual(store.message(retained.id), before.message);
    assert.equal(store.projects()[0].topic_count, 1);
    assert.equal(store.inbox(agent.id).notifications[0].id, retained.id);
    assert.equal(store.inbox("human").notifications.length, 0);
    assert.equal(store.byRequest("human", "first"), null);
    for (const table of ["messages", "members", "sessions"])
      assert.equal(store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE topic_id=?`).get(topic.id).n, 0);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM deliveries").get().n, 1);
    assert.deepEqual(store.db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.throws(() => store.deleteTopic(topic.id), (error) => error.status === 404);
    assert.throws(() => store.read(topic.id), (error) => error.status === 404);
    assert.throws(() => store.join(topic.id, agent.id), (error) => error.status === 404);
    assert.throws(() => store.post(topic.id, { as: "human", body: "重试", requestId: "first" }), (error) => error.status === 404);
  } finally {
    store.close();
  }
});

test("failed deletion rolls back messages, receipts and membership together", () => {
  const store = new Store(":memory:");
  try {
    const topic = store.createTopic({ title: "事务", goal: "原子删除" });
    const agent = store.createParticipant({ name: "reader" });
    store.join(topic.id, agent.id);
    const message = store.post(topic.id, { as: "human", to: agent.id, body: "保持", requestId: "rollback" });
    store.db.exec("CREATE TRIGGER reject_delete BEFORE DELETE ON topics BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
    assert.throws(() => store.deleteTopic(topic.id), /injected failure/);
    assert.deepEqual(store.message(message.id), message);
    assert.equal(store.members(topic.id).length, 2);
    assert.deepEqual(store.db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    store.close();
  }
});

test("real CLI deletes a topic, HTTP rejects later writes, and SSE observers see the deletion", async (t) => {
  const app = await startServer({ port: 0, dbPath: ":memory:" });
  t.after(() => app.close());
  const client = new Client(app.url);
  const topic = await client.request("/api/topics", { title: "CLI 删除", goal: "通知页面" });
  const stop = new AbortController();
  const snapshots = [];
  const watching = (async () => {
    for await (const _ of client.events("/api/events", stop.signal))
      snapshots.push(await client.request("/api/state"));
  })().catch((error) => { if (!stop.signal.aborted) throw error; });
  t.after(async () => { stop.abort(); await watching; });
  await until(() => snapshots.some((state) => state.topics.length === 1));
  const { stdout } = await exec(process.execPath, [resolve("bin/mailbox.js"), "--url", app.url, "topic", "delete", topic.id]);
  assert.deepEqual(JSON.parse(stdout), { id: topic.id, title: topic.title, deleted: true });
  await until(() => snapshots.some((state) => state.topics.length === 0));
  for (const suffix of ["", "/messages", "/members", "/sessions/codex"])
    await assert.rejects(client.request(`/api/topics/${topic.id}${suffix}`), (error) => error.status === 404);
  await assert.rejects(client.request(`/api/topics/${topic.id}`, undefined, "DELETE"), /404/);
  await assert.rejects(client.request(`/api/topics/${topic.id}/messages`, { as: "human", body: "不能复活", requestId: "late" }), /404/);
  await assert.rejects(exec(process.execPath, [resolve("bin/mailbox.js"), "--url", app.url, "topic", "delete"]), /缺少主题 ID/);
});

test("deleting during native transport cancels that topic and delivers the next topic on the same route", async (t) => {
  const dir = await temp(t);
  const app = await startServer({ port: 0, dbPath: ":memory:" });
  t.after(() => app.close());
  const client = new Client(app.url);
  const agent = await client.request("/api/participants", { name: "shared-codex", kind: "codex" });
  const topic = await client.request("/api/topics", { title: "删除中", goal: "停止本主题传输" });
  const other = await client.request("/api/topics", { title: "继续", goal: "不影响共享身份" });
  const entry = join(dir, "queue.mjs"), calls = join(dir, "calls.jsonl");
  await writeFile(entry, `import {appendFileSync} from 'node:fs';
const args=process.argv.slice(2);appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');
if(args.includes('--message') && args[args.indexOf('--message')+1].includes(${JSON.stringify(topic.id)})) setInterval(()=>{},1000);
else console.log('queued');`);
  for (const id of [topic.id, other.id])
    await client.request(`/api/topics/${id}/members`, { as: agent.id, notification: { thread: "shared", agentBin: entry } });
  const post = (id, requestId) => client.request(`/api/topics/${id}/messages`, { as: "human", to: agent.id, body: requestId, requestId });
  await post(topic.id, "in-flight");
  await until(async () => {
    try { return (await readFile(calls, "utf8")).trim().length > 0; }
    catch (error) { if (error.code === "ENOENT") return false; throw error; }
  });
  await post(topic.id, "never dispatch");
  const retained = await post(other.id, "still deliver");
  await client.request(`/api/topics/${topic.id}`, undefined, "DELETE");
  await until(async () => (await client.request(`/api/topics/${other.id}/messages`)).messages[0].notified_at);
  assert.equal((await client.request("/api/state")).recipients[0].status, "ready");
  const inbox = await client.request(`/api/inbox?as=${agent.id}`);
  assert.deepEqual(inbox.notifications.map((m) => m.id), [retained.id]);
  const sent = (await readFile(calls, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(sent.length, 2);
  assert.match(sent[1][sent[1].indexOf("--message") + 1], new RegExp(other.id));
});
