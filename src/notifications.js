import { agentCommand } from "./connect.js";
import { appContext } from "./codex-app.js";
import {
  notificationText,
  queueCodex,
  validateClaudeAddress,
  writeClaude,
} from "./native.js";
import { HttpError, required, number } from "./store.js";
import { notificationRetryDelays } from "./notification-recovery.js";

// Session addresses and credentials belong to this service lifetime, never SQLite or public state.
export class NativeRecipients {
  constructor(store, url, changed, codexApp, { retryDelays = notificationRetryDelays } = {}) {
    this.store = store;
    this.url = url;
    this.changed = changed;
    this.codexApp = codexApp;
    this.routes = new Map();
    this.stopping = false;
    this.retryDelays = [...retryDelays];
    this.verifiedDesktopTargets = new WeakMap();
  }
  route(id, target, { registeredAt = new Date().toISOString(), preserveDelivered = false } = {}) {
    const sent = preserveDelivered
      ? new Set(this.store.inbox(id).notifications
        .filter((message) => message.notified_at)
        .map((message) => message.id))
      : new Set();
    const route = {
      registration: Symbol("native recipient"),
      target,
      status: "ready",
      registered_at: registeredAt,
      sent,
      count: 0,
      controller: new AbortController(),
      task: null,
      retryCount: 0,
      retryTimer: null,
      retryAt: null,
      retryMessageId: null,
    };
    this.routes.set(id, route);
    return route;
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
      if (input.app !== undefined) {
        if (input.endpoint) throw new HttpError(409, "桌面任务入口不能同时指定独立 App Server 地址");
        if (input.app?.threadId !== target.thread)
          throw new HttpError(409, "桌面入口必须由目标任务自身登记，不能更换调用任务");
        // Capture only the joining task's own context, never the server's caller.
        // A manually opened App task has no mailbox-created session record.
        target.app = { pipe: input.app.pipe, threadId: input.app.threadId };
        try { await this.codexApp.probe(target.app); }
        catch (error) { throw new HttpError(409, error.message); }
        target.transport = "desktop-app";
        target.token = null;
        const old = this.routes.get(participant.id);
        let staleRegistration;
        if (old?.status === "ready" && !old.task && old.target.transport === "desktop-app" &&
            old.target.thread === target.thread && old.target.app?.pipe !== target.app.pipe) {
          // A new live endpoint alone cannot evict another live endpoint. Probe only
          // the previously registered address, never discover pipes or borrow a caller.
          try { await this.codexApp.probe(old.target.app); }
          catch (error) { if (error.retryableNotification) staleRegistration = old.registration; }
        }
        this.verifiedDesktopTargets.set(target, { ...target.app, staleRegistration });
        return target;
      }
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
    const verified = this.verifiedDesktopTargets.get(target);
    const recoverDesktop = old && !old.task && old.target.kind === "codex" &&
      target.transport === "desktop-app" && target.app && old.target.thread === target.thread &&
      verified?.threadId === target.thread && verified.pipe === target.app.pipe &&
      (["error", "retrying"].includes(old.status) ||
        (verified.staleRegistration !== undefined && verified.staleRegistration === old.registration));
    if (old && !recoverDesktop && JSON.stringify(old.target) !== JSON.stringify(target))
      throw new HttpError(409, "此身份已登记另一入口，请先停止原身份通知");
    if (old?.status === "ready" && !recoverDesktop) return this.store.join(topic, id);
    if (old?.task) throw new HttpError(409, "原入口仍在完成投递，请稍后重新加入");
    const member = this.store.join(topic, id);
    if (old) {
      clearTimeout(old.retryTimer);
      old.controller.abort(new Error("原会话已重新登记入口"));
    }
    this.route(id, target);
    return member;
  }
  async resumeCodex(routes, pipe) {
    const resumed = [];
    for (const persisted of routes) {
      if (persisted.resume_blocked) continue;
      const id = persisted.participant_id;
      const old = this.routes.get(id);
      const target = {
        kind: "codex",
        thread: persisted.native_id,
        token: null,
        maxMessages: persisted.max_messages,
        transport: "desktop-app",
        app: { pipe, threadId: persisted.native_id },
      };
      if (old?.target.transport === "desktop-app" &&
          old.target.thread === target.thread && old.target.app?.pipe === pipe) {
        if (["error", "retrying"].includes(old.status) && !old.task) {
          clearTimeout(old.retryTimer);
          old.status = "ready";
          old.retryAt = null;
          old.retryMessageId = null;
          old.retryCount = 0;
          old.sent = new Set(this.store.inbox(id).notifications
            .filter((message) => message.notified_at)
            .map((message) => message.id));
          resumed.push(id);
        }
        continue;
      }
      if (old?.task) await old.task;
      if (old) {
        clearTimeout(old.retryTimer);
        old.controller.abort(new Error("Codex App 使用路由 cookie 更新了投递地址"));
      }
      this.route(id, target, {
        registeredAt: persisted.updated_at,
        preserveDelivered: true,
      });
      resumed.push(id);
    }
    if (resumed.length) this.changed();
    return resumed;
  }
  status() {
    return [...this.routes].map(([id, route]) => ({
      participant_id: id,
      kind: route.target.kind,
      status: route.status,
      registered_at: route.registered_at,
      error: route.error ?? null,
      retry_at: route.retryAt,
      retry_count: route.retryCount,
      retry_message_id: route.retryMessageId,
    }));
  }
  async remove(id) {
    const route = this.routes.get(id);
    if (!route) return false;
    route.status = "stopping";
    clearTimeout(route.retryTimer);
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
        if (route.status === "retrying" && this.routes.get(id) === route && !this.stopping) {
          route.retryTimer = setTimeout(() => {
            route.retryTimer = null;
            if (this.stopping || this.routes.get(id) !== route || route.status !== "retrying") return;
            route.status = "ready";
            route.retryAt = null;
            this.changed();
          }, Math.max(0, Date.parse(route.retryAt) - Date.now()));
          route.retryTimer.unref();
        }
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
          await this.codexApp.send(route.target.thread, text, { signal, context: route.target.app });
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
        this.store.setNotificationRouteFailure(id, null, false);
        route.count++;
        route.retryCount = 0;
        route.retryAt = null;
        route.retryMessageId = null;
        route.error = null;
        this.changed();
      } catch (error) {
        if (route.controller.signal.aborted) return;
        if (controller.signal.aborted) continue;
        let detail = error.message;
        if (route.target.token)
          detail = detail.replaceAll(route.target.token, "[redacted]");
        route.error = detail.slice(0, 2000);
        const delay = error.retryableNotification ? this.retryDelays[route.retryCount] : undefined;
        if (delay !== undefined) {
          // No bytes were sent: removing this attempt from sent cannot duplicate a turn.
          route.sent.delete(message.id);
          route.retryCount++;
          route.retryAt = new Date(Date.now() + delay).toISOString();
          route.retryMessageId = message.id;
          route.status = "retrying";
        } else {
          route.status = "error";
          route.retryAt = null;
          route.retryMessageId = null;
        }
        this.store.setNotificationRouteFailure(
          id,
          route.error,
          !error.retryableNotification,
        );
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
    for (const route of this.routes.values()) {
      clearTimeout(route.retryTimer);
      route.controller.abort(new Error("服务停止"));
    }
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
    if (!options.endpoint && env.CODEX_APP_TOOLS_PIPE_PATH) {
      const app = appContext(env);
      if (thread !== app.threadId)
        throw new Error("桌面入口必须由目标任务自身登记，不能用 --thread 指向其他任务");
      return { thread, app, maxMessages: options.maxMessages };
    }
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
