import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { connectorToken, connectorUrls, secureUrl, subscribeConnectorEvents, uuid } from "./connector-subscription.js";

export function validateNotifierConfig(config) {
  const { mcp: mailbox, events: socket } = connectorUrls(config.mailboxUrl);
  const webhook = secureUrl(config.paperclipWebhookUrl, /^\/api\/routine-triggers\/public\/[^/]+\/fire$/);
  if (!connectorToken.test(config.mailboxToken ?? "") ||
      !uuid.test(config.projectId ?? "") || !uuid.test(config.participantId ?? "") ||
      typeof config.webhookSecret !== "string" || !config.webhookSecret.trim() ||
      typeof config.statePath !== "string" || !config.statePath) throw new Error("Incomplete notifier configuration");
  return { mailbox, webhook, socket };
}

// Runs beside Paperclip, not in the model. No admin API, mailbox ACK, or message body access.
// Its receipt means Paperclip saved a task, NOT that the model read/replied to mail.
export async function startPaperclipNotifier(config, { signal, onState = () => {}, retryMs = 1000, fetchImpl = fetch } = {}) {
  const urls = validateNotifierConfig(config);
  await mkdir(dirname(config.statePath), { recursive: true });
  const db = new DatabaseSync(config.statePath);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS notifier_binding (id INTEGER PRIMARY KEY CHECK(id=1), binding TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS notifier_events (
      id TEXT PRIMARY KEY, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0,
      issue_id TEXT, run_id TEXT, error TEXT, received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);`);
  const binding = JSON.stringify([urls.mailbox.href, config.projectId, config.participantId, urls.webhook.href]);
  db.prepare("INSERT OR IGNORE INTO notifier_binding VALUES (1,?)").run(binding);
  if (db.prepare("SELECT binding FROM notifier_binding WHERE id=1").get().binding !== binding) {
    db.close(); throw new Error("State database belongs to another mailbox or Paperclip trigger");
  }
  const stop = new AbortController();
  const combined = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal;
  let connected = false, stopping = false;
  const status = () => ({ connected,
    counts: db.prepare("SELECT status,COUNT(*) AS count FROM notifier_events GROUP BY status").all() });
  const emit = (type, extra = {}) => onState({ type, ...extra });
  const pause = (ms) => delay(ms, undefined, { signal: combined }).catch(() => {});

  // A rejected or revoked key ends the process; systemd restarts it and the outbox resumes.
  const listen = () => subscribeConnectorEvents({ url: urls.socket, authorization: `Bearer ${config.mailboxToken}`,
    participantId: config.participantId, projectId: config.projectId, signal: combined,
    retryDelay: (attempt) => Math.min(60000, retryMs * 2 ** Math.min(attempt, 6)),
    onReady: () => { connected = true; emit("connected"); },
    onDisconnect: () => { connected = false; emit("disconnected"); },
    onMessage: ({ topicId, messageId }) => {
      const payload = { type: "mailbox.message", version: 1, projectId: config.projectId,
        participantId: config.participantId, topicId, messageId };
      const id = "mailbox:" + createHash("sha256").update(binding).update(":" + messageId).digest("hex");
      const saved = db.prepare("INSERT OR IGNORE INTO notifier_events(id,payload) VALUES (?,?)")
        .run(id, JSON.stringify(payload));
      if (saved.changes) emit("received", { messageId });
    },
  });

  async function dispatch() {
    while (!combined.aborted) {
      const event = db.prepare("SELECT * FROM notifier_events WHERE status='pending' AND next_at<=? ORDER BY received_at,rowid LIMIT 1").get(Date.now());
      if (!event) { await pause(Math.min(retryMs, 1000)); continue; }
      let result, error, blocked = false;
      try {
        const response = await fetchImpl(urls.webhook, { method: "POST", redirect: "error",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.webhookSecret}`, "Idempotency-Key": event.id },
          body: event.payload, signal: AbortSignal.any([combined, AbortSignal.timeout(15000)]) });
        if (!response.ok) {
          error = `http_${response.status}`;
          // 409 (paused routine) and configuration/auth errors remain pending for operator repair.
          await response.body?.cancel();
        } else {
          result = await response.json();
          if (!["issue_created", "completed"].includes(result.status) || !uuid.test(result.linkedIssueId ?? "")) {
            error = "routine_did_not_create_task";
            // A saved failed/skipped/coalesced run cannot be repaired by changing idempotency keys.
            blocked = true;
          }
        }
      } catch { error = "request_unconfirmed"; }
      if (combined.aborted) break;
      if (!error) {
        db.prepare("UPDATE notifier_events SET status='submitted',issue_id=?,run_id=?,error=NULL WHERE id=?")
          .run(result.linkedIssueId, result.id ?? null, event.id);
        emit("submitted", { messageId: JSON.parse(event.payload).messageId, issueId: result.linkedIssueId, runId: result.id });
      } else {
        const attempts = event.attempts + 1;
        db.prepare("UPDATE notifier_events SET status=?,attempts=?,next_at=?,error=? WHERE id=?")
          .run(blocked ? "blocked" : "pending", attempts, Date.now() + Math.min(300000, retryMs * 2 ** Math.min(attempts, 9)), error, event.id);
        emit(blocked ? "blocked" : "retry", { messageId: JSON.parse(event.payload).messageId, error });
      }
    }
  }
  const done = Promise.all([listen(), dispatch()]);
  // Surface key rejection and unexpected bugs to the caller through `done`; close() always releases the state.
  done.catch(() => stop.abort());
  return { status, done, async close() {
    if (stopping) return done.catch(() => {});
    stopping = true; stop.abort();
    try { await done.catch(() => {}); } finally { db.close(); }
  } };
}
