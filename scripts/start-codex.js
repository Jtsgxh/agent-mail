// Explicitly start one shared, localhost-only Codex host. Never restarts the desktop app.
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { mkdir, open, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { agentCommand } from "../src/connect.js";
import { CodexConnection } from "../src/codex.js";
import { codexHostFile } from "../src/sessions.js";

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "4500" },
    "agent-bin": { type: "string" },
  },
});
if (
  !/^\d+$/.test(values.port) ||
  Number(values.port) < 1 ||
  Number(values.port) > 65535
)
  throw new Error("port 必须为 1–65535");
const port = Number(values.port);
const endpoint = `ws://127.0.0.1:${port}`;
const program = await agentCommand("codex", { bin: values["agent-bin"] });
const agentBin = program.args[0] ?? program.command;
const root = fileURLToPath(new URL("../", import.meta.url));
await mkdir(dirname(codexHostFile), { recursive: true });
const log = resolve(dirname(codexHostFile), "codex-app-server.log");
const listening = await new Promise((done) => {
  const socket = net.connect({ host: "127.0.0.1", port });
  socket.setTimeout(2000);
  const finish = (value) => {
    socket.destroy();
    done(value);
  };
  socket.once("connect", () => finish(true));
  socket.once("error", () => finish(false));
  socket.once("timeout", () => finish(false));
});
let child;
if (!listening) {
  const output = await open(log, "a");
  const env = { ...process.env };
  for (const key of [
    "CODEX_THREAD_ID",
    "CODEX_SESSION_ID",
    "CODEX_APP_TOOLS_PIPE_PATH",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
  ])
    delete env[key];
  child = spawn(
    program.command,
    [...program.args, "app-server", "--listen", endpoint],
    {
      cwd: root,
      env,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", output.fd, output.fd],
    },
  );
  const spawned = new Promise((ok, fail) => {
    child.once("spawn", ok);
    child.once("error", fail);
  });
  await output.close();
  await spawned;
  // This is a bounded startup readiness check, not restart/retry of a failed agent turn.
  const deadline = Date.now() + 20000;
  try {
    for (;;) {
      if (child.exitCode !== null)
        throw new Error(`App Server 退出 (${child.exitCode})，查看 ${log}`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/readyz`, {
          signal: AbortSignal.timeout(1000),
        });
        if (response.ok) break;
      } catch {}
      if (Date.now() >= deadline)
        throw new Error(`App Server 启动超时，查看 ${log}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  } catch (error) {
    child.kill();
    throw error;
  }
}
try {
  const rpc = await new CodexConnection(
    endpoint,
    process.env.MAILBOX_CODEX_TOKEN,
  ).connect();
  await rpc.close();
  await writeFile(
    codexHostFile,
    JSON.stringify({ endpoint, agentBin }, null, 2) + "\n",
  );
  child?.unref();
  console.log(
    JSON.stringify(
      {
        endpoint,
        pid: child?.pid ?? null,
        reused: listening,
        config: codexHostFile,
        log,
      },
      null,
      2,
    ),
  );
} catch (error) {
  child?.kill();
  throw error;
}
