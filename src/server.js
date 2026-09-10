import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { EventEmitter } from "node:events";
import { Store, HttpError, number } from "./store.js";
import { NativeRecipients } from "./notifications.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assets = new Map([
  ["/", ["public/index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["public/app.js", "text/javascript; charset=utf-8"]],
  ["/style.css", ["public/style.css", "text/css; charset=utf-8"]],
  [
    "/vendor/marked.js",
    ["node_modules/marked/lib/marked.umd.js", "text/javascript"],
  ],
  [
    "/vendor/purify.js",
    ["node_modules/dompurify/dist/purify.min.js", "text/javascript"],
  ],
]);

export async function startServer({
  port = 4317,
  dbPath = resolve(root, ".mailbox/mailbox.db"),
} = {}) {
  const store = new Store(dbPath);
  const changes = new EventEmitter();
  changes.setMaxListeners(0);
  const streams = new Set();
  const bridges = new Map();
  const bridgeStreams = new Map();
  const changed = () => {
    changes.emit("change");
    recipients.dispatch();
  };
  const recipients = new NativeRecipients(
    store,
    () => `http://127.0.0.1:${server.address().port}`,
    changed,
  );
  const server = http.createServer(async (req, res) => {
    const send = (data, status = 200) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(data));
    };
    try {
      const host = req.headers.host;
      const actualPort = server.address().port;
      if (
        ![`127.0.0.1:${actualPort}`, `localhost:${actualPort}`].includes(host)
      )
        throw new HttpError(403, "仅允许本机访问");
      if (
        req.headers.origin &&
        ![
          `http://127.0.0.1:${actualPort}`,
          `http://localhost:${actualPort}`,
        ].includes(req.headers.origin)
      ) {
        throw new HttpError(403, "不允许跨站请求");
      }
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'",
      );
      const url = new URL(req.url, `http://${host}`);
      const path = url.pathname;
      const query = Object.fromEntries(url.searchParams);
      let body = {};
      if (["POST", "PATCH"].includes(req.method)) {
        if (!req.headers["content-type"]?.startsWith("application/json"))
          throw new HttpError(415, "需要 application/json");
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 300000) throw new HttpError(413, "请求过大");
          chunks.push(chunk);
        }
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          throw new HttpError(400, "JSON 格式错误");
        }
        if (!body || typeof body !== "object" || Array.isArray(body))
          throw new HttpError(400, "需要 JSON 对象");
      }
      if (
        req.method === "GET" &&
        (path === "/api/events" || path === "/api/bridge/events")
      ) {
        const as = path === "/api/bridge/events" ? query.as : null;
        if (as) {
          store.participant(as);
          if (bridges.has(as) || recipients.routes.has(as))
            throw new HttpError(
              409,
              "此参与者已有桥接连接，请为不同会话创建独立身份",
            );
        } else if (path === "/api/bridge/events")
          throw new HttpError(400, "缺少 as");
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.flushHeaders();
        streams.add(res);
        const emitted = new Set();
        const write = (event, data) => {
          if (!res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
            res.end();
        };
        const update = () => {
          if (res.destroyed || res.writableEnded) return;
          if (!as) return write("change", {});
          for (const m of store.inbox(as).notifications) {
            if (m.topic_status !== "open") {
              emitted.delete(m.id);
              continue;
            }
            if (emitted.has(m.id)) continue;
            emitted.add(m.id);
            write("message", { ...m, topic: store.topic(m.topic_id) });
          }
        };
        if (as)
          bridges.set(as, {
            participant_id: as,
            kind: query.kind ?? "bridge",
            connected_at: new Date().toISOString(),
          });
        changes.on("change", update);
        if (as) bridgeStreams.set(as, res);
        const heartbeat = setInterval(
          () => res.write(": heartbeat\n\n"),
          15000,
        );
        res.on("close", () => {
          clearInterval(heartbeat);
          changes.off("change", update);
          streams.delete(res);
          if (as) {
            bridges.delete(as);
            bridgeStreams.delete(as);
            changed();
          }
        });
        write("ready", { as });
        update();
        changed();
        return;
      }
      if (req.method === "GET" && path === "/api/health")
        return send({ ok: true, version: "0.1.0" });
      const disconnect = path.match(/^\/api\/bridge\/([^/]+)$/);
      if (req.method === "DELETE" && disconnect) {
        store.participant(disconnect[1]);
        if (await recipients.remove(disconnect[1])) {
          changed();
          return send({ participant_id: disconnect[1], status: "stopped" });
        }
        const stream = bridgeStreams.get(disconnect[1]);
        if (!stream) throw new HttpError(409, "该参与者没有活动通知连接");
        stream.end("event: stopped\ndata: {}\n\n");
        return send({ participant_id: disconnect[1], status: "disconnected" });
      }
      if (req.method === "GET" && path === "/api/setup")
        return send({
          node: process.execPath,
          cli: resolve(root, "bin/mailbox.js"),
        });
      if (req.method === "GET" && path === "/api/message-by-request") {
        store.participant(query.as);
        return send(store.byRequest(query.as, query.requestId));
      }
      if (req.method === "GET" && path === "/api/state")
        return send({
          topics: store.topics(),
          projects: store.projects(),
          participants: store.participants(),
          bridges: [...bridges.values()],
          recipients: recipients.status(),
        });
      if (req.method === "GET" && path === "/api/participants")
        return send(store.participants());
      if (req.method === "POST" && path === "/api/participants") {
        const p = store.createParticipant(body);
        changed();
        return send(p, 201);
      }
      if (req.method === "GET" && path === "/api/projects")
        return send(store.projects());
      if (req.method === "POST" && path === "/api/projects") {
        const project = store.createProject(body);
        changed();
        return send(project, 201);
      }
      if (req.method === "GET" && path === "/api/topics")
        return send(
          store.topics(query.project === "unassigned" ? null : query.project),
        );
      if (req.method === "POST" && path === "/api/topics") {
        const t = store.createTopic(body);
        changed();
        return send(t, 201);
      }
      if (req.method === "GET" && path === "/api/inbox")
        return send(store.inbox(query.as));
      const sessionRoute = path.match(
        /^\/api\/topics\/([^/]+)\/sessions\/([^/]+)$/,
      );
      if (sessionRoute) {
        const [, topic, kind] = sessionRoute;
        if (req.method === "GET") {
          const session = store.session(topic, kind);
          return send(
            session && {
              ...session,
              notification:
                recipients
                  .status()
                  .find((r) => r.participant_id === session.participant_id) ??
                null,
            },
          );
        }
        if (req.method === "POST") {
          const session = store.reserveSession(topic, { ...body, kind });
          changed();
          return send(session, 201);
        }
        if (req.method === "PATCH") {
          const session = store.updateSession(topic, kind, body);
          changed();
          return send(session);
        }
      }
      let match = path.match(
        /^\/api\/topics\/([^/]+)(?:\/(messages|members|ack))?$/,
      );
      if (match) {
        const [, id, action] = match;
        if (req.method === "GET" && !action)
          return send({ ...store.topic(id), members: store.members(id) });
        if (req.method === "DELETE" && !action) {
          const result = store.deleteTopic(id);
          recipients.cancelTopic(id);
          changed();
          return send(result);
        }
        if (req.method === "PATCH" && !action) {
          if ((body.status !== undefined) === (body.project !== undefined))
            throw new HttpError(400, "每次只修改 status 或 project 之一");
          const t =
            body.project !== undefined
              ? store.setProject(id, body.project)
              : store.setStatus(id, body.status);
          changed();
          return send(t);
        }
        if (req.method === "GET" && action === "messages")
          return send(store.read(id, query.after ?? 0, query.limit ?? 100));
        if (req.method === "POST" && action === "messages") {
          const m = store.post(id, body);
          changed();
          return send(m, 201);
        }
        if (req.method === "GET" && action === "members")
          return send(store.members(id));
        if (req.method === "POST" && action === "members") {
          let target;
          if (body.notification !== undefined) {
            store.topic(id);
            if (bridges.has(body.as))
              throw new HttpError(
                409,
                "此身份仍有旧版通知连接，请先停止旧连接",
              );
            target = await recipients.prepare(
              store.participant(body.as),
              body.notification,
            );
            // Recheck after resolving the executable; another request may have registered meanwhile.
            if (bridges.has(body.as))
              throw new HttpError(409, "此身份仍有旧版通知连接");
          }
          const m = target
            ? recipients.join(id, body.as, target)
            : store.join(id, body.as);
          changed();
          return send({
            ...m,
            notification:
              recipients.status().find((r) => r.participant_id === body.as) ??
              null,
          });
        }
        if (req.method === "POST" && action === "ack") {
          const a = store.ack(id, body.as, body.through);
          changed();
          return send(a);
        }
      }
      match = path.match(/^\/api\/deliveries\/(\d+)$/);
      if (match && req.method === "POST") {
        const m = store.delivery(Number(match[1]), body.as, body.error ?? null);
        changed();
        return send(m);
      }
      if (req.method === "GET" && assets.has(path)) {
        const [file, type] = assets.get(path);
        const content = await readFile(resolve(root, file));
        res.writeHead(200, {
          "Content-Type": type,
          "Cache-Control": "no-cache",
        });
        return res.end(content);
      }
      throw new HttpError(404, "接口或资源不存在");
    } catch (e) {
      if (res.headersSent) {
        res.destroy(e);
        return;
      }
      if (!e.status) console.error(e);
      send(
        { error: e.status ? e.message : "服务内部错误，请检查日志" },
        e.status ?? 500,
      );
    }
  });
  try {
    await new Promise((ok, fail) => {
      server.once("error", fail);
      server.listen(port, "127.0.0.1", ok);
    });
  } catch (e) {
    store.close();
    throw e;
  }
  return {
    server,
    store,
    url: `http://127.0.0.1:${server.address().port}`,
    async close() {
      await recipients.close();
      for (const stream of streams) stream.end();
      await new Promise((ok, fail) => {
        server.close((e) => (e ? fail(e) : ok()));
        server.closeAllConnections();
      });
      store.close();
    },
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const app = await startServer({
    port: number(process.env.MAILBOX_PORT ?? 4317, "MAILBOX_PORT", 1, 65535),
    dbPath: process.env.MAILBOX_DB,
  });
  console.log(`Agent Mailbox → ${app.url}`);
  let closing = false;
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, async () => {
      if (closing) return;
      closing = true;
      await app.close();
      process.exit(0);
    });
}
