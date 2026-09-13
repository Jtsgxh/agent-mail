import net from "node:net";
import { randomUUID } from "node:crypto";
import { endianness } from "node:os";
import { isAbsolute, relative, sep } from "node:path";
import { nativeConnectFailure } from "./notification-recovery.js";

const littleEndian = endianness() === "LE";
const maxFrame = 8 * 1024 * 1024;
const allowedTools = new Set([
  "list_projects", "create_thread", "send_message_to_thread",
  "list_threads", "create_sidebar_section", "move_thread_to_sidebar_section",
]);
const sidebarName = "Agent Mailbox";

// This is the installed desktop App's native tools protocol, not a TCP App Server.
// Keep the real caller context; the App resolves it and applies its normal task permissions.
export function appContext(env = process.env) {
  return { pipe: env.CODEX_APP_TOOLS_PIPE_PATH, threadId: env.CODEX_THREAD_ID };
}

function validateContext(context) {
  if (!context?.pipe || !context.threadId)
    throw new Error("请在当前 Codex App 的任务中执行 mailbox codex app connect，将此 App 接入信箱");
  if (typeof context.pipe !== "string" || context.pipe.length > 2000 ||
      (process.platform === "win32" ? !context.pipe.startsWith("\\\\.\\pipe\\") : !isAbsolute(context.pipe)))
    throw new Error("Codex App 入口必须是本机管道");
  if (typeof context.threadId !== "string" || context.threadId.length > 200)
    throw new Error("Codex App 调用任务 ID 无效");
}

function frame(value) {
  const body = Buffer.from(JSON.stringify(value));
  if (body.length > maxFrame) throw new Error("Codex App 请求过大");
  const header = Buffer.alloc(4);
  if (littleEndian) header.writeUInt32LE(body.length);
  else header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

export function appRequest(context, method, params, { signal, timeout = 30000 } = {}) {
  validateContext(context);
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const socket = net.createConnection(context.pipe);
    let buffer = Buffer.alloc(0), settled = false, sent = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      socket.destroy();
      if (error) reject(error); else resolve(result);
    };
    const cancel = (error) => {
      if (sent && !socket.destroyed)
        socket.write(frame({ jsonrpc: "2.0", id, method: "tools/cancel" }));
      finish(error);
    };
    const abort = () => cancel(signal.reason);
    const timer = setTimeout(() => cancel(new Error("Codex App 调用超时；创建结果可能已生效，请检查原记录，不要重复创建")), timeout);
    signal?.addEventListener("abort", abort, { once: true });
    socket.on("error", (error) => finish(nativeConnectFailure(
      `无法连接当前 Codex App（${error.code ?? "连接失败"}）；请确认 App 已打开并重新接入`, error, sent,
    )));
    socket.on("close", () => finish(new Error("Codex App 连接提前关闭，调用结果未确认")));
    socket.on("connect", () => {
      try {
        socket.write(frame({ jsonrpc: "2.0", id, method, params }));
        sent = true;
      } catch (error) { finish(error); }
    });
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (!settled && buffer.length >= 4) {
        const length = littleEndian ? buffer.readUInt32LE() : buffer.readUInt32BE();
        if (!length || length > maxFrame) return finish(new Error("Codex App 返回了不支持的消息帧"));
        if (buffer.length < length + 4) return;
        let message;
        try { message = JSON.parse(buffer.subarray(4, length + 4).toString("utf8")); }
        catch { return finish(new Error("Codex App 返回了无效 JSON")); }
        buffer = buffer.subarray(length + 4);
        if (!message || typeof message !== "object" || Array.isArray(message))
          return finish(new Error("Codex App 返回了无效 RPC 消息"));
        if (message.id !== id) continue;
        if (message.error) return finish(new Error("Codex App 拒绝调用；请确认调用任务仍可用及 App 工具权限"));
        finish(null, message.result);
      }
    });
  });
}

export class CodexApp {
  constructor({ env = process.env } = {}) {
    this.context = appContext(env);
    this.sidebarSetups = new Map();
  }
  async call(tool, args, options = {}) {
    if (!allowedTools.has(tool)) throw new Error("不支持的 Codex App 操作");
    const context = options.context ?? this.context;
    // The bundled MCP adapter uses these independent IDs when executor turn IDs are absent.
    const result = await appRequest(context, "tools/call", {
      namespace: "codex_app", tool, arguments: args,
      threadId: context.threadId,
      callId: `mcp-call-${randomUUID()}`, turnId: `mcp-turn-${randomUUID()}`,
    }, options);
    if (result?.success !== true)
      throw new Error("Codex App 未确认操作成功；请在 App 检查任务和权限，信箱不会自动重试");
    try {
      const items = result.contentItems.filter((item) => item.type === "inputText");
      if (items.length !== 1) throw new Error("unsupported result");
      return JSON.parse(items[0].text);
    } catch { throw new Error("无法识别 Codex App 返回结果，请检查 App 版本兼容性"); }
  }
  async projects(options = {}) {
    const result = await this.call("list_projects", {}, options);
    if (!Array.isArray(result?.projects)) throw new Error("Codex App 项目列表格式不兼容");
    return result.projects;
  }
  async sidebarSections(options = {}) {
    const result = await this.call("list_threads", { limit: 1 }, options);
    if (!Array.isArray(result?.sections)) throw new Error("当前 Codex App 未提供侧栏分组信息");
    return result.sections;
  }
  async prepareSidebar(options = {}) {
    // Only setup/creation prepares a group. Joining reuses it, so simultaneous new
    // tasks cannot each create a separate group in their own CLI processes.
    const context = options.context ?? this.context;
    options = { ...options, context };
    if (this.sidebarSetups.has(context.pipe)) return this.sidebarSetups.get(context.pipe);
    const task = (async () => {
      const sections = await this.sidebarSections(options);
      const matches = sections.filter((section) => section.name === sidebarName);
      if (matches.length > 1) throw new Error("Codex App 有多个 Agent Mailbox 分组，请先保留一个明确的目标分组");
      if (matches.length === 1) return matches[0];
      const created = await this.call("create_sidebar_section", { name: sidebarName }, options);
      if (typeof created?.sectionId !== "string" || !created.sectionId || created.name !== sidebarName)
        throw new Error("Codex App 未确认创建侧栏分组，请检查 App，不要重复创建");
      return created;
    })();
    this.sidebarSetups.set(context.pipe, task);
    try { return await task; }
    finally { if (this.sidebarSetups.get(context.pipe) === task) this.sidebarSetups.delete(context.pipe); }
  }
  async showInSidebar(thread, options = {}) {
    if (typeof thread !== "string" || !thread) throw new Error("缺少正式 Codex 任务 ID");
    const sections = await this.sidebarSections(options);
    const key = `codex:thread:local:${thread}`;
    // Preserve a placement the user has already chosen, including pinned tasks.
    const existing = sections.find((section) => section.itemKeys?.includes(key));
    if (existing) return { threadId: thread, hostId: "local", sectionId: existing.sectionId };
    const matches = sections.filter((section) => section.name === sidebarName);
    if (matches.length !== 1)
      throw new Error("需要唯一的 Agent Mailbox 侧栏分组；请先在 App 任务中执行 mailbox codex app connect");
    const sectionId = matches[0].sectionId;
    const moved = await this.call("move_thread_to_sidebar_section", { threadId: thread, hostId: "local", sectionId }, options);
    if (moved?.threadId !== thread || moved.hostId !== "local" || moved.sectionId !== sectionId)
      throw new Error("Codex App 未确认任务的侧栏归属，请检查原任务，不要重新创建");
    return moved;
  }
  async probe(context) {
    validateContext(context);
    const tools = await appRequest(context, "tools/list", { threadStartKind: "all" }, { timeout: 5000 });
    if (![...allowedTools].every((name) => tools?.tools?.some((tool) => tool.namespace === "codex_app" && tool.name === name)))
      throw new Error("当前 Codex App 未提供所需任务工具，请检查 App 版本");
    await this.projects({ context, timeout: 5000 });
    return { status: "reachable", transport: "desktop-app", checked_at: new Date().toISOString(), error: null };
  }
  async connect(context = this.context) {
    const result = await this.probe(context);
    await this.prepareSidebar({ context });
    this.context = { pipe: context.pipe, threadId: context.threadId };
    return result;
  }
  async status() {
    try { return await this.probe(this.context); }
    catch (error) {
      return {
        status: this.context.pipe && this.context.threadId ? "unreachable" : "unconfigured",
        transport: "desktop-app", checked_at: new Date().toISOString(), error: error.message,
      };
    }
  }
  assertNewTarget(thread, context = this.context) {
    if (typeof thread !== "string" || !thread || thread === context.threadId)
      throw new Error("Codex App 返回了无效的新任务 ID；不能将创建请求或信件发给调用任务");
  }
  async send(thread, prompt, options = {}) {
    if (options.context) {
      validateContext(options.context);
      if (thread !== options.context.threadId)
        throw new Error("已登记的桌面入口只能向自身任务递交通知");
    } else this.assertNewTarget(thread);
    const result = await this.call("send_message_to_thread", { threadId: thread, hostId: "local", prompt }, options);
    if (result?.threadId !== thread)
      throw new Error("Codex App 未确认向绑定任务递交消息，请检查原任务，不要重投");
    return result;
  }
}

export function projectTarget(projects, cwd) {
  const matches = projects.filter((project) => {
    if (project.projectKind !== "local" || project.hostId !== "local" || !project.path) return false;
    const child = relative(project.path, cwd);
    return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`));
  }).sort((a, b) => b.path.length - a.path.length);
  const project = matches[0];
  if (!project || typeof project.isGitRepository !== "boolean")
    throw new Error("请先将 --cwd 对应目录添加为 Codex App 项目，再创建讨论任务");
  return { type: "project", projectId: project.projectId, environment: { type: project.isGitRepository ? "worktree" : "local" } };
}
