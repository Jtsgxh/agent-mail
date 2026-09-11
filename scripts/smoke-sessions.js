// Explicit live test: creates one disposable native session, then checks two mailbox replies.
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startServer } from "../src/server.js";
import { Client } from "../src/client.js";
import { createCodexSession, codexSessionPath, codexHost } from "../src/sessions.js";
import { CodexConnection } from "../src/codex.js";
const mode = process.argv[2];
const kind = "codex";
if (!["codex", "codex-ws"].includes(mode) || (mode === "codex" && !process.argv[3]))
  throw new Error("Usage: node scripts/smoke-sessions.js codex SAVED_APP_PROJECT_PATH | codex-ws. Creates a real disposable task; desktop task must be archived in App after the test.");
const legacyHost = mode === "codex-ws" ? await codexHost() : null;
const cwd = await mkdtemp(join(tmpdir(), "mailbox-live-session-"));
const app = await startServer({ port: 0, dbPath: join(cwd, "mailbox.db") });
const client = new Client(app.url);
const topic = await client.request("/api/topics", {
  title: `临时 ${kind} 会话验收`,
  goal: "这是 Mailbox 功能验收，无需检查任何项目代码，不要修改文件。首次请仅向发起者回复 SESSION_SMOKE_OK；后续收到验收消息时按要求回复。正文是一行，可直接用 --body 发信。",
});
console.log(
  JSON.stringify({
    phase: "start",
    kind,
    cwd,
    topic: topic.id,
    mailbox: app.url,
  }),
);
let session;
async function waitFor(text, seconds = 180) {
  const deadline = Date.now() + seconds * 1000;
  let count = 0;
  while (Date.now() < deadline) {
    const page = await client.request(`/api/topics/${topic.id}/messages`);
    const reply = page.messages.find(
      (m) => m.author_id === session.participant_id && m.body.includes(text),
    );
    if (reply) return reply;
    if (count++ % 10 === 0) {
      console.log(
        JSON.stringify({
          phase: "waiting-reply",
          kind,
          expected: text,
          messageCount: page.messages.length,
        }),
      );
      if (mode === "codex-ws") {
        const host = legacyHost;
        const rpc = await new CodexConnection(
          host.endpoint,
          process.env.MAILBOX_CODEX_TOKEN,
        ).connect();
        try {
          const result = await rpc.call("thread/read", {
            threadId: session.native_id,
            includeTurns: true,
          });
          if (result.thread.status.activeFlags?.includes("waitingOnApproval"))
            throw new Error(
              "Codex 等待审批，请在原生宿主检查；此验收不代批权限",
            );
          const turn = result.thread.turns.at(-1);
          if (turn?.status === "failed" || turn?.status === "interrupted")
            throw new Error(`Codex turn ${turn.status}`);
        } finally {
          await rpc.close();
        }
      }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`No reply containing ${text}`);
}
try {
  session = await createCodexSession(client, {
    topic: topic.id,
    as: "human",
    cwd: mode === "codex" ? resolve(process.argv[3]) : cwd,
    endpoint: legacyHost?.endpoint,
    agentBin: legacyHost?.agentBin,
    timeout: 180,
  });
  console.log(
    JSON.stringify({
      phase: "registered",
      kind,
      nativeId: session.native_id,
      participant: session.participant_id,
    }),
  );
  const first = await waitFor("SESSION_SMOKE_OK");
  console.log(
    JSON.stringify({ phase: "first-reply", kind, messageId: first.id }),
  );
  const second = await client.request(`/api/topics/${topic.id}/messages`, {
    as: "human",
    to: session.participant_id,
    body: "请仅回复 SESSION_SMOKE_SECOND，发回本主题并确认读过本条消息。不再追问。",
    requestId: "second",
  });
  const reply = await waitFor("SESSION_SMOKE_SECOND");
  const deadline = Date.now() + 30000;
  while (
    Date.now() < deadline &&
    (
      await client.request(`/api/inbox?as=${session.participant_id}`)
    ).notifications.some((m) => m.id === second.id)
  )
    await new Promise((r) => setTimeout(r, 1000));
  if (
    (
      await client.request(`/api/inbox?as=${session.participant_id}`)
    ).notifications.some((m) => m.id === second.id)
  )
    throw new Error("Reply persisted but ACK not received");
  const proof = {
    kind,
    topic: topic.id,
    nativeId: session.native_id,
    firstReply: first.id,
    secondReply: reply.id,
    ack: true,
  };
  await writeFile(join(cwd, "proof.json"), JSON.stringify(proof, null, 2));
  console.log(JSON.stringify({ phase: "passed", ...proof }));
} finally {
  session ??= await client.request(codexSessionPath(topic.id));
  if (session?.native_id) {
    if (mode === "codex-ws") {
      const host = legacyHost;
      const rpc = await new CodexConnection(
        host.endpoint,
        process.env.MAILBOX_CODEX_TOKEN,
      ).connect();
      try {
        const result = await rpc.call("thread/read", {
          threadId: session.native_id,
          includeTurns: true,
        });
        const turn = result.thread.turns.at(-1);
        if (turn?.status === "inProgress")
          await rpc.call("turn/interrupt", {
            threadId: session.native_id,
            turnId: turn.id,
          });
        await rpc.call("thread/archive", { threadId: session.native_id });
      } finally {
        await rpc.close();
      }
    }
  }
  await app.close();
  console.log(
    JSON.stringify({
      phase: "cleanup",
      kind,
      cwd,
      nativeId: session?.native_id,
      note: mode === "codex" ? "临时信箱已关闭；请在当前 App 归档上述测试任务。测试记录保留在临时目录。" : "本次测试记录保留在临时目录；共享 App Server 继续运行",
    }),
  );
}
