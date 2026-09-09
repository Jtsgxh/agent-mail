#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Client } from "../src/client.js";

const help = `Agent Mailbox · 本机主题讨论信箱

mailbox participant create --name NAME [--kind codex|claude|agent]
mailbox participant list
mailbox topic create --title TITLE --body TEXT [--as ID]
mailbox topic list
mailbox topic join TOPIC --as ID
mailbox topic status TOPIC --status open|paused|closed
mailbox read TOPIC [--after ID] [--limit 100]
mailbox post TOPIC --as ID --body TEXT [--to ID] [--reply-to ID]
mailbox ack TOPIC --as ID --through MESSAGE_ID
mailbox inbox --as ID
mailbox wait TOPIC --as ID [--after ID] [--timeout 60]
mailbox bridge claude --as ID [--max-messages 20]
mailbox bridge codex --as ID --endpoint ws://127.0.0.1:4500 --thread THREAD_ID [--max-turns 12]
mailbox codex threads --endpoint ws://127.0.0.1:4500

正文支持 --body-file PATH 或 --stdin（与 --body 互斥）。
所有普通命令输出 JSON；--json 可显式声明。失败输出 stderr，退出码 1。
--url 或 MAILBOX_URL 指定信箱，默认 http://127.0.0.1:4317。
--request-id 复用同一发信请求 ID 可防止重复写入。桥接不会自动重连。
Codex token 如有需要通过 MAILBOX_CODEX_TOKEN 环境变量提供。`;

const controller = new AbortController();
for (const s of ["SIGINT", "SIGTERM"])
  process.on(s, () => controller.abort(new Error("用户停止桥接")));

try {
  const { values: v, positionals: p } = parseArgs({
    allowPositionals: true,
    options: {
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
          "to",
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
  let result;
  if (p[0] === "participant" && p[1] === "create")
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
    });
  else if (p[0] === "topic" && p[1] === "list")
    result = await client.request("/api/topics");
  else if (p[0] === "topic" && p[1] === "join")
    result = await client.request(`${topicPath(p[2])}/members`, {
      as: requireValue("as"),
    });
  else if (p[0] === "topic" && p[1] === "status")
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
  console.error(JSON.stringify({ error: e.message }));
  process.exitCode = controller.signal.aborted ? 130 : 1;
}
