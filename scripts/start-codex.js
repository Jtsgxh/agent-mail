// Start one shared, localhost-only Codex host. Never restarts the desktop app.
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { mkdir, open, readFile, writeFile, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import net from "node:net";
import { agentCommand } from "../src/connect.js";
import { codexHostFile, codexHostStatus } from "../src/sessions.js";

const root = fileURLToPath(new URL("../", import.meta.url));

export async function startCodexHost({
  port, agentBin, env = process.env, configPath = codexHostFile,
  signal, timeout = 20000, probeTimeout = 3000,
} = {}) {
  signal?.throwIfAborted();
  let config = { endpoint: "ws://127.0.0.1:4500" };
  try { config = JSON.parse(await readFile(configPath, "utf8")); }
  catch (error) {
    if (error.code !== "ENOENT") throw new Error("无法读取 Codex 宿主配置，请先修正配置文件");
  }
  if (!config || typeof config !== "object" || Array.isArray(config))
    throw new Error("Codex 宿主配置必须是对象");
  if (port !== undefined && (!/^\d+$/.test(String(port)) || Number(port) < 1 || Number(port) > 65535))
    throw new Error("port 必须为 1–65535");
  if (port !== undefined && env.MAILBOX_CODEX_ENDPOINT)
    throw new Error("已设置 MAILBOX_CODEX_ENDPOINT，请移除该环境变量后再用 --port 更换宿主");
  const endpoint = env.MAILBOX_CODEX_ENDPOINT || (port !== undefined
    ? `ws://127.0.0.1:${port}` : config.endpoint);
  const probeOptions = { env: { ...env, MAILBOX_CODEX_ENDPOINT: endpoint }, configPath, timeout: probeTimeout };
  let status = await codexHostStatus(probeOptions);
  if (status.status === "invalid_config" || status.status === "unconfigured") throw new Error(status.error);
  const url = new URL(status.endpoint);
  const program = await agentCommand("codex", {
    bin: agentBin ?? (env.MAILBOX_CODEX_BIN || config.agentBin),
    searchPath: env.PATH,
  });
  const resolvedBin = program.args[0] ?? program.command;
  await mkdir(dirname(configPath), { recursive: true });
  const log = resolve(dirname(configPath), "codex-app-server.log");
  let child;
  try {
    signal?.throwIfAborted();
    if (status.status !== "reachable") {
      const listening = await new Promise((done) => {
        const socket = net.connect({ host: url.hostname.replace(/^\[|\]$/g, ""), port: Number(url.port || 80) });
        const finish = (value) => { socket.destroy(); done(value); };
        socket.setTimeout(1000);
        socket.once("connect", () => finish(true));
        socket.once("error", () => finish(false));
        socket.once("timeout", () => finish(false));
      });
      if (listening)
        throw new Error(`目标端口已有服务，但 Codex 握手失败；未启动或替换进程。${status.error}`);
      if (url.pathname !== "/" || url.hostname === "localhost")
        throw new Error("自动启动需要形如 ws://127.0.0.1:4500 的本机 IP 地址；请先修正配置");
      signal?.throwIfAborted();
      const output = await open(log, "a");
      const childEnv = { ...env };
      for (const key of ["CODEX_THREAD_ID", "CODEX_SESSION_ID", "CODEX_APP_TOOLS_PIPE_PATH",
        "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN"])
        delete childEnv[key];
      try {
        child = spawn(program.command, [...program.args, "app-server", "--listen", url.origin], {
          cwd: root, env: childEnv, detached: true, windowsHide: true,
          stdio: ["ignore", output.fd, output.fd],
        });
        await new Promise((ok, fail) => { child.once("spawn", ok); child.once("error", fail); });
      } finally { await output.close(); }
      const deadline = Date.now() + timeout;
      // Bounded readiness wait for this newly started child, never a restart loop.
      for (;;) {
        signal?.throwIfAborted();
        if (child.exitCode !== null || child.signalCode !== null)
          throw new Error(`Codex 创建服务已退出 (${child.exitCode ?? child.signalCode})，查看 ${log}`);
        try {
          const response = await fetch(`http://${url.host}/readyz`, {
            signal: AbortSignal.any([AbortSignal.timeout(1000), ...(signal ? [signal] : [])]),
          });
          if (response.ok) break;
        } catch { signal?.throwIfAborted(); }
        if (Date.now() >= deadline) throw new Error(`Codex 创建服务启动超时，查看 ${log}`);
        await delay(100, undefined, { signal });
      }
      status = await codexHostStatus(probeOptions);
      if (status.status !== "reachable") throw new Error(`Codex 握手失败：${status.error}`);
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(`Codex 创建服务已退出，查看 ${log}`);
    }
    signal?.throwIfAborted();
    // The UI and session create consume this same config, saved only after handshake.
    const temp = `${configPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, JSON.stringify({ ...config, endpoint: status.endpoint, agentBin: resolvedBin }, null, 2) + "\n", { flag: "wx" });
      await rename(temp, configPath);
    } catch { throw new Error("无法保存 Codex 宿主配置，请检查配置目录的写入权限"); }
    finally { await rm(temp, { force: true }); }
    child?.unref();
    return { ...status, pid: child?.pid ?? null, reused: !child, config: configPath, log };
  } catch (error) {
    // Failed/cancelled startup owns only the child it created, never an existing host.
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((ok) => child.once("exit", ok));
      child.kill();
      const force = setTimeout(() => child.kill("SIGKILL"), 2000);
      force.unref();
      try { await exited; } finally { clearTimeout(force); }
    }
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { port: { type: "string" }, "agent-bin": { type: "string" } } });
  const controller = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => controller.abort(new Error("启动已取消")));
  try {
    console.log(JSON.stringify(await startCodexHost({ port: values.port, agentBin: values["agent-bin"], signal: controller.signal }), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
