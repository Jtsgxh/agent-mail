import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { endianness, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { CodexApp, appRequest, projectTarget } from "../src/codex-app.js";
import { startServer } from "../src/server.js";
import { Client } from "../src/client.js";
import { createCodexSession } from "../src/sessions.js";
import { sessionNotification, NativeRecipients } from "../src/notifications.js";

const exec = promisify(execFile);
const le = endianness() === "LE";
const encode = (value) => {
  const body = Buffer.from(JSON.stringify(value)), header = Buffer.alloc(4);
  if (le) header.writeUInt32LE(body.length); else header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
};
const result = (value) => ({ success: true, contentItems: [{ type: "inputText", text: JSON.stringify(value) }] });
async function until(check) {
  const end = Date.now() + 5000;
  while (!await check()) {
    if (Date.now() > end) throw new Error("condition not reached");
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function fixture(t, mode = "join") {
  const cookieDir = await mkdtemp(join(tmpdir(), "mailbox-route-cookies-"));
  const pipe = process.platform === "win32" ? `\\\\.\\pipe\\mailbox-app-test-${randomUUID()}` : join(tmpdir(), `mailbox-app-${randomUUID()}.sock`);
  const caller = randomUUID(), nativeId = randomUUID(), clientId = randomUUID();
  const calls = [], connections = new Set(), jobs = [];
  const sections = [];
  let client, topic, joinError;
  const fake = net.createServer((socket) => {
    connections.add(socket); socket.on("close", () => connections.delete(socket));
    socket.on("error", () => {});
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = le ? buffer.readUInt32LE() : buffer.readUInt32BE();
        if (buffer.length < length + 4) break;
        const request = JSON.parse(buffer.subarray(4, length + 4));
        buffer = buffer.subarray(length + 4);
        calls.push(request);
        jobs.push(handle(request, socket).catch((error) => { joinError = error; socket.destroy(); }));
      }
    });
  });
  const send = (socket, request, value) => {
    const bytes = encode({ jsonrpc: "2.0", id: request.id, result: value });
    socket.write(bytes.subarray(0, 2)); // Deliberately split both header and UTF-8 payload.
    socket.write(bytes.subarray(2, 9));
    socket.write(bytes.subarray(9));
  };
  const handle = async (request, socket) => {
    if (request.method === "tools/cancel") return;
    if (request.method === "tools/list") return send(socket, request, { tools: ["list_projects", "create_thread", "send_message_to_thread", "list_threads", "create_sidebar_section", "move_thread_to_sidebar_section"].map((name) => ({ name, namespace: "codex_app" })) });
    const p = request.params;
    assert.ok(p.threadId === caller || (p.threadId === nativeId && ["list_projects", "send_message_to_thread", "list_threads", "move_thread_to_sidebar_section"].includes(p.tool)));
    assert.match(p.callId, /^mcp-call-/);
    assert.match(p.turnId, /^mcp-turn-/);
    if (p.tool === "list_projects") return send(socket, request, result({ projects: [{ projectKind: "local", hostId: "local", projectId: "saved-project", path: process.cwd(), isGitRepository: false }] }));
    if (p.tool === "send_message_to_thread") return send(socket, request, result({ threadId: mode === "wrong-delivery" ? "other" : p.arguments.threadId }));
    if (p.tool === "list_threads") return send(socket, request, result(mode === "no-sections" ? {} : { sections }));
    if (p.tool === "create_sidebar_section") {
      const section = { sectionId: randomUUID(), name: p.arguments.name, itemKeys: [] };
      sections.push(section);
      return send(socket, request, result(section));
    }
    if (p.tool === "move_thread_to_sidebar_section") {
      assert.equal(p.arguments.threadId, nativeId);
      if (mode === "sidebar-fail") return send(socket, request, { success: false, contentItems: [] });
      const section = sections.find((s) => s.sectionId === p.arguments.sectionId);
      assert.ok(section);
      section.itemKeys.push(`codex:thread:local:${nativeId}`);
      return send(socket, request, result(p.arguments));
    }
    assert.equal(p.tool, "create_thread");
    assert.deepEqual(p.arguments.target, { type: "project", projectId: "saved-project", environment: { type: "local" } });
    assert.equal(p.arguments.model, undefined);
    if (mode === "hang") return;
    if (mode === "failed-turn") return send(socket, request, result({ hostId: "local", conversationId: nativeId, status: "created", firstTurn: { status: "failed" } }));
    if (mode === "caller") return send(socket, request, result({ hostId: "local", threadId: caller }));
    const response = { hostId: "local", ...(mode === "pending" ? { clientThreadId: clientId } : { threadId: nativeId }) };
    if (mode !== "early-join") send(socket, request, result(response));
    if (mode === "nojoin") return;
    const line = p.arguments.prompt.split("\n").find((line) => line.startsWith("1. 首先"));
    const argv = JSON.parse(line.slice(line.indexOf("[")));
    assert.equal(argv.includes("--endpoint"), false);
    const env = {
      ...process.env,
      CODEX_THREAD_ID: nativeId,
      CODEX_APP_TOOLS_PIPE_PATH: pipe,
      MAILBOX_ROUTE_COOKIE_JAR: join(cookieDir, "cookies.json"),
    };
    if (mode === "sidebar-fail") {
      await assert.rejects(exec(argv[0], argv.slice(1), { env, windowsHide: true }), /Codex App 未确认/);
      return;
    }
    const joined = JSON.parse((await exec(argv[0], argv.slice(1), { env, windowsHide: true })).stdout);
    assert.equal(joined.notification.status, "ready");
    if (mode === "early-join") send(socket, request, result(response));
  };
  fake.listen(pipe); await once(fake, "listening");
  const env = {
    CODEX_APP_TOOLS_PIPE_PATH: pipe,
    CODEX_THREAD_ID: caller,
    MAILBOX_ROUTE_COOKIE_JAR: join(cookieDir, "cookies.json"),
  };
  const app = await startServer({ port: 0, dbPath: ":memory:", codexAppOptions: { env } });
  client = new Client(app.url);
  topic = await client.request("/api/topics", { title: "App 复用测试", goal: "仅测试连接" });
  t.after(async () => {
    await app.close();
    for (const connection of connections) connection.destroy();
    await new Promise((r) => fake.close(r));
    await Promise.allSettled(jobs);
    await rm(cookieDir, { recursive: true, force: true });
    if (joinError) throw joinError;
  });
  return { app, client, topic, nativeId, caller, clientId, calls, env, pipe, sections,
    options: { topic: topic.id, cwd: process.cwd(), as: "human", timeout: 2 } };
}

test("App readiness verifies tools and caller, exposes no pipe and changes no mailbox data", async (t) => {
  const f = await fixture(t);
  const before = await f.client.request("/api/state");
  const status = await f.client.request("/api/codex/status");
  assert.equal(status.status, "reachable");
  assert.equal(status.transport, "desktop-app");
  assert.equal(JSON.stringify(status).includes(f.pipe), false);
  assert.equal(JSON.stringify(status).includes(f.caller), false);
  assert.deepEqual(await f.client.request("/api/state"), before);
  assert.deepEqual(f.calls.map((call) => call.method === "tools/list" ? call.method : call.params.tool), ["tools/list", "list_projects"]);
  await assert.rejects(f.client.request("/api/codex/start", {}), /404/);
});

test("missing App registration never falls back to configured WS host", async () => {
  const app = new CodexApp({ env: { MAILBOX_CODEX_ENDPOINT: "ws://127.0.0.1:4500" } });
  assert.equal((await app.status()).status, "unconfigured");
  await assert.rejects(app.projects(), /codex app connect/);
});

for (const mode of ["join", "early-join", "pending"])
  test(`App create ${mode}: own registration binds the final ID and later mail targets only the new task`, async (t) => {
    const f = await fixture(t, mode);
    const session = await createCodexSession(f.client, f.options);
    assert.equal(session.transport, "desktop-app");
    assert.equal(session.native_id, f.nativeId);
    assert.equal(session.launch_ref, mode === "pending" ? f.clientId : null);
    assert.equal(session.launch_status, "submitted");
    assert.equal(session.notification.status, "ready");
    assert.ok(f.sections.some((section) => section.name === "Agent Mailbox" && section.itemKeys.includes(`codex:thread:local:${f.nativeId}`)));
    const placement = f.calls.find((call) => call.params?.tool === "move_thread_to_sidebar_section");
    assert.equal(placement.params.threadId, f.nativeId, "the new App task registers its own sidebar entry");
    assert.equal(placement.params.arguments.threadId, f.nativeId);
    assert.equal(f.calls.filter((call) => call.params?.tool === "create_sidebar_section").length, 1);
    const message = await f.client.request(`/api/topics/${f.topic.id}/messages`, { as: "human", to: session.participant_id, body: "后续问题", requestId: randomUUID() });
    await until(() => f.app.store.read(f.topic.id).messages[0]?.notified_at);
    const sent = f.calls.find((call) => call.params?.tool === "send_message_to_thread");
    assert.equal(sent.params.arguments.threadId, f.nativeId);
    assert.ok(sent.params.arguments.prompt.includes(String(message.id)));
    assert.equal(f.app.store.read(f.topic.id).messages[0].ack_at, null);
    await assert.rejects(f.client.request(`/api/topics/${f.topic.id}/members`, { as: session.participant_id, notification: { thread: f.caller } }), /调用任务/);
    await assert.rejects(f.client.request(`/api/topics/${f.topic.id}/members`, { as: session.participant_id, notification: { thread: randomUUID() } }), /不能更换/);
    await assert.rejects(createCodexSession(f.client, f.options), /已有/);
    assert.equal(f.calls.filter((call) => call.params?.tool === "create_thread").length, 1);
  });

test("Claude-side CLI needs no App environment and still uses server's connected App", async (t) => {
  const f = await fixture(t);
  const env = { ...process.env, MAILBOX_CODEX_ENDPOINT: "ws://127.0.0.1:1" };
  delete env.CODEX_APP_TOOLS_PIPE_PATH; delete env.CODEX_THREAD_ID;
  const output = await exec(process.execPath, [resolve("bin/mailbox.js"), "--url", f.app.url, "session", "create", "codex", "--topic", f.topic.id, "--cwd", process.cwd(), "--as", "human", "--timeout", "3"], { env, windowsHide: true });
  assert.equal(JSON.parse(output.stdout).native_id, f.nativeId);
});

for (const mode of ["failed-turn", "caller", "nojoin"])
  test(`App create ${mode}: failure retains one record and cannot become false readiness`, async (t) => {
    const f = await fixture(t, mode);
    await assert.rejects(createCodexSession(f.client, { ...f.options, timeout: 1 }));
    const session = await f.client.request(`/api/topics/${f.topic.id}/sessions/codex`);
    assert.equal(session.notification, null);
    assert.equal(session.launch_status, mode === "nojoin" ? "submitted" : "uncertain");
    assert.notEqual(session.native_id, f.caller);
    if (mode === "failed-turn") assert.equal(session.native_id, f.nativeId);
    await assert.rejects(createCodexSession(f.client, f.options), /已有/);
    assert.equal(f.calls.filter((call) => call.params?.tool === "create_thread").length, 1);
  });

test("concurrent launch, abort and topic deletion never recreate a task or resurrect deleted rows", async (t) => {
  const f = await fixture(t, "hang");
  const pending = f.client.request(`/api/topics/${f.topic.id}/sessions/codex/launch`, { as: "human", cwd: process.cwd() }).catch((error) => error);
  await until(() => f.calls.some((call) => call.params?.tool === "create_thread"));
  await assert.rejects(f.client.request(`/api/topics/${f.topic.id}/sessions/codex/launch`, { as: "human", cwd: process.cwd() }), /409/);
  await f.client.request(`/api/topics/${f.topic.id}`, undefined, "DELETE");
  assert.ok(await pending instanceof Error);
  await until(() => f.calls.some((call) => call.method === "tools/cancel"));
  assert.equal(f.app.store.db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n, 0);
  assert.equal(f.calls.filter((call) => call.params?.tool === "create_thread").length, 1);
});

test("delivery acknowledgement must name the bound new task", async (t) => {
  const f = await fixture(t, "wrong-delivery");
  const session = await createCodexSession(f.client, f.options);
  await f.client.request(`/api/topics/${f.topic.id}/messages`, { as: "human", to: session.participant_id, body: "test", requestId: randomUUID() });
  await until(() => f.app.store.read(f.topic.id).messages[0]?.recipients[0]?.error);
  assert.equal(f.app.store.read(f.topic.id).messages[0].notified_at, null);
});

test("project mapping uses longest real project ancestor, respects boundary and Git worktree default", () => {
  const root = resolve("."), nested = join(root, "nested");
  const projects = [root, nested].map((path, i) => ({ path, projectId: String(i), projectKind: "local", hostId: "local", isGitRepository: i === 1 }));
  assert.deepEqual(projectTarget(projects, join(nested, "src")), { type: "project", projectId: "1", environment: { type: "worktree" } });
  assert.equal(projectTarget(projects, root).environment.type, "local");
  assert.throws(() => projectTarget(projects, root + "-outside"), /添加为 Codex App 项目/);
});

test("non-local App addresses and unsupported tool methods are rejected", async (t) => {
  const f = await fixture(t);
  assert.throws(() => appRequest({ pipe: "https://remote", threadId: f.caller }, "tools/list", {}), /本机管道/);
  await assert.rejects(new CodexApp({ env: f.env }).call("archive_anything", {}), /不支持/);
});

test("concurrent setup creates one group and reuses App's existing placement", async (t) => {
  const f = await fixture(t);
  const app = new CodexApp({ env: f.env });
  const [one, two] = await Promise.all([app.prepareSidebar(), app.prepareSidebar()]);
  assert.equal(one.sectionId, two.sectionId);
  assert.equal(f.calls.filter((call) => call.params?.tool === "create_sidebar_section").length, 1);
  f.sections.push({ sectionId: "user-chosen", name: "My tasks", itemKeys: [`codex:thread:local:${f.nativeId}`] });
  assert.equal((await app.showInSidebar(f.nativeId)).sectionId, "user-chosen");
  assert.equal(f.calls.some((call) => call.params?.tool === "move_thread_to_sidebar_section"), false);
});

test("missing sidebar support fails before creating a task or reserving an identity", async (t) => {
  const f = await fixture(t, "no-sections");
  await assert.rejects(createCodexSession(f.client, f.options), /侧栏分组信息/);
  assert.equal(f.app.store.session(f.topic.id, "codex"), null);
  assert.equal(f.calls.some((call) => call.params?.tool === "create_thread"), false);
});

test("sidebar placement failure cannot report a newly joined task as ready", async (t) => {
  const f = await fixture(t, "sidebar-fail");
  await assert.rejects(createCodexSession(f.client, { ...f.options, timeout: 1 }), /尚未确认加入/);
  const session = await f.client.request(`/api/topics/${f.topic.id}/sessions/codex`);
  assert.equal(session.native_id, f.nativeId);
  assert.equal(session.notification, null);
  await assert.rejects(createCodexSession(f.client, f.options), /已有/);
});

test("joining without a prepared group fails explicitly and never creates duplicate groups", async (t) => {
  const f = await fixture(t);
  const app = new CodexApp({ env: f.env });
  await assert.rejects(app.showInSidebar(f.nativeId), /codex app connect/);
  assert.equal(f.calls.some((call) => call.params?.tool === "create_sidebar_section"), false);
});

test("an existing desktop task joins an unconfigured server without a session record and receives pending mail via App", async (t) => {
  const f = await fixture(t);
  // Match a mailbox started from an ordinary terminal, outside the desktop App.
  const server = await startServer({ port: 0, dbPath: ":memory:", codexAppOptions: { env: {} } });
  t.after(() => server.close());
  const client = new Client(server.url);
  const topic = await client.request("/api/topics", { title: "existing task", goal: "direct desktop join" });
  const p = await client.request("/api/participants", { name: "existing-desktop", kind: "codex" });
  await client.request(`/api/topics/${topic.id}/members`, { as: p.id });
  const message = await client.request(`/api/topics/${topic.id}/messages`, { as: "human", to: p.id, body: "pending review", requestId: randomUUID() });
  const env = {
    ...process.env,
    CODEX_THREAD_ID: f.nativeId,
    CODEX_APP_TOOLS_PIPE_PATH: f.pipe,
    MAILBOX_ROUTE_COOKIE_JAR: f.env.MAILBOX_ROUTE_COOKIE_JAR,
  };
  const args = [resolve("bin/mailbox.js"), "--url", server.url, "topic", "join", topic.id, "--as", p.id];
  const joined = JSON.parse((await exec(process.execPath, args, { env, windowsHide: true })).stdout);
  assert.equal(joined.notification.status, "ready");
  await until(() => server.store.read(topic.id).messages[0]?.notified_at);
  assert.equal(server.store.session(topic.id, "codex"), null);
  const sends = () => f.calls.filter((call) => call.params?.tool === "send_message_to_thread");
  assert.equal(sends().length, 1);
  assert.equal(sends()[0].params.threadId, f.nativeId);
  assert.equal(sends()[0].params.arguments.threadId, f.nativeId);
  assert.ok(sends()[0].params.arguments.prompt.includes(`消息 #${message.id}`));
  assert.equal(server.store.read(topic.id).messages[0].ack_at, null);
  assert.equal(f.calls.some((call) => call.params?.tool === "create_thread"), false);
  await exec(process.execPath, args, { env, windowsHide: true });
  assert.equal(sends().length, 1, "rejoining never repeats a submitted notification");
  for (const output of [joined, await client.request("/api/state")]) {
    assert.equal(JSON.stringify(output).includes(f.pipe), false);
    assert.equal(JSON.stringify(output).includes(f.nativeId), false);
  }
  const other = sessionNotification(p, {}, { CODEX_THREAD_ID: f.caller, CODEX_APP_TOOLS_PIPE_PATH: f.pipe });
  await assert.rejects(client.request(`/api/topics/${topic.id}/members`, { as: p.id, notification: other }), /另一入口/);
});

test("desktop detection honors an explicit WS endpoint and rejects thread impersonation", () => {
  const env = { CODEX_THREAD_ID: "own", CODEX_APP_TOOLS_PIPE_PATH: "own-pipe", MAILBOX_CODEX_TOKEN: "unused-secret" };
  assert.deepEqual(sessionNotification({ kind: "codex" }, {}, env), {
    thread: "own", app: { pipe: "own-pipe", threadId: "own" }, maxMessages: undefined,
  });
  assert.throws(() => sessionNotification({ kind: "codex" }, { thread: "other" }, env), /自身登记/);
  const native = sessionNotification({ kind: "codex" }, { endpoint: "ws://127.0.0.1:4500", thread: "explicit" }, env);
  assert.equal(native.app, undefined);
  assert.equal(native.endpoint, "ws://127.0.0.1:4500");
  assert.equal(native.thread, "explicit");
  assert.equal(sessionNotification({ kind: "codex" }, { manual: true }, env), undefined);
});

test("invalid desktop registration cannot silently fall back to CLI or bind a recipient", async (t) => {
  const f = await fixture(t);
  const p = await f.client.request("/api/participants", { name: "invalid-desktop", kind: "codex" });
  const member = `/api/topics/${f.topic.id}/members`;
  for (const notification of [
    { thread: f.nativeId, app: { pipe: f.pipe, threadId: f.caller } },
    { thread: f.nativeId, app: { pipe: "https://not-local", threadId: f.nativeId } },
    { thread: f.nativeId, endpoint: "ws://127.0.0.1:4500", app: { pipe: f.pipe, threadId: f.nativeId } },
  ]) await assert.rejects(f.client.request(member, { as: p.id, notification }), /409/);
  assert.equal((await f.client.request("/api/state")).recipients.length, 0);
});

test("a failed CLI route can recover only to the same task's verified desktop entry", async (t) => {
  const f = await fixture(t);
  const p = f.app.store.createParticipant({ name: "recover", kind: "codex" });
  const recipients = new NativeRecipients(f.app.store, () => f.app.url, () => {}, new CodexApp({ env: f.env }));
  t.after(() => recipients.close());
  const oldTarget = { kind: "codex", thread: f.nativeId, token: null, maxMessages: 20 };
  recipients.join(f.topic.id, p.id, oldTarget);
  const target = await recipients.prepare(p, { thread: f.nativeId, app: { pipe: f.pipe, threadId: f.nativeId } });
  assert.throws(() => recipients.join(f.topic.id, p.id, target), /另一入口/);
  recipients.routes.get(p.id).status = "error";
  assert.throws(() => recipients.join(f.topic.id, p.id, { ...target, thread: f.caller }), /另一入口/);
  recipients.join(f.topic.id, p.id, target);
  assert.equal(recipients.routes.get(p.id).target.transport, "desktop-app");
  assert.equal(recipients.status()[0].status, "ready");
});
