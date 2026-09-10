import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import net from "node:net";
import http from "node:http";
import { once } from "node:events";
import { startCodexHost } from "../scripts/start-codex.js";
import { codexHost, codexHostStatus } from "../src/sessions.js";
import { startServer } from "../src/server.js";
import { Client } from "../src/client.js";

async function until(predicate) {
  const end = Date.now() + 5000;
  while (!await predicate()) {
    assert.ok(Date.now() < end, "state did not settle");
    await new Promise((r) => setTimeout(r, 20));
  }
}
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}
async function fixture(t, mode = "ready") {
  const dir = await mkdtemp(join(tmpdir(), "mailbox-host-start-"));
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  const endpoint = `ws://127.0.0.1:${port}`;
  const entry = join(dir, "codex.mjs"), calls = join(dir, "calls.jsonl"), pidFile = join(dir, "pid");
  const configPath = join(dir, "codex-host.json");
  const ws = new URL("../node_modules/ws/wrapper.mjs", import.meta.url).href;
  await writeFile(entry, String.raw`
import http from 'node:http';
import {writeFileSync,appendFileSync} from 'node:fs';
import {WebSocketServer} from ${JSON.stringify(ws)};
const args=process.argv.slice(2);
if(args[0]!=='app-server') process.exit(99);
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
appendFileSync(${JSON.stringify(calls)},JSON.stringify({spawn:true, thread:process.env.CODEX_THREAD_ID??null, claude:process.env.CLAUDE_CODE_MESSAGING_TOKEN??null})+'\n');
if(${JSON.stringify(mode)}==='exit') process.exit(8);
const url=new URL(args[args.indexOf('--listen')+1]);
const server=http.createServer((req,res)=>{res.statusCode=${JSON.stringify(mode)}==='hang'?503:200;res.end('ready');});
const ws=new WebSocketServer({server});
ws.on('connection',socket=>socket.on('message',raw=>{
  const m=JSON.parse(raw); appendFileSync(${JSON.stringify(calls)},JSON.stringify(m)+'\n');
  if(m.method==='initialize') socket.send(JSON.stringify({id:m.id,result:{userAgent:'test'}}));
}));
server.listen(Number(url.port),url.hostname);
`);
  const before = JSON.stringify({ endpoint, agentBin: entry, keep: "unchanged" });
  await writeFile(configPath, before);
  t.after(async () => {
    const log = await readFile(join(dir, "codex-app-server.log"), "utf8").catch(() => "");
    if (log.trim()) t.diagnostic(log);
    const pid = Number(await readFile(pidFile, "utf8").catch(() => "0"));
    if (pid && alive(pid)) process.kill(pid);
    if (pid) await until(() => !alive(pid));
    assert.equal(dirname(dir), resolve(tmpdir()));
    assert.ok(basename(dir).startsWith("mailbox-host-start-"));
    await rm(dir, { recursive: true });
  });
  return { dir, endpoint, entry, calls, pidFile, configPath, before,
    options: { configPath, env: { ...process.env, MAILBOX_CODEX_ENDPOINT: "", MAILBOX_CODEX_BIN: "", CODEX_THREAD_ID: "parent", CLAUDE_CODE_MESSAGING_TOKEN: "parent-secret" }, probeTimeout: 200, timeout: 1500 } };
}

test("HTTP start coalesces clicks, verifies protocol, saves the session default and reuses the host", async (t) => {
  const f = await fixture(t);
  const app = await startServer({ port: 0, dbPath: ":memory:", codexHostOptions: f.options });
  let closed = false;
  t.after(async () => { if (!closed) await app.close(); });
  const client = new Client(app.url);
  const before = await client.request("/api/state");
  const results = await Promise.all([client.request("/api/codex/host/start", {}), client.request("/api/codex/host/start", {})]);
  assert.equal(results[0].status, "reachable");
  assert.equal(results[0].pid, results[1].pid);
  assert.equal(results[0].reused, false);
  assert.equal((await codexHost({ env: {}, configPath: f.configPath })).endpoint, f.endpoint + "/");
  assert.equal(JSON.parse(await readFile(f.configPath, "utf8")).keep, "unchanged");
  assert.equal((await client.request("/api/codex/host/status")).status, "reachable");
  assert.equal((await client.request("/api/codex/host/start", {})).reused, true);
  assert.deepEqual(await client.request("/api/state"), before);
  const calls = (await readFile(f.calls, "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(calls.filter((c) => c.spawn), [{ spawn: true, thread: null, claude: null }]);
  assert.ok(calls.filter((c) => !c.spawn).every((c) => ["initialize", "initialized"].includes(c.method)));
  await app.close(); closed = true;
  assert.equal((await codexHostStatus(f.options)).status, "reachable", "successful shared host survives mailbox shutdown");
});

test("occupied non-Codex port is not replaced and the configuration is unchanged", async (t) => {
  const f = await fixture(t);
  const server = http.createServer((req, res) => res.end("unrelated"));
  server.listen(Number(new URL(f.endpoint).port), "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((r) => { server.close(r); server.closeAllConnections(); }));
  const app = await startServer({ port: 0, dbPath: ":memory:", codexHostOptions: f.options });
  t.after(() => app.close());
  await assert.rejects(new Client(app.url).request("/api/codex/host/start", {}), /502:.*端口已有服务/);
  assert.equal(await readFile(f.configPath, "utf8"), f.before);
  await assert.rejects(readFile(f.pidFile), { code: "ENOENT" });
  assert.equal((await fetch(f.endpoint.replace("ws:", "http:"))).status, 200);
});

for (const mode of ["exit", "hang"])
  test(`failed startup ${mode} releases its child and does not save readiness`, async (t) => {
    const f = await fixture(t, mode);
    await assert.rejects(startCodexHost({ ...f.options, timeout: 200 }), /退出|超时/);
    assert.equal(await readFile(f.configPath, "utf8"), f.before);
    const pid = Number(await readFile(f.pidFile, "utf8"));
    await until(() => !alive(pid));
  });

test("mailbox shutdown cancels unfinished host startup and releases only that child", async (t) => {
  const f = await fixture(t, "hang");
  const app = await startServer({ port: 0, dbPath: ":memory:", codexHostOptions: f.options });
  let closed = false;
  t.after(async () => { if (!closed) await app.close(); });
  const request = new Client(app.url).request("/api/codex/host/start", {}).catch((e) => e);
  await until(async () => !!(await readFile(f.pidFile, "utf8").catch(() => "")));
  assert.equal((await new Client(app.url).request("/api/codex/host/status")).status, "starting");
  await app.close(); closed = true;
  assert.ok(await request instanceof Error);
  assert.equal(await readFile(f.configPath, "utf8"), f.before);
  const pid = Number(await readFile(f.pidFile, "utf8"));
  await until(() => !alive(pid));
});

test("invalid configuration fails before spawning and never exposes credentials", async (t) => {
  const f = await fixture(t);
  for (const config of [
    '{"endpoint":"ws://user:private-test-token@127.0.0.1:4500"}', '{"endpoint":""}', '{}',
  ]) {
    await writeFile(f.configPath, config);
    await assert.rejects(startCodexHost(f.options), (error) => !error.message.includes("private-test-token") && /地址/.test(error.message));
    assert.equal(await readFile(f.configPath, "utf8"), config);
  }
  await assert.rejects(readFile(f.pidFile), { code: "ENOENT" });
});

test("first launch without configuration saves the explicitly selected port and CLI", async (t) => {
  const f = await fixture(t);
  await rm(f.configPath);
  const result = await startCodexHost({ ...f.options, port: new URL(f.endpoint).port, agentBin: f.entry });
  assert.equal(result.status, "reachable");
  assert.equal(result.endpoint, f.endpoint + "/");
  assert.equal((await codexHost({ env: {}, configPath: f.configPath })).agentBin, f.entry);
});
