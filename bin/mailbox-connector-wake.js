#!/usr/bin/env node
import { parseArgs } from "node:util";
import { fork } from "node:child_process";
import { open, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { redactCredentials, uuid } from "../src/connector-subscription.js";
import { connectProjectMailbox, startConnectorWake } from "../src/connector-wake.js";
import { wakeHost } from "../src/wake-hosts.js";

const stop = new AbortController();
for (const name of ["SIGINT", "SIGTERM"]) process.on(name, () => stop.abort());
const selfTest = "Agent Mailbox 本机唤醒自检：仅验证此聊天可以被通知唤醒，不是远端来信。请核对本地接收器状态；不要发送信件或改变 ACK。";

try {
  const { values } = parseArgs({ options: {
    host: { type: "string", default: "codex" },
    connection: { type: "string", default: "agent-mailbox" }, topic: { type: "string" },
    "state-path": { type: "string" }, "agent-bin": { type: "string" },
    "max-messages": { type: "string", default: "20" }, background: { type: "boolean" },
    call: { type: "string" }, arguments: { type: "string", default: "{}" },
    status: { type: "boolean" }, "test-wake": { type: "boolean" }, help: { type: "boolean" },
  } });
  if (values.help) {
    console.log("mailbox-connector-wake [--host codex|claude] --connection agent-mailbox --topic TOPIC [--background]\n" +
      "--status shows local receiver state; --test-wake sends a local self-test to this conversation.\n" +
      "--call mailbox_inbox [--arguments '{\"topic\":\"...\"}'] invokes the configured project MCP.\n" +
      "Targets the conversation of the current tool environment (CODEX_THREAD_ID or CLAUDE_CODE_SESSION_ID);\n" +
      "credentials stay in that host's existing MCP config.");
  } else {
    if (!/^[\w-]+$/.test(values.connection)) throw new Error("Invalid connection name");
    const host = wakeHost(values.host, { agentBin: values["agent-bin"] });
    const { thread } = host;
    const conversation = () => { if (!uuid.test(thread ?? "")) throw new Error(`Run inside the target ${host.kind} conversation`); };
    // State lives beside the package, not in whichever project the chat happens to be in.
    const statePath = () => values["state-path"] ? resolve(values["state-path"])
      : (conversation(), fileURLToPath(new URL(`../.mailbox/connector-wakes/${values.connection}-${thread}.db`, import.meta.url)));
    if (values.status) {
      const db = new DatabaseSync(statePath(), { readOnly: true });
      try {
        const state = JSON.parse(db.prepare("SELECT value FROM wake_status WHERE id=1").get().value);
        let alive = true;
        try { process.kill(state.pid, 0); } catch (e) { if (e.code === "ESRCH") alive = false; }
        console.log(JSON.stringify({ ...state, processAlive: alive, connected: alive && state.connected }));
      } finally { db.close(); }
    } else if (values["test-wake"]) {
      conversation();
      console.log(JSON.stringify(await host.wake(selfTest, stop.signal)));
    } else {
      const credentials = await host.connection(values.connection);
      if (values.call) {
        const mailbox = await connectProjectMailbox({ ...credentials, signal: stop.signal });
        try { console.log(JSON.stringify(await mailbox.call(values.call, JSON.parse(values.arguments)))); }
        finally { await mailbox.close(); }
      } else if (values.background) {
        conversation();
        const state = statePath();
        await mkdir(dirname(state), { recursive: true });
        const log = await open(`${state}.log`, "a");
        const args = process.argv.slice(2).filter((arg) => arg !== "--background");
        const child = fork(fileURLToPath(import.meta.url), args, { detached: true, windowsHide: true,
          stdio: ["ignore", log.fd, log.fd, "ipc"] });
        try {
          const result = await new Promise((resolveReady, reject) => {
            const timer = setTimeout(() => { child.kill(); reject(new Error("Receiver startup timed out; inspect its log")); }, 35000);
            child.once("error", (e) => { clearTimeout(timer); reject(e); });
            child.once("exit", () => { clearTimeout(timer); reject(new Error("Receiver exited before subscription; inspect its log")); });
            child.on("message", (message) => {
              if (message.type === "ready" || message.type === "error") {
                clearTimeout(timer);
                if (message.type === "error") reject(new Error(message.error)); else resolveReady(message);
              }
            });
          });
          console.log(JSON.stringify({ ...result, logPath: `${state}.log`, statePath: state }));
        } finally { if (child.connected) child.disconnect(); child.unref(); await log.close(); }
      } else {
        await host.check();
        const config = { ...credentials, thread, topic: values.topic, statePath: statePath(),
          connection: values.connection, host: host.kind, maxMessages: Number(values["max-messages"]) };
        const service = await startConnectorWake(config, {
          signal: stop.signal,
          wake: host.wake,
          onState: (state) => {
            console.log(JSON.stringify({ at: new Date().toISOString(), ...state }));
            if (state.type === "listening" && process.connected) process.send({ ...state, type: "ready" });
          },
        });
        try { await service.done; }
        finally { const failed = service.status().error; await service.close(); if (failed) process.exitCode = 1; }
      }
    }
  }
} catch (error) {
  const message = redactCredentials(error.message);
  if (process.connected) process.send({ type: "error", error: message });
  console.error(JSON.stringify({ error: message }));
  process.exitCode = 1;
}
