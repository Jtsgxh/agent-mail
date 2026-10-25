import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { startServer } from "../src/server.js";
import { Client } from "../src/client.js";
import { startPaperclipNotifier, validateNotifierConfig } from "../src/paperclip-notifier.js";

async function until(check) { const end = Date.now() + 7000;
  while (!check()) { if (Date.now() > end) throw new Error("notifier timeout"); await new Promise((r) => setTimeout(r, 10)); } }

test("durable notifier retries an uncertain Paperclip response with the same key; reconnect/restart do not create another task", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mailbox-notifier-"));
  const app = await startServer({ port: 0, mcpPort: 0, dbPath: ":memory:", codexAppOptions: { env: {} } });
  const client = new Client(app.url), services = [], calls = [], tasks = new Map();
  let loseResponse = true, rejectRun = false;
  const hook = createServer(async (req, res) => {
    const chunks = []; for await (const data of req) chunks.push(data);
    assert.equal(req.headers.authorization, "Bearer hook-secret");
    const payload = JSON.parse(Buffer.concat(chunks));
    const id = req.headers["idempotency-key"];
    calls.push({ id, payload });
    if (!tasks.has(id)) tasks.set(id, rejectRun ? { status: "failed", id: randomUUID(), linkedIssueId: null }
      : { status: "issue_created", id: randomUUID(), linkedIssueId: randomUUID() });
    if (loseResponse) { loseResponse = false; res.destroy(); return; }
    res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(tasks.get(id)));
  });
  await new Promise((r) => hook.listen(0, "127.0.0.1", r));
  t.after(async () => { for (const service of services) await service.close(); await app.close(); hook.closeAllConnections();
    await new Promise((r) => hook.close(r)); await rm(dir, { recursive: true }); });
  const project = await client.request("/api/projects", { name: "Project" });
  const as = await client.request("/api/participants", { name: "Receiver", kind: "agent" });
  const topic = await client.request("/api/topics", { title: "Review", goal: "Test dispatch", project: project.id });
  await client.request(`/api/topics/${topic.id}/members`, { as: as.id });
  const key = await client.request("/api/connectors", { name: "Key", as: as.id, project: project.id });
  const config = { mailboxUrl: app.mcpUrl, mailboxToken: key.token, projectId: project.id, participantId: as.id,
    paperclipWebhookUrl: `http://127.0.0.1:${hook.address().port}/api/routine-triggers/public/test/fire`, webhookSecret: "hook-secret", statePath: join(dir, "notifier.db") };
  const states = [];
  const start = async () => { const s = await startPaperclipNotifier(config, { retryMs: 20, onState: (e) => states.push(e) }); services.push(s); return s; };
  const service = await start(); await until(() => service.status().connected);
  const message = await client.request(`/api/topics/${topic.id}/messages`, { as: "human", requestId: randomUUID(), to: as.id, body: "Not sent to webhook" });
  await until(() => service.status().counts.some((s) => s.status === "submitted" && s.count === 1));
  assert.equal(calls.length, 2); assert.equal(tasks.size, 1); assert.equal(calls[0].id, calls[1].id);
  assert.equal(calls[0].payload.messageId, message.id); assert.equal(calls[0].payload.body, undefined);
  assert.equal((await client.request(`/api/inbox?as=${as.id}`)).notifications.length, 1);
  await service.close();
  // Mail arriving while the receiver is offline is replayed on the next connection.
  await client.request(`/api/topics/${topic.id}/messages`, { as: "human", requestId: randomUUID(), to: as.id, body: "offline" });
  const restarted = await start();
  await until(() => restarted.status().counts.some((s) => s.status === "submitted" && s.count === 2));
  assert.equal(tasks.size, 2); assert.equal(calls.length, 3);
  assert.ok(states.some((s) => s.type === "retry"));
  rejectRun = true;
  await client.request(`/api/topics/${topic.id}/messages`, { as: "human", requestId: randomUUID(), to: as.id, body: "must remain unacknowledged" });
  await until(() => restarted.status().counts.some((s) => s.status === "blocked" && s.count === 1));
  assert.equal(restarted.status().counts.find((s) => s.status === "submitted").count, 2);
  assert.equal((await client.request(`/api/inbox?as=${as.id}`)).notifications.length, 3);
  await assert.rejects(startPaperclipNotifier({ ...config, participantId: randomUUID() }), /another mailbox/);
  assert.throws(() => validateNotifierConfig({ ...config, mailboxUrl: "http://public.invalid/mcp" }), /HTTPS/);
  assert.throws(() => validateNotifierConfig({ ...config, mailboxUrl: "https://user:secret@example.org/mcp" }), /HTTPS/);
});

test("a revoked mailbox key ends the notifier so its supervisor can restart it, and close still releases state", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mailbox-notifier-revoke-"));
  const app = await startServer({ port: 0, mcpPort: 0, dbPath: ":memory:", codexAppOptions: { env: {} } });
  const client = new Client(app.url);
  t.after(async () => { await app.close(); await rm(dir, { recursive: true }); });
  const project = await client.request("/api/projects", { name: "Project" });
  const as = await client.request("/api/participants", { name: "Receiver", kind: "agent" });
  const topic = await client.request("/api/topics", { title: "Review", goal: "Revocation", project: project.id });
  await client.request(`/api/topics/${topic.id}/members`, { as: as.id });
  const key = await client.request("/api/connectors", { name: "Key", as: as.id, project: project.id });
  const service = await startPaperclipNotifier({ mailboxUrl: app.mcpUrl, mailboxToken: key.token, projectId: project.id,
    participantId: as.id, paperclipWebhookUrl: "http://127.0.0.1:9/api/routine-triggers/public/test/fire",
    webhookSecret: "hook-secret", statePath: join(dir, "notifier.db") }, { retryMs: 20 });
  await until(() => service.status().connected);
  await client.request(`/api/connectors/${key.id}`, undefined, "DELETE");
  // Any mailbox change makes the server revalidate the key at once instead of at the next heartbeat.
  await client.request(`/api/topics/${topic.id}/messages`, { as: "human", requestId: randomUUID(), body: "Revalidate authorization" });
  await assert.rejects(service.done, /authorization revoked/);
  await service.close();
});
