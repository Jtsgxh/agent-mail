import { access, readFile, stat, mkdir, open } from "node:fs/promises";
import { constants } from "node:fs";
import {
  delimiter,
  dirname,
  extname,
  isAbsolute,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";
import { fork } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { listenNative, validateClaudeAddress } from "./native.js";

// Resolve native programs and npm entry points, without invoking a shell.
export async function agentCommand(
  kind,
  {
    bin,
    searchPath = process.env.PATH ?? "",
    platform = process.platform,
  } = {},
) {
  if (!["codex", "claude"].includes(kind))
    throw new Error("仅支持 codex 或 claude");
  const explicit = bin ?? process.env[`MAILBOX_${kind.toUpperCase()}_BIN`];
  let executable;
  if (explicit) {
    executable = resolve(explicit);
    if (!(await stat(executable)).isFile())
      throw new Error("--agent-bin 必须指向文件");
  } else {
    const names =
      platform === "win32" ? [`${kind}.exe`, `${kind}.cmd`] : [kind];
    for (const dir of searchPath
      .split(platform === "win32" ? ";" : delimiter)
      .filter(Boolean)) {
      for (const name of names) {
        const candidate = resolve(dir.replace(/^"|"$/g, ""), name);
        try {
          await access(candidate, constants.X_OK);
          executable = candidate;
          break;
        } catch (error) {
          if (!["ENOENT", "EACCES"].includes(error.code)) throw error;
        }
      }
      if (executable) break;
    }
    if (!executable)
      throw new Error(
        `未找到 ${kind}。请先安装 CLI，或用 --agent-bin 指定程序文件。`,
      );
  }
  if (extname(executable).toLowerCase() === ".cmd") {
    const shim = await readFile(executable, "utf8");
    const match = shim.match(
      /"%dp0%[\\/]node_modules[\\/]([^"\r\n]+\.(?:js|exe))"/i,
    );
    if (!match)
      throw new Error(
        `无法解析 ${executable}；请用 --agent-bin 指定实际 .exe 或 .js 文件。`,
      );
    const modules = resolve(dirname(executable), "node_modules");
    executable = resolve(modules, match[1].replaceAll("\\", "/"));
    const rel = relative(modules, executable);
    if (rel.startsWith("..") || isAbsolute(rel))
      throw new Error("无效的 npm 启动脚本路径");
    await access(executable, constants.X_OK);
  }
  return [".js", ".mjs", ".cjs"].includes(extname(executable).toLowerCase())
    ? { command: process.execPath, args: [executable] }
    : { command: executable, args: [] };
}

export async function choose(label, choices, signal) {
  if (!process.stdin.isTTY)
    throw new Error(
      `${label}需要在普通交互终端选择；也可使用 --as 指定，--list 查看参与者列表。`,
    );
  console.error(`\n${label}`);
  choices.forEach((item, i) => console.error(`  ${i + 1}. ${item.label}`));
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question("输入序号（q 退出）：", { signal });
    if (answer.trim().toLowerCase() === "q") throw new Error("已取消连接");
    const index = Number(answer) - 1;
    if (!/^\d+$/.test(answer.trim()) || !choices[index])
      throw new Error("无效序号，请重新运行 connect");
    return choices[index].value;
  } finally {
    rl.close();
  }
}

export async function connectMailbox(client, options = {}, select = choose) {
  const {
    as,
    kind,
    list = false,
    preview = false,
    signal,
    background = false,
    endpoint,
    maxMessages = 20,
  } = options;
  if (kind && !["codex", "claude"].includes(kind))
    throw new Error("connect 类型必须为 codex 或 claude");
  const state = await client.request("/api/state");
  const candidates = state.participants.filter(
    (p) => ["codex", "claude"].includes(p.kind) && (!kind || p.kind === kind),
  );
  if (list && !as) return { participants: candidates };
  const matches = as
    ? candidates.filter((p) => p.id === as || p.name === as)
    : [];
  if (as && matches.length !== 1)
    throw new Error("--as 必须对应唯一的参与者名称或 ID，且与 agent 类型一致");
  if (!candidates.length)
    throw new Error("请先为本会话创建 Codex 或 Claude 参与者身份");
  const participant = as
    ? matches[0]
    : await select(
        "选择本会话的信箱身份",
        candidates.map((p) => ({ label: `${p.name} (${p.kind})`, value: p })),
        signal,
      );
  const thread =
    options.thread ??
    (participant.kind === "codex" ? process.env.CODEX_THREAD_ID : undefined);
  const socket = options.socket ?? process.env.CLAUDE_CODE_MESSAGING_SOCKET;
  const token = process.env.CLAUDE_CODE_MESSAGING_TOKEN;
  const plan = {
    participant,
    mode: `${participant.kind}-native`,
    thread: thread ?? null,
    endpoint: endpoint ?? null,
    hasClaudeAddress: !!socket,
    hasClaudeToken: !!token,
  };
  if (list || preview) return plan;
  if (state.bridges.some((b) => b.participant_id === participant.id))
    throw new Error(
      `${participant.name} 已有通知连接；请勿重复连接或冒用别的会话身份。`,
    );
  if (participant.kind === "codex" && !thread)
    throw new Error(
      "请在目标 Codex 会话内执行 connect，或用 --thread 指定目标会话 ID / 完整名称",
    );
  if (participant.kind === "claude") {
    if (thread || endpoint)
      throw new Error(
        "Claude 原生通知使用会话自身的收件地址，不使用 --thread / --endpoint",
      );
    validateClaudeAddress(socket, token);
  }
  if (background) {
    signal?.throwIfAborted();
    const logDir = fileURLToPath(
      new URL("../.mailbox/connections/", import.meta.url),
    );
    await mkdir(logDir, { recursive: true });
    const logPath = resolve(logDir, `${participant.id}.log`);
    const logFile = await open(logPath, "a");
    const args = [
      "--url",
      client.url,
      "connect",
      participant.kind,
      "--as",
      participant.id,
      "--max-messages",
      String(maxMessages),
    ];
    if (thread) args.push("--thread", thread);
    if (endpoint) args.push("--endpoint", endpoint);
    if (options.socket) args.push("--socket", options.socket);
    if (options.agentBin) args.push("--agent-bin", options.agentBin);
    const child = fork(
      fileURLToPath(new URL("../bin/mailbox.js", import.meta.url)),
      args,
      {
        detached: true,
        windowsHide: true,
        stdio: ["ignore", logFile.fd, logFile.fd, "ipc"],
      },
    );
    await logFile.close();
    return new Promise((resolveResult, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (error) {
          child.kill();
          reject(error);
        } else {
          child.disconnect();
          child.unref();
          resolveResult({
            ...plan,
            pid: child.pid,
            log: logPath,
            status: "listening",
          });
        }
      };
      const abort = () => finish(signal.reason);
      const timer = setTimeout(
        () => finish(new Error(`通知进程启动超时，请查看 ${logPath}`)),
        20000,
      );
      signal?.addEventListener("abort", abort, { once: true });
      child.once("error", finish);
      child.once("exit", (code) =>
        finish(new Error(`通知进程退出 (${code})，请查看 ${logPath}`)),
      );
      child.on("message", (message) => {
        if (message.type === "ready") finish();
        if (message.type === "error") finish(new Error(message.error));
      });
    });
  }
  const program =
    participant.kind === "codex"
      ? await agentCommand("codex", { bin: options.agentBin })
      : undefined;
  await listenNative(client, participant, {
    program,
    thread,
    endpoint,
    socket,
    token,
    signal,
    maxMessages,
    onReady() {
      if (process.connected && process.send) process.send({ type: "ready" });
      console.error(
        `${participant.name}：原生通知已连接，未启动或恢复 agent 会话。`,
      );
    },
  });
}

export async function disconnectMailbox(client, as) {
  const state = await client.request("/api/state");
  const matches = state.participants.filter(
    (p) => p.id === as || p.name === as,
  );
  if (matches.length !== 1)
    throw new Error("请用 --as 指定唯一参与者名称或 ID");
  return client.request(`/api/bridge/${matches[0].id}`, undefined, "DELETE");
}
