import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { NativeRecipients } from "../src/notifications.js";
import { nativeConnectFailure } from "../src/notification-recovery.js";
import { appRequest } from "../src/codex-app.js";
import { writeClaude } from "../src/native.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check) {
  const deadline = Date.now() + 2000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("recovery did not converge");
    await sleep(5);
  }
}
function fixture(t, delays = [20, 40]) {
  const store = new Store(":memory:");
  const participant = store.createParticipant({ name: "recovery", kind: "codex" });
  const topic = store.createTopic({ title: "recovery", goal: "same task owns its endpoint" });
  const alive = new Set(["old-pipe", "new-pipe"]), calls = [];
  let rejectSend;
  const app = {
    async probe(context) {
      if (!alive.has(context?.pipe)) throw nativeConnectFailure("endpoint absent", { code: "ENOENT" }, false);
    },
    async send(thread, text, { context }) {
      calls.push({ thread, text, pipe: context.pipe });
      if (rejectSend) throw rejectSend;
      await this.probe(context);
    },
  };
  const recipients = new NativeRecipients(store, () => "http://test", () => recipients.dispatch(), app, { retryDelays: delays });
  t.after(async () => { await recipients.close(); store.close(); });
  const prepare = (pipe = "old-pipe", thread = "own-task") => recipients.prepare(participant, { thread, app: { pipe, threadId: thread } });
  const register = async (pipe, thread) => {
    const target = await prepare(pipe, thread);
    recipients.join(topic.id, participant.id, target);
    recipients.dispatch();
  };
  const post = () => {
    const message = store.post(topic.id, { as: "human", to: participant.id, body: "review", requestId: randomUUID() });
    recipients.dispatch();
    return message;
  };
  return { store, participant, topic, alive, calls, recipients, prepare, register, post,
    failWith: (error) => { rejectSend = error; },
    route: () => recipients.routes.get(participant.id),
    delivery: (id) => store.message(id).recipients[0] };
}

test("verified same-task rejoin replaces a failed desktop pipe and resumes unacknowledged mail", async (t) => {
  const f = fixture(t, []);
  await f.register();
  const acknowledged = f.post();
  await until(() => !!f.delivery(acknowledged.id).notified_at && !f.route().task);
  f.store.ack(f.topic.id, f.participant.id, acknowledged.id);
  f.alive.delete("old-pipe");
  const pending = f.post();
  await until(() => f.route().status === "error" && !f.route().task);
  const other = await f.prepare("new-pipe", "other-task");
  assert.throws(() => f.recipients.join(f.topic.id, f.participant.id, other), /另一入口/);
  await f.register("new-pipe");
  await until(() => !!f.delivery(pending.id).notified_at && !f.route().task);
  assert.equal(f.route().status, "ready");
  assert.equal(f.delivery(pending.id).error, null);
  assert.equal(f.calls.filter((call) => call.pipe === "new-pipe").length, 1);
  await f.register("new-pipe");
  await sleep(30);
  assert.equal(f.calls.length, 3, "healthy repeated join must not replay submitted notifications");
});

test("rejoin probes a ready old pipe before replacement and refuses a live or unverified replacement", async (t) => {
  const f = fixture(t);
  await f.register();
  await until(() => !f.route().task);
  await assert.rejects(f.register("new-pipe"), /另一入口/);
  const old = f.route();
  f.alive.delete("old-pipe");
  await assert.rejects(f.register("missing-pipe"), /endpoint absent/);
  assert.equal(f.route(), old);
  const prepared = await f.prepare("new-pipe");
  assert.throws(() => f.recipients.join(f.topic.id, f.participant.id, { ...prepared }), /另一入口/);
  f.recipients.join(f.topic.id, f.participant.id, prepared);
  assert.equal(f.route().target.app.pipe, "new-pipe");
});

test("an in-flight delivery is never replaced by a second endpoint", async (t) => {
  const f = fixture(t);
  await f.register();
  await until(() => !f.route().task);
  f.route().status = "error";
  const original = f.route();
  original.task = Promise.resolve();
  await assert.rejects(f.register("new-pipe"), /另一入口/);
  assert.equal(f.route(), original);
  original.task = null;
});

test("a pipe coming back at the same address automatically receives the pending message", async (t) => {
  const f = fixture(t);
  await f.register();
  await until(() => !f.route().task);
  f.alive.delete("old-pipe");
  const message = f.post();
  await until(() => f.route().status === "retrying");
  assert.equal(f.route().retryCount, 1);
  assert.ok(f.recipients.status()[0].retry_at);
  f.alive.add("old-pipe");
  await until(() => !!f.delivery(message.id).notified_at);
  assert.equal(f.calls.length, 2);
  assert.equal(f.route().retryCount, 0);
  assert.equal(f.route().error, null);
});

test("retry budget is finite and restarting a retry does not bypass the delivery limit", async (t) => {
  const f = fixture(t);
  await f.register();
  await until(() => !f.route().task);
  f.alive.delete("old-pipe");
  const message = f.post();
  await until(() => f.route().status === "error" && !f.route().task);
  assert.equal(f.calls.length, 3);
  assert.equal(f.delivery(message.id).notified_at, null);
  await sleep(80);
  assert.equal(f.calls.length, 3);
  f.alive.add("old-pipe");
  await f.register();
  await until(() => !!f.delivery(message.id).notified_at && !f.route().task);
  f.route().target.maxMessages = 1;
  f.post();
  await until(() => f.route().status === "error");
  assert.match(f.route().error, /上限/);
  assert.equal(f.calls.length, 4, "maxMessages must be checked before contacting the endpoint");
});

test("ambiguous failures are not automatically retried", async (t) => {
  const f = fixture(t);
  await f.register();
  f.failWith(new Error("connection closed after request was sent"));
  f.post();
  await until(() => f.route().status === "error");
  await sleep(100);
  assert.equal(f.calls.length, 1);
});

test("pausing, removing a recipient, and shutting down stop retry delivery", async (t) => {
  for (const action of ["pause", "remove", "close"]) {
    await t.test(action, async (t) => {
      const f = fixture(t, [80]);
      await f.register();
      f.alive.delete("old-pipe");
      f.post();
      await until(() => f.route().status === "retrying" && !f.route().task);
      if (action === "pause") f.store.setStatus(f.topic.id, "paused");
      else if (action === "remove") await f.recipients.remove(f.participant.id);
      else await f.recipients.close();
      await sleep(130);
      assert.equal(f.calls.length, 1);
    });
  }
});

const address = () => process.platform === "win32"
  ? `\\\\.\\pipe\\mailbox-recovery-${randomUUID()}` : join(tmpdir(), `mailbox-recovery-${randomUUID()}.sock`);

test("native IPC failures are retryable only before writing a request", async (t) => {
  await assert.rejects(appRequest({ pipe: address(), threadId: "own" }, "tools/list", {}), (e) => e.retryableNotification === true);
  await assert.rejects(writeClaude({ socket: address(), token: "test-token", text: "test" }), (e) => e.retryableNotification === true);
  const pipe = address();
  const server = net.createServer((socket) => socket.once("data", () => socket.destroy()));
  server.listen(pipe);
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await assert.rejects(appRequest({ pipe, threadId: "own" }, "tools/list", {}), (e) => !e.retryableNotification);
  assert.equal(nativeConnectFailure("later failure", { code: "ENOENT" }, true).retryableNotification, undefined);
  assert.equal(nativeConnectFailure("permission denied", { code: "EACCES" }, false).retryableNotification, undefined);
});
