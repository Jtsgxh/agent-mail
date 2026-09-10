import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { once } from "node:events";
import net from "node:net";
import { WebSocketServer } from "ws";
import { codexHost, codexHostStatus } from "../src/sessions.js";
import { startServer } from "../src/server.js";
import { Client } from "../src/client.js";

async function until(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Connection did not close");
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function fakeHost(t, behavior = "ready") {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  t.after(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise((r) => server.close(r));
  });
  const messages = [], headers = [];
  server.on("connection", (socket, request) => {
    headers.push(request.headers);
    socket.on("message", (raw) => {
      const message = JSON.parse(raw);
      messages.push(message);
      if (message.method !== "initialize") return;
      if (behavior === "silent") return;
      if (behavior === "invalid") return socket.send("not-json");
      socket.send(JSON.stringify({
        id: message.id,
        ...(behavior === "reject"
          ? { error: { code: 401, message: "denied private-test-token" } }
          : { result: { userAgent: "codex-test-host", platformFamily: "windows", platformOs: "windows" } }),
      }));
    });
  });
  return { server, messages, headers, endpoint: `ws://127.0.0.1:${server.address().port}` };
}

test("host status distinguishes absent and invalid config and follows the session config priority", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mailbox-host-status-"));
  t.after(async () => {
    assert.equal(dirname(dir), resolve(tmpdir()));
    assert.ok(basename(dir).startsWith("mailbox-host-status-"));
    await rm(dir, { recursive: true });
  });
  const configPath = join(dir, "codex-host.json");
  assert.equal((await codexHostStatus({ env: {}, configPath })).status, "unconfigured");
  await assert.rejects(codexHost({ env: {}, configPath }), /未配置/);
  await writeFile(configPath, '{"private-test-token":');
  const invalid = await codexHostStatus({ env: {}, configPath });
  assert.equal(invalid.status, "invalid_config");
  assert.ok(!JSON.stringify(invalid).includes("private-test-token"));
  const host = await fakeHost(t);
  const env = { MAILBOX_CODEX_ENDPOINT: host.endpoint };
  assert.equal((await codexHost({ env, configPath })).endpoint, host.endpoint);
  assert.equal((await codexHostStatus({ env, configPath })).status, "reachable");
  await writeFile(configPath, JSON.stringify({ endpoint: host.endpoint, agentBin: "unused" }));
  assert.equal((await codexHostStatus({ env: {}, configPath })).status, "reachable");
  await until(() => host.server.clients.size === 0);
});

test("host probes reject malformed, remote and credential-bearing addresses without exposing secrets", async () => {
  for (const endpoint of [
    "invalid-private-test-token", "https://localhost", "ws://example.com:4500",
    "ws://user:private-test-token@localhost:4500", "ws://localhost:4500/?token=private-test-token",
    "ws://localhost:4500/#private-test-token",
  ]) {
    const status = await codexHostStatus({ env: { MAILBOX_CODEX_ENDPOINT: endpoint } });
    assert.equal(status.status, "invalid_config");
    assert.equal(status.endpoint, null);
    assert.ok(!JSON.stringify(status).includes("private-test-token"));
  }
});

test("host probe performs only the authenticated initialize handshake and closes its connection", async (t) => {
  const host = await fakeHost(t);
  const status = await codexHostStatus({ env: {
    MAILBOX_CODEX_ENDPOINT: host.endpoint,
    MAILBOX_CODEX_TOKEN: "private-test-token",
  } });
  await until(() => host.server.clients.size === 0);
  assert.equal(status.status, "reachable");
  assert.equal(status.endpoint, host.endpoint + "/");
  assert.ok(Number.isFinite(Date.parse(status.checked_at)));
  assert.equal(host.headers[0].authorization, "Bearer private-test-token");
  assert.deepEqual(host.messages.map((message) => message.method), ["initialize", "initialized"]);
  assert.ok(!JSON.stringify(status).includes("private-test-token"));
});

for (const behavior of ["reject", "silent", "invalid"]) {
  test(`host probe reports ${behavior} protocol failure and releases the socket`, async (t) => {
    const host = await fakeHost(t, behavior);
    const status = await codexHostStatus({
      env: { MAILBOX_CODEX_ENDPOINT: host.endpoint, MAILBOX_CODEX_TOKEN: "private-test-token" },
      timeout: 100,
    });
    await until(() => host.server.clients.size === 0);
    assert.equal(status.status, "unreachable");
    assert.ok(status.error);
    assert.ok(!JSON.stringify(status).includes("private-test-token"));
    assert.deepEqual(host.messages.map((message) => message.method), ["initialize"]);
  });
}

test("a port accepting TCP without a WebSocket handshake is not reported as connected", async (t) => {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("data", () => {});
    socket.on("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((r) => server.close(r));
  });
  const status = await codexHostStatus({
    env: { MAILBOX_CODEX_ENDPOINT: `ws://127.0.0.1:${server.address().port}` },
    timeout: 100,
  });
  assert.equal(status.status, "unreachable");
  await until(() => sockets.size === 0);
});

test("HTTP host status is independent of mailbox data and rechecks host availability each time", async (t) => {
  const host = await fakeHost(t);
  const original = process.env.MAILBOX_CODEX_ENDPOINT;
  process.env.MAILBOX_CODEX_ENDPOINT = host.endpoint;
  t.after(() => {
    if (original === undefined) delete process.env.MAILBOX_CODEX_ENDPOINT;
    else process.env.MAILBOX_CODEX_ENDPOINT = original;
  });
  const app = await startServer({ port: 0, dbPath: ":memory:" });
  t.after(() => app.close());
  const client = new Client(app.url);
  const topic = await client.request("/api/topics", { title: "保留讨论", goal: "检查不改变讨论" });
  app.store.reserveSession(topic.id, { kind: "codex", as: "human", cwd: process.cwd() });
  const before = await client.request("/api/state");
  const session = app.store.session(topic.id, "codex");
  assert.equal((await client.request("/api/codex/status")).status, "reachable");
  await until(() => host.server.clients.size === 0);
  await new Promise((r) => host.server.close(r));
  assert.equal((await client.request("/api/codex/status")).status, "unreachable");
  assert.deepEqual(await client.request("/api/state"), before);
  assert.deepEqual(app.store.session(topic.id, "codex"), session);
});
