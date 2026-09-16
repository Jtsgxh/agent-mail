import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { endianness, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "../src/client.js";
import { startServer } from "../src/server.js";
import {
  hashRouteCookie,
  removeRouteCookie,
  routeCookiesFor,
  saveRouteCookie,
} from "../src/route-cookies.js";

const exec = promisify(execFile);
const littleEndian = endianness() === "LE";
const cli = resolve("bin/mailbox.js");

function frame(value) {
  const body = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  if (littleEndian) header.writeUInt32LE(body.length);
  else header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

async function fakeApp(t, pipe, calls) {
  const connections = new Set();
  const server = net.createServer((socket) => {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
    socket.on("error", () => {});
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = littleEndian ? buffer.readUInt32LE() : buffer.readUInt32BE();
        if (buffer.length < length + 4) break;
        const request = JSON.parse(buffer.subarray(4, length + 4));
        buffer = buffer.subarray(length + 4);
        calls.push(request);
        let value;
        if (request.method === "tools/list") {
          value = {
            tools: [
              "list_projects", "create_thread", "send_message_to_thread",
              "list_threads", "create_sidebar_section", "move_thread_to_sidebar_section",
            ].map((name) => ({ namespace: "codex_app", name })),
          };
        } else {
          const tool = request.params.tool;
          let result;
          if (tool === "list_projects") result = { projects: [] };
          else if (tool === "list_threads")
            result = { sections: [{ sectionId: "mailbox", name: "Agent Mailbox", itemKeys: [] }] };
          else if (tool === "send_message_to_thread")
            result = { threadId: request.params.arguments.threadId };
          else throw new Error(`unexpected tool ${tool}`);
          value = {
            success: true,
            contentItems: [{ type: "inputText", text: JSON.stringify(result) }],
          };
        }
        socket.write(frame({ jsonrpc: "2.0", id: request.id, result: value }));
      }
    });
  });
  server.listen(pipe);
  await once(server, "listening");
  t.after(async () => {
    for (const connection of connections) connection.destroy();
    if (server.listening) await new Promise((resolveClose) => server.close(resolveClose));
  });
  return server;
}

async function until(check) {
  const end = Date.now() + 5000;
  while (!await check()) {
    if (Date.now() >= end) throw new Error("condition not reached");
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
}

test("concurrent CLI-style cookie updates do not lose unrelated routes", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mailbox-cookie-jar-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { MAILBOX_ROUTE_COOKIE_JAR: join(dir, "cookies.json") };
  const url = "http://127.0.0.1:4317";
  const routes = Array.from({ length: 24 }, (_, index) => ({
    participantId: `participant-${index}`,
    cookie: Buffer.alloc(32, index + 1).toString("base64url"),
  }));
  await Promise.all(routes.map((route) =>
    saveRouteCookie(url, route.participantId, route.cookie, { env })));
  const stored = await routeCookiesFor(url, { env });
  assert.deepEqual(
    stored.map((route) => route.participantId).sort(),
    routes.map((route) => route.participantId).sort(),
  );
  assert.equal(await removeRouteCookie(url, routes[0].participantId, { env }), true);
  assert.equal((await routeCookiesFor(url, { env })).length, routes.length - 1);
});

test("disconnect revokes the persisted route and removes its client cookie", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mailbox-cookie-disconnect-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const jarPath = join(dir, "cookies.json");
  const mailbox = await startServer({ port: 0, dbPath: ":memory:" });
  t.after(() => mailbox.close());
  const client = new Client(mailbox.url);
  const participant = await client.request("/api/participants", {
    name: "disconnect-cookie", kind: "codex",
  });
  const cookie = Buffer.alloc(32, 7).toString("base64url");
  mailbox.store.saveNotificationRoute(participant.id, {
    kind: "codex",
    nativeId: "cookie-task",
    cookieHash: hashRouteCookie(cookie),
    maxMessages: 20,
  });
  const env = { ...process.env, MAILBOX_ROUTE_COOKIE_JAR: jarPath };
  await saveRouteCookie(mailbox.url, participant.id, cookie, { env });
  const output = await exec(process.execPath, [
    cli, "--url", mailbox.url, "disconnect", "--as", participant.id,
  ], { env, windowsHide: true });
  assert.equal(JSON.parse(output.stdout).route_cookie_revoked, true);
  assert.equal(mailbox.store.notificationRoute(participant.id), null);
  assert.deepEqual(await routeCookiesFor(mailbox.url, { env }), []);
});

test("route cookie survives Mailbox restart and an ordinary CLI command resumes pending Codex delivery", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mailbox-cookie-route-"));
  const dbPath = join(dir, "mailbox.db");
  const jarPath = join(dir, "cookies.json");
  const pipeOne = process.platform === "win32"
    ? `\\\\.\\pipe\\mailbox-cookie-one-${randomUUID()}`
    : join(dir, "app-one.sock");
  const pipeTwo = process.platform === "win32"
    ? `\\\\.\\pipe\\mailbox-cookie-two-${randomUUID()}`
    : join(dir, "app-two.sock");
  const calls = [];
  const firstApp = await fakeApp(t, pipeOne, calls);
  let mailbox = await startServer({ port: 0, dbPath, codexAppOptions: { env: {} } });
  t.after(async () => {
    if (mailbox) await mailbox.close();
    await rm(dir, { recursive: true, force: true });
  });
  let client = new Client(mailbox.url);
  const topic = await client.request("/api/topics", { title: "cookie route", goal: "resume without rejoin" });
  const participant = await client.request("/api/participants", { name: "cookie-codex", kind: "codex" });
  await client.request(`/api/topics/${topic.id}/members`, { as: participant.id });
  const firstMessage = await client.request(`/api/topics/${topic.id}/messages`, {
    as: "human", to: participant.id, body: "first", requestId: randomUUID(),
  });
  const taskThread = randomUUID();
  const baseEnv = {
    ...process.env,
    MAILBOX_ROUTE_COOKIE_JAR: jarPath,
  };
  const joined = await exec(process.execPath, [
    cli, "--url", mailbox.url, "topic", "join", topic.id, "--as", participant.id,
  ], {
    env: { ...baseEnv, CODEX_THREAD_ID: taskThread, CODEX_APP_TOOLS_PIPE_PATH: pipeOne },
    windowsHide: true,
  });
  assert.equal(joined.stderr, "");
  assert.equal(JSON.parse(joined.stdout).notification.status, "ready");
  const jarText = await readFile(jarPath, "utf8");
  const cookie = JSON.parse(jarText).routes[0].cookie;
  assert.ok(cookie.length >= 40);
  assert.equal(joined.stdout.includes(cookie), false, "CLI output must hide the cookie");
  assert.equal(JSON.stringify(await client.request("/api/state")).includes(cookie), false);
  assert.equal(JSON.stringify(mailbox.store.notificationRoute(participant.id)).includes(cookie), false);
  await until(() => mailbox.store.message(firstMessage.id).notified_at);
  await client.request(`/api/topics/${topic.id}/ack`, { as: participant.id, through: firstMessage.id });

  const mailboxPort = Number(new URL(mailbox.url).port);
  await mailbox.close();
  mailbox = null;
  await new Promise((resolveClose) => firstApp.close(resolveClose));
  await fakeApp(t, pipeTwo, calls);
  mailbox = await startServer({ port: mailboxPort, dbPath, codexAppOptions: { env: {} } });
  client = new Client(mailbox.url);
  await client.request("/api/health").catch(() => client.request("/api/health"));
  assert.equal((await client.request("/api/state")).recipients[0].status, "waiting");
  const pending = await client.request(`/api/topics/${topic.id}/messages`, {
    as: "human", to: participant.id, body: "after restart", requestId: randomUUID(),
  });
  assert.equal(mailbox.store.message(pending.id).notified_at, null);

  const resumedByOrdinaryCommand = await exec(process.execPath, [
    cli, "--url", mailbox.url, "inbox", "--as", "human",
  ], {
    env: {
      ...baseEnv,
      CODEX_THREAD_ID: randomUUID(),
      CODEX_APP_TOOLS_PIPE_PATH: pipeTwo,
    },
    windowsHide: true,
  });
  assert.deepEqual(JSON.parse(resumedByOrdinaryCommand.stdout).notifications, []);
  assert.equal(resumedByOrdinaryCommand.stdout.includes(cookie), false);
  await until(() => mailbox.store.message(pending.id).notified_at);
  const sends = calls.filter((call) => call.params?.tool === "send_message_to_thread");
  assert.equal(sends.at(-1).params.threadId, taskThread);
  assert.equal(sends.at(-1).params.arguments.threadId, taskThread);

  const connected = await exec(process.execPath, [
    cli, "--url", mailbox.url, "codex", "app", "connect",
  ], {
    env: {
      ...baseEnv,
      CODEX_THREAD_ID: randomUUID(),
      CODEX_APP_TOOLS_PIPE_PATH: pipeTwo,
    },
    windowsHide: true,
  });
  assert.equal(JSON.parse(connected.stdout).resumed_routes, 0);
  assert.equal(calls.filter((call) => call.params?.tool === "send_message_to_thread").length, sends.length);
});
