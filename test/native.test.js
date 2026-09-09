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
import { sessionNotification } from "../src/notifications.js";
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

test("joining via actual CLI registers the session and server delivers directly without a bridge", async (t) => {
  const f = await fixture(t);
  const result = await exec(
    process.execPath,
    [
      resolve("bin/mailbox.js"),
      "--url",
      f.app.url,
      "topic",
      "join",
      f.topic.id,
      "--as",
      f.p.name,
      "--agent-bin",
      f.entry,
    ],
    { env: { ...process.env, CODEX_THREAD_ID: "own-session" } },
  );
  assert.equal(JSON.parse(result.stdout).notification.status, "ready");
  const state = await f.client.request("/api/state");
  assert.equal(state.bridges.length, 0);
  assert.equal(state.recipients.length, 1);
  const m = await f.post();
  await until(
    async () =>
      !!(await f.client.request(`/api/inbox?as=${f.p.id}`)).notifications[0]
        .notified_at,
  );
  const call = JSON.parse((await readFile(f.calls, "utf8")).trim());
  assert.equal(call[0], "queue");
  assert.equal(call[2], "own-session");
  assert.equal(
    (await f.client.request(`/api/topics/${f.topic.id}/messages`)).messages
      .length,
    1,
  );
  assert.equal(
    (await f.client.request(`/api/inbox?as=${f.p.id}`)).notifications[0].ack_at,
    null,
  );
  // Rejoining the same endpoint must not replay an already submitted message.
  const registration = {
    as: f.p.id,
    notification: { thread: "own-session", agentBin: f.entry },
  };
  await f.client.request(`/api/topics/${f.topic.id}/members`, registration);
  await f.client.request(`/api/topics/${f.topic.id}/ack`, {
    as: f.p.id,
    through: m.id,
  });
  await assert.rejects(
    f.client.request(`/api/topics/${f.topic.id}/members`, {
      as: f.p.id,
      notification: { thread: "someone-else", agentBin: f.entry },
    }),
    /409/,
  );
  await disconnectMailbox(f.client, f.p.id);
  assert.equal((await readFile(f.calls, "utf8")).trim().split("\n").length, 1);
  assert.equal((await f.client.request("/api/state")).recipients.length, 0);
});

test("direct delivery respects pause, reports failures, and only explicit rejoin retries", async (t) => {
  const f = await fixture(t);
  const registration = {
    as: f.p.id,
    notification: { thread: "own", agentBin: f.entry },
  };
  await f.client.request(
    `/api/topics/${f.topic.id}`,
    { status: "paused" },
    "PATCH",
  );
  await f.post();
  await f.client.request(`/api/topics/${f.topic.id}/members`, registration);
  assert.equal(
    (await f.client.request(`/api/inbox?as=${f.p.id}`)).notifications[0]
      .notified_at,
    null,
  );
  await writeFile(f.entry, "console.error('offline');process.exit(1)");
  await f.client.request(
    `/api/topics/${f.topic.id}`,
    { status: "open" },
    "PATCH",
  );
  await until(
    async () =>
      (await f.client.request("/api/state")).recipients[0].status === "error",
  );
  assert.match(
    (await f.client.request(`/api/inbox?as=${f.p.id}`)).notifications[0].error,
    /offline/,
  );
  await writeFile(f.entry, "console.log('queued')");
  await f.client.request(`/api/topics/${f.topic.id}/members`, registration);
  await until(
    async () =>
      !!(await f.client.request(`/api/inbox?as=${f.p.id}`)).notifications[0]
        .notified_at,
  );
  assert.equal(
    (await f.client.request("/api/state")).recipients[0].status,
    "ready",
  );
});

test("Claude joins with its own credentials; direct server IPC does not disclose them", async (t) => {
  const f = await fixture(t, "claude");
  const address =
    process.platform === "win32"
      ? `\\\\.\\pipe\\mailbox-join-${randomUUID()}`
      : join(f.dir, "join.sock");
  let frames;
  const server = net.createServer((c) => {
    let data = "";
    c.on("data", (d) => (data += d));
    c.on("end", () => {
      frames = data.trim().split("\n").map(JSON.parse);
      c.end();
    });
  });
  server.listen(address);
  await once(server, "listening");
  t.after(() => new Promise((r) => server.close(r)));
  const notification = sessionNotification(
    f.p,
    {},
    {
      CLAUDE_CODE_MESSAGING_SOCKET: address,
      CLAUDE_CODE_MESSAGING_TOKEN: "private-test-token",
    },
  );
  const joined = await f.client.request(`/api/topics/${f.topic.id}/members`, {
    as: f.p.id,
    notification,
  });
  assert.ok(!JSON.stringify(joined).includes("private-test-token"));
  await f.post();
  await until(() => frames?.length === 2);
  assert.deepEqual(frames[0], { type: "auth", token: "private-test-token" });
  assert.equal(frames[1].type, "user");
  const state = JSON.stringify(await f.client.request("/api/state"));
  assert.ok(!state.includes(address));
  assert.ok(!state.includes("private-test-token"));
  assert.equal(
    (await f.client.request(`/api/inbox?as=${f.p.id}`)).notifications[0].ack_at,
    null,
  );
  assert.throws(() => sessionNotification({ kind: "codex" }, {}, {}), /会话内/);
  assert.equal(
    sessionNotification({ kind: "codex" }, { manual: true }, {}),
    undefined,
  );
});

test("service restart preserves mail but clears native credentials until rejoin", async (t) => {
  const f = await fixture(t);
  const dbPath = join(f.dir, "restart.db");
  const first = await startServer({ port: 0, dbPath });
  let second;
  const client = new Client(first.url);
  let participant, topic;
  try {
    participant = await client.request("/api/participants", {
      name: "restart",
      kind: "codex",
    });
    topic = await client.request("/api/topics", {
      title: "restart",
      goal: "preserve pending mail",
    });
    await client.request(
      `/api/topics/${topic.id}`,
      { status: "paused" },
      "PATCH",
    );
    await client.request(`/api/topics/${topic.id}/members`, {
      as: participant.id,
      notification: {
        thread: "own",
        agentBin: f.entry,
        token: "ephemeral-only",
      },
    });
    await client.request(`/api/topics/${topic.id}/messages`, {
      as: "human",
      to: participant.id,
      body: "pending",
      requestId: "restart-1",
    });
  } finally {
    await first.close();
  }
  assert.ok(!(await readFile(dbPath)).includes(Buffer.from("ephemeral-only")));
  second = await startServer({ port: 0, dbPath });
  try {
    const next = new Client(second.url);
    assert.deepEqual((await next.request("/api/state")).recipients, []);
    assert.equal(
      (await next.request(`/api/inbox?as=${participant.id}`)).notifications
        .length,
      1,
    );
    await next.request(`/api/topics/${topic.id}/members`, {
      as: participant.id,
      notification: { thread: "own", agentBin: f.entry },
    });
    await next.request(`/api/topics/${topic.id}`, { status: "open" }, "PATCH");
    await until(
      async () =>
        !!(await next.request(`/api/inbox?as=${participant.id}`))
          .notifications[0].notified_at,
    );
  } finally {
    await second.close();
  }
});

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
