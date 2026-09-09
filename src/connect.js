import { access, readFile, stat } from "node:fs/promises";
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
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { CodexConnection, runCodexBridge } from "./codex.js";

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
      `${label}需要在普通交互终端选择；也可使用 --as / --thread 指定，--list 查看列表。`,
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

export function claudeLaunch(
  program,
  { as, url, cwd, thread, maxMessages = 20 },
) {
  const config = {
    mcpServers: {
      mailbox: {
        command: process.execPath,
        args: [
          fileURLToPath(new URL("../bin/mailbox.js", import.meta.url)),
          "--url",
          url,
          "bridge",
          "claude",
          "--as",
          as,
          "--max-messages",
          String(maxMessages),
        ],
      },
    },
  };
  const args = [
    ...program.args,
    "--mcp-config",
    JSON.stringify(config),
    "--dangerously-load-development-channels",
    "server:mailbox",
    "--resume",
  ];
  if (thread) args.push(thread);
  return { command: program.command, args, cwd };
}

export async function connectMailbox(client, options = {}, select = choose) {
  const {
    as,
    kind,
    endpoint,
    thread,
    agentBin,
    list = false,
    preview = false,
    signal,
    maxTurns = 12,
    maxMessages = 20,
  } = options;
  if (kind && !["codex", "claude"].includes(kind))
    throw new Error("connect 类型必须为 codex 或 claude");
  const cwd = resolve(options.cwd ?? process.cwd());
  if (!(await stat(cwd)).isDirectory()) throw new Error("--cwd 必须是项目目录");
  const state = await client.request("/api/state");
  const candidates = state.participants.filter(
    (p) => ["codex", "claude"].includes(p.kind) && (!kind || p.kind === kind),
  );
  if (list && !as && !kind) return { participants: candidates };
  const matches = as
    ? candidates.filter((p) => p.id === as || p.name === as)
    : [];
  if (as && matches.length !== 1)
    throw new Error("--as 必须对应唯一的参与者名称或 ID，且与 agent 类型一致");
  if (!candidates.length)
    throw new Error(
      "还没有可连接的参与者，请先在网页右侧创建 Codex 或 Claude 身份",
    );
  const participant = as
    ? matches[0]
    : await select(
        "选择本次会话使用的信箱身份",
        candidates.map((p) => ({ label: `${p.name} (${p.kind})`, value: p })),
        signal,
      );
  if (
    !list &&
    !preview &&
    state.bridges.some((b) => b.participant_id === participant.id)
  )
    throw new Error(
      `${participant.name} 已有桥接连接，请使用属于本会话的独立身份。`,
    );
  if (participant.kind === "claude") {
    if (endpoint) throw new Error("Claude 接入不需要 --endpoint");
    if (list)
      return {
        participant,
        sessionPicker: "Claude --resume 会在启动时显示原生会话选择器",
      };
    const program = await agentCommand("claude", { bin: agentBin });
    const launch = claudeLaunch(program, {
      as: participant.id,
      url: client.url,
      cwd,
      thread,
      maxMessages,
    });
    if (preview) return { participant, launch };
    if (!process.stdin.isTTY)
      throw new Error(
        "请在普通交互终端运行 mailbox connect claude；Claude 需要选择已有会话并确认自定义 Channel。可先用 --preview 检查启动参数。",
      );
    if (process.env.CLAUDECODE)
      throw new Error(
        "请退出目标 Claude 会话后，在普通终端运行 connect，避免在 Claude 内嵌套启动它自己。",
      );
    console.error(
      `\n正在接入 ${participant.name}。请选择需要继续的已有 Claude 会话，并确认自定义 Mailbox Channel。`,
    );
    const child = spawn(launch.command, launch.args, {
      cwd,
      stdio: "inherit",
      windowsHide: true,
    });
    const stop = () => child.kill();
    signal?.addEventListener("abort", stop, { once: true });
    try {
      const code = await new Promise((ok, fail) => {
        child.once("error", fail);
        child.once("exit", (code, reason) =>
          reason ? fail(new Error(`Claude 已停止: ${reason}`)) : ok(code),
        );
      });
      if (code !== 0)
        throw new Error(`Claude 退出码 ${code}，请检查终端中的启动说明`);
    } finally {
      signal?.removeEventListener("abort", stop);
    }
    return;
  }

  if (preview)
    return {
      participant,
      mode: endpoint ? "existing-app-server" : "local-stdio",
      endpoint: endpoint ?? null,
      thread: thread ?? "运行时选择已有会话",
      cwd,
    };
  const launch = endpoint
    ? undefined
    : { ...(await agentCommand("codex", { bin: agentBin })), cwd };
  const rpc = await new CodexConnection(
    endpoint,
    process.env.MAILBOX_CODEX_TOKEN,
    launch,
  ).connect();
  try {
    let selectedThread = thread;
    if (list || !selectedThread) {
      const result = await rpc.call("thread/list", {
        limit: 20,
        sortKey: "updated_at",
        cursor: options.cursor ?? null,
      });
      if (list)
        return {
          participant,
          threads: result.data.map((t) => ({
            id: t.id,
            title: t.name || t.preview,
            cwd: t.cwd,
            status: t.status,
          })),
          nextCursor: result.nextCursor,
        };
      if (!result.data.length)
        throw new Error(
          "没有可恢复的 Codex 会话。请先在 Codex 中建立会话并完成一轮，再连接。",
        );
      let page = result;
      while (!selectedThread) {
        const choices = page.data.map((t) => ({
          label: `${(t.name || t.preview || t.id).replaceAll(/\s+/g, " ").slice(0, 100)}\n     ${t.cwd}`,
          value: t.id,
        }));
        if (page.nextCursor)
          choices.push({ label: "下一页", value: "next-page" });
        const value = await select(
          endpoint
            ? "选择该 App Server 中的已有会话"
            : "选择要恢复的已有会话（请先退出原会话，避免两个进程同时写入）",
          choices,
          signal,
        );
        if (value === "next-page")
          page = await rpc.call("thread/list", {
            limit: 20,
            sortKey: "updated_at",
            cursor: page.nextCursor,
          });
        else selectedThread = value;
      }
    }
    if (!endpoint && process.env.CODEX_THREAD_ID === selectedThread)
      throw new Error(
        "不能从目标会话内部再次恢复自身；请退出原会话后在普通终端连接。",
      );
    console.error(
      `\n${participant.name} → Codex ${selectedThread}\n连接后在网页发定向消息即可；Ctrl+C 停止桥接。`,
    );
    await runCodexBridge(client, participant.id, {
      connection: rpc,
      thread: selectedThread,
      signal,
      maxTurns,
    });
  } finally {
    await rpc.close();
  }
}
