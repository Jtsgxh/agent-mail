import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import net from "node:net";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { startServer } from "../src/server.js";
import { Client } from "../src/client.js";
import { Store } from "../src/store.js";
import { createSession, sessionPath } from "../src/sessions.js";
const exec = promisify(execFile);

test("session reservations survive SQLite restart without changing topic history", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mailbox-session-db-"));
  t.after(async () => {
    assert.equal(dirname(dir), resolve(tmpdir()));
    assert.ok(basename(dir).startsWith("mailbox-session-db-"));
    await rm(dir, { recursive: true });
  });
  const path = join(dir, "mailbox.db");
  let store = new Store(path);
  try {
    const topic = store.createTopic({ title: "持久化", goal: "保留消息" });
    const message = store.post(topic.id, {
      as: "human",
      body: "已有记录",
      requestId: "existing",
    });
    const session = store.reserveSession(topic.id, {
      kind: "claude",
      as: "human",
      cwd: dir,
    });
    const nativeId = randomUUID();
    store.updateSession(topic.id, "claude", {
      nativeId,
      launchStatus: "submitted",
    });
    store.close();
    store = new Store(path);
    assert.equal(store.session(topic.id, "claude").native_id, nativeId);
    assert.equal(
      store.session(topic.id, "claude").participant_id,
      session.participant_id,
    );
    assert.equal(store.read(topic.id).messages[0].id, message.id);
    assert.throws(
      () =>
        store.reserveSession(topic.id, {
          kind: "claude",
          as: "human",
          cwd: dir,
        }),
      /已有/,
    );
    const other = store.reserveSession(topic.id, {
      kind: "codex",
      as: "human",
      cwd: dir,
    });
    assert.notEqual(other.participant_id, session.participant_id);
  } finally {
    store.close();
  }
});

async function fixture(t, behavior = "join") {
  const dir = await mkdtemp(join(tmpdir(), "mailbox-session-"));
  t.after(async () => {
    assert.equal(dirname(dir), resolve(tmpdir()));
    assert.ok(basename(dir).startsWith("mailbox-session-"));
    await rm(dir, { recursive: true });
  });
  const app = await startServer({ port: 0, dbPath: ":memory:" });
  t.after(() => app.close());
  const client = new Client(app.url);
  const topic = await client.request("/api/topics", {
    title: "独立会话",
    goal: "讨论目标",
  });
  const socket =
    process.platform === "win32"
      ? `\\\\.\\pipe\\mailbox-session-${randomUUID()}`
      : join(dir, "inbox.sock");
  const received = [];
  const inbox = net.createServer((connection) => {
    let data = "";
    connection.on("data", (chunk) => (data += chunk));
    connection.on("end", () => received.push(data));
  });
  inbox.listen(socket);
  await once(inbox, "listening");
  t.after(() => new Promise((r) => inbox.close(r)));
  const rpcCalls = [];
  const ws = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(ws, "listening");
  const endpoint = `ws://127.0.0.1:${ws.address().port}`;
  const nativeId = randomUUID();
  ws.on("connection", (connection) =>
    connection.on("message", (raw) => {
      const request = JSON.parse(raw);
      rpcCalls.push(request);
      if (request.id === undefined) return;
      assert.ok(["initialize", "thread/start"].includes(request.method));
      connection.send(
        JSON.stringify({
          id: request.id,
          result:
            request.method === "initialize" ? {} : { thread: { id: nativeId } },
        }),
      );
    }),
  );
  t.after(
    () =>
      new Promise((r) => {
        for (const c of ws.clients) c.terminate();
        ws.close(r);
      }),
  );
  const entry = join(dir, "fake-agent.mjs"),
    calls = join(dir, "calls.jsonl");
  await writeFile(
    entry,
    `
import {appendFileSync} from 'node:fs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const args=process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');
if(args[0]==='agents') { console.log(JSON.stringify(${behavior === "offline" ? "[]" : "[{pid:123,kind:'interactive'}]"})); process.exit(0); }
if(${JSON.stringify(behavior)}==='fail') process.exit(9);
const prompt=args[0]==='queue'?args[args.indexOf('--message')+1]:args.at(-1);
if(${JSON.stringify(behavior)}==='join' && prompt.includes('1. 首先')) {
  const line=prompt.split('\\n').find(x=>x.startsWith('1. 首先'));
  const argv=JSON.parse(line.slice(line.indexOf('[')));
  const env={...process.env,CODEX_THREAD_ID:${JSON.stringify(nativeId)},CLAUDE_CODE_MESSAGING_SOCKET:${JSON.stringify(socket)},CLAUDE_CODE_MESSAGING_TOKEN:'test-own-token'};
  const result=await promisify(execFile)(argv[0],argv.slice(1),{env,windowsHide:true});
  if(JSON.parse(result.stdout).notification.status!=='ready') process.exit(8);
}
console.log('submitted');
`,
  );
  return {
    dir,
    app,
    client,
    topic,
    entry,
    calls,
    endpoint,
    nativeId,
    rpcCalls,
    received,
    options: {
      topic: topic.id,
      as: "human",
      cwd: dir,
      agentBin: entry,
      timeout: 2,
    },
  };
}

for (const kind of ["claude", "codex"])
  test(`${kind}: actual create CLI reserves a new identity, registers its own route and accepts a later message`, async (t) => {
    const f = await fixture(t);
    const args = [
      resolve("bin/mailbox.js"),
      "--url",
      f.app.url,
      "session",
      "create",
      kind,
      "--topic",
      f.topic.id,
      "--cwd",
      f.dir,
      "--as",
      "human",
      "--agent-bin",
      f.entry,
      "--timeout",
      "3",
    ];
    if (kind === "codex") args.push("--endpoint", f.endpoint);
    const result = JSON.parse(
      (await exec(process.execPath, args, { timeout: 10000 })).stdout,
    );
    assert.equal(result.launch_status, "submitted");
    assert.equal(result.notification.status, "ready");
    assert.equal(result.kind, kind);
    assert.notEqual(result.participant_id, "human");
    const info = JSON.parse(
      (
        await exec(process.execPath, [
          resolve("bin/mailbox.js"),
          "--url",
          f.app.url,
          "session",
          "info",
          kind,
          "--topic",
          f.topic.id,
        ])
      ).stdout,
    );
    assert.equal(info.native_id, result.native_id);
    assert.ok(!JSON.stringify(info).includes("test-own-token"));
    if (kind === "codex") {
      assert.equal(result.native_id, f.nativeId);
      assert.equal(
        f.rpcCalls.filter((x) => x.method === "thread/start").length,
        1,
      );
      assert.deepEqual(
        f.rpcCalls.find((x) => x.method === "thread/start").params,
        { cwd: result.cwd },
      );
    } else {
      const calls = (await readFile(f.calls, "utf8"))
        .trim()
        .split("\n")
        .map(JSON.parse);
      assert.equal(
        calls[1][calls[1].indexOf("--session-id") + 1],
        result.native_id,
      );
      assert.equal(calls[1][0], "--bg");
    }
    const message = await f.client.request(
      `/api/topics/${f.topic.id}/messages`,
      {
        as: "human",
        to: result.participant_id,
        body: "第二次来信",
        requestId: "second",
      },
    );
    const deadline = Date.now() + 4000;
    for (;;) {
      const inbox = await f.client.request(
        `/api/inbox?as=${result.participant_id}`,
      );
      if (inbox.notifications[0].notified_at) {
        assert.equal(inbox.notifications[0].ack_at, null);
        break;
      }
      assert.ok(Date.now() < deadline);
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(message.id, 1);
    await assert.rejects(exec(process.execPath, args), /已有/);
    assert.equal(
      (await f.client.request(`/api/topics/${f.topic.id}/members`)).length,
      2,
    );
  });

test("concurrent reservations launch only one Codex session", async (t) => {
  const f = await fixture(t);
  const results = await Promise.allSettled(
    [1, 2].map(() =>
      createSession(f.client, "codex", { ...f.options, endpoint: f.endpoint }),
    ),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(f.rpcCalls.filter((x) => x.method === "thread/start").length, 1);
});

test("offline Claude and paused topics fail before reserving an identity", async (t) => {
  const f = await fixture(t, "offline");
  await assert.rejects(
    createSession(f.client, "claude", f.options),
    /没有正在运行/,
  );
  assert.equal(await f.client.request(sessionPath(f.topic.id, "claude")), null);
  await f.client.request(
    `/api/topics/${f.topic.id}`,
    { status: "paused" },
    "PATCH",
  );
  await assert.rejects(
    createSession(f.client, "codex", { ...f.options, endpoint: f.endpoint }),
    /开放主题/,
  );
  assert.equal((await f.client.request("/api/participants")).length, 1);
  assert.equal(f.rpcCalls.length, 0);
});

test("a launch error retains its session id and cannot be blindly retried", async (t) => {
  const f = await fixture(t, "fail");
  await assert.rejects(
    createSession(f.client, "claude", f.options),
    /未成功确认/,
  );
  const info = await f.client.request(sessionPath(f.topic.id, "claude"));
  assert.equal(info.launch_status, "uncertain");
  assert.ok(info.native_id);
  assert.equal(info.notification, null);
  await assert.rejects(createSession(f.client, "claude", f.options), /已有/);
});

test("command success without native registration reports timeout, never ready", async (t) => {
  const f = await fixture(t, "no-join");
  await assert.rejects(
    createSession(f.client, "codex", {
      ...f.options,
      endpoint: f.endpoint,
      timeout: 1,
    }),
    /尚未确认加入/,
  );
  const info = await f.client.request(sessionPath(f.topic.id, "codex"));
  assert.equal(info.launch_status, "submitted");
  assert.equal(info.notification, null);
  assert.equal(info.native_id, f.nativeId);
  await assert.rejects(
    f.client.request(
      sessionPath(f.topic.id, "codex"),
      { launchStatus: "reserved", nativeId: randomUUID() },
      "PATCH",
    ),
    /409/,
  );
});
