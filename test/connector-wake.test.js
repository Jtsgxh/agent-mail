import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { startServer } from "../src/server.js";
import { Client } from "../src/client.js";
import { startConnectorWake, connectProjectMailbox } from "../src/connector-wake.js";
import { connectorUrls, subscribeConnectorEvents } from "../src/connector-subscription.js";
import { wakeHost } from "../src/wake-hosts.js";

const cli = fileURLToPath(new URL("../bin/mailbox-connector-wake.js", import.meta.url));

async function until(check) {
  const end = Date.now() + 6000;
  while (!check()) { if (Date.now() > end) throw new Error("wake timeout"); await new Promise((r) => setTimeout(r, 10)); }
}

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "mailbox-connector-wake-"));
  const app = await startServer({ port: 0, mcpPort: 0, dbPath: ":memory:", codexAppOptions: { env: {} } });
  const client = new Client(app.url), services = [];
  t.after(async () => { for (const service of services) await service.close(); await app.close(); await rm(dir, { recursive: true }); });
  const project = await client.request("/api/projects", { name: "Wake project" });
  const participant = await client.request("/api/participants", { name: "GPT", kind: "agent" });
  const topic = await client.request("/api/topics", { title: "Untrusted title", goal: "Wake test", project: project.id });
  await client.request(`/api/topics/${topic.id}/members`, { as: participant.id });
  const key = await client.request("/api/connectors", { name: "GPT", as: participant.id, project: project.id });
  const config = { url: app.mcpUrl, authorization: `Bearer ${key.token}`, topic: topic.id, thread: randomUUID(), statePath: join(dir, "wake.db") };
  const calls = [], states = [];
  const start = async (changes = {}, wake = async (text) => { calls.push(text); }) => {
    const service = await startConnectorWake({ ...config, ...changes }, { wake, retryDelays: [10], wakeRetryDelays: [10, 10], onState: (s) => states.push(s) });
    services.push(service); return service;
  };
  const post = (body, extra = {}) => client.request(`/api/topics/${topic.id}/messages`, { as: "human", body, to: participant.id, requestId: randomUUID(), ...extra });
  return { app, client, project, participant, topic, key, config, calls, states, start, post };
}

test("project connector wakes for directed mail, preserves identity and does not ACK; restart deduplicates replay", async (t) => {
  const f = await fixture(t);
  const service = await f.start();
  assert.equal(service.status().connected, true);
  assert.equal(service.status().participant.id, f.participant.id);
  const first = await f.post("REMOTE BODY MUST NOT ENTER QUEUE");
  await until(() => f.calls.length === 1 && service.status().counts.some((c) => c.status === "submitted"));
  assert.match(f.calls[0], new RegExp(`消息 #${first.id}`));
  assert.equal(f.calls[0].includes("REMOTE BODY"), false);
  assert.equal(f.calls[0].includes("Untrusted title"), false);
  assert.equal(f.calls[0].includes(f.key.token), false);
  assert.equal((await f.client.request(`/api/inbox?as=${f.participant.id}`)).notifications.length, 1);
  await service.close();
  const restarted = await f.start();
  const second = await f.post("Second directed message");
  await until(() => f.calls.length === 2 && restarted.status().counts.some((c) => c.count === 2));
  assert.match(f.calls[1], new RegExp(`消息 #${second.id}`));
  assert.equal((await f.client.request(`/api/inbox?as=${f.participant.id}`)).notifications.length, 2);
});

test("only the selected open topic and explicitly directed messages wake the conversation", async (t) => {
  const f = await fixture(t);
  const service = await f.start();
  await f.post("record only", { to: undefined });
  const other = await f.client.request("/api/topics", { title: "Other", goal: "Outside selected topic", project: f.project.id });
  await f.client.request(`/api/topics/${other.id}/members`, { as: f.participant.id });
  await f.client.request(`/api/topics/${other.id}/messages`, { as: "human", body: "Other topic", to: f.participant.id, requestId: randomUUID() });
  await f.client.request(`/api/topics/${f.topic.id}`, { status: "paused" }, "PATCH");
  await f.post("Deferred while paused");
  // A scoped read completes after the writes; no queue invocation should have occurred.
  const mcp = await connectProjectMailbox(f.config);
  try { await mcp.call("mailbox_inbox"); } finally { await mcp.close(); }
  assert.equal(f.calls.length, 0);
  await f.client.request(`/api/topics/${f.topic.id}`, { status: "open" }, "PATCH");
  await until(() => f.calls.length === 1 && service.status().counts.some((c) => c.status === "submitted"));
});

test("an uncertain queue result is durable and never blindly retried after restart", async (t) => {
  const f = await fixture(t);
  let attempts = 0;
  const service = await f.start({}, async () => { attempts++; throw new Error("Queue result uncertain"); });
  await f.post("Needs attention");
  await service.done;
  assert.match(service.status().error, /uncertain/);
  await service.close();
  await assert.rejects(f.start(), /earlier wake submission is uncertain/);
  assert.equal(attempts, 1);
});

test("a wake that provably never reached the chat is retried, then stays deliverable after restart", async (t) => {
  const f = await fixture(t);
  const unreachable = () => Object.assign(new Error("inbox unreachable"), { retryableNotification: true });
  let attempts = 0;
  const service = await f.start({}, async (text) => { if (++attempts < 3) throw unreachable(); f.calls.push(text); });
  await f.post("Arrives after two refused connections");
  await until(() => f.calls.length === 1 && service.status().counts.some((c) => c.status === "submitted"));
  assert.equal(attempts, 3);
  await service.close();
  const gone = await f.start({}, async () => { throw unreachable(); });
  await f.post("The chat has gone away");
  await gone.done;
  assert.match(gone.status().error, /unreachable/);
  await gone.close();
  const back = await f.start();
  await until(() => f.calls.length === 2 && back.status().counts.some((c) => c.status === "submitted" && c.count === 2));
});

test("event subscription stops on a rejected key or a foreign identity instead of retrying", async (t) => {
  const f = await fixture(t);
  const { events } = connectorUrls(f.config.url);
  const subscribe = (changes) => subscribeConnectorEvents({ url: events, authorization: f.config.authorization,
    participantId: f.participant.id, projectId: f.project.id, signal: AbortSignal.timeout(5000), retryDelay: () => 10,
    onMessage() {}, ...changes });
  await assert.rejects(subscribe({ authorization: `Bearer amb_${"x".repeat(43)}` }), /rejected connection \(401\)/);
  await assert.rejects(subscribe({ participantId: randomUUID() }), /scope does not match/);
  assert.throws(() => connectorUrls("http://public.invalid/mcp"), /HTTPS/);
});

test("duplicate receivers, changed conversation bindings and revoked tokens fail explicitly", async (t) => {
  const f = await fixture(t);
  const service = await f.start();
  await assert.rejects(f.start(), /live receiver/);
  await assert.rejects(f.start({ thread: randomUUID() }), /another project, identity, topic or conversation/);
  await f.client.request(`/api/connectors/${f.key.id}`, undefined, "DELETE");
  await f.post("Revalidate authorization");
  await service.done;
  assert.match(service.status().error, /authorization revoked/);
  assert.equal(f.calls.length, 0);
});

test("queue limits stop delivery without acknowledging unseen messages", async (t) => {
  const f = await fixture(t);
  const service = await f.start({ maxMessages: 1 });
  await f.post("First");
  await until(() => f.calls.length === 1 && service.status().counts.some((c) => c.status === "submitted"));
  await f.post("Second");
  await service.done;
  assert.match(service.status().error, /limit reached/);
  assert.equal(f.calls.length, 1);
  assert.equal((await f.client.request(`/api/inbox?as=${f.participant.id}`)).notifications.length, 2);
});

test("actual background CLI reports ready, survives its parent and exposes no credential", async (t) => {
  const f = await fixture(t);
  const cliDir = await mkdtemp(join(tmpdir(), "mailbox-wake-cli-"));
  const agentBin = join(cliDir, "codex.cjs");
  const statePath = join(cliDir, "cli.db");
  await writeFile(agentBin, `if(process.argv[2]==='mcp') console.log(${JSON.stringify(JSON.stringify({
    enabled: true, transport: { type: "streamable_http", url: f.config.url, http_headers: { Authorization: f.config.authorization } },
  }))});\n`);
  let pid;
  t.after(async () => {
    if (pid) { try { process.kill(pid); } catch {} }
    await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
    await rm(cliDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  const args = [cli, "--connection", "agent-mailbox", "--agent-bin", agentBin, "--state-path", statePath];
  const run = (extra) => promisify(execFile)(process.execPath, [...args, ...extra], {
    windowsHide: true, timeout: 15000, env: { ...process.env, CODEX_THREAD_ID: f.config.thread },
  });
  const { stdout } = await run(["--topic", f.topic.id, "--background"]);
  const ready = JSON.parse(stdout);
  pid = ready.pid;
  assert.equal(ready.type, "ready");
  assert.equal(ready.connected, true);
  assert.equal(stdout.includes(f.key.token), false);
  const status = JSON.parse((await run(["--status"])).stdout);
  assert.equal(status.processAlive, true);
  assert.equal(status.connected, true);
  await f.post("Exercise real child notification handler");
  await until(() => {
    // Read only the child's durable status, without opening a second receiver.
    const db = new DatabaseSync(statePath, { readOnly: true });
    try { return db.prepare("SELECT status FROM wake_messages").get()?.status === "submitted"; }
    finally { db.close(); }
  });
  const identity = JSON.parse((await run(["--call", "mailbox_identity"])).stdout);
  assert.equal(identity.participant.id, f.participant.id);
});

test("Claude host uses its own MCP config and wakes the session through its native inbox", async (t) => {
  const f = await fixture(t);
  const dir = await mkdtemp(join(tmpdir(), "mailbox-wake-claude-"));
  const project = join(dir, "project");
  await mkdir(project);
  // Local scope for the launch directory wins over user scope, as in Claude Code.
  await writeFile(join(dir, ".claude.json"), JSON.stringify({
    mcpServers: { "agent-mailbox": { type: "http", url: "https://user-scope.invalid/mcp", headers: { Authorization: `Bearer amb_${"u".repeat(43)}` } },
      "stdio-only": { type: "stdio", command: "mailbox-mcp" } },
    projects: { [project]: { mcpServers: { "agent-mailbox": { type: "http", url: f.config.url, headers: { authorization: f.config.authorization } } } } },
  }));
  const address = process.platform === "win32" ? `\\\\.\\pipe\\mailbox-wake-${randomUUID()}` : join(dir, "inbox.sock");
  const frames = [];
  const inbox = net.createServer((c) => {
    let data = "";
    c.on("data", (d) => (data += d));
    c.on("end", () => { frames.push(...data.trim().split("\n").map(JSON.parse)); c.end(); });
  });
  inbox.listen(address);
  await once(inbox, "listening");
  const env = { ...process.env, CLAUDE_CONFIG_DIR: dir, CLAUDE_CODE_SESSION_ID: f.config.thread,
    CLAUDE_CODE_MESSAGING_SOCKET: address, CLAUDE_CODE_MESSAGING_TOKEN: "test-only-secret" };
  await assert.rejects(wakeHost("claude", { env, cwd: project }).connection("stdio-only"), /HTTP MCP connection is required/);
  assert.throws(() => wakeHost("other"), /codex or claude/);
  const statePath = join(dir, "claude.db");
  let pid;
  t.after(async () => {
    if (pid) { try { process.kill(pid); } catch {} }
    await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
    await new Promise((r) => inbox.close(r));
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  const run = (extra) => promisify(execFile)(process.execPath, [cli, "--host", "claude", "--state-path", statePath, ...extra], {
    cwd: project, windowsHide: true, timeout: 15000, env,
  });
  const { stdout } = await run(["--topic", f.topic.id, "--background"]);
  const ready = JSON.parse(stdout);
  pid = ready.pid;
  assert.equal(ready.host, "claude");
  assert.equal(ready.connected, true);
  assert.equal(stdout.includes(f.key.token), false);
  const message = await f.post("BODY STAYS ON MCP");
  await until(() => frames.length === 2);
  assert.deepEqual(frames[0], { type: "auth", token: "test-only-secret" });
  assert.match(frames[1].message.content, new RegExp(`消息 #${message.id}`));
  assert.match(frames[1].message.content, /--host claude/);
  assert.equal(frames[1].message.content.includes("BODY STAYS"), false);
  const status = JSON.parse((await run(["--status"])).stdout);
  assert.equal(status.host, "claude");
  assert.equal(status.processAlive, true);
  await run(["--test-wake"]);
  await until(() => frames.length === 4);
  assert.match(frames[3].message.content, /本机唤醒自检/);
  const identity = JSON.parse((await run(["--call", "mailbox_identity"])).stdout);
  assert.equal(identity.participant.id, f.participant.id);
});
