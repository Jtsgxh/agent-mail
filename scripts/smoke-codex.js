// Explicit integration smoke: uses the installed Codex login (one seed turn + two mailbox turns).
// A test thread is created in an empty temporary directory and archived afterwards.
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import net from "node:net";
import { once } from "node:events";
import { startServer } from "../src/server.js";
import { Client } from "../src/client.js";
import { CodexConnection, runCodexBridge } from "../src/codex.js";
import { listenNative } from "../src/native.js";

const entry = process.argv[2];
const native = process.argv.includes("--native");
if (!entry)
  throw new Error(
    "Usage: node scripts/smoke-codex.js ABSOLUTE_PATH_TO_CODEX_JS_OR_EXE",
  );
const dir = await mkdtemp(join(tmpdir(), "mailbox-live-"));
const reserve = net.createServer().listen(0, "127.0.0.1");
await once(reserve, "listening");
const port = reserve.address().port;
await new Promise((r) => reserve.close(r));
const args = ["app-server", "--listen", `ws://127.0.0.1:${port}`];
const child = entry.endsWith(".js")
  ? spawn(process.execPath, [resolve(entry), ...args], {
      cwd: dir,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    })
  : spawn(resolve(entry), args, {
      cwd: dir,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
let stderr = "";
child.stderr.on("data", (data) => {
  stderr += data.toString();
});
child.stdout.resume();
const stop = new AbortController();
let app, rpc, bridge, thread;
try {
  await new Promise((ok, fail) => {
    const timeout = setTimeout(
      () => fail(new Error("App Server startup timeout")),
      15000,
    );
    child.once("error", (e) => {
      clearTimeout(timeout);
      fail(e);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      fail(new Error(`App Server exited ${code}`));
    });
    const probe = () => {
      const socket = net.connect(port, "127.0.0.1");
      socket.once("connect", () => {
        socket.end();
        clearTimeout(timeout);
        ok();
      });
      socket.once("error", () => {
        if (child.exitCode === null) setTimeout(probe, 100);
      });
    };
    probe();
  });
  rpc = await new CodexConnection(`ws://127.0.0.1:${port}`).connect();
  const started = await rpc.call("thread/start", {
    cwd: dir,
    approvalPolicy: "never",
    sandbox: "read-only",
    baseInstructions:
      "This is a mailbox integration test. Do not use any tools. Reply briefly in Chinese, exactly as requested, using the supplied JSON schema. Do not ask for further responses.",
  });
  thread = started.thread.id;
  const seed = await rpc.call("turn/start", {
    threadId: thread,
    input: [
      { type: "text", text: "请只回答 ready，不要调用工具。这是测试初始化。" },
    ],
    effort: "low",
  });
  await rpc.until(() => rpc.completed.has(seed.turn.id), undefined, 180000);
  if (rpc.completed.get(seed.turn.id).status !== "completed")
    throw new Error("Seed turn failed");
  console.log(
    "REAL APP SERVER: test thread has completed its initial turn and is idle",
  );
  app = await startServer({ port: 0, dbPath: ":memory:" });
  const client = new Client(app.url);
  const a = await client.request("/api/participants", {
    name: "real-codex-smoke",
    kind: "codex",
  });
  const topic = await client.request("/api/topics", {
    title: "真实 Codex 唤醒验收",
    goal: "只验证收信、回复、再次空闲唤醒，不执行任何命令",
  });
  await client.request(`/api/topics/${topic.id}/members`, { as: a.id });
  bridge = native
    ? listenNative(client, a, {
        program: entry.endsWith(".js")
          ? { command: process.execPath, args: [resolve(entry)] }
          : { command: resolve(entry), args: [] },
        endpoint: `ws://127.0.0.1:${port}`,
        thread,
        signal: stop.signal,
      })
    : runCodexBridge(client, a.id, {
        endpoint: `ws://127.0.0.1:${port}`,
        thread,
        signal: stop.signal,
        maxTurns: 2,
      });
  let bridgeError;
  bridge.catch((e) => {
    bridgeError = e;
  });
  for (let i = 1; i <= 2; i++) {
    const previousTurns = rpc.completed.size;
    const m = await client.request(`/api/topics/${topic.id}/messages`, {
      as: "human",
      to: a.id,
      body: `这是第 ${i} 次唤醒测试。请只回复“第 ${i} 次收信成功”，notify=false。不要调用任何工具。`,
      requestId: `smoke-${i}`,
    });
    const deadline = Date.now() + (native ? 45000 : 180000);
    while (true) {
      if (bridgeError) throw bridgeError;
      const page = await client.request(`/api/topics/${topic.id}/messages`);
      const reply = page.messages.find((item) => item.reply_to === m.id);
      const pending = (await client.request(`/api/inbox?as=${a.id}`))
        .notifications;
      if (native && rpc.completed.size > previousTurns) {
        const last = [...rpc.completed.values()].at(-1);
        if (last.status !== "completed")
          throw new Error(`Native turn ${last.status}`);
        if (reply || !pending.some((item) => item.id === m.id))
          throw new Error(
            "Native notification unexpectedly posted a reply or acknowledged the message",
          );
        console.log(
          JSON.stringify({
            test: i,
            mode: "native",
            modelResponse: rpc.agentMessages.get(last.id),
            mailboxAutoAck: pending.length === 0,
          }),
        );
        break;
      }
      if (reply && pending.length === 0) {
        console.log(
          JSON.stringify({ test: i, reply: reply.body, acknowledged: true }),
        );
        break;
      }
      if (Date.now() > deadline)
        throw new Error(`Real model turn ${i} timed out`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  console.log(
    "PASS: two real model replies on the same thread, with idle between them",
  );
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  stop.abort(new Error("Smoke finished"));
  await bridge?.catch(() => {});
  if (thread && rpc && !rpc.dead)
    await rpc
      .call("thread/archive", { threadId: thread })
      .catch((e) => console.error("Test thread archive: " + e.message));
  rpc?.close();
  await app?.close();
  child.kill();
  await Promise.race([
    once(child, "exit").catch(() => {}),
    new Promise((r) => setTimeout(r, 3000)),
  ]);
  if (
    dirname(resolve(dir)) !== resolve(tmpdir()) ||
    !basename(dir).startsWith("mailbox-live-")
  ) {
    throw new Error("Refusing to remove an unexpected temporary directory");
  }
  await rm(dir, { recursive: true });
}
