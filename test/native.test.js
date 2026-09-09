import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { randomUUID } from "node:crypto";
import net from "node:net";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { startServer } from "../src/server.js";
import { Client } from "../src/client.js";
import {
  listenNative,
  writeClaude,
  validateClaudeAddress,
} from "../src/native.js";
import { disconnectMailbox } from "../src/connect.js";
const exec = promisify(execFile);
async function until(predicate) {
  const deadline = Date.now() + 7000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("Timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}
async function fixture(t, kind = "codex") {
  const dir = await mkdtemp(join(tmpdir(), "mailbox-native-"));
  t.after(async () => {
    assert.equal(dirname(dir), resolve(tmpdir()));
    assert.ok(basename(dir).startsWith("mailbox-native-"));
    await rm(dir, { recursive: true });
  });
  const app = await startServer({ port: 0, dbPath: ":memory:" });
  t.after(() => app.close());
  const client = new Client(app.url);
  const p = await client.request("/api/participants", {
    name: "native-" + kind,
    kind,
  });
  const topic = await client.request("/api/topics", {
    title: "原生通知",
    goal: "原会话自己读信和回信",
  });
  await client.request(`/api/topics/${topic.id}/members`, { as: p.id });
  const post = () =>
    client.request(`/api/topics/${topic.id}/messages`, {
      as: "human",
      to: p.id,
      body: "需要讨论",
      requestId: randomUUID(),
    });
  const entry = join(dir, "fake-codex.mjs"),
    calls = join(dir, "calls.jsonl");
  await writeFile(
    entry,
    `import{appendFileSync}from'node:fs';const a=process.argv.slice(2);if(a[0]!=='queue')process.exit(99);appendFileSync(${JSON.stringify(calls)},JSON.stringify(a)+'\\n');console.log('queued');`,
  );
  return {
    dir,
    app,
    client,
    p,
    topic,
    post,
    entry,
    calls,
    program: { command: process.execPath, args: [entry] },
  };
}

test("Codex native notification only invokes queue, preserves messages and never auto-acks or posts a reply", async (t) => {
  const f = await fixture(t);
  const stop = new AbortController();
  const run = listenNative(f.client, f.p, {
    program: f.program,
    thread: "existing-session",
    signal: stop.signal,
  }).catch((e) => {
    if (!stop.signal.aborted) throw e;
  });
  t.after(async () => {
    stop.abort();
    await run;
  });
  await until(
    async () => (await f.client.request("/api/state")).bridges.length === 1,
  );
  const m = await f.post();
  await until(
    async () =>
      !!(await f.client.request(`/api/inbox?as=${f.p.id}`)).notifications[0]
        ?.notified_at,
  );
  const call = JSON.parse((await readFile(f.calls, "utf8")).trim());
  assert.equal(call[0], "queue");
  assert.equal(call[2], "existing-session");
  assert.ok(call[4].includes(f.topic.id));
  assert.ok(!call.includes("app-server"));
  assert.ok(!call[4].includes("需要讨论"), "only a notice, not the peer body");
  const inbox = await f.client.request(`/api/inbox?as=${f.p.id}`);
  assert.equal(inbox.notifications[0].ack_at, null);
  const page = await f.client.request(`/api/topics/${f.topic.id}/messages`);
  assert.equal(page.messages.length, 1);
  assert.equal(page.messages[0].id, m.id);
  await disconnectMailbox(f.client, f.p.name);
  await run;
});

test("Codex queue error leaves a durable pending notification and a visible failure", async (t) => {
  const f = await fixture(t);
  await writeFile(
    f.entry,
    "console.error('target unreachable');process.exit(7)",
  );
  await f.post();
  await assert.rejects(
    listenNative(f.client, f.p, { program: f.program, thread: "target" }),
    /target unreachable/,
  );
  const m = (await f.client.request(`/api/inbox?as=${f.p.id}`))
    .notifications[0];
  assert.equal(m.notified_at, null);
  assert.equal(m.ack_at, null);
  assert.match(m.error, /target unreachable/);
});

test("native listener respects pause and replays unconfirmed messages after reconnect", async (t) => {
  const f = await fixture(t);
  await f.client.request(
    `/api/topics/${f.topic.id}`,
    { status: "paused" },
    "PATCH",
  );
  await f.post();
  const stop = new AbortController();
  let ready = false;
  const run = listenNative(f.client, f.p, {
    program: f.program,
    thread: "target",
    signal: stop.signal,
    onReady() {
      ready = true;
    },
  }).catch((e) => {
    if (!stop.signal.aborted) throw e;
  });
  t.after(async () => {
    stop.abort();
    await run;
  });
  await until(() => ready);
  assert.equal(
    (await f.client.request(`/api/inbox?as=${f.p.id}`)).notifications[0]
      .notified_at,
    null,
  );
  await f.client.request(
    `/api/topics/${f.topic.id}`,
    { status: "open" },
    "PATCH",
  );
  await until(
    async () =>
      !!(await f.client.request(`/api/inbox?as=${f.p.id}`)).notifications[0]
        .notified_at,
  );
  await disconnectMailbox(f.client, f.p.id);
  await run;
  const stop2 = new AbortController();
  const again = listenNative(f.client, f.p, {
    program: f.program,
    thread: "target",
    signal: stop2.signal,
  }).catch((e) => {
    if (!stop2.signal.aborted) throw e;
  });
  t.after(async () => {
    stop2.abort();
    await again;
  });
  await until(
    async () =>
      (await readFile(f.calls, "utf8")).trim().split("\n").length === 2,
  );
});

test("Claude native inbox uses real local IPC with auth and a user-message envelope", async (t) => {
  const f = await fixture(t, "claude");
  const address =
    process.platform === "win32"
      ? `\\\\.\\pipe\\mailbox-native-${randomUUID()}`
      : join(f.dir, "inbox.sock");
  const frames = [];
  const server = net.createServer((c) => {
    let data = "";
    c.on("data", (d) => (data += d));
    c.on("end", () => {
      frames.push(...data.trim().split("\n").map(JSON.parse));
      c.end();
    });
  });
  server.listen(address);
  await once(server, "listening");
  t.after(() => new Promise((r) => server.close(r)));
  await writeClaude({
    socket: address,
    token: "test-only-secret",
    text: "原生消息",
  });
  await until(() => frames.length === 2);
  assert.deepEqual(frames[0], { type: "auth", token: "test-only-secret" });
  assert.deepEqual(frames[1], {
    type: "user",
    message: { role: "user", content: "原生消息" },
  });
  assert.throws(
    () => validateClaudeAddress("\\\\.\\pipe\\test", null, "win32"),
    /TOKEN/,
  );
  assert.throws(
    () => validateClaudeAddress("https://example.com", "x", "win32"),
    /命名管道/,
  );
  await assert.rejects(
    writeClaude({
      socket: address + "-missing",
      token: "not-logged",
      text: "test",
    }),
    (e) => !e.message.includes("not-logged"),
  );
});

test("background connect returns only after subscription, disconnect exits helper without starting an agent", async (t) => {
  const f = await fixture(t);
  const cli = resolve("bin/mailbox.js");
  const { stdout } = await exec(
    process.execPath,
    [
      cli,
      "--url",
      f.app.url,
      "connect",
      "codex",
      "--as",
      f.p.name,
      "--thread",
      "target",
      "--agent-bin",
      f.entry,
      "--background",
    ],
    { timeout: 10000 },
  );
  const connected = JSON.parse(stdout);
  assert.equal(connected.status, "listening");
  assert.equal(connected.mode, "codex-native");
  t.after(async () => {
    await disconnectMailbox(f.client, f.p.id).catch(() => {});
  });
  assert.equal(
    (await f.client.request("/api/state")).bridges[0].kind,
    "codex-native",
  );
  await f.post();
  await until(
    async () =>
      !!(await f.client.request(`/api/inbox?as=${f.p.id}`)).notifications[0]
        .notified_at,
  );
  await disconnectMailbox(f.client, f.p.name);
  await until(() => {
    try {
      process.kill(connected.pid, 0);
      return false;
    } catch {
      return true;
    }
  });
});
