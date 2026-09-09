import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { join, resolve, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { startServer } from "../src/server.js";
import { Client } from "../src/client.js";
import { agentCommand, claudeLaunch, connectMailbox } from "../src/connect.js";
import { CodexConnection } from "../src/codex.js";

const exec = promisify(execFile);
async function temporary(t) {
  const dir = await mkdtemp(join(tmpdir(), "mailbox-connect-"));
  t.after(async () => {
    assert.equal(dirname(dir), resolve(tmpdir()));
    assert.ok(basename(dir).startsWith("mailbox-connect-"));
    await rm(dir, { recursive: true });
  });
  return dir;
}
async function fixture(t) {
  const app = await startServer({ port: 0, dbPath: ":memory:" });
  t.after(() => app.close());
  const client = new Client(app.url);
  const codex = await client.request("/api/participants", {
    name: "codex 简单接入",
    kind: "codex",
  });
  const claude = await client.request("/api/participants", {
    name: "claude-existing",
    kind: "claude",
  });
  return { app, client, codex, claude };
}
async function fakeCodex(t) {
  const dir = await temporary(t);
  const script = join(dir, "fake-codex.mjs");
  await writeFile(
    script,
    `
import {createInterface} from 'node:readline';
const send = x => process.stdout.write(JSON.stringify(x)+'\\n');
createInterface({input:process.stdin}).on('line', line => {
  const r=JSON.parse(line); if(r.id===undefined)return;
  if(r.method==='initialize') send({id:r.id,result:{userAgent:'fixture'}});
  else if(r.method==='thread/list') send({id:r.id,result:{data:[{id:'existing-1',preview:'已有讨论',cwd:process.cwd(),status:{type:'notLoaded'}}],nextCursor:null}});
  else if(r.method==='thread/resume')send({id:r.id,result:{thread:{id:'existing-1',status:{type:'idle'}}}});
  else if(r.method==='turn/start'){
    const turn={id:'t1',status:'completed',items:[],error:null};
    send({id:r.id,result:{turn:{...turn,status:'inProgress'}}});
    send({method:'item/completed',params:{threadId:'existing-1',turnId:'t1',item:{type:'agentMessage',text:JSON.stringify({body:'通过一条命令收到来信',notify:false})}}});
    send({method:'turn/completed',params:{threadId:'existing-1',turn}});
  } else send({id:r.id,error:{code:-32601,message:'Unexpected method '+r.method}});
});
`,
  );
  return script;
}

test("connect resolves participant names, preserves identities, and previews without changing state", async (t) => {
  const f = await fixture(t);
  const before = await f.client.request("/api/state");
  const preview = await connectMailbox(f.client, {
    as: f.codex.name,
    preview: true,
  });
  assert.equal(preview.participant.id, f.codex.id);
  assert.equal(preview.mode, "local-stdio");
  assert.deepEqual(await f.client.request("/api/state"), before);
  await assert.rejects(
    connectMailbox(f.client, {
      kind: "claude",
      as: f.codex.name,
      preview: true,
    }),
    /类型一致/,
  );
  await assert.rejects(
    connectMailbox(f.client, { as: "missing", preview: true }),
    /唯一/,
  );
});

test("Claude launch passes inline MCP config as one argv value and preserves resume and permissions", () => {
  const plan = claudeLaunch(
    { command: "C:/Program Files/Claude/claude.exe", args: [] },
    {
      as: "actor-id",
      url: "http://127.0.0.1:4317",
      cwd: "E:/Project With Spaces",
      thread: "existing-id",
    },
  );
  const config = JSON.parse(plan.args[plan.args.indexOf("--mcp-config") + 1]);
  assert.equal(plan.args.at(-2), "--resume");
  assert.equal(plan.args.at(-1), "existing-id");
  assert.equal(
    config.mcpServers.mailbox.args[
      config.mcpServers.mailbox.args.indexOf("--as") + 1
    ],
    "actor-id",
  );
  assert.ok(plan.args.includes("server:mailbox"));
  assert.ok(!plan.args.includes("--strict-mcp-config"));
  assert.ok(!plan.args.includes("--dangerously-skip-permissions"));
  assert.equal(plan.cwd, "E:/Project With Spaces");
});

test("Windows npm shims resolve to direct executables without shell evaluation or path escape", async (t) => {
  const dir = await temporary(t);
  const binDir = join(dir, "spaces & names", "node_modules", "agent", "bin");
  await mkdir(binDir, { recursive: true });
  const entry = join(binDir, "cli.js");
  await writeFile(entry, "");
  const shimDir = resolve(binDir, "../../..");
  await writeFile(
    join(shimDir, "codex.cmd"),
    '"%dp0%\\node_modules\\agent\\bin\\cli.js" %*',
  );
  const result = await agentCommand("codex", {
    searchPath: shimDir,
    platform: "win32",
  });
  assert.deepEqual(result, { command: process.execPath, args: [entry] });
  await writeFile(
    join(shimDir, "codex.cmd"),
    '"%dp0%\\node_modules\\..\\outside.exe" %*',
  );
  await assert.rejects(
    agentCommand("codex", { searchPath: shimDir, platform: "win32" }),
    /无效/,
  );
});

test("actual connect CLI lists existing Codex sessions using an owned stdio server then exits", async (t) => {
  const f = await fixture(t);
  const script = await fakeCodex(t);
  const { stdout } = await exec(
    process.execPath,
    [
      resolve("bin/mailbox.js"),
      "--url",
      f.app.url,
      "connect",
      "codex",
      "--as",
      f.codex.name,
      "--agent-bin",
      script,
      "--list",
    ],
    { timeout: 10000 },
  );
  const result = JSON.parse(stdout);
  assert.equal(result.participant.id, f.codex.id);
  assert.equal(result.threads[0].id, "existing-1");
  assert.equal((await f.client.request("/api/state")).bridges.length, 0);
});

test("connect picker selects an existing session and completes notification, reply and acknowledgement", async (t) => {
  const f = await fixture(t);
  const script = await fakeCodex(t);
  const topic = await f.client.request("/api/topics", {
    title: "连接验收",
    goal: "只选名称和会话",
  });
  await f.client.request(`/api/topics/${topic.id}/members`, { as: f.codex.id });
  await f.client.request(`/api/topics/${topic.id}/messages`, {
    as: "human",
    to: f.codex.id,
    body: "请回复",
    requestId: "connect-test",
  });
  const controller = new AbortController();
  let choices = 0;
  const run = connectMailbox(
    f.client,
    { kind: "codex", agentBin: script, signal: controller.signal },
    async (label, items) => {
      choices++;
      return items[0].value;
    },
  ).catch((error) => {
    if (!controller.signal.aborted) throw error;
  });
  t.after(async () => {
    controller.abort();
    await run;
  });
  const deadline = Date.now() + 5000;
  while (
    (await f.client.request(`/api/inbox?as=${f.codex.id}`)).notifications.length
  ) {
    if (Date.now() > deadline) throw new Error("connect did not reply");
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(choices, 2);
  const messages = (await f.client.request(`/api/topics/${topic.id}/messages`))
    .messages;
  assert.equal(messages[1].body, "通过一条命令收到来信");
});

test("owned Codex process is stopped when initialize is rejected", async (t) => {
  const dir = await temporary(t);
  const file = join(dir, "reject.mjs");
  await writeFile(
    file,
    `import {createInterface} from 'node:readline';createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);process.stdout.write(JSON.stringify({id:r.id,error:{code:-1,message:'Rejected initialization'}})+'\\n')});`,
  );
  const rpc = new CodexConnection(undefined, undefined, {
    command: process.execPath,
    args: [file],
    cwd: dir,
  });
  await assert.rejects(rpc.connect(), /Rejected initialization/);
  await rpc.close();
  assert.notEqual(rpc.child.exitCode, null);
});
