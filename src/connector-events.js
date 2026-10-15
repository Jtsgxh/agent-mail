import { WebSocketServer, WebSocket } from "ws";

// Notifications contain identifiers only. Message bodies and mutations stay on MCP.
// Reconnect replays every unacknowledged directed message; the consumer owns dedup.
export function attachConnectorEvents(server, { store, connectors, changes, endpoint, heartbeatMs = 15000 }) {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  const upgrade = (req, socket, head) => {
    const reject = (status) => socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    try {
      const target = new URL(req.url, endpoint());
      if (target.pathname !== "/mcp/events" || target.search) return reject("404 Not Found");
      if (req.headers.host !== endpoint().host || (req.headers.origin && req.headers.origin !== endpoint().origin))
        return reject("403 Forbidden");
      const token = /^Bearer (\S+)$/i.exec(req.headers.authorization ?? "")?.[1];
      const grant = connectors.authenticate(token);
      if (sockets.clients.size >= 64) return reject("503 Service Unavailable");
      sockets.handleUpgrade(req, socket, head, (ws) => {
        let alive = true;
        const sent = new Set();
        const send = (value) => {
          if (ws.bufferedAmount > 1024 * 1024) { ws.terminate(); return false; }
          if (ws.readyState !== WebSocket.OPEN) return false;
          ws.send(JSON.stringify(value));
          return true;
        };
        const pump = () => {
          try {
            const current = connectors.authenticate(token);
            const rows = store.db.prepare(`SELECT m.id AS messageId,m.topic_id AS topicId
              FROM deliveries d JOIN messages m ON m.id=d.message_id JOIN topics t ON t.id=m.topic_id
              WHERE d.recipient_id=? AND d.ack_at IS NULL AND t.project_id=? AND t.status='open'
              ORDER BY m.id`).all(current.participant_id, current.project_id);
            const pending = new Set(rows.map((r) => r.messageId));
            for (const id of sent) if (!pending.has(id)) sent.delete(id);
            for (const row of rows) {
              if (sent.has(row.messageId)) continue;
              if (!send({ type: "mailbox.message", version: 1, ...row,
                participantId: current.participant_id, projectId: current.project_id })) break;
              sent.add(row.messageId);
            }
          } catch { ws.close(1008, "Mailbox authorization no longer valid"); }
        };
        ws.on("pong", () => { alive = true; });
        ws.on("error", () => ws.terminate());
        // This channel is notification-only, not an alternate RPC interface.
        ws.on("message", () => ws.close(1008, "Use MCP for mailbox operations"));
        changes.on("change", pump);
        const timer = setInterval(() => {
          if (!alive) return ws.terminate();
          alive = false;
          ws.ping();
          pump(); // Revalidate even when no new mail arrives.
        }, heartbeatMs);
        timer.unref();
        ws.once("close", () => { clearInterval(timer); changes.off("change", pump); });
        send({ type: "mailbox.ready", version: 1, participantId: grant.participant_id, projectId: grant.project_id });
        pump();
      });
    } catch { reject("401 Unauthorized"); }
  };
  server.on("upgrade", upgrade);
  return () => {
    server.off("upgrade", upgrade);
    for (const ws of sockets.clients) ws.terminate();
    sockets.close();
  };
}
