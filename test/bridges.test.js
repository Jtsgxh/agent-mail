import test from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve } from "node:path";
import { z } from "zod";
import { startServer } from "../src/server.js";
import { Client } from "../src/client.js";
import { startClaudeChannel } from "../src/claude.js";
import { runCodexBridge } from "../src/codex.js";

async function waitFor(predicate) {
  const until = Date.now() + 5000;
  while (!(await predicate())) {
    if (Date.now() > until) throw new Error("Timed out");
    await new Promise((r) => setTimeout(r, 15));
  }
}
async function setup(t, kind) {
  const app = await startServer({ port: 0, dbPath: ":memory:" });
  t.after(() => app.close());
  const client = new Client(app.url);
  const agent = await client.request("/api/participants", {
    name: `test-${kind}`,
    kind,
  });
  const topic = await client.request("/api/topics", {
    title: "桥接测试",
    goal: "空闲后收到消息并回复",
  });
  await client.request(`/api/topics/${topic.id}/members`, { as: agent.id });
  const post = (body, requestId = body) =>
    client.request(`/api/topics/${topic.id}/messages`, {
      as: "human",
      to: agent.id,
      body,
      requestId,
    });
  return { app, client, agent, topic, post };
}

test("Claude: real MCP SDK initialize → channel notification → read → reply → ack", async (t) => {
  const f = await setup(t, "claude");
  const [hostTransport, channelTransport] =
    InMemoryTransport.createLinkedPair();
  const channel = await startClaudeChannel(f.client, f.agent.id, {
    transport: channelTransport,
  });
  const host = new McpClient({ name: "test-host", version: "1" });
  const incoming = [];
  host.setNotificationHandler(
    z.object({
      method: z.literal("notifications/claude/channel"),
      params: z.object({
        content: z.string(),
        meta: z.record(z.string(), z.string()),
      }),
    }),
    (n) => {
      incoming.push(n.params);
    },
  );
  channel.done.catch(() => {});
  t.after(async () => {
    await channel.close();
    await host.close();
  });
  await f.post("before initialization");
  assert.equal((await f.client.request("/api/state")).bridges.length, 0);
  await host.connect(hostTransport);
  await waitFor(() => incoming.length === 1);
  const m = Number(incoming[0].meta.message_id);
  assert.match(incoming[0].content, /before initialization/);
  assert.doesNotMatch(incoming[0].content, /空闲后收到消息并回复/);
  assert.deepEqual(
    (await host.listTools()).tools.map((t) => t.name),
    ["mailbox_topic", "mailbox_read", "mailbox_ack", "mailbox_reply"],
  );
  const topic = await host.callTool({
    name: "mailbox_topic",
    arguments: { topic: f.topic.id },
  });
  assert.equal(JSON.parse(topic.content[0].text).goal, "空闲后收到消息并回复");
  const read = await host.callTool({
    name: "mailbox_read",
    arguments: { topic: f.topic.id },
  });
  assert.equal(JSON.parse(read.content[0].text).messages[0].id, m);
  assert.equal(
    (await f.client.request(`/api/inbox?as=${f.agent.id}`)).notifications
      .length,
    1,
  );
  const reply = await host.callTool({
    name: "mailbox_reply",
    arguments: {
      topic: f.topic.id,
      message: m,
      body: "已经读到，建议使用事件驱动。",
    },
  });
  assert.equal(reply.isError, undefined);
  const stored = JSON.parse(reply.content[0].text);
  assert.equal(stored.to_id, null);
  await host.callTool({
    name: "mailbox_ack",
    arguments: { topic: f.topic.id, through: m },
  });
  assert.equal(
    (await f.client.request(`/api/inbox?as=${f.agent.id}`)).notifications
      .length,
    0,
  );
  const duplicate = await host.callTool({
    name: "mailbox_reply",
    arguments: { topic: f.topic.id, message: m, body: stored.body },
  });
  assert.equal(JSON.parse(duplicate.content[0].text).id, stored.id);
  await f.post("after idle");
  await waitFor(() => incoming.length === 2);
  assert.match(incoming[1].content, /after idle/);
});

test("Claude: actual mailbox CLI works over MCP stdio without stdout log pollution", async (t) => {
  const f = await setup(t, "claude");
  const host = new McpClient({ name: "stdio-test-host", version: "1" });
  const incoming = [];
  host.setNotificationHandler(
    z.object({
      method: z.literal("notifications/claude/channel"),
      params: z.object({ content: z.string() }).passthrough(),
    }),
    (n) => {
      incoming.push(n.params);
    },
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      resolve("bin/mailbox.js"),
      "--url",
      f.app.url,
      "bridge",
      "claude",
      "--as",
      f.agent.id,
    ],
    stderr: "pipe",
  });
  t.after(() => host.close());
  await host.connect(transport);
  assert.equal((await host.listTools()).tools.length, 4);
  await f.post("real stdio transport");
  await waitFor(() => incoming.length === 1);
  assert.match(incoming[0].content, /real stdio transport/);
});

async function fakeCodex(t, { initialStatus = "idle", invalid = false } = {}) {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((r) => wss.once("listening", r));
  const requests = [];
  let socket,
    n = 0;
  wss.on("connection", (ws) => {
    socket = ws;
    ws.on("message", (raw) => {
      const r = JSON.parse(raw);
      requests.push(r);
      if (r.id === undefined) return;
      const send = (result) => ws.send(JSON.stringify({ id: r.id, result }));
      if (r.method === "initialize") send({ userAgent: "protocol-fixture" });
      else if (r.method === "thread/resume")
        send({
          thread: {
            id: "existing-thread",
            status: { type: initialStatus },
            turns: [],
          },
        });
      else if (r.method === "turn/start") {
        const turn = {
          id: `turn-${++n}`,
          status: "inProgress",
          items: [],
          error: null,
        };
        send({ turn });
        ws.send(
          JSON.stringify({
            method: "turn/started",
            params: { threadId: "existing-thread", turn },
          }),
        );
        // Completion deliberately has an empty items array, as in the App Server event contract.
        ws.send(
          JSON.stringify({
            method: "item/completed",
            params: {
              threadId: "existing-thread",
              turnId: turn.id,
              item: {
                id: `item-${n}`,
                type: "agentMessage",
                text: invalid
                  ? "bad JSON"
                  : JSON.stringify({
                      body: `协议测试回复 ${n}`,
                      notify: false,
                    }),
              },
            },
          }),
        );
        ws.send(
          JSON.stringify({
            method: "turn/completed",
            params: {
              threadId: "existing-thread",
              turn: { ...turn, status: "completed" },
            },
          }),
        );
      } else if (r.method === "turn/interrupt") send({});
      else
        ws.send(
          JSON.stringify({
            id: r.id,
            error: { code: -32601, message: "unexpected method" },
          }),
        );
    });
  });
  t.after(async () => {
    for (const s of wss.clients) s.terminate();
    await new Promise((r) => wss.close(r));
  });
  return {
    endpoint: `ws://127.0.0.1:${wss.address().port}`,
    requests,
    disconnect() {
      socket.close();
    },
    idle() {
      socket.send(
        JSON.stringify({
          method: "thread/status/changed",
          params: { threadId: "existing-thread", status: { type: "idle" } },
        }),
      );
    },
  };
}

test("Codex: queues while busy, wakes twice from idle, captures final events and prevents reply loops", async (t) => {
  const f = await setup(t, "codex");
  const codex = await fakeCodex(t, { initialStatus: "active" });
  const stop = new AbortController();
  const run = runCodexBridge(f.client, f.agent.id, {
    endpoint: codex.endpoint,
    thread: "existing-thread",
    signal: stop.signal,
    log() {},
  }).catch((e) => {
    if (!stop.signal.aborted) throw e;
  });
  t.after(async () => {
    stop.abort();
    await run;
  });
  await waitFor(
    async () => (await f.client.request("/api/state")).bridges.length === 1,
  );
  await f.post("first");
  assert.equal(
    codex.requests.filter((r) => r.method === "turn/start").length,
    0,
  );
  codex.idle();
  await waitFor(
    async () =>
      (await f.client.request(`/api/topics/${f.topic.id}/messages`)).messages
        .length === 2,
  );
  await waitFor(
    async () =>
      (await f.client.request(`/api/inbox?as=${f.agent.id}`)).notifications
        .length === 0,
  );
  await f.post("second");
  await waitFor(
    async () =>
      (await f.client.request(`/api/topics/${f.topic.id}/messages`)).messages
        .length === 4,
  );
  const all = (await f.client.request(`/api/topics/${f.topic.id}/messages`))
    .messages;
  assert.deepEqual(
    all.filter((m) => m.author_id === f.agent.id).map((m) => m.body),
    ["协议测试回复 1", "协议测试回复 2"],
  );
  assert.ok(
    all
      .filter((m) => m.author_id === f.agent.id)
      .every((m) => m.to_id === null),
  );
  assert.equal(
    codex.requests.filter((r) => r.method === "turn/start").length,
    2,
  );
  const prompts = codex.requests
    .filter((r) => r.method === "turn/start")
    .map((r) => r.params.input[0].text);
  assert.ok(prompts.every((text) => text.includes(`topic show ${f.topic.id}`)));
  assert.ok(prompts.every((text) => !text.includes("空闲后收到消息并回复")));
  assert.equal(
    codex.requests.some((r) => r.method === "thread/start"),
    false,
    "must use the specified existing session",
  );
});

test("Codex: server disconnect while idle also closes the mailbox bridge connection", async (t) => {
  const f = await setup(t, "codex");
  const codex = await fakeCodex(t);
  const run = runCodexBridge(f.client, f.agent.id, {
    endpoint: codex.endpoint,
    thread: "existing-thread",
    log() {},
  });
  const rejected = assert.rejects(run, /连接已关闭/);
  await waitFor(
    async () => (await f.client.request("/api/state")).bridges.length === 1,
  );
  codex.disconnect();
  await rejected;
  await waitFor(
    async () => (await f.client.request("/api/state")).bridges.length === 0,
  );
});

test("Codex: invalid model output leaves message unacknowledged with a visible error", async (t) => {
  const f = await setup(t, "codex");
  const codex = await fakeCodex(t, { invalid: true });
  await f.post("bad output");
  await assert.rejects(
    runCodexBridge(f.client, f.agent.id, {
      endpoint: codex.endpoint,
      thread: "existing-thread",
      log() {},
    }),
    /JSON/,
  );
  const inbox = await f.client.request(`/api/inbox?as=${f.agent.id}`);
  assert.equal(inbox.notifications.length, 1);
  assert.ok(inbox.notifications[0].error);
  assert.equal(inbox.notifications[0].ack_at, null);
});

test("Codex: restart after persisted reply but before ack does not invoke the model or send twice", async (t) => {
  const f = await setup(t, "codex");
  const codex = await fakeCodex(t);
  const message = await f.post("retry after crash");
  await f.client.request(`/api/topics/${f.topic.id}/messages`, {
    as: f.agent.id,
    body: "already replied",
    replyTo: message.id,
    requestId: `codex-reply-${message.id}`,
  });
  const stop = new AbortController();
  const run = runCodexBridge(f.client, f.agent.id, {
    endpoint: codex.endpoint,
    thread: "existing-thread",
    signal: stop.signal,
    log() {},
  }).catch((e) => {
    if (!stop.signal.aborted) throw e;
  });
  t.after(async () => {
    stop.abort();
    await run;
  });
  await waitFor(
    async () =>
      (await f.client.request(`/api/inbox?as=${f.agent.id}`)).notifications
        .length === 0,
  );
  assert.equal(
    codex.requests.some((r) => r.method === "turn/start"),
    false,
  );
  assert.equal(
    (await f.client.request(`/api/topics/${f.topic.id}/messages`)).messages
      .length,
    2,
  );
});

test("Codex: deletion before recording a turn receipt preserves the bridge for another topic", async (t) => {
  const f = await setup(t, "codex");
  const codex = await fakeCodex(t);
  const first = await f.post("deleted during turn");
  const other = await f.client.request("/api/topics", { title: "保留主题", goal: "继续回复" });
  await f.client.request(`/api/topics/${other.id}/members`, { as: f.agent.id });
  const request = f.client.request.bind(f.client);
  f.client.request = async (path, ...args) => {
    if (path === `/api/deliveries/${first.id}`)
      await request(`/api/topics/${f.topic.id}`, undefined, "DELETE");
    return request(path, ...args);
  };
  const stop = new AbortController();
  const run = runCodexBridge(f.client, f.agent.id, {
    endpoint: codex.endpoint, thread: "existing-thread", signal: stop.signal, log() {},
  }).catch((error) => { if (!stop.signal.aborted) throw error; });
  t.after(async () => { stop.abort(); await run; });
  await waitFor(async () => !(await request("/api/topics")).some((topic) => topic.id === f.topic.id));
  await request(`/api/topics/${other.id}/messages`, { as: "human", to: f.agent.id, body: "请继续", requestId: "other-topic" });
  await waitFor(async () => (await request(`/api/topics/${other.id}/messages`)).messages.length === 2);
  await waitFor(async () => (await request(`/api/inbox?as=${f.agent.id}`)).notifications.length === 0);
  assert.equal((await request("/api/state")).bridges.length, 1);
  assert.equal(codex.requests.filter((r) => r.method === "turn/start").length, 2);
  assert.equal(codex.requests.some((r) => r.method === "turn/interrupt"), false);
});

test("Claude: deletion before recording a channel receipt keeps notifications working", async (t) => {
  const f = await setup(t, "claude");
  const first = await f.post("deleted during notification");
  const other = await f.client.request("/api/topics", { title: "保留主题", goal: "继续通知" });
  await f.client.request(`/api/topics/${other.id}/members`, { as: f.agent.id });
  const request = f.client.request.bind(f.client);
  f.client.request = async (path, ...args) => {
    if (path === `/api/deliveries/${first.id}`)
      await request(`/api/topics/${f.topic.id}`, undefined, "DELETE");
    return request(path, ...args);
  };
  const [hostTransport, channelTransport] = InMemoryTransport.createLinkedPair();
  const channel = await startClaudeChannel(f.client, f.agent.id, { transport: channelTransport });
  channel.done.catch(() => {});
  const host = new McpClient({ name: "deletion-host", version: "1" });
  const incoming = [];
  host.setNotificationHandler(
    z.object({ method: z.literal("notifications/claude/channel"), params: z.object({ content: z.string() }).passthrough() }),
    (notification) => incoming.push(notification.params),
  );
  t.after(async () => { await channel.close(); await host.close(); });
  await host.connect(hostTransport);
  await waitFor(async () => !(await request("/api/topics")).some((topic) => topic.id === f.topic.id));
  await request(`/api/topics/${other.id}/messages`, { as: "human", to: f.agent.id, body: "请继续", requestId: "other-topic" });
  await waitFor(async () => (await request(`/api/topics/${other.id}/messages`)).messages[0].notified_at);
  assert.equal(incoming.length, 2);
  assert.equal((await request("/api/state")).bridges.length, 1);
});
