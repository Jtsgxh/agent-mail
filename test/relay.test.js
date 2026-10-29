import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import http from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { endianness, networkInterfaces, tmpdir } from "node:os";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { startServer } from "../src/server.js";
import { Client } from "../src/client.js";
import { runRelay } from "../src/relay.js";

const exec = promisify(execFile);
const le = endianness() === "LE";

// 等待可观察状态，超时给出明确失败，避免依赖固定睡眠验证投递。
async function until(check) {
  const end = Date.now() + 7000;
  while (!await check()) {
    if (Date.now() > end) throw new Error("condition timeout");
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
}

// 使用真实 TCP HTTP 和独立本机 IPC 测试入口，模拟另一台机器自己的 Codex App。
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "mailbox-relay-"));
  const pipe = process.platform === "win32" ? `\\\\.\\pipe\\mailbox-relay-${randomUUID()}` : join(dir, "app.sock");
  const thread = randomUUID(), sends = [], sockets = new Set(), children = new Set(), runs = [];
  const state = { uncertain: false };
  // 按项目已验证的 App 帧协议返回响应，并记录实际向任务提交的消息。
  const fake = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = le ? buffer.readUInt32LE() : buffer.readUInt32BE();
        if (buffer.length < length + 4) return;
        const request = JSON.parse(buffer.subarray(4, length + 4));
        buffer = buffer.subarray(length + 4);
        if (request.method === "tools/cancel") continue;
        let result;
        if (request.method === "tools/list") {
          result = { tools: ["list_projects", "create_thread", "send_message_to_thread", "list_threads",
            "create_sidebar_section", "move_thread_to_sidebar_section"].map((name) => ({ namespace: "codex_app", name })) };
        } else {
          assert.equal(request.params.callerSource, "codex");
          const { tool, arguments: args } = request.params;
          let value;
          if (tool === "list_projects") value = { projects: [] };
          else {
            assert.equal(request.params.threadId, thread);
            assert.equal(tool, "send_message_to_thread");
            assert.equal(args.threadId, thread);
            sends.push(args);
            if (state.uncertain) { socket.destroy(); continue; }
            value = { threadId: thread };
          }
          result = { success: true, contentItems: [{ type: "inputText", text: JSON.stringify(value) }] };
        }
        const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
        const header = Buffer.alloc(4);
        if (le) header.writeUInt32LE(body.length); else header.writeUInt32BE(body.length);
        socket.write(Buffer.concat([header, body]));
      }
    });
  });
  fake.listen(pipe);
  await once(fake, "listening");
  const app = await startServer({ host: "0.0.0.0", port: 0, dbPath: ":memory:", codexAppOptions: { env: {} } });
  const address = Object.values(networkInterfaces()).flat().find((a) => a?.family === "IPv4" && !a.internal)?.address ?? "127.0.0.1";
  const client = new Client(`http://${address}:${app.server.address().port}`);
  const participant = await client.request("/api/participants", { name: "remote-test", kind: "codex" });
  const topic = await client.request("/api/topics", { title: "远端通知测试", goal: "不将目标正文注入通知" });
  const env = { ...process.env, CODEX_THREAD_ID: thread, CODEX_APP_TOOLS_PIPE_PATH: pipe,
    MAILBOX_RELAY_DB: join(dir, "relay.db") };
  t.after(async () => {
    for (const run of runs) run.stop.abort();
    await Promise.all(runs.map((run) => run.done));
    for (const pid of children) {
      try { process.kill(pid); } catch {}
      await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
    }
    await app.close();
    for (const socket of sockets) socket.destroy();
    if (fake.listening) await new Promise((done) => fake.close(done));
    assert.ok(dir.startsWith(join(tmpdir(), "mailbox-relay-")));
    await rm(dir, { recursive: true, force: true });
  });
  // 以主题创建者身份向远端任务发信，不借用任何真实 agent 身份。
  const post = () => client.request(`/api/topics/${topic.id}/messages`, {
    as: "human", to: participant.id, body: "只通过 HTTP 主动读取这段正文", requestId: randomUUID(),
  });
  // 每个测试管理自己的转发器生命周期，结束时确保订阅和数据库均关闭。
  const start = (options = {}) => {
    const stop = new AbortController(), ready = Promise.withResolvers();
    const done = runRelay(client, participant, { env, signal: stop.signal, topic: topic.id,
      retryDelays: [10, 20, 40, 80], ...options,
      // 只有实际建立订阅后才解除测试的发送屏障。
      async onReady() { ready.resolve(); await options.onReady?.(); },
    }).catch((error) => error);
    runs.push({ stop, done });
    return { stop, ready: ready.promise, done };
  };
  return { dir, fake, pipe, thread, sends, state, app, client, participant, topic, env, post, start, children };
}

// 精简分发包实际启动后台进程，经网卡 IP 收信并投递本机 App，且可正常停止。
test("portable relay needs no npm dependencies and wakes only its local desktop task", async (t) => {
  const f = await fixture(t);
  const destination = join(f.dir, "portable");
  await exec(process.execPath, [resolve("scripts/export-relay.js"), destination]);
  assert.deepEqual((await readdir(destination)).sort(), ["README.md", "bin", "package.json", "src"]);
  const { stdout } = await exec(process.execPath, [join(destination, "bin/mailbox-relay.js"),
    "--url", f.client.url, "--as", f.participant.id, "--topic", f.topic.id, "--background"], { env: f.env, timeout: 10000 });
  const connected = JSON.parse(stdout);
  f.children.add(connected.pid);
  assert.equal(connected.status, "listening");
  assert.equal(connected.mode, "codex-remote-relay");
  const message = await f.post();
  await until(async () => (await f.client.request(`/api/inbox?as=${f.participant.id}`)).notifications[0]?.notified_at);
  assert.equal(f.sends.length, 1);
  assert.ok(f.sends[0].prompt.includes(`GET ${f.client.url}/api/topics/${f.topic.id}`));
  assert.ok(!f.sends[0].prompt.includes("不将目标正文注入通知"));
  assert.ok(!f.sends[0].prompt.includes(message.body));
  assert.ok(!f.sends[0].prompt.includes("mailbox --url"));
  assert.equal(f.app.store.notificationRoutes().length, 0);
  assert.equal((await f.client.request("/api/state")).bridges[0].kind, "codex-remote-relay");
  const bytes = await readFile(f.env.MAILBOX_RELAY_DB);
  assert.ok(!bytes.includes(Buffer.from(f.pipe)));
  assert.ok(!bytes.includes(Buffer.from(message.body)));
  assert.equal((await f.client.request(`/api/inbox?as=${f.participant.id}`)).notifications[0].ack_at, null);
  await f.client.request(`/api/bridge/${f.participant.id}`, undefined, "DELETE");
  await until(() => { try { process.kill(connected.pid, 0); return false; } catch { return true; } });
});

// HTTP 回执丢失后重连只补回执；进程重启后仍复用持久化的已提交状态。
test("receipt loss, reconnect and process restart never resubmit a successful App message", async (t) => {
  const f = await fixture(t);
  const request = f.client.request.bind(f.client);
  let failReceipt = true, readyCount = 0;
  // 丢弃一次投递回执，模拟 App 已成功但服务器未收到回执的网络故障。
  f.client.request = async (path, ...args) => {
    if (path.startsWith("/api/deliveries/") && failReceipt) {
      failReceipt = false;
      throw new Error("lost receipt");
    }
    return request(path, ...args);
  };
  const run = f.start({ onReady() { readyCount++; } });
  await run.ready;
  const message = await f.post();
  await until(async () => (await request(`/api/inbox?as=${f.participant.id}`)).notifications[0]?.notified_at);
  assert.ok(readyCount >= 2);
  assert.equal(f.sends.length, 1);
  run.stop.abort(); await run.done;
  await until(async () => !(await request("/api/state")).bridges.length);
  f.app.store.db.prepare("UPDATE deliveries SET notified_at=NULL WHERE message_id=?").run(message.id);
  const restarted = f.start();
  await restarted.ready;
  await until(async () => (await request(`/api/inbox?as=${f.participant.id}`)).notifications[0]?.notified_at);
  assert.equal(f.sends.length, 1);
  restarted.stop.abort(); await restarted.done;
});

// 请求已写出但 App 未确认时保留占位，重启也不能重复唤醒或换绑任务。
test("ambiguous IPC failure persists and cannot be replayed or rebound after restart", async (t) => {
  const f = await fixture(t);
  f.state.uncertain = true;
  const run = f.start();
  await run.ready;
  await f.post();
  assert.match((await run.done).message, /未确认/);
  assert.equal(f.sends.length, 1);
  await until(async () => !(await f.client.request("/api/state")).bridges.length);
  f.state.uncertain = false;
  const retry = f.start();
  assert.match((await retry.done).message, /结果不明/);
  assert.equal(f.sends.length, 1);
  const journal = new DatabaseSync(f.env.MAILBOX_RELAY_DB);
  assert.equal(journal.prepare("SELECT status FROM deliveries").get().status, "pending");
  journal.close();
  // 另一任务的本机 App 验证可通过，但同一身份仍不能换绑。
  const otherEnv = { ...f.env, CODEX_THREAD_ID: randomUUID() };
  await assert.rejects(runRelay(f.client, f.participant, { env: otherEnv }), /已绑定另一 Codex 任务/);
});

// 发送前管道不可达可以安全重试；成功后通知数量不受旧参数限制。
test("pre-write IPC failure retries safely and delivery has no message limit", async (t) => {
  const f = await fixture(t);
  let retries = 0;
  const run = f.start({ maxMessages: 1,
    // 第一次安全失败后重新开放同一测试管道，确保下一次尝试可以成功。
    async onRetry({ message }) {
      if (message) {
        retries++;
        f.fake.listen(f.pipe);
        await once(f.fake, "listening");
      }
    },
  });
  await run.ready;
  await new Promise((done) => f.fake.close(done));
  await f.post();
  await until(async () => (await f.client.request(`/api/inbox?as=${f.participant.id}`)).notifications[0]?.notified_at);
  assert.equal(retries, 1);
  assert.equal(f.sends.length, 1);
  for (let i = 0; i < 22; i++) {
    await f.post();
    await until(() => f.sends.length === i + 2);
  }
  assert.equal(f.sends.length, 23);
  run.stop.abort();
  await run.done;
});

// 连续快速断流会耗尽预算，不能每次 ready 就清零导致无限重连。
test("repeated SSE disconnects exhaust the bounded reconnect budget", async (t) => {
  const f = await fixture(t);
  let connections = 0;
  const run = f.start({ retryDelays: [10, 20],
    // ready 后主动断开所有测试连接，模拟不断中断的远端服务。
    onReady() { connections++; setImmediate(() => f.app.server.closeAllConnections()); },
  });
  const error = await run.done;
  assert.ok(error instanceof Error);
  assert.equal(connections, 3);
  assert.equal(f.sends.length, 0);
});

// 缺少心跳时及时结束半开订阅，同时保留 HTTP 状态供重连策略判断。
test("SSE idle timeout aborts silent streams and preserves HTTP failure status", async (t) => {
  const server = http.createServer((req, res) => {
    if (req.url === "/forbidden") {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end('{"error":"forbidden"}');
    } else { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.flushHeaders(); }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise((done) => server.close(done)); });
  const client = new Client(`http://127.0.0.1:${server.address().port}`);
  const events = client.events("/silent", undefined, { idleTimeout: 25 });
  await assert.rejects(events.next(), /abort|超时/i);
  await assert.rejects(client.events("/forbidden").next(), (error) => error.status === 403);
});

// 暂停、已读和关闭主题均不唤醒；恢复后只投递尚未确认的消息。
test("remote relay respects pause, acknowledgement and topic closure", async (t) => {
  const f = await fixture(t);
  const run = f.start();
  await run.ready;
  await f.client.request(`/api/topics/${f.topic.id}`, { status: "paused" }, "PATCH");
  const acknowledged = await f.post();
  await f.client.request(`/api/topics/${f.topic.id}/ack`, { as: f.participant.id, through: acknowledged.id });
  const pending = await f.post();
  assert.equal(f.sends.length, 0);
  await f.client.request(`/api/topics/${f.topic.id}`, { status: "open" }, "PATCH");
  await until(() => f.sends.length === 1);
  assert.ok(f.sends[0].prompt.includes(`消息 #${pending.id}`));
  await f.client.request(`/api/topics/${f.topic.id}`, { status: "closed" }, "PATCH");
  await assert.rejects(f.post(), /关闭/);
  assert.equal(f.sends.length, 1);
});

// 现有 CLI 的 relay 命令也走轻量入口，不能自动把远端管道上传做服务器路由恢复。
test("full CLI relay bypasses server App registration and rejects task impersonation", async (t) => {
  const f = await fixture(t);
  const requests = [];
  f.app.server.on("request", (req) => requests.push(req.url));
  const jar = join(f.dir, "cookies.json");
  await writeFile(jar, JSON.stringify({ version: 1, routes: [{
    origin: f.client.url, participantId: f.participant.id, cookie: Buffer.alloc(32, 1).toString("base64url"),
  }] }));
  const { stdout } = await exec(process.execPath, [resolve("bin/mailbox.js"), "--url", f.client.url,
    "relay", "--as", f.participant.id, "--topic", f.topic.id, "--background"],
  { env: { ...f.env, MAILBOX_ROUTE_COOKIE_JAR: jar }, timeout: 10000 });
  const connected = JSON.parse(stdout);
  f.children.add(connected.pid);
  assert.equal(connected.mode, "codex-remote-relay");
  assert.ok(!requests.some((url) => url.startsWith("/api/codex/")));
  assert.equal(f.app.store.notificationRoutes().length, 0);
  await assert.rejects(exec(process.execPath, [resolve("bin/mailbox.js"), "--url", f.client.url,
    "relay", "--as", f.participant.id, "--thread", "other-task"], { env: f.env }),
  (error) => error.code === 1 && error.stderr.includes("自身的入口"));
  await f.client.request(`/api/bridge/${f.participant.id}`, undefined, "DELETE");
  await until(() => { try { process.kill(connected.pid, 0); return false; } catch { return true; } });
});
