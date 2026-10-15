import test from "node:test";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { once } from "node:events";
import { WebSocket } from "ws";
import { startServer } from "../src/server.js";
import { Client } from "../src/client.js";

async function until(check) {
  const deadline = Date.now() + 5000;
  while (!check()) { if (Date.now() > deadline) throw new Error("event timeout"); await new Promise((r) => setTimeout(r, 10)); }
}
async function fixture(t) {
  const app = await startServer({ port: 0, mcpPort: 0, dbPath: ":memory:", codexAppOptions: { env: {} } });
  t.after(() => app.close());
  const client = new Client(app.url);
  const project = await client.request("/api/projects", { name: "Public" });
  const other = await client.request("/api/projects", { name: "Private" });
  const as = await client.request("/api/participants", { name: "Receiver", kind: "agent" });
  const topic = await client.request("/api/topics", { title: "Discussion", goal: "Test notifications", project: project.id });
  await client.request(`/api/topics/${topic.id}/members`, { as: as.id });
  const key = await client.request("/api/connectors", { name: "Receiver", as: as.id, project: project.id });
  const opened = [];
  t.after(() => { for (const ws of opened) ws.terminate(); });
  const url = app.mcpUrl.replace("http:", "ws:") + "/events";
  async function connect(token = key.token, options = {}) {
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` }, ...options });
    opened.push(ws);
    const events = [];
    ws.on("message", (data) => events.push(JSON.parse(data)));
    await once(ws, "open"); await until(() => events.length > 0);
    return { ws, events };
  }
  const post = (body, extra = {}) => client.request(`/api/topics/${topic.id}/messages`, { as: "human", requestId: randomUUID(), body, to: as.id, ...extra });
  return { app, client, project, other, as, topic, key, url, connect, post };
}

test("notification WebSocket replays directed mail, scopes projects and leaves read/ACK to MCP", async (t) => {
  const f = await fixture(t);
  const first = await f.post("private body should not appear in notification");
  const { ws, events } = await f.connect();
  await until(() => events.length === 2);
  assert.deepEqual(events[1], { type: "mailbox.message", version: 1, messageId: first.id,
    topicId: f.topic.id, participantId: f.as.id, projectId: f.project.id });
  const hidden = await f.client.request("/api/topics", { title: "Hidden", goal: "Private test", project: f.other.id });
  await f.client.request(`/api/topics/${hidden.id}/members`, { as: f.as.id });
  await f.client.request(`/api/topics/${hidden.id}/messages`, { as: "human", requestId: randomUUID(), to: f.as.id, body: "hidden" });
  await f.post("record only", { to: undefined });
  const second = await f.post("second");
  await until(() => events.length === 3);
  assert.equal(events[2].messageId, second.id);
  assert.equal((await f.client.request(`/api/inbox?as=${f.as.id}`)).notifications.find((m) => m.id === first.id).notified_at, null);
  ws.close(); await once(ws, "close");
  const replay = await f.connect(); await until(() => replay.events.length === 3);
  assert.deepEqual(replay.events.slice(1).map((e) => e.messageId), [first.id, second.id]);
  await f.client.request(`/api/topics/${f.topic.id}/ack`, { as: f.as.id, through: second.id });
  const fresh = await f.connect(); assert.equal(fresh.events.length, 1);
});

test("notification auth, origin and token revocation terminate access", async (t) => {
  const f = await fixture(t);
  for (const options of [{ headers: {} }, { headers: { Authorization: `Bearer ${f.key.token}`, Origin: "https://evil.invalid" } }]) {
    const ws = new WebSocket(f.url, options);
    const [error] = await once(ws, "error"); assert.match(error.message, /401|403/);
  }
  const active = await f.connect();
  const closed = once(active.ws, "close");
  await f.client.request(`/api/connectors/${f.key.id}`, undefined, "DELETE");
  // Admin revocation need not emit change; next mail triggers immediate revalidation.
  await f.post("after revocation");
  assert.equal((await closed)[0], 1008);
  assert.equal(active.events.length, 1);
});

test("paused and moved topics are withheld; reopening replays pending mail", async (t) => {
  const f = await fixture(t);
  await f.client.request(`/api/topics/${f.topic.id}`, { status: "paused" }, "PATCH");
  const message = await f.post("while paused");
  const connection = await f.connect();
  assert.equal(connection.events.length, 1);
  await f.client.request(`/api/topics/${f.topic.id}`, { project: f.other.id }, "PATCH");
  await f.client.request(`/api/topics/${f.topic.id}`, { status: "open" }, "PATCH");
  const hidden = await f.connect(); assert.equal(hidden.events.length, 1);
  await f.client.request(`/api/topics/${f.topic.id}`, { project: f.project.id }, "PATCH");
  await until(() => connection.events.length === 2);
  assert.equal(connection.events[1].messageId, message.id);
});
