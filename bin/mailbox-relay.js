#!/usr/bin/env node
import { parseArgs } from "node:util";
import { Client } from "../src/client.js";
import { connectMailbox } from "../src/connect.js";

const stop = new AbortController();
// 退出时取消 HTTP 和本机 IPC，后台进程不会接管或结束 Codex 会话。
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => stop.abort(new Error("远端转发器已停止")));

try {
  const { values } = parseArgs({ options: {
    url: { type: "string" }, as: { type: "string" }, topic: { type: "string" },
    "max-messages": { type: "string", default: "20" },
    background: { type: "boolean" }, help: { type: "boolean" },
  } });
  if (values.help) {
    console.log("在目标 Codex App 任务内运行：node bin/mailbox-relay.js --url http://服务器IP:4317 --as 本会话身份ID [--topic 主题ID] [--background] [--max-messages 20]");
  } else {
    if (!values.as) throw new Error("缺少 --as，请先通过 HTTP 创建本会话的独立 Codex 身份");
    if (!/^\d+$/.test(values["max-messages"])) throw new Error("--max-messages 必须为正整数");
    const result = await connectMailbox(new Client(values.url), {
      relay: true, as: values.as, kind: "codex", topic: values.topic,
      background: values.background, signal: stop.signal,
      maxMessages: Number(values["max-messages"]),
    });
    if (result) console.log(JSON.stringify(result, null, 2));
  }
} catch (error) {
  if (process.connected && process.send) process.send({ type: "error", error: error.message });
  console.error(JSON.stringify({ error: error.message }));
  process.exitCode = stop.signal.aborted ? 130 : 1;
}
