import WebSocket from "ws";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function safeUrl(value, path) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash ||
      !(url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) ||
      !path.test(url.pathname)) throw new Error("Use HTTPS or loopback HTTP without URL credentials");
  return url;
}

export function validateNotifierConfig(config) {
  const mailbox = safeUrl(config.mailboxUrl, /^\/mcp$/);
  const webhook = safeUrl(config.paperclipWebhookUrl, /^\/api\/routine-triggers\/public\/[^/]+\/fire$/);
  if (!/^amb_[A-Za-z0-9_-]{43}$/.test(config.mailboxToken ?? "") ||
      !uuid.test(config.projectId ?? "") || !uuid.test(config.participantId ?? "") ||
      typeof config.webhookSecret !== "string" || !config.webhookSecret.trim() ||
      typeof config.statePath !== "string" || !config.statePath) throw new Error("Incomplete notifier configuration");
  const socket = new URL(mailbox);
  socket.protocol = mailbox.protocol === "https:" ? "wss:" : "ws:";
  socket.pathname = "/mcp/events";
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
  let socket, connected = false, stopping = false;
  const status = () => ({ connected,
    counts: db.prepare("SELECT status,COUNT(*) AS count FROM notifier_events GROUP BY status").all() });
  const emit = (type, extra = {}) => onState({ type, ...extra });
  const pause = (ms) => delay(ms, undefined, { signal: combined }).catch(() => {});

  async function listen() {
    let failures = 0;
    while (!combined.aborted) {
      await new Promise((resolve) => {
        let ready = false, lastSeen = Date.now();
        socket = new WebSocket(urls.socket, { headers: { Authorization: `Bearer ${config.mailboxToken}` },
          handshakeTimeout: 10000, maxPayload: 8192, followRedirects: false });
        const current = socket;
        const abort = () => current.terminate();
        combined.addEventListener("abort", abort, { once: true });
        const watchdog = setInterval(() => {
          if (Date.now() - lastSeen > (ready ? 45000 : 10000)) current.terminate();
        }, 1000);
        current.on("ping", () => { lastSeen = Date.now(); });
        current.on("error", () => {}); // Never log library errors containing endpoint/headers.
        current.on("message", (raw) => {
          try {
            const event = JSON.parse(raw.toString());
            if (event.version !== 1 || event.projectId !== config.projectId || event.participantId !== config.participantId)
              throw new Error("scope");
            lastSeen = Date.now();
            if (event.type === "mailbox.ready") {
              ready = true; connected = true; failures = 0; emit("connected"); return;
            }
            if (!ready || event.type !== "mailbox.message" || !uuid.test(event.topicId ?? "") ||
                !Number.isSafeInteger(event.messageId) || event.messageId < 1) throw new Error("event");
            const payload = { type: "mailbox.message", version: 1, projectId: config.projectId,
              participantId: config.participantId, topicId: event.topicId, messageId: event.messageId };
            const id = "mailbox:" + createHash("sha256").update(binding).update(":" + event.messageId).digest("hex");
            const saved = db.prepare("INSERT OR IGNORE INTO notifier_events(id,payload) VALUES (?,?)")
              .run(id, JSON.stringify(payload));
            if (saved.changes) emit("received", { messageId: event.messageId });
          } catch { emit("invalid_event"); current.close(1008, "Invalid notification"); }
        });
        current.once("close", () => {
          connected = false; clearInterval(watchdog); combined.removeEventListener("abort", abort);
          emit("disconnected"); resolve();
        });
        if (combined.aborted) abort();
      });
      if (!combined.aborted) await pause(Math.min(60000, retryMs * 2 ** Math.min(failures++, 6)));
    }
  }

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
  // Surface unexpected bugs to the caller rather than losing a background promise.
  done.catch(() => stop.abort());
  return { status, done, async close() {
    if (stopping) return done;
    stopping = true; stop.abort(); socket?.terminate();
    try { await done; } finally { db.close(); }
  } };
}
