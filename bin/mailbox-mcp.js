#!/usr/bin/env node
import { parseArgs } from "node:util";
import { Client } from "../src/client.js";
import { startMailboxMcp } from "../src/mcp.js";

const controller = new AbortController();
// 信号与 stdin 结束均交给同一个 MCP 生命周期，不能留下后台订阅。
function stop() { controller.abort(); }
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.stdin.on("end", stop);
try {
  const { values } = parseArgs({ options: {
    url: { type: "string" }, "max-messages": { type: "string", default: "20" },
    help: { type: "boolean" },
  } });
  if (values.help) {
    console.error("mailbox-mcp [--url HTTP_OR_HTTPS_URL]\n由 Codex 作为 STDIO MCP 启动；首次 mailbox_join 后自动接收新信。");
  } else {
    const maxMessages = Number(values["max-messages"]);
    if (!Number.isSafeInteger(maxMessages) || maxMessages < 1) throw new Error("max-messages 必须为正整数");
    const mcp = await startMailboxMcp(new Client(values.url), { signal: controller.signal, maxMessages });
    await mcp.done;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
