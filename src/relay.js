import { DatabaseSync } from "node:sqlite";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CodexApp, appContext } from "./codex-app.js";
import { notificationText } from "./native.js";
import { notificationRetryDelays } from "./notification-recovery.js";

// 本地只保存任务绑定和投递状态，原始 App 管道始终只留在进程内存。
export function relayStatePath(env = process.env) {
  if (env.MAILBOX_RELAY_DB) return resolve(env.MAILBOX_RELAY_DB);
  const base = env.LOCALAPPDATA || env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(base, "AgentMailbox", "relay.db");
}

// 订阅远端 HTTP，由本机 App 或 MCP 队列入口唤醒绑定任务，绝不上传管道信息。
export async function runRelay(client, participant, {
  env = process.env, signal, topic,
  onReady = () => {}, onRetry = () => {},
  retryDelays = notificationRetryDelays, wake,
} = {}) {
  if (participant.kind !== "codex") throw new Error("远端转发目前只支持 Codex");
  signal?.throwIfAborted();
  const context = wake ? { threadId: wake.threadId } : appContext(env);
  const app = wake ? null : new CodexApp({ env });
  if (!wake) await app.probe(context);
  const statePath = relayStatePath(env);
  await mkdir(dirname(statePath), { recursive: true });
  const db = new DatabaseSync(statePath);
  let reconnects = 0;
  try {
    db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS bindings (
        origin TEXT, participant TEXT, thread TEXT NOT NULL,
        PRIMARY KEY(origin,participant));
      CREATE TABLE IF NOT EXISTS deliveries (
        origin TEXT, participant TEXT, message INTEGER, status TEXT NOT NULL,
        PRIMARY KEY(origin,participant,message));`);
    db.prepare("INSERT OR IGNORE INTO bindings VALUES (?,?,?)")
      .run(client.url, participant.id, context.threadId);
    const binding = db.prepare("SELECT thread FROM bindings WHERE origin=? AND participant=?")
      .get(client.url, participant.id);
    if (binding.thread !== context.threadId)
      throw new Error("此信箱身份已绑定另一 Codex 任务，请使用本会话自己的身份");
    if (topic)
      await client.request(`/api/topics/${encodeURIComponent(topic)}/members`, { as: participant.id }, "POST", { signal });
    const query = new URLSearchParams({ as: participant.id, kind: "codex-remote-relay" });
    while (!signal?.aborted) {
      let transportError, connectedAt = 0;
      const events = client.events(`/api/bridge/events?${query}`, signal, {
        connectTimeout: 10000, idleTimeout: 45000,
      });
      try {
        while (!signal?.aborted) {
          let item;
          try { item = await events.next(); }
          catch (error) { transportError = error; break; }
          if (item.done) { transportError = new Error("信箱事件连接结束"); break; }
          const { event, data } = item.value;
          if (event === "stopped") return;
          if (event === "ready") {
            connectedAt = Date.now();
            await onReady();
            continue;
          }
          if (event !== "message") continue;
          // SSE 重放后重新查收件箱，暂停、已确认和已提交的消息均不重复唤醒。
          for (let attempt = 0; ; attempt++) {
            let pending;
            try {
              const inbox = await client.request(`/api/inbox?as=${encodeURIComponent(participant.id)}`,
                undefined, "GET", { signal });
              pending = inbox.notifications.find((message) => message.id === data.id && message.topic_status === "open");
            } catch (error) { transportError = error; break; }
            if (!pending || pending.notified_at) break;
            const previous = db.prepare("SELECT status FROM deliveries WHERE origin=? AND participant=? AND message=?")
              .get(client.url, participant.id, data.id);
            let submitted = previous?.status === "submitted";
            if (!submitted) {
              // 提交前先持久化占位；崩溃或提交结果不明时，重启也不能盲目再次唤醒。
              const claimed = previous
                ? db.prepare("UPDATE deliveries SET status='pending' WHERE origin=? AND participant=? AND message=? AND status='retryable'")
                  .run(client.url, participant.id, data.id)
                : db.prepare("INSERT OR IGNORE INTO deliveries VALUES (?,?,?,'pending')")
                  .run(client.url, participant.id, data.id);
              if (!claimed.changes)
                throw new Error(`消息 #${data.id} 的上次提交结果不明，请先检查原任务，禁止自动重投`);
              try {
                if (wake) await wake.send(signal);
                else await app.send(context.threadId,
                    notificationText({ ...pending, topic: data.topic }, participant.id, client.url, { httpOnly: true }),
                    { context, signal });
                db.prepare("UPDATE deliveries SET status='submitted' WHERE origin=? AND participant=? AND message=?")
                  .run(client.url, participant.id, data.id);
                submitted = true;
              } catch (error) {
                if (error.retryableNotification)
                  db.prepare("UPDATE deliveries SET status='retryable' WHERE origin=? AND participant=? AND message=?")
                    .run(client.url, participant.id, data.id);
                await client.request(`/api/deliveries/${data.id}`, {
                  as: participant.id, error: error.message.slice(0, 2000),
                }, "POST", { signal }).catch(() => {});
                const wait = error.retryableNotification ? retryDelays[attempt] : undefined;
                if (wait === undefined) throw error;
                await onRetry({ message: data.id, delay: wait });
                await delay(wait, undefined, { signal });
                continue;
              }
            }
            if (submitted) {
              try {
                await client.request(`/api/deliveries/${data.id}`, { as: participant.id }, "POST", { signal });
                reconnects = 0;
              } catch (error) {
                // 主题删除不影响其他主题；HTTP 回执丢失时只重试回执，不能重发 App 消息。
                if (error.status !== 404) transportError = error;
              }
            }
            break;
          }
          if (transportError) break;
        }
      } finally {
        await events.return();
      }
      signal?.throwIfAborted();
      if (!transportError) return;
      if (connectedAt && Date.now() - connectedAt >= 30000) reconnects = 0;
      // 409 可能是上一次断流尚未释放，有限等待；其他客户端错误直接报告。
      if (transportError.status && transportError.status < 500 && transportError.status !== 409)
        throw transportError;
      const wait = retryDelays[reconnects++];
      if (wait === undefined) throw transportError;
      await onRetry({ delay: wait });
      await delay(wait, undefined, { signal });
    }
  } finally {
    db.close();
  }
}
