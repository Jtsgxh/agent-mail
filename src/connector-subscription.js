import WebSocket from "ws";
import { setTimeout as delay } from "node:timers/promises";

// Client side of the connector's notification-only `/mcp/events` stream, shared by the local receivers
// (Paperclip notifier, chat wake). Events carry identifiers only; bodies and mutations stay on project MCP.

export const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const connectorToken = /^amb_[A-Za-z0-9_-]{43}$/;
export const redactCredentials = (text) => text.replace(/Bearer\s+\S+|amb_[A-Za-z0-9_-]{43}/g, "[redacted]");

export function secureUrl(value, path) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || !path.test(url.pathname) ||
      !(url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))))
    throw new Error("Use HTTPS or loopback HTTP without URL credentials");
  return url;
}

// The project MCP endpoint and the event stream served beside it.
export function connectorUrls(value) {
  const mcp = secureUrl(value, /^\/mcp$/);
  const events = new URL(mcp);
  events.protocol = mcp.protocol === "https:" ? "wss:" : "ws:";
  events.pathname = "/mcp/events";
  return { mcp, events };
}

// Stays subscribed until `signal` aborts (resolves). Rejects when the connector refuses or revokes the key, sends an
// event outside the configured identity, or `retryDelay(attempt)` returns undefined. Every connection replays all
// unacknowledged directed messages, so `onMessage` must deduplicate by messageId.
export async function subscribeConnectorEvents({ url, authorization, participantId, projectId, signal, retryDelay,
  onReady = () => {}, onMessage, onDisconnect = () => {} }) {
  let attempt = 0;
  while (!signal.aborted) {
    const { readyAt, error } = await connectOnce({ url, authorization, participantId, projectId, signal, onReady, onMessage, onDisconnect });
    if (error) throw error;
    if (signal.aborted) return;
    // Only a connection that stayed up resets the backoff, so a flapping endpoint cannot loop fast.
    if (readyAt && Date.now() - readyAt >= 30000) attempt = 0;
    const wait = retryDelay(attempt++);
    if (wait === undefined) throw new Error("Notification connection lost; reconnect limit reached");
    await delay(wait, undefined, { signal }).catch(() => {});
  }
}

function connectOnce({ url, authorization, participantId, projectId, signal, onReady, onMessage, onDisconnect }) {
  return new Promise((resolve) => {
    let readyAt = 0, lastSeen = Date.now(), error = null;
    const ws = new WebSocket(url, { headers: { Authorization: authorization },
      handshakeTimeout: 10000, maxPayload: 8192, followRedirects: false });
    const abort = () => ws.terminate();
    signal.addEventListener("abort", abort, { once: true });
    const watchdog = setInterval(() => { if (Date.now() - lastSeen > (readyAt ? 45000 : 12000)) ws.terminate(); }, 1000);
    ws.on("ping", () => { lastSeen = Date.now(); });
    ws.on("error", () => {}); // Library diagnostics can contain credential headers.
    ws.on("unexpected-response", (_, res) => {
      res.resume();
      if ([401, 403, 404].includes(res.statusCode)) error = new Error(`Notification endpoint rejected connection (${res.statusCode})`);
      ws.terminate();
    });
    ws.on("message", (raw) => {
      try {
        let event;
        try { event = JSON.parse(raw.toString()); } catch { throw new Error("Invalid notification envelope"); }
        if (event?.version !== 1 || event.participantId !== participantId || event.projectId !== projectId)
          throw new Error("Notification scope does not match configured identity");
        lastSeen = Date.now();
        if (event.type === "mailbox.ready") { readyAt = Date.now(); onReady(); return; }
        if (!readyAt || event.type !== "mailbox.message" || !uuid.test(event.topicId ?? "") ||
            !Number.isSafeInteger(event.messageId) || event.messageId < 1) throw new Error("Invalid notification envelope");
        onMessage({ topicId: event.topicId, messageId: event.messageId });
      } catch (e) { error ??= e; ws.terminate(); }
    });
    ws.once("close", (code) => {
      clearInterval(watchdog);
      signal.removeEventListener("abort", abort);
      if (code === 1008 && !signal.aborted) error ??= new Error("Notification authorization revoked");
      onDisconnect();
      resolve({ readyAt, error });
    });
    if (signal.aborted) abort();
  });
}
