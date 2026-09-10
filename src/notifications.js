import { agentCommand } from "./connect.js";
import {
  notificationText,
  queueCodex,
  validateClaudeAddress,
  writeClaude,
} from "./native.js";
import { HttpError, required, number } from "./store.js";

// Session addresses and credentials belong to this service lifetime, never SQLite or public state.
export class NativeRecipients {
  constructor(store, url, changed, codexApp) {
    this.store = store;
    this.url = url;
    this.changed = changed;
    this.codexApp = codexApp;
    this.routes = new Map();
    this.stopping = false;
  }
  async prepare(participant, input, { desktop = false } = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new HttpError(400, "notification 必须是会话入口对象");
    if (!["codex", "claude"].includes(participant.kind))
      throw new HttpError(400, "此身份不支持原生通知");
    const target = {
      kind: participant.kind,
      token: null,
      maxMessages: number(input.maxMessages ?? 20, "maxMessages", 1),
    };
    if (input.token !== undefined)
      target.token = required(input.token, "token", 16000);
    if (participant.kind === "codex") {
      target.thread = required(input.thread, "thread");
      if (desktop) {
        if (input.endpoint) throw new HttpError(409, "App 创建的任务不使用独立 App Server 地址");
        try { this.codexApp.assertNewTarget(target.thread); }
        catch (error) { throw new HttpError(409, error.message); }
        target.transport = "desktop-app";
        return target;
      }
      if (input.endpoint) {
        let url;
        try {
          url = new URL(input.endpoint);
        } catch {
          throw new HttpError(400, "endpoint 无效");
        }
        if (
          !["ws:", "wss:"].includes(url.protocol) ||
          url.username ||
          url.password
        )
          throw new HttpError(400, "endpoint 必须是不含凭据的 WebSocket 地址");
        target.endpoint = url.href;
      }
      try {
        target.program = await agentCommand("codex", { bin: input.agentBin });
      } catch {
        throw new HttpError(
          400,
          "服务无法找到 Codex 程序，请检查安装或 --agent-bin",
        );
      }
    } else {
      target.socket = required(input.socket, "socket", 2000);
      try {
        validateClaudeAddress(target.socket, target.token);
      } catch {
        throw new HttpError(
          400,
          "Claude 原生入口无效；请在目标会话内加入，提供自身消息地址和认证信息",
        );
      }
    }
    return target;
  }
  join(topic, id, target) {
    if (this.stopping) throw new HttpError(503, "服务正在停止");
    const old = this.routes.get(id);
    if (old?.status === "stopping")
      throw new HttpError(409, "此身份通知正在停止");
    if (old && JSON.stringify(old.target) !== JSON.stringify(target))
      throw new HttpError(409, "此身份已登记另一入口，请先停止原身份通知");
    const member = this.store.join(topic, id);
    if (old?.status === "ready") return member;
    this.routes.set(id, {
      target,
      status: "ready",
      registered_at: new Date().toISOString(),
      sent: new Set(),
      count: 0,
      controller: new AbortController(),
      task: null,
    });
    return member;
  }
  status() {
    return [...this.routes].map(([id, route]) => ({
      participant_id: id,
      kind: route.target.kind,
      status: route.status,
      registered_at: route.registered_at,
      error: route.error ?? null,
    }));
  }
  async remove(id) {
    const route = this.routes.get(id);
    if (!route) return false;
    route.status = "stopping";
    route.controller.abort(new Error("通知已停止"));
    await route.task;
    this.routes.delete(id);
    return true;
  }
  dispatch() {
    if (this.stopping) return;
    for (const [id, route] of this.routes) {
      if (route.task || route.status !== "ready") continue;
      route.task = this.deliver(id, route).finally(() => {
        route.task = null;
      });
    }
  }
  cancelTopic(topic) {
    for (const route of this.routes.values()) {
      if (route.delivery?.topic === topic)
        route.delivery.controller.abort(new Error("主题已删除"));
    }
  }
  async deliver(id, route) {
    while (!route.controller.signal.aborted) {
      const message = this.store
        .inbox(id)
        .notifications.find(
          (m) => m.topic_status === "open" && !route.sent.has(m.id),
        );
      if (!message) return;
      route.sent.add(message.id);
      const controller = new AbortController();
      const signal = AbortSignal.any([
        route.controller.signal,
        controller.signal,
      ]);
      route.delivery = { topic: message.topic_id, controller };
      try {
        if (route.count >= route.target.maxMessages)
          throw new Error("本次通知已达上限；检查讨论后重新加入主题可继续");
        const text = notificationText(
          { ...message, topic: this.store.topic(message.topic_id) },
          id,
          this.url(),
        );
        if (route.target.transport === "desktop-app")
          await this.codexApp.send(route.target.thread, text, { signal });
        else if (route.target.kind === "codex")
          await queueCodex(route.target.program, {
            ...route.target,
            text,
            signal,
          });
        else await writeClaude({ ...route.target, text, signal });
        // Deletion may have committed while the transport was completing.
        signal.throwIfAborted();
        this.store.delivery(message.id, id);
        route.count++;
        this.changed();
      } catch (error) {
        if (route.controller.signal.aborted) return;
        if (controller.signal.aborted) continue;
        let detail = error.message;
        if (route.target.token)
          detail = detail.replaceAll(route.target.token, "[redacted]");
        route.status = "error";
        route.error = detail.slice(0, 2000);
        this.store.delivery(message.id, id, route.error);
        this.changed();
        return;
      } finally {
        route.delivery = null;
      }
    }
  }
  async close() {
    this.stopping = true;
    for (const route of this.routes.values())
      route.controller.abort(new Error("服务停止"));
    await Promise.all([...this.routes.values()].map((r) => r.task));
    this.routes.clear();
  }
}

export function sessionNotification(
  participant,
  options = {},
  env = process.env,
) {
  if (options.manual || !["codex", "claude"].includes(participant.kind))
    return undefined;
  if (participant.kind === "codex") {
    const thread = options.thread ?? env.CODEX_THREAD_ID;
    if (!thread)
      throw new Error(
        "请在目标 Codex 会话内加入主题，或明确传 --thread；仅手动收信用 --manual",
      );
    return {
      thread,
      endpoint: options.endpoint,
      token: env.MAILBOX_CODEX_TOKEN,
      agentBin: options.agentBin ?? env.MAILBOX_CODEX_BIN,
      maxMessages: options.maxMessages,
    };
  }
  const socket = options.socket ?? env.CLAUDE_CODE_MESSAGING_SOCKET;
  const token = env.CLAUDE_CODE_MESSAGING_TOKEN;
  validateClaudeAddress(socket, token);
  return { socket, token, maxMessages: options.maxMessages };
}
