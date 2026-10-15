import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startServer } from "../src/server.js";
import { Client } from "../src/client.js";

async function setup(t, options = {}) {
  const app = await startServer({ port: 0, dbPath: ":memory:", ...options });
  t.after(() => app.close());
  const client = new Client(app.url);
  const project = await client.request("/api/projects", { name: "Connector project" });
  const other = await client.request("/api/projects", { name: "Private project" });
  const participant = await client.request("/api/participants", { name: "Paperclip", kind: "agent" });
  const topic = await client.request("/api/topics", { title: "Review", goal: "Discuss the design", project: project.id });
  const hidden = await client.request("/api/topics", { title: "Private", goal: "Hidden goal", project: other.id });
  const credential = await client.request("/api/connectors", { name: "Paperclip", as: participant.id, project: project.id });
  async function connect(token = credential.token) {
    const host = new McpClient({ name: "third-party", version: "1" });
    await host.connect(new StreamableHTTPClientTransport(new URL(`${app.url}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }));
    t.after(() => host.close());
    return host;
  }
  const host = await connect();
  async function call(name, args = {}, target = host) {
    const result = await target.callTool({ name, arguments: args });
    assert.equal(result.isError, undefined, result.content?.[0]?.text);
    const data = JSON.parse(result.content[0].text);
    assert.deepEqual(result.structuredContent, data);
    return data;
  }
  return { app, client, project, other, participant, topic, hidden, credential, host, connect, call };
}

test("third-party HTTP MCP: discover, identity, join, send, deduplicate, read, reply and ACK", async (t) => {
  const f = await setup(t);
  const tools = (await f.host.listTools()).tools;
  assert.equal(tools.length, 10);
  assert.equal(tools.find((v) => v.name === "mailbox_read").annotations.readOnlyHint, true);
  assert.equal(tools.find((v) => v.name === "mailbox_ack").annotations.readOnlyHint, false);
  const identity = await f.call("mailbox_identity");
  assert.equal(identity.participant.id, f.participant.id);
  assert.equal(identity.project.id, f.project.id);
  assert.deepEqual((await f.call("mailbox_topics")).topics.map((v) => v.id), [f.topic.id]);
  await f.call("mailbox_join", { topic: f.topic.id });
  const incoming = await f.client.request(`/api/topics/${f.topic.id}/messages`, {
    as: "human", to: f.participant.id, body: "Please review", requestId: "incoming",
  });
  assert.equal((await f.call("mailbox_inbox")).notifications[0].id, incoming.id);
  const replyArgs = { topic: f.topic.id, message: incoming.id, body: "Reviewed", requestId: "reply-1", notify: true };
  const reply = await f.call("mailbox_reply", replyArgs);
  assert.equal(reply.author_id, f.participant.id);
  assert.equal(reply.reply_to, incoming.id);
  assert.equal(reply.to_id, "human");
  assert.equal((await f.call("mailbox_reply", replyArgs)).id, reply.id);
  const page = await f.call("mailbox_read", { topic: f.topic.id, limit: 1 });
  assert.equal(page.next, incoming.id);
  assert.equal(page.hasMore, true);
  assert.deepEqual((await f.call("mailbox_read", { topic: f.topic.id, after: page.next })).messages.map((m) => m.id), [reply.id]);
  assert.equal((await f.call("mailbox_inbox")).notifications.length, 1, "reading and replying must not auto-ACK");
  await f.call("mailbox_ack", { topic: f.topic.id, through: incoming.id });
  assert.equal((await f.call("mailbox_inbox")).notifications.length, 0);
  assert.equal((await f.client.request("/api/inbox?as=human")).notifications[0].id, reply.id, "one participant's ACK must not acknowledge the other");
  const created = await f.call("mailbox_create_topic", { title: "Follow-up", goal: "Next steps" });
  assert.equal(created.project_id, f.project.id);
  const posted = await f.call("mailbox_post", { topic: created.id, body: "Plan", requestId: "post-1" });
  assert.equal(posted.author_id, f.participant.id);
  const conflict = await f.host.callTool({ name: "mailbox_post", arguments: { topic: created.id, body: "Different", requestId: "post-1" } });
  assert.equal(conflict.isError, true);
  assert.match(conflict.content[0].text, /409/);
});

test("project isolation, identity spoofing, read-only grants, moved topics and token revocation", async (t) => {
  const f = await setup(t);
  await f.client.request(`/api/topics/${f.hidden.id}/members`, { as: f.participant.id });
  await f.client.request(`/api/topics/${f.hidden.id}/messages`, { as: "human", to: f.participant.id, body: "secret", requestId: "hidden" });
  assert.deepEqual(await f.call("mailbox_inbox"), { notifications: [], topics: [] });
  for (const name of ["mailbox_topic", "mailbox_read", "mailbox_join"]) {
    const denied = await f.host.callTool({ name, arguments: { topic: f.hidden.id } });
    assert.equal(denied.isError, true);
    assert.match(denied.content[0].text, /403/);
    assert.doesNotMatch(denied.content[0].text, /Hidden goal/);
  }
  const spoof = await f.host.callTool({ name: "mailbox_post", arguments: { topic: f.topic.id, body: "spoof", requestId: "spoof", as: "human" } });
  assert.equal(spoof.isError, true);
  assert.equal(f.app.store.read(f.topic.id).messages.length, 0);
  await assert.rejects(f.client.request("/api/connectors", { name: "bad", as: "human", project: f.project.id }), /400/);
  const ro = await f.client.request("/api/connectors", { name: "Read only", as: f.participant.id, project: f.project.id, readOnly: true });
  const readonly = await f.connect(ro.token);
  assert.equal((await readonly.listTools()).tools.every((v) => v.annotations.readOnlyHint), true);
  assert.equal((await f.call("mailbox_identity", {}, readonly)).readOnly, true);
  assert.equal((await readonly.callTool({ name: "mailbox_join", arguments: { topic: f.topic.id } })).isError, true);
  await f.client.request(`/api/topics/${f.topic.id}`, { project: f.other.id }, "PATCH");
  assert.deepEqual((await f.call("mailbox_topics")).topics, []);
  assert.equal((await f.host.callTool({ name: "mailbox_read", arguments: { topic: f.topic.id } })).isError, true);
  const listing = await f.client.request("/api/connectors");
  assert.equal(JSON.stringify(listing).includes(f.credential.token), false);
  assert.equal(JSON.stringify(listing).includes("token_hash"), false);
  const dbRow = f.app.store.db.prepare("SELECT token_hash FROM connectors WHERE id=?").get(f.credential.id);
  assert.notEqual(dbRow.token_hash, f.credential.token);
  assert.equal(dbRow.token_hash.length, 64);
  await f.client.request(`/api/connectors/${f.credential.id}`, undefined, "DELETE");
  await assert.rejects(f.host.listTools(), /无效或已撤销/);
  assert.equal((await f.call("mailbox_identity", {}, readonly)).participant.id, f.participant.id);
});

test("HTTP auth, origin, host, administrative boundaries and stateless transport", async (t) => {
  const f = await setup(t);
  const init = { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) };
  for (const authorization of [undefined, "Bearer invalid"]) {
    const response = await fetch(`${f.app.url}/mcp`, { ...init, headers: { ...init.headers, ...(authorization ? { authorization } : {}) } });
    assert.equal(response.status, 401);
    assert.match(response.headers.get("www-authenticate"), /Bearer/);
  }
  const headers = { ...init.headers, Authorization: `Bearer ${f.credential.token}` };
  assert.equal((await fetch(`${f.app.url}/mcp`, { ...init, headers: { ...headers, Origin: "https://evil.example" } })).status, 403);
  const badHostStatus = await new Promise((resolve, reject) => {
    const req = httpRequest(`${f.app.url}/mcp`, { method: "POST", headers: { ...headers, Host: "evil.example" } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on("error", reject);
    req.end(init.body);
  });
  assert.equal(badHostStatus, 403);
  assert.equal((await fetch(`${f.app.url}/api/state`, { headers })).status, 403);
  assert.equal((await fetch(`${f.app.url}/api/connectors`, { headers })).status, 403);
  assert.equal((await fetch(`${f.app.url}/mcp?token=${f.credential.token}`, init)).status, 401);
  const response = await fetch(`${f.app.url}/mcp`, { ...init, headers });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("mcp-session-id"), null);
  assert.equal((await response.json()).result.tools.length, 10);
});

test("credentials persist across restart and deleting a project removes its credentials", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mailbox-connector-"));
  const path = join(dir, "mailbox.db");
  let app = await startServer({ port: 0, dbPath: path });
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  let client = new Client(app.url);
  const project = await client.request("/api/projects", { name: "Durable" });
  const p = await client.request("/api/participants", { name: "Durable agent" });
  const c = await client.request("/api/connectors", { name: "Durable", as: p.id, project: project.id });
  await app.close();
  app = await startServer({ port: 0, dbPath: path });
  client = new Client(app.url);
  const host = new McpClient({ name: "restart", version: "1" });
  t.after(() => host.close());
  await host.connect(new StreamableHTTPClientTransport(new URL(`${app.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${c.token}` } } }));
  assert.equal((await host.listTools()).tools.length, 10);
  await client.request(`/api/projects/${project.id}`, undefined, "DELETE");
  await assert.rejects(host.listTools(), /无效或已撤销/);
});

test("dedicated MCP listener shares delivery state but never exposes administration", async (t) => {
  const f = await setup(t, { mcpPort: 0 });
  const endpoint = f.app.mcpUrl;
  assert.notEqual(new URL(endpoint).port, new URL(f.app.url).port);
  assert.equal((await f.client.request("/api/connectors/setup")).endpoint, endpoint);
  assert.equal((await fetch(endpoint)).status, 401);
  const headers = { Authorization: `Bearer ${f.credential.token}` };
  for (const path of ["/", "/api/state", "/api/connectors", "/api/participants"])
    assert.equal((await fetch(new URL(path, endpoint), { headers })).status, 404);
  assert.equal((await fetch(endpoint, { headers: { ...headers, Origin: "https://untrusted.example" } })).status, 403);
  const host = new McpClient({ name: "docker-equivalent", version: "1" });
  t.after(() => host.close());
  await host.connect(new StreamableHTTPClientTransport(new URL(endpoint), { requestInit: { headers } }));
  assert.equal((await host.listTools()).tools.length, 10);
  await f.call("mailbox_join", { topic: f.topic.id }, host);
  const message = await f.call("mailbox_post", { topic: f.topic.id, body: "From dedicated listener", requestId: "external-post", to: ["human"] }, host);
  assert.equal((await f.client.request("/api/inbox?as=human")).notifications[0].id, message.id);
  await f.client.request(`/api/connectors/${f.credential.id}`, undefined, "DELETE");
  assert.equal((await fetch(endpoint, { headers })).status, 401);
});

test("real CLI provisions paste-ready configuration, lists redacted credentials and revokes them", async (t) => {
  const f = await setup(t, { mcpPort: 0 });
  const run = async (...args) => JSON.parse((await promisify(execFile)(process.execPath,
    ["bin/mailbox.js", "--url", f.app.url, ...args], { cwd: new URL("..", import.meta.url) })).stdout);
  const created = await run("connector", "create", "--name", "CLI connector", "--as", f.participant.id, "--project", f.project.id, "--read-only");
  assert.equal(created.read_only, true);
  assert.equal(created.config.mcpServers["agent-mailbox"].url, f.app.mcpUrl);
  assert.equal(created.config.mcpServers["agent-mailbox"].headers.Authorization, `Bearer ${created.token}`);
  assert.equal(JSON.stringify(await run("connector", "list")).includes(created.token), false);
  const host = await f.connect(created.token);
  assert.equal((await host.listTools()).tools.length, 5);
  assert.deepEqual(await run("connector", "revoke", created.id), { id: created.id, revoked: true });
  await assert.rejects(host.listTools(), /无效或已撤销/);
});
