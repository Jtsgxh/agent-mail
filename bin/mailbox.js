#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Client } from "../src/client.js";

const help = `Agent Mailbox · 本机主题讨论信箱

mailbox connect [codex|claude] [--as 名称或ID]
mailbox connect codex --as NAME --thread SESSION_ID --background
mailbox connect claude --as NAME --background
mailbox connect codex --as NAME --list
mailbox connect claude --as NAME --preview
mailbox disconnect --as NAME

mailbox project create --name NAME
mailbox project list
mailbox project rename NAME_OR_ID --name NEW_NAME
mailbox project delete NAME_OR_ID
mailbox participant create --name NAME [--kind codex|claude|agent]
mailbox participant list
mailbox session create claude|codex --topic TOPIC --cwd PATH --as INITIATOR_ID [--timeout 60]
mailbox session info claude|codex --topic TOPIC
mailbox topic create --title TITLE --body TEXT [--as ID] [--project NAME_OR_ID]
mailbox topic show TOPIC
mailbox topic list [--project NAME_OR_ID | --unassigned]
mailbox topic move TOPIC --project NAME_OR_ID
mailbox topic move TOPIC --unassigned
mailbox topic join TOPIC --as ID_OR_NAME [--manual]
mailbox topic status TOPIC --status open|paused|closed
mailbox topic delete TOPIC
mailbox read TOPIC [--after ID] [--limit 100]
mailbox post TOPIC --as ID --body TEXT [--to ID --to ID | --broadcast] [--reply-to ID]
mailbox ack TOPIC --as ID --through MESSAGE_ID
mailbox inbox --as ID
mailbox wait TOPIC --as ID [--after ID] [--timeout 60]
mailbox bridge claude --as ID [--max-messages 20]
mailbox bridge codex --as ID --endpoint ws://127.0.0.1:4500 --thread THREAD_ID [--max-turns 12]
mailbox codex threads --endpoint ws://127.0.0.1:4500
mailbox codex app connect
mailbox codex app status

正文支持 --body-file PATH 或 --stdin（与 --body 互斥）。
所有普通命令输出 JSON；--json 可显式声明。失败输出 stderr，退出码 1。
--url 或 MAILBOX_URL 指定信箱，默认 http://127.0.0.1:4317。
--request-id 复用同一发信请求 ID 可防止重复写入。桥接不会自动重连。
connect 在目标 agent 会话内部执行，使用自身原生消息入口；--background 仅后台运行通知进程。
Codex 使用 CODEX_THREAD_ID 或 --thread；Claude 使用自身导出的消息地址和 token。
--agent-bin 指定目标 agent 程序；--list 查看参与者，--preview 只检查参数。
session create 为 topic 创建独立会话；Codex 默认复用已接入的桌面 App，Claude 使用 --bg。
codex app connect 在当前 Codex App 任务内执行，仅登记自身 App 入口；Claude 之后可直接创建。
只有明确传 --endpoint 才使用独立 App Server，不会自动启动或回退到 4500。
session create 成功仅表示新会话已登记收件入口；讨论结果查看 read，处理进度查看 ACK。
Codex token 如有需要通过 MAILBOX_CODEX_TOKEN 环境变量提供。
topic join 在目标会话中自动登记通知入口，无需 connect 或后台进程。
--manual 仅加入主题并手动收信；原生入口缺失时不会静默改为手动模式。`;

const controller = new AbortController();
for (const s of ["SIGINT", "SIGTERM"])
  process.on(s, () => controller.abort(new Error("用户停止桥接")));

try {
  const { values: v, positionals: p } = parseArgs({
    allowPositionals: true,
    options: {
      list: { type: "boolean" },
      preview: { type: "boolean" },
      background: { type: "boolean" },
      manual: { type: "boolean" },
      unassigned: { type: "boolean" },
      broadcast: { type: "boolean" },
      to: { type: "string", multiple: true },
      help: { type: "boolean", short: "h" },
      json: { type: "boolean" },
      stdin: { type: "boolean" },
      ...Object.fromEntries(
        [
          "url",
          "name",
          "kind",
          "title",
          "as",
          "body",
          "body-file",
          "reply-to",
          "request-id",
          "through",
          "after",
          "limit",
          "timeout",
          "status",
          "endpoint",
          "thread",
          "max-turns",
          "max-messages",
          "agent-bin",
          "socket",
          "project",
          "topic",
          "cwd",
        ].map((k) => [k, { type: "string" }]),
      ),
    },
  });
  if (v.help || p.length === 0) {
    console.log(help);
    process.exit(0);
  }
  const client = new Client(v.url);
  const requireValue = (key) => {
    if (!v[key]) throw new Error(`缺少 --${key}`);
    return v[key];
  };
  const int = (key, defaultValue, max = Number.MAX_SAFE_INTEGER) => {
    if (v[key] === undefined && defaultValue !== undefined) return defaultValue;
    if (
      !/^\d+$/.test(v[key] ?? "") ||
      !Number.isSafeInteger(Number(v[key])) ||
      Number(v[key]) > max
    )
      throw new Error(`--${key} 必须是有效整数`);
    return Number(v[key]);
  };
  const text = async () => {
    if (
      [v.body !== undefined, v["body-file"] !== undefined, !!v.stdin].filter(
        Boolean,
      ).length !== 1
    )
      throw new Error("必须且只能指定 --body、--body-file、--stdin 之一");
    if (v["body-file"]) return readFile(v["body-file"], "utf8");
    if (v.stdin) {
      const chunks = [];
      for await (const c of process.stdin) chunks.push(c);
      return Buffer.concat(chunks).toString("utf8");
    }
    return v.body;
  };
  const topicPath = (id) => {
    if (!id) throw new Error("缺少主题 ID");
    return `/api/topics/${encodeURIComponent(id)}`;
  };
  const projectId = async (value = v.project) => {
    if (v.unassigned && value !== undefined)
      throw new Error("--project 与 --unassigned 互斥");
    if (value === undefined) return null;
    const projects = await client.request("/api/projects");
    const matches = projects.filter(
      (project) => project.id === value || project.name === value,
    );
    if (matches.length !== 1)
      throw new Error("项目必须对应唯一项目名称或 ID");
    return matches[0].id;
  };
  let result;
  if (p[0] === "codex" && p[1] === "app" && ["connect", "status"].includes(p[2])) {
    if (p[2] === "connect") {
      const { appContext } = await import("../src/codex-app.js");
      const context = appContext();
      if (!context.pipe || !context.threadId) throw new Error("请在当前 Codex App 的任务内执行此命令；不接受手填或猜测其他任务的入口");
      result = await client.request("/api/codex/connect", { context });
    } else result = await client.request("/api/codex/status");
  } else if (p[0] === "session" && ["create", "info"].includes(p[1])) {
    const { createSession, sessionPath } = await import("../src/sessions.js");
    const topic = requireValue("topic");
    result =
      p[1] === "info"
        ? await client.request(sessionPath(topic, p[2]))
        : await createSession(client, p[2], {
            topic,
            cwd: requireValue("cwd"),
            as: requireValue("as"),
            agentBin: v["agent-bin"],
            endpoint: v.endpoint,
            timeout: int("timeout", 60, 300),
            maxMessages: int("max-messages", 20),
            signal: controller.signal,
          });
  } else if (p[0] === "connect") {
    const { connectMailbox } = await import("../src/connect.js");
    const maxMessages = int("max-messages", 20);
    if (maxMessages < 1) throw new Error("消息上限必须大于 0");
    result = await connectMailbox(client, {
      kind: p[1],
      as: v.as,
      thread: v.thread,
      endpoint: v.endpoint,
      agentBin: v["agent-bin"],
      list: v.list,
      preview: v.preview,
      signal: controller.signal,
      maxMessages,
      background: v.background,
      socket: v.socket,
    });
  } else if (p[0] === "disconnect") {
    const { disconnectMailbox } = await import("../src/connect.js");
    result = await disconnectMailbox(client, requireValue("as"));
  } else if (p[0] === "project" && p[1] === "create")
    result = await client.request("/api/projects", {
      name: requireValue("name"),
    });
  else if (p[0] === "project" && p[1] === "list")
    result = await client.request("/api/projects");
  else if (p[0] === "project" && ["rename", "delete"].includes(p[1])) {
    if (!p[2]) throw new Error("缺少项目名称或 ID");
    const body = p[1] === "rename" ? { name: requireValue("name") } : undefined;
    result = await client.request(
      `/api/projects/${encodeURIComponent(await projectId(p[2]))}`,
      body,
      p[1] === "rename" ? "PATCH" : "DELETE",
    );
  } else if (p[0] === "participant" && p[1] === "create")
    result = await client.request("/api/participants", {
      name: requireValue("name"),
      kind: v.kind ?? "agent",
    });
  else if (p[0] === "participant" && p[1] === "list")
    result = await client.request("/api/participants");
  else if (p[0] === "topic" && p[1] === "create")
    result = await client.request("/api/topics", {
      title: requireValue("title"),
      goal: await text(),
      as: v.as ?? "human",
      project: await projectId(),
    });
  else if (p[0] === "topic" && p[1] === "show")
    result = await client.request(topicPath(p[2]));
  else if (p[0] === "topic" && p[1] === "delete")
    result = await client.request(topicPath(p[2]), undefined, "DELETE");
  else if (p[0] === "topic" && p[1] === "list")
    result = await client.request(
      v.project !== undefined || v.unassigned
        ? `/api/topics?project=${encodeURIComponent((await projectId()) ?? "unassigned")}`
        : "/api/topics",
    );
  else if (p[0] === "topic" && p[1] === "move") {
    if (v.project === undefined && !v.unassigned)
      throw new Error("请指定 --project 或 --unassigned");
    result = await client.request(
      topicPath(p[2]),
      { project: await projectId() },
      "PATCH",
    );
  } else if (p[0] === "topic" && p[1] === "join") {
    const { sessionNotification } = await import("../src/notifications.js");
    const as = requireValue("as");
    const participants = await client.request("/api/participants");
    const matches = participants.filter(
      (item) => item.id === as || item.name === as,
    );
    if (matches.length !== 1)
      throw new Error("--as 必须对应唯一的参与者名称或 ID");
    const participant = matches[0];
    const notification = sessionNotification(participant, {
      manual: v.manual,
      thread: v.thread,
      endpoint: v.endpoint,
      socket: v.socket,
      agentBin: v["agent-bin"],
      maxMessages: int("max-messages", 20),
    });
    result = await client.request(`${topicPath(p[2])}/members`, {
      as: participant.id,
      notification,
    });
  } else if (p[0] === "topic" && p[1] === "status")
    result = await client.request(
      topicPath(p[2]),
      { status: requireValue("status") },
      "PATCH",
    );
  else if (p[0] === "read")
    result = await client.request(
      `${topicPath(p[1])}/messages?after=${int("after", 0)}&limit=${int("limit", 100, 200)}`,
    );
  else if (p[0] === "post")
    result = await client.request(`${topicPath(p[1])}/messages`, {
      as: requireValue("as"),
      body: await text(),
      to: v.to ?? null,
      broadcast: v.broadcast ?? false,
      replyTo: v["reply-to"] === undefined ? null : int("reply-to"),
      requestId: v["request-id"] ?? randomUUID(),
    });
  else if (p[0] === "ack")
    result = await client.request(`${topicPath(p[1])}/ack`, {
      as: requireValue("as"),
      through: int("through"),
    });
  else if (p[0] === "inbox")
    result = await client.request(
      `/api/inbox?as=${encodeURIComponent(requireValue("as"))}`,
    );
  else if (p[0] === "wait") {
    const path = topicPath(p[1]);
    requireValue("as");
    await client.request(`/api/inbox?as=${encodeURIComponent(v.as)}`);
    const after = int("after", 0);
    const seconds = int("timeout", 60, 3600);
    if (seconds < 1) throw new Error("--timeout 必须大于 0");
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(seconds * 1000),
    ]);
    try {
      // Subscribe first, then query on ready/change; no query-subscribe race.
      for await (const _ of client.events("/api/events", signal)) {
        const page = await client.request(`${path}/messages?after=${after}`);
        if (page.messages.length) {
          result = { ...page, timedOut: false };
          break;
        }
        const topic = await client.request(path);
        if (topic.status === "closed") {
          result = { ...page, closed: true, timedOut: false };
          break;
        }
      }
    } catch (e) {
      if (signal.aborted && !controller.signal.aborted)
        result = { messages: [], next: after, hasMore: false, timedOut: true };
      else throw e;
    }
  } else if (p[0] === "bridge" && p[1] === "claude") {
    const { startClaudeChannel } = await import("../src/claude.js");
    const maxMessages = int("max-messages", 20);
    if (maxMessages < 1) throw new Error("--max-messages 必须大于 0");
    const channel = await startClaudeChannel(client, requireValue("as"), {
      signal: controller.signal,
      maxMessages,
    });
    try {
      await channel.done;
    } finally {
      await channel.close();
    }
  } else if (p[0] === "bridge" && p[1] === "codex") {
    const { runCodexBridge } = await import("../src/codex.js");
    const maxTurns = int("max-turns", 12);
    if (maxTurns < 1) throw new Error("--max-turns 必须大于 0");
    await runCodexBridge(client, requireValue("as"), {
      endpoint: requireValue("endpoint"),
      thread: requireValue("thread"),
      token: process.env.MAILBOX_CODEX_TOKEN,
      maxTurns,
      signal: controller.signal,
    });
  } else if (p[0] === "codex" && p[1] === "threads") {
    const { CodexConnection } = await import("../src/codex.js");
    const rpc = await new CodexConnection(
      requireValue("endpoint"),
      process.env.MAILBOX_CODEX_TOKEN,
    ).connect();
    try {
      result = await rpc.call("thread/list", { limit: 50 });
    } finally {
      rpc.close();
    }
  } else throw new Error("未知命令，运行 mailbox --help 查看用法");
  if (result !== undefined) console.log(JSON.stringify(result, null, 2));
} catch (e) {
  if (process.connected && process.send)
    process.send({ type: "error", error: e.message });
  console.error(JSON.stringify({ error: e.message }));
  process.exitCode = controller.signal.aborted ? 130 : 1;
}
