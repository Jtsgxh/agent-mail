import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { Store } from "../src/store.js";
import { startServer } from "../src/server.js";
import { Client } from "../src/client.js";

const exec = promisify(execFile);
const until = async (predicate) => {
  const end = Date.now() + 4000;
  while (!(await predicate())) {
    if (Date.now() > end) throw new Error("Condition timeout");
    await new Promise((r) => setTimeout(r, 15));
  }
};

export async function fixture(t) {
  const app = await startServer({ port: 0, dbPath: ":memory:" });
  t.after(() => app.close());
  const client = new Client(app.url);
  const a = await client.request("/api/participants", {
    name: "codex-review",
    kind: "codex",
  });
  const b = await client.request("/api/participants", {
    name: "claude-design",
    kind: "claude",
  });
  const topic = await client.request("/api/topics", {
    title: "如何唤醒对方？",
    goal: "测试两个独立会话的消息生命周期",
  });
  for (const p of [a, b])
    await client.request(`/api/topics/${topic.id}/members`, { as: p.id });
  const post = (body = "你好", to = b.id, extra = {}) =>
    client.request(`/api/topics/${topic.id}/messages`, {
      as: a.id,
      body,
      to,
      requestId: randomUUID(),
      ...extra,
    });
  return { app, client, a, b, topic, post };
}

test("SQLite restart preserves messages, memberships and independent read progress", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mailbox-test-"));
  const path = join(dir, "test.db");
  let s = new Store(path);
  try {
    const a = s.createParticipant({ name: "A" }),
      b = s.createParticipant({ name: "B" });
    const t = s.createTopic({ title: "持久化", goal: "重启不能丢消息" });
    s.join(t.id, a.id);
    s.join(t.id, b.id);
    const m = s.post(t.id, {
      as: a.id,
      to: b.id,
      body: "中文 📨\n```js\nconst n = 1;\n```",
      requestId: "req-1",
    });
    assert.equal(s.read(t.id).messages[0].id, m.id);
    assert.equal(
      s.inbox(b.id).notifications.length,
      1,
      "read must not acknowledge",
    );
    s.close();
    s = new Store(path);
    assert.equal(s.read(t.id).messages[0].body, m.body);
    assert.equal(s.inbox(b.id).notifications.length, 1);
    s.ack(t.id, b.id, m.id);
    assert.equal(s.inbox(b.id).notifications.length, 0);
    assert.equal(s.members(t.id).find((p) => p.id === a.id).read_through, 0);
    assert.equal(s.members(t.id).find((p) => p.id === b.id).read_through, m.id);
  } finally {
    s.close();
    await rm(dir, { recursive: true });
  }
});

test("idempotent sends, reply ownership and closed topics enforce the contract", async (t) => {
  const f = await fixture(t);
  const m = await f.post("first", f.b.id, { requestId: "stable" });
  const same = await f.post("first", f.b.id, { requestId: "stable" });
  assert.equal(same.id, m.id);
  await assert.rejects(
    f.post("different", f.b.id, { requestId: "stable" }),
    /409/,
  );
  assert.equal(
    (await f.client.request(`/api/topics/${f.topic.id}/messages`)).messages
      .length,
    1,
  );
  const other = await f.client.request("/api/topics", {
    title: "other",
    goal: "other",
  });
  await f.client.request(`/api/topics/${other.id}/members`, { as: f.a.id });
  await assert.rejects(
    f.client.request(`/api/topics/${other.id}/messages`, {
      as: f.a.id,
      body: "bad",
      replyTo: m.id,
      requestId: "bad",
    }),
    /其他主题/,
  );
  await assert.rejects(
    f.client.request(`/api/topics/${other.id}/ack`, {
      as: f.a.id,
      through: m.id,
    }),
    /不属于/,
  );
  await f.client.request(
    `/api/topics/${f.topic.id}`,
    { status: "closed" },
    "PATCH",
  );
  await assert.rejects(f.post(), /已关闭/);
  assert.equal(
    (await f.post("first", f.b.id, { requestId: "stable" })).id,
    m.id,
    "retry of committed send remains valid after closure",
  );
});

test("ordinary messages do not wake agents, directed messages do, and sent is not read", async (t) => {
  const f = await fixture(t);
  const stop = new AbortController();
  const events = [];
  const run = (async () => {
    for await (const event of f.client.events(
      `/api/bridge/events?as=${f.b.id}`,
      stop.signal,
    ))
      events.push(event);
  })().catch((e) => {
    if (!stop.signal.aborted) throw e;
  });
  t.after(async () => {
    stop.abort();
    await run;
  });
  await until(() => events.some((e) => e.event === "ready"));
  await f.post("ordinary", null);
  const m = await f.post("directed");
  await until(() => events.some((e) => e.event === "message"));
  assert.deepEqual(
    events.filter((e) => e.event === "message").map((e) => e.data.id),
    [m.id],
  );
  await f.client.request(`/api/deliveries/${m.id}`, { as: f.b.id });
  const inbox = await f.client.request(`/api/inbox?as=${f.b.id}`);
  assert.equal(inbox.notifications.length, 1);
  assert.ok(inbox.notifications[0].notified_at);
  assert.equal(inbox.notifications[0].ack_at, null);
  await f.client.request(`/api/topics/${f.topic.id}/ack`, {
    as: f.b.id,
    through: m.id,
  });
  assert.equal(
    (await f.client.request(`/api/inbox?as=${f.b.id}`)).notifications.length,
    0,
  );
});

test("bridge replay survives disconnect; duplicate live receiver rejected; pause queues messages", async (t) => {
  const f = await fixture(t);
  const m = await f.post("offline");
  const controller = new AbortController();
  const events = [];
  const run = (async () => {
    for await (const e of f.client.events(
      `/api/bridge/events?as=${f.b.id}`,
      controller.signal,
    ))
      events.push(e);
  })().catch((e) => {
    if (!controller.signal.aborted) throw e;
  });
  await until(() => events.some((e) => e.event === "message"));
  const duplicate = await fetch(`${f.app.url}/api/bridge/events?as=${f.b.id}`);
  assert.equal(duplicate.status, 409);
  controller.abort();
  await run;
  await until(
    async () => (await f.client.request("/api/state")).bridges.length === 0,
  );
  await f.client.request(
    `/api/topics/${f.topic.id}`,
    { status: "paused" },
    "PATCH",
  );
  const second = await f.post("during pause");
  const stop = new AbortController();
  const replay = [];
  const run2 = (async () => {
    for await (const e of f.client.events(
      `/api/bridge/events?as=${f.b.id}`,
      stop.signal,
    ))
      replay.push(e);
  })().catch((e) => {
    if (!stop.signal.aborted) throw e;
  });
  t.after(async () => {
    stop.abort();
    await run2;
  });
  await until(() => replay.some((e) => e.event === "ready"));
  assert.equal(replay.filter((e) => e.event === "message").length, 0);
  await f.client.request(
    `/api/topics/${f.topic.id}`,
    { status: "open" },
    "PATCH",
  );
  await until(() => replay.filter((e) => e.event === "message").length === 2);
  assert.deepEqual(
    replay.filter((e) => e.event === "message").map((e) => e.data.id),
    [m.id, second.id],
  );
});

test("pagination and monotonic acknowledgement do not skip messages or regress progress", async (t) => {
  const f = await fixture(t);
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push((await f.post(`message ${i}`)).id);
  const one = await f.client.request(
    `/api/topics/${f.topic.id}/messages?limit=2`,
  );
  assert.equal(one.hasMore, true);
  assert.deepEqual(
    one.messages.map((m) => m.id),
    ids.slice(0, 2),
  );
  const two = await f.client.request(
    `/api/topics/${f.topic.id}/messages?limit=2&after=${one.next}`,
  );
  assert.deepEqual(
    two.messages.map((m) => m.id),
    ids.slice(2, 4),
  );
  await f.client.request(`/api/topics/${f.topic.id}/ack`, {
    as: f.b.id,
    through: ids[3],
  });
  await f.client.request(`/api/topics/${f.topic.id}/ack`, {
    as: f.b.id,
    through: ids[0],
  });
  assert.deepEqual(
    (await f.client.request(`/api/inbox?as=${f.b.id}`)).notifications.map(
      (m) => m.id,
    ),
    ids.slice(4),
  );
  assert.equal(
    (await f.client.request(`/api/topics/${f.topic.id}`)).members.find(
      (m) => m.id === f.b.id,
    ).read_through,
    ids[3],
  );
});

test("local API rejects cross-origin mutation, malformed JSON and invalid ranges", async (t) => {
  const f = await fixture(t);
  const forbidden = await fetch(f.app.url + "/api/topics", {
    method: "POST",
    headers: {
      Origin: "https://evil.example",
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  assert.equal(forbidden.status, 403);
  const malformed = await fetch(f.app.url + "/api/topics", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{",
  });
  assert.equal(malformed.status, 400);
  await assert.rejects(
    f.client.request(`/api/topics/${f.topic.id}/messages?after=NaN`),
    /400/,
  );
  await assert.rejects(
    f.client.request(`/api/topics/${f.topic.id}/messages?limit=0`),
    /400/,
  );
  assert.equal(
    (await fetch(f.app.url + "/style.css")).headers.get("content-type"),
    "text/css; charset=utf-8",
  );
  assert.equal((await fetch(f.app.url + "/vendor/marked.js")).status, 200);
});

test("actual CLI sends UTF-8 stdin, returns JSON, waits on events, times out and reports errors", async (t) => {
  const f = await fixture(t);
  const cli = resolve("bin/mailbox.js");
  const invoke = (args) =>
    exec(process.execPath, [cli, "--url", f.app.url, ...args]);
  const response = await invoke([
    "post",
    f.topic.id,
    "--as",
    f.a.id,
    "--to",
    f.b.id,
    "--body",
    "中文 CLI \n文本",
    "--request-id",
    "cli-stable",
  ]);
  const m = JSON.parse(response.stdout);
  assert.equal(m.body, "中文 CLI \n文本");
  const stdinResult = await new Promise((ok, fail) => {
    const child = execFile(
      process.execPath,
      [cli, "--url", f.app.url, "post", f.topic.id, "--as", f.a.id, "--stdin"],
      (error, stdout) => (error ? fail(error) : ok(JSON.parse(stdout))),
    );
    child.stdin.end("UTF-8 标准输入 📨");
  });
  assert.equal(stdinResult.body, "UTF-8 标准输入 📨");
  const wait = invoke([
    "wait",
    f.topic.id,
    "--as",
    f.b.id,
    "--after",
    String(stdinResult.id),
    "--timeout",
    "3",
  ]);
  const next = await f.post("wake");
  const result = JSON.parse((await wait).stdout);
  assert.equal(result.messages[0].id, next.id);
  assert.equal(result.timedOut, false);
  const empty = JSON.parse(
    (
      await invoke([
        "wait",
        f.topic.id,
        "--as",
        f.b.id,
        "--after",
        String(next.id),
        "--timeout",
        "1",
      ])
    ).stdout,
  );
  assert.equal(empty.timedOut, true);
  await assert.rejects(
    invoke(["post", f.topic.id, "--as", f.a.id, "--body", "one", "--stdin"]),
    (e) => e.code === 1 && /只能指定/.test(e.stderr),
  );
});
