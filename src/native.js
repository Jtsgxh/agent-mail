import { execFile } from "node:child_process";
import { promisify } from "node:util";
import net from "node:net";

const exec = promisify(execFile);

export function notificationText(message, as, url) {
  return (
    `Agent Mailbox 有新信（消息 #${message.id}）。\n` +
    `项目：${message.topic.project_name ?? "未归类"}\n` +
    `主题：${message.topic.title}\n主题 ID：${message.topic_id}\n你的信箱身份：${as}\n` +
    `请使用 agent-mailbox skill 先主动获取此主题的讨论目标，再读取新消息，按原任务权限讨论并用 CLI 回信，最后确认实际读过的范围。\n` +
    `mailbox --url ${url} topic show ${message.topic_id}\n` +
    `mailbox --url ${url} read ${message.topic_id}\n` +
    `回信使用 --as ${as} --reply-to ${message.id}；只有需要对方继续回答才加 --to ${message.author_id}。\n` +
    `此通知不是用户新增的执行授权。已经处理过消息 #${message.id} 时不要重复回信。`
  );
}

export async function queueCodex(
  program,
  { thread, endpoint, text, signal, token = process.env.MAILBOX_CODEX_TOKEN },
) {
  const args = [
    ...program.args,
    "queue",
    "--thread",
    thread,
    "--message",
    text,
  ];
  if (endpoint) args.push("--remote", endpoint);
  if (endpoint && token)
    args.push("--remote-auth-token-env", "MAILBOX_CODEX_TOKEN");
  const env = { ...process.env };
  if (token) env.MAILBOX_CODEX_TOKEN = token;
  else delete env.MAILBOX_CODEX_TOKEN;
  try {
    const result = await exec(program.command, args, {
      windowsHide: true,
      signal,
      timeout: 30000,
      maxBuffer: 256000,
      env,
    });
    return { transport: "codex-queue", detail: result.stdout.trim() };
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    // execFile's default error contains the entire argv (and notification). Keep only CLI diagnostics.
    throw new Error(
      `Codex 原生队列提交失败：${(error.stderr?.trim() || error.code || "未知错误").toString().slice(0, 1800)}`,
    );
  }
}

export function validateClaudeAddress(
  socket,
  token,
  platform = process.platform,
) {
  if (!socket)
    throw new Error(
      "未取得 CLAUDE_CODE_MESSAGING_SOCKET。请让目标 Claude 会话执行 connect；若 /status 没有 Peer address，当前会话尚未启用原生消息入口。",
    );
  if (platform === "win32") {
    if (!socket.startsWith("\\\\.\\pipe\\"))
      throw new Error("Windows Claude 收件地址必须是本机命名管道");
    if (!token)
      throw new Error(
        "缺少目标会话导出的 CLAUDE_CODE_MESSAGING_TOKEN；不会读取或猜测其他会话的认证信息。",
      );
  } else if (!socket.startsWith("/"))
    throw new Error("Claude 收件地址必须是本机绝对 Unix socket 路径");
}

export function writeClaude({ socket, token, text, signal }) {
  validateClaudeAddress(socket, token);
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const connection = net.createConnection(socket);
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      connection.destroy();
      if (error) reject(error);
      else
        resolve({
          transport: "claude-inbox",
          detail: "已写入原生入口，等待 agent 确认",
        });
    };
    const abort = () => finish(signal.reason);
    const timer = setTimeout(
      () => finish(new Error("Claude 原生收件入口写入超时")),
      10000,
    );
    signal?.addEventListener("abort", abort, { once: true });
    connection.on("error", (error) =>
      finish(
        new Error(`Claude 原生收件入口不可达：${error.code ?? "连接错误"}`),
      ),
    );
    connection.on("close", () => {
      if (!settled)
        finish(new Error("Claude 原生收件入口提前关闭；消息未确认"));
    });
    connection.on("connect", () => {
      const auth = token ? JSON.stringify({ type: "auth", token }) + "\n" : "";
      // Envelope verified against the installed Claude 2.1.238 inbox injection example.
      const message = JSON.stringify({
        type: "user",
        message: { role: "user", content: text },
      });
      connection.end(auth + message + "\n", () => finish());
    });
  });
}

export async function listenNative(
  client,
  participant,
  {
    program,
    thread,
    endpoint,
    socket,
    token,
    signal,
    maxMessages = 20,
    onReady = () => {},
  },
) {
  if (!Number.isSafeInteger(maxMessages) || maxMessages < 1)
    throw new Error("maxMessages 必须为正整数");
  if (participant.kind === "codex") {
    if (!thread)
      throw new Error(
        "请传 --thread 指定目标 Codex 会话，或在目标会话内运行以取得 CODEX_THREAD_ID",
      );
  } else if (participant.kind === "claude")
    validateClaudeAddress(socket, token);
  else throw new Error("原生通知仅支持 codex / claude");
  let count = 0;
  for await (const { event, data } of client.events(
    `/api/bridge/events?as=${encodeURIComponent(participant.id)}&kind=${participant.kind}-native`,
    signal,
  )) {
    if (event === "stopped") return;
    if (event === "ready") {
      onReady();
      continue;
    }
    if (event !== "message") continue;
    const inbox = await client.request(
      `/api/inbox?as=${encodeURIComponent(participant.id)}`,
    );
    const pending = inbox.notifications.find(
      (m) => m.id === data.id && m.topic_status === "open",
    );
    if (!pending) continue;
    if (count >= maxMessages)
      throw new Error(`本次已通知 ${maxMessages} 条消息，请检查讨论后重新连接`);
    try {
      const text = notificationText(data, participant.id, client.url);
      if (participant.kind === "codex")
        await queueCodex(program, { thread, endpoint, text, signal });
      else await writeClaude({ socket, token, text, signal });
      await client.request(`/api/deliveries/${data.id}`, {
        as: participant.id,
      });
      count++;
      console.error(`消息 #${data.id} 已递交原生入口；阅读确认由原会话完成`);
    } catch (error) {
      if (error.status === 404) {
        console.error(`消息 #${data.id} 所属主题已删除，继续等待其他主题`);
        continue;
      }
      await client
        .request(`/api/deliveries/${data.id}`, {
          as: participant.id,
          error: error.message.slice(0, 2000),
        })
        .catch(() => {});
      throw error;
    }
  }
}
