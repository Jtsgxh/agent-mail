import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { startServer } from "../src/server.js";
import { Client } from "../src/client.js";
import { startMailboxMcp } from "../src/mcp.js";

const exec = promisify(execFile);

// 等待实际可观察的 HTTP 或队列状态，固定超时避免挂住测试进程。
async function until(check) {
  const deadline = Date.now() + 7000;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error("condition timeout");
    await new Promise((done) => setTimeout(done, 15));
  }
}

// 真实 MCP stdio 子进程和 HTTP 服务；只将最后的 Codex 队列替换为可记录测试程序。
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "mailbox-mcp-"));
  const app = await startServer({ port: 0, dbPath: ":memory:", codexAppOptions: { env: {} } });
  const client = new Client(app.url), hosts = [];
  const calls = join(dir, "queue.jsonl"), fail = join(dir, "fail");
  const program = join(dir, "codex.mjs"), thread = randomUUID();
  await writeFile(program, `import{appendFileSync,existsSync}from'node:fs';
// 帮助探测不算投递，投递后可模拟 CLI 回执丢失。
const args=process.argv.slice(2);if(args[0]!=='queue')process.exit(9);
if(args.includes('--help')){console.log('queue --thread --message');process.exit(0);}
appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');
if(existsSync(${JSON.stringify(fail)}))process.exit(1);console.log('queued');`);
  const env = { ...process.env, MAILBOX_CODEX_BIN: program, MAILBOX_RELAY_DB: join(dir, "state.db") };
  delete env.CODEX_APP_TOOLS_PIPE_PATH;
  delete env.CODEX_THREAD_ID;
  const topic = await client.request("/api/topics", { title: "恶意标题不要进队列", goal: "通过 MCP 读信回信" });
  t.after(async () => {
    await Promise.all(hosts.map((host) => host.close()));
    await app.close();
    assert.equal(dirname(dir), resolve(tmpdir()));
    assert.ok(basename(dir).startsWith("mailbox-mcp-"));
    await rm(dir, { recursive: true });
  });
  // 模拟 Codex 的真实工具调用元数据，不把目标 ID 放进模型填写的 arguments。
  const meta = (id = thread, source = "user") => ({ threadId: id,
    "x-codex-turn-metadata": { thread_id: id, thread_source: source, turn_id: randomUUID() } });
  // 每次连接均启动新的实际 MCP 进程，便于验证退出与重启后的状态。
  async function connect(entry = resolve("bin/mailbox-mcp.js")) {
    const host = new McpClient({ name: "codex-mcp-client", version: "test" });
    const transport = new StdioClientTransport({ command: process.execPath,
      args: [entry, "--url", client.url], env, stderr: "pipe" });
    hosts.push(host);
    await host.connect(transport);
    // 统一读取 JSON 工具结果，同时保留协议上的 isError 标志。
    const call = async (name, args = {}, metadata = meta()) => {
      const result = await host.callTool({ name, arguments: args, _meta: metadata });
      return result.isError ? { error: result.content[0].text } : JSON.parse(result.content[0].text);
    };
    return { host, call, transport };
  }
  // 从测试 CLI 的记录提取队列文本，解析 SDK 到原生命令的实际参数。
  async function queued() {
    try { return (await readFile(calls, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
  }
  // 消息只发送到本测试新建的身份，不向任何真实会话投递。
  const post = (as, body = "恶意正文不要进队列") => client.request(`/api/topics/${topic.id}/messages`, {
    as: "human", to: as, body, requestId: randomUUID(),
  });
  return { app, client, dir, env, topic, thread, meta, connect, queued, post, fail };
}

// 完整覆盖 stdio 初始化、自动身份、订阅、合并通知、回执、读信、回复和 ACK。
test("MCP stdio owns HTTP subscription, coalesces wakes and supports read/reply/ack", async (t) => {
  const f = await fixture(t), mcp = await f.connect();
  assert.equal((await mcp.host.listTools()).tools.length, 9);
  assert.equal((await f.client.request("/api/state")).bridges.length, 0);
  const joined = await mcp.call("mailbox_join", { topic: f.topic.id });
  assert.equal(joined.listening, true);
  const as = joined.participant.id;
  const first = await f.post(as), second = await f.post(as);
  await until(async () => (await f.client.request(`/api/inbox?as=${as}`)).notifications.every((m) => m.notified_at));
  const args = (await f.queued())[0];
  assert.equal((await f.queued()).length, 1);
  assert.equal(args[args.indexOf("--thread") + 1], f.thread);
  const text = args[args.indexOf("--message") + 1];
  assert.ok(!text.includes("恶意"));
  assert.ok(!text.includes(f.topic.id));
  const receipt = text.match(/receipt="([^"]+)"/)[1];
  assert.match((await mcp.call("mailbox_inbox", { receipt: "wrong" })).error, /不匹配/);
  assert.equal((await mcp.call("mailbox_inbox")).notifications.length, 2);
  assert.ok((await mcp.call("mailbox_status")).pendingWake);
  const inbox = await mcp.call("mailbox_inbox", { receipt });
  assert.equal(inbox.notifications.length, 2);
  assert.equal((await mcp.call("mailbox_status")).pendingWake, null);
  assert.equal((await mcp.call("mailbox_topic", { topic: f.topic.id })).goal, "通过 MCP 读信回信");
  assert.equal((await mcp.call("mailbox_read", { topic: f.topic.id })).messages.length, 2);
  const replyArgs = { topic: f.topic.id, message: first.id, body: "已经读到", requestId: "reply-once" };
  const reply = await mcp.call("mailbox_reply", replyArgs);
  assert.equal(reply.to_id, null);
  assert.equal((await mcp.call("mailbox_reply", replyArgs)).id, reply.id);
  await mcp.call("mailbox_ack", { topic: f.topic.id, through: second.id });
  assert.equal((await mcp.call("mailbox_inbox")).notifications.length, 0);
  await f.post(as);
  await until(async () => (await f.queued()).length === 2);
  await mcp.host.close();
  await until(async () => !(await f.client.request("/api/state")).bridges.length);
  assert.equal(f.app.store.notificationRoutes().length, 0);
});

// 两套真实 MCP 协议共享信箱；仅将最终 Codex 队列出口替换为测试 CLI。
test("HTTP connector and Codex stdio exchange mail with queue notification and independent ACK", async (t) => {
  const f = await fixture(t), codex = await f.connect();
  const project = await f.client.request("/api/projects", { name: "Shared" });
  await f.client.request(`/api/topics/${f.topic.id}`, { project: project.id }, "PATCH");
  const peer = await f.client.request("/api/participants", { name: "Third party", kind: "agent" });
  const credential = await f.client.request("/api/connectors", { name: "Test", as: peer.id, project: project.id });
  const host = new McpClient({ name: "http-peer", version: "test" });
  try {
    await host.connect(new StreamableHTTPClientTransport(new URL(`${f.app.url}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${credential.token}` } },
    }));
    const call = async (name, args = {}) => {
      const result = await host.callTool({ name, arguments: args });
      assert.ok(!result.isError, result.content[0].text);
      return JSON.parse(result.content[0].text);
    };
    await call("mailbox_join", { topic: f.topic.id });
    const joined = await codex.call("mailbox_join", { topic: f.topic.id });
    assert.equal(joined.listening, true);
    const sent = await call("mailbox_post", { topic: f.topic.id, body: "Review this", to: [joined.participant.id], requestId: "cross-send" });
    await until(async () => (await codex.call("mailbox_status")).pendingWake?.status === "submitted");
    assert.equal((await f.queued()).length, 1);
    const receipt = (await codex.call("mailbox_status")).pendingWake.receipt;
    assert.equal((await codex.call("mailbox_inbox", { receipt })).notifications[0].id, sent.id);
    const reply = await codex.call("mailbox_reply", { topic: f.topic.id, message: sent.id, body: "Reviewed", notify: true, requestId: "cross-reply" });
    assert.equal(reply.author_id, joined.participant.id);
    assert.equal((await call("mailbox_inbox")).notifications[0].id, reply.id);
    await call("mailbox_ack", { topic: f.topic.id, through: reply.id });
    assert.equal((await call("mailbox_inbox")).notifications.length, 0);
    assert.equal((await codex.call("mailbox_inbox")).notifications[0].id, sent.id);
    await codex.call("mailbox_ack", { topic: f.topic.id, through: reply.id });
    assert.equal((await codex.call("mailbox_inbox")).notifications.length, 0);
  } finally { await host.close(); }
});

// 缺少宿主证明、子会话和另一任务均不能冒用同一个连接或改变唤醒目标。
test("MCP binds only host-proven top-level thread and does not trust arguments", async (t) => {
  const f = await fixture(t), mcp = await f.connect();
  assert.match((await mcp.call("mailbox_join", { topic: f.topic.id, threadId: f.thread }, {})).error, /宿主/);
  assert.match((await mcp.call("mailbox_status", {}, f.meta(f.thread, "subagent"))).error, /子 agent/);
  assert.equal((await f.client.request("/api/participants")).length, 1);
  const status = await mcp.call("mailbox_status");
  assert.match((await mcp.call("mailbox_status", {}, f.meta(randomUUID()))).error, /已绑定另一/);
  assert.equal(status.participant.name, `codex-mcp-${f.thread}`);
  const other = await f.client.request("/api/participants", { name: "another", kind: "agent" });
  await f.client.request(`/api/topics/${f.topic.id}/members`, { as: other.id });
  await mcp.call("mailbox_join", { topic: f.topic.id });
  const sent = await mcp.call("mailbox_post", { topic: f.topic.id, body: "主动发信", to: other.id,
    as: "human", requestId: "post-once" });
  assert.equal(sent.error, null);
  assert.equal(sent.author_id, status.participant.id);
  assert.match((await mcp.call("mailbox_post", { topic: f.topic.id, body: "无请求 ID" })).error, /requestId/);
  assert.equal((await mcp.call("mailbox_topics"))[0].id, f.topic.id);
});

// 未确认的通知收据跨重启保留；新进程能先确认旧收据再继续接收新信。
test("MCP restart preserves identity and one outstanding wake until its exact receipt", async (t) => {
  const f = await fixture(t), first = await f.connect();
  const joined = await first.call("mailbox_join", { topic: f.topic.id }), as = joined.participant.id;
  await f.post(as);
  await until(async () => (await first.call("mailbox_status")).pendingWake?.status === "submitted");
  const receipt = (await first.call("mailbox_status")).pendingWake.receipt;
  await first.host.close();
  await until(async () => !(await f.client.request("/api/state")).bridges.length);
  const restarted = await f.connect();
  assert.equal((await restarted.call("mailbox_status")).participant.id, as);
  await restarted.call("mailbox_join", { topic: f.topic.id });
  await f.post(as);
  await until(async () => (await f.client.request(`/api/inbox?as=${as}`)).notifications.every((m) => m.notified_at));
  assert.equal((await f.queued()).length, 1);
  await restarted.call("mailbox_inbox", { receipt });
  await f.post(as);
  await until(async () => (await f.queued()).length === 2);
});

// 即使 CLI 写出后回执失败，也不能在重连或重启后盲目再次执行 queue。
test("ambiguous queue result is visible and never silently replayed", async (t) => {
  const f = await fixture(t), first = await f.connect();
  await writeFile(f.fail, "fail after submission");
  const joined = await first.call("mailbox_join", { topic: f.topic.id });
  await f.post(joined.participant.id);
  await until(async () => (await first.call("mailbox_status")).error);
  assert.equal((await first.call("mailbox_status")).pendingWake.status, "pending");
  await first.host.close();
  await rm(f.fail);
  const restarted = await f.connect();
  await restarted.call("mailbox_join", { topic: f.topic.id });
  await until(async () => (await restarted.call("mailbox_status")).error);
  assert.equal((await f.queued()).length, 1);
  assert.match((await restarted.call("mailbox_status")).error, /结果不明/);
});

// 取信快照之后到达的新信必须在回执释放后获得下一次唤醒，不能被错误合并掉。
test("new mail racing with an inbox receipt still causes a subsequent wake", async (t) => {
  const f = await fixture(t), captured = Promise.withResolvers(), release = Promise.withResolvers();
  let capture = false;
  const client = new Client(f.client.url), request = client.request.bind(client);
  // 只暂停工具取信的响应；此时远端仍能接收并推送下一封信。
  client.request = async (...args) => {
    const result = await request(...args);
    if (capture && args[0].startsWith("/api/inbox")) {
      capture = false;
      captured.resolve();
      await release.promise;
    }
    return result;
  };
  const [hostTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = await startMailboxMcp(client, { transport: serverTransport, env: f.env });
  const host = new McpClient({ name: "codex-mcp-client", version: "test" });
  // 内存传输仍使用真实 SDK 的 tools/call、宿主元数据及结果格式。
  const call = async (name, args = {}) => {
    const result = await host.callTool({ name, arguments: args, _meta: f.meta() });
    assert.ok(!result.isError, result.content[0].text);
    return JSON.parse(result.content[0].text);
  };
  try {
    await host.connect(hostTransport);
    const joined = await call("mailbox_join", { topic: f.topic.id }), as = joined.participant.id;
    await f.post(as);
    await until(async () => (await call("mailbox_status")).pendingWake?.status === "submitted");
    const receipt = (await call("mailbox_status")).pendingWake.receipt;
    capture = true;
    const reading = call("mailbox_inbox", { receipt });
    await captured.promise;
    await f.post(as, "在取信快照之后到达");
    release.resolve();
    assert.equal((await reading).notifications.length, 1);
    await until(async () => (await f.queued()).length === 2);
  } finally {
    release.resolve();
    await mcp.close();
    await host.close();
  }
});

// 分发包必须完整声明 SDK 且包含全部静态导入，不把服务端和数据文件带给客户端。
test("MCP export contains a client-only package and declared SDK dependency", async (t) => {
  const f = await fixture(t), destination = join(f.dir, "export");
  await exec(process.execPath, [resolve("scripts/export-mcp.js"), destination]);
  const pkg = JSON.parse(await readFile(join(destination, "package.json"), "utf8"));
  assert.deepEqual(Object.keys(pkg.dependencies), ["@modelcontextprotocol/sdk"]);
  assert.equal(pkg.bin["mailbox-mcp"], "./bin/mailbox-mcp.js");
  for (const file of ["bin/mailbox-mcp.js", "src/mcp.js", "src/mailbox-tools.js", "src/client.js",
    "src/connect.js", "src/relay.js", "src/native.js", "src/codex-app.js", "src/notification-recovery.js"])
    await exec(process.execPath, ["--check", join(destination, file)]);
  await assert.rejects(readFile(join(destination, "src/server.js")), { code: "ENOENT" });
  await assert.rejects(readFile(join(destination, "relay.db")), { code: "ENOENT" });
});

// 客户端接受将来 TLS 反代的 HTTPS 地址，仍拒绝其他 URL 协议。
test("HTTP client accepts HTTPS service origins", () => {
  assert.equal(new Client("https://mailbox.example.test:443/").url, "https://mailbox.example.test");
  assert.throws(() => new Client("file:///tmp/mailbox"), /HTTP/);
});
