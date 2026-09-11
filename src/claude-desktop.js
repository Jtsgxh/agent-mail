import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export const claudeDesktopAction =
  "请在 Claude 桌面确认项目目录并发送预填指令；新会话将自行加入信箱。已发送则检查该会话的接入结果，不要重复创建。";

export function claudeDesktopLink(cwd, prompt) {
  // Desktop truncates q at roughly 14,000 characters. Reject instead of losing join instructions.
  if (prompt.length > 12000) throw new Error("Claude 桌面启动指令过长，请缩短路径后重试");
  const url = new URL("claude://code/new");
  url.searchParams.set("q", prompt);
  url.searchParams.set("folder", cwd);
  // Also keep the Windows environment value below its 32,767 character limit.
  if (url.href.length > 30000) throw new Error("Claude 桌面链接过长，请缩短路径后重试");
  return url.href;
}

export async function openClaudeDesktop(url, {
  signal, platform = process.platform, run = exec, env = process.env,
} = {}) {
  const parsed = new URL(url);
  if (parsed.protocol !== "claude:" || parsed.hostname !== "code" || parsed.pathname !== "/new" || parsed.username || parsed.password)
    throw new Error("无效的 Claude 桌面创建链接");
  const childEnv = { ...env };
  delete childEnv.CODEX_THREAD_ID;
  delete childEnv.CLAUDE_CODE_MESSAGING_SOCKET;
  delete childEnv.CLAUDE_CODE_MESSAGING_TOKEN;
  let command, args;
  if (platform === "win32") {
    command = "powershell.exe";
    // The URL is data, never interpolated into PowerShell source or a cmd.exe command.
    childEnv.MAILBOX_CLAUDE_DESKTOP_URL = url;
    args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      "Start-Process -FilePath $env:MAILBOX_CLAUDE_DESKTOP_URL -ErrorAction Stop"];
  } else if (platform === "darwin") {
    command = "open";
    args = [url];
  } else if (platform === "linux") {
    command = "xdg-open";
    args = [url];
  } else {
    throw new Error("当前系统不支持 Claude 桌面链接");
  }
  try {
    await run(command, args, { env: childEnv, windowsHide: true, timeout: 15000, signal });
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    // execFile errors can include argv and output. Keep the prompt out of errors.
    throw new Error(`Claude 桌面打开结果未确认 (${error.code ?? "unknown"})；请检查桌面应用安装及 claude:// 协议关联，再查看 session info，不要重复创建`);
  }
}
