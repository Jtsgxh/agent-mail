import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export function required(value, name, max = 200) {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new HttpError(400, `${name} 必须是 1–${max} 字符的文本`);
  }
  return value.trim();
}
export function number(value, name, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const n =
    typeof value === "number"
      ? value
      : /^\d+$/.test(value ?? "")
        ? Number(value)
        : NaN;
  if (!Number.isSafeInteger(n) || n < min || n > max)
    throw new HttpError(400, `${name} 无效`);
  return n;
}

export class Store {
  constructor(path) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 3000;
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE TABLE IF NOT EXISTS participants (
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE TABLE IF NOT EXISTS topics (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, goal TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE TABLE IF NOT EXISTS members (
        topic_id TEXT REFERENCES topics(id), participant_id TEXT REFERENCES participants(id),
        read_through INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(topic_id, participant_id)
      );
      CREATE TABLE IF NOT EXISTS sessions (
        topic_id TEXT NOT NULL REFERENCES topics(id), kind TEXT NOT NULL,
        participant_id TEXT NOT NULL UNIQUE REFERENCES participants(id),
        requested_by TEXT NOT NULL REFERENCES participants(id), cwd TEXT NOT NULL,
        native_id TEXT, launch_status TEXT NOT NULL DEFAULT 'reserved', error TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        PRIMARY KEY(topic_id,kind)
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, topic_id TEXT NOT NULL REFERENCES topics(id),
        author_id TEXT NOT NULL REFERENCES participants(id), body TEXT NOT NULL,
        reply_to INTEGER REFERENCES messages(id), broadcast INTEGER NOT NULL DEFAULT 0,
        request_id TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        UNIQUE(author_id, request_id)
      );
      CREATE INDEX IF NOT EXISTS messages_topic ON messages(topic_id, id);
      CREATE TABLE IF NOT EXISTS deliveries (
        message_id INTEGER NOT NULL REFERENCES messages(id), recipient_id TEXT NOT NULL REFERENCES participants(id),
        notified_at TEXT, ack_at TEXT, error TEXT, PRIMARY KEY(message_id,recipient_id)
      );
      CREATE INDEX IF NOT EXISTS deliveries_recipient ON deliveries(recipient_id, message_id);
      INSERT OR IGNORE INTO participants(id,name,kind) VALUES ('human','我','human');
    `);
    if (
      !this.db
        .prepare("PRAGMA table_info(topics)")
        .all()
        .some((column) => column.name === "project_id")
    )
      this.db.exec(
        "ALTER TABLE topics ADD COLUMN project_id TEXT REFERENCES projects(id)",
      );
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS topics_project ON topics(project_id)",
    );
    const sessionColumns = this.db.prepare("PRAGMA table_info(sessions)").all();
    if (!sessionColumns.some((column) => column.name === "transport"))
      this.db.exec("ALTER TABLE sessions ADD COLUMN transport TEXT NOT NULL DEFAULT 'native'");
    if (!sessionColumns.some((column) => column.name === "launch_ref"))
      this.db.exec("ALTER TABLE sessions ADD COLUMN launch_ref TEXT");
    // Preserve old per-message receipts while changing their key to message + recipient.
    this.db.exec("BEGIN");
    try {
      if (
        !this.db
          .prepare("PRAGMA table_info(deliveries)")
          .all()
          .find((c) => c.name === "recipient_id").pk
      ) {
        this.db.exec(`ALTER TABLE deliveries RENAME TO deliveries_single;
          CREATE TABLE deliveries (
            message_id INTEGER NOT NULL REFERENCES messages(id), recipient_id TEXT NOT NULL REFERENCES participants(id),
            notified_at TEXT, ack_at TEXT, error TEXT, PRIMARY KEY(message_id,recipient_id)
          );
          INSERT INTO deliveries SELECT message_id,recipient_id,notified_at,ack_at,error FROM deliveries_single;
          DROP TABLE deliveries_single;
          CREATE INDEX deliveries_recipient ON deliveries(recipient_id,message_id);`);
      }
      const columns = this.db.prepare("PRAGMA table_info(messages)").all();
      if (!columns.some((c) => c.name === "broadcast"))
        this.db.exec(
          "ALTER TABLE messages ADD COLUMN broadcast INTEGER NOT NULL DEFAULT 0",
        );
      if (columns.some((c) => c.name === "to_id"))
        this.db.exec("ALTER TABLE messages DROP COLUMN to_id");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  close() {
    this.db.close();
  }
  session(topic, kind) {
    this.topic(topic);
    if (!["codex", "claude"].includes(kind))
      throw new HttpError(400, "会话类型必须为 codex 或 claude");
    return (
      this.db
        .prepare("SELECT * FROM sessions WHERE topic_id=? AND kind=?")
        .get(topic, kind) ?? null
    );
  }
  reserveSession(topic, { kind, as, cwd, transport = "native" }) {
    if (!["native", "desktop-app"].includes(transport))
      throw new HttpError(400, "会话传输类型无效");
    if (this.topic(topic).status !== "open")
      throw new HttpError(409, "只可为开放主题创建会话");
    this.member(topic, as);
    cwd = required(cwd, "cwd", 4000);
    const existing = this.session(topic, kind);
    if (existing)
      throw new HttpError(
        409,
        `此主题已有 ${kind} 会话记录，请使用 session info 查看；不会重复启动`,
      );
    this.db.exec("BEGIN");
    try {
      const participant = this.createParticipant({
        name: `${kind}-${topic}`,
        kind,
      });
      this.db
        .prepare(
          "INSERT INTO sessions(topic_id,kind,participant_id,requested_by,cwd,transport) VALUES (?,?,?,?,?,?)",
        )
        .run(topic, kind, participant.id, as, cwd, transport);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.session(topic, kind);
  }
  updateSession(topic, kind, { nativeId, launchRef, launchStatus, error = null }) {
    const session = this.session(topic, kind);
    if (!session) throw new HttpError(404, "会话记录不存在");
    if (nativeId !== undefined) {
      nativeId = required(nativeId, "nativeId");
      if (session.native_id && session.native_id !== nativeId)
        throw new HttpError(409, "不能更换已绑定会话");
    }
    if (launchRef !== undefined) {
      launchRef = required(launchRef, "launchRef");
      if (session.transport !== "desktop-app" || (session.launch_ref && session.launch_ref !== launchRef))
        throw new HttpError(409, "不能更换 App 创建请求");
    }
    if (!["reserved", "submitted", "uncertain"].includes(launchStatus))
      throw new HttpError(400, "launchStatus 无效");
    if (session.launch_status !== "reserved")
      throw new HttpError(409, "启动结果已记录，不可重新启动");
    if (launchStatus === "submitted" && !(nativeId ?? session.native_id ?? launchRef ?? session.launch_ref))
      throw new HttpError(400, "缺少原生会话 ID");
    if (error !== null) error = required(error, "error", 2000);
    this.db
      .prepare(
        "UPDATE sessions SET native_id=COALESCE(?,native_id),launch_ref=COALESCE(?,launch_ref),launch_status=?,error=? WHERE topic_id=? AND kind=?",
      )
      .run(nativeId ?? null, launchRef ?? null, launchStatus, error, topic, kind);
    return this.session(topic, kind);
  }
  bindDesktopSession(topic, participant, thread) {
    const session = this.session(topic, "codex");
    if (!session || session.transport !== "desktop-app" || session.participant_id !== participant)
      throw new HttpError(409, "此身份不是该主题的 App 创建任务");
    thread = required(thread, "thread");
    if (session.native_id && session.native_id !== thread)
      throw new HttpError(409, "不能更换已绑定的 App 任务");
    this.db.prepare("UPDATE sessions SET native_id=? WHERE topic_id=? AND kind='codex'").run(thread, topic);
  }
  project(id) {
    const project = this.db
      .prepare("SELECT * FROM projects WHERE id=?")
      .get(required(id, "project id"));
    if (!project) throw new HttpError(404, "项目不存在");
    return project;
  }
  projects() {
    return this.db
      .prepare(
        `SELECT p.*, COUNT(t.id) AS topic_count FROM projects p
      LEFT JOIN topics t ON t.project_id=p.id GROUP BY p.id ORDER BY p.name,p.id`,
      )
      .all();
  }
  createProject({ name }) {
    name = required(name, "name", 80);
    if (this.db.prepare("SELECT id FROM projects WHERE name=?").get(name))
      throw new HttpError(409, "项目名称已存在");
    const id = randomUUID();
    this.db.prepare("INSERT INTO projects(id,name) VALUES (?,?)").run(id, name);
    return this.project(id);
  }
  renameProject(id, { name }) {
    this.project(id);
    name = required(name, "name", 80);
    if (
      this.db
        .prepare("SELECT id FROM projects WHERE name=? AND id<>?")
        .get(name, id)
    )
      throw new HttpError(409, "项目名称已存在");
    this.db.prepare("UPDATE projects SET name=? WHERE id=?").run(name, id);
    return this.project(id);
  }
  deleteProject(id) {
    const project = this.project(id);
    this.db.exec("BEGIN");
    try {
      const moved = this.db
        .prepare("UPDATE topics SET project_id=NULL WHERE project_id=?")
        .run(id);
      this.db.prepare("DELETE FROM projects WHERE id=?").run(id);
      this.db.exec("COMMIT");
      return {
        ...project,
        deleted: true,
        unassigned_topics: Number(moved.changes),
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  participant(id) {
    id = required(id, "participant id");
    const p = this.db.prepare("SELECT * FROM participants WHERE id=?").get(id);
    if (!p) throw new HttpError(404, "参与者不存在");
    return p;
  }
  participants() {
    return this.db
      .prepare("SELECT * FROM participants ORDER BY created_at,id")
      .all();
  }
  createParticipant({ name, kind = "agent" }) {
    name = required(name, "name", 80);
    if (!["agent", "codex", "claude", "human"].includes(kind))
      throw new HttpError(400, "kind 无效");
    if (this.db.prepare("SELECT id FROM participants WHERE name=?").get(name))
      throw new HttpError(409, "参与者名称已存在");
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO participants(id,name,kind) VALUES (?,?,?)")
      .run(id, name, kind);
    return this.participant(id);
  }
  topic(id) {
    const t = this.db
      .prepare(
        "SELECT t.*, p.name AS project_name FROM topics t LEFT JOIN projects p ON p.id=t.project_id WHERE t.id=?",
      )
      .get(id);
    if (!t) throw new HttpError(404, "主题不存在");
    return t;
  }
  topics(project) {
    if (project !== undefined && project !== null) this.project(project);
    return this.db
      .prepare(
        `SELECT t.*, p.name AS project_name, COUNT(m.id) AS message_count, MAX(m.created_at) AS last_message_at
      FROM topics t LEFT JOIN projects p ON p.id=t.project_id LEFT JOIN messages m ON m.topic_id=t.id
      ${project === undefined ? "" : "WHERE t.project_id IS ?"} GROUP BY t.id
      ORDER BY COALESCE(MAX(m.created_at),t.created_at) DESC,t.id`,
      )
      .all(...(project === undefined ? [] : [project]));
  }
  createTopic({ title, goal, as = "human", project = null }) {
    title = required(title, "title", 160);
    goal = required(goal, "goal", 20000);
    this.participant(as);
    if (project !== null) this.project(project);
    const id = randomUUID();
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          "INSERT INTO topics(id,title,goal,project_id) VALUES (?,?,?,?)",
        )
        .run(id, title, goal, project);
      this.join(id, as);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return this.topic(id);
  }
  setStatus(id, status) {
    this.topic(id);
    if (!["open", "paused", "closed"].includes(status))
      throw new HttpError(400, "status 无效");
    this.db.prepare("UPDATE topics SET status=? WHERE id=?").run(status, id);
    return this.topic(id);
  }
  deleteTopic(id) {
    const topic = this.topic(id);
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          "DELETE FROM deliveries WHERE message_id IN (SELECT id FROM messages WHERE topic_id=?)",
        )
        .run(id);
      this.db.prepare("DELETE FROM messages WHERE topic_id=?").run(id);
      this.db.prepare("DELETE FROM members WHERE topic_id=?").run(id);
      this.db.prepare("DELETE FROM sessions WHERE topic_id=?").run(id);
      this.db.prepare("DELETE FROM topics WHERE id=?").run(id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { id: topic.id, title: topic.title, deleted: true };
  }
  setProject(id, project) {
    this.topic(id);
    if (project !== null) this.project(project);
    this.db
      .prepare("UPDATE topics SET project_id=? WHERE id=?")
      .run(project, id);
    return this.topic(id);
  }
  join(topic, participant) {
    this.topic(topic);
    this.participant(participant);
    this.db
      .prepare(
        "INSERT OR IGNORE INTO members(topic_id,participant_id) VALUES (?,?)",
      )
      .run(topic, participant);
    return { topic_id: topic, participant_id: participant };
  }
  members(topic) {
    this.topic(topic);
    return this.db
      .prepare(
        `SELECT p.*,mb.read_through FROM members mb JOIN participants p ON p.id=mb.participant_id
      WHERE mb.topic_id=? ORDER BY p.created_at,p.id`,
      )
      .all(topic);
  }
  member(topic, participant) {
    if (
      !this.db
        .prepare("SELECT 1 FROM members WHERE topic_id=? AND participant_id=?")
        .get(topic, participant)
    ) {
      throw new HttpError(400, "参与者必须先加入主题");
    }
  }
  message(id) {
    const m = this.db
      .prepare(
        `SELECT m.*, p.name AS author_name, p.kind AS author_kind
      FROM messages m JOIN participants p ON p.id=m.author_id WHERE m.id=?`,
      )
      .get(id);
    if (!m) throw new HttpError(404, "消息不存在");
    const recipients = this.db
      .prepare(
        `SELECT d.recipient_id,p.name AS recipient_name,p.kind AS recipient_kind,
      d.notified_at,d.ack_at,d.error FROM deliveries d JOIN participants p ON p.id=d.recipient_id
      WHERE d.message_id=? ORDER BY d.recipient_id`,
      )
      .all(id);
    // Keep the existing single-recipient response fields as a projection, not duplicate storage.
    const single = recipients.length === 1 ? recipients[0] : null;
    return {
      ...m,
      broadcast: !!m.broadcast,
      recipients,
      to_id: single?.recipient_id ?? null,
      to_name: single?.recipient_name ?? null,
      notified_at: single?.notified_at ?? null,
      ack_at: single?.ack_at ?? null,
      error: single?.error ?? null,
    };
  }
  byRequest(as, requestId) {
    requestId = required(requestId, "requestId", 160);
    const row = this.db
      .prepare("SELECT id FROM messages WHERE author_id=? AND request_id=?")
      .get(as, requestId);
    return row ? this.message(row.id) : null;
  }
  post(
    topic,
    { as, body, to = null, broadcast = false, replyTo = null, requestId },
  ) {
    as = required(as, "as");
    body = required(body, "body", 64000);
    requestId = required(requestId, "requestId", 160);
    if (typeof broadcast !== "boolean")
      throw new HttpError(400, "broadcast 必须是布尔值");
    const supplied = to === null ? [] : typeof to === "string" ? [to] : to;
    if (!Array.isArray(supplied))
      throw new HttpError(400, "to 必须是参与者 ID 或 ID 数组");
    const targets = [
      ...new Set(supplied.map((id) => required(id, "recipient id"))),
    ].sort();
    if (broadcast && targets.length)
      throw new HttpError(400, "广播与指定收件人不能同时使用");
    if (replyTo !== null) replyTo = number(replyTo, "replyTo", 1);
    const prior = this.db
      .prepare("SELECT id FROM messages WHERE author_id=? AND request_id=?")
      .get(as, requestId);
    if (prior) {
      const m = this.message(prior.id);
      if (
        m.topic_id !== topic ||
        m.body !== body ||
        m.broadcast !== broadcast ||
        (!broadcast &&
          JSON.stringify(m.recipients.map((r) => r.recipient_id)) !==
            JSON.stringify(targets)) ||
        m.reply_to !== replyTo
      ) {
        throw new HttpError(409, "requestId 已用于不同消息");
      }
      return m;
    }
    const t = this.topic(topic);
    this.participant(as);
    this.member(topic, as);
    if (t.status === "closed") throw new HttpError(409, "主题已关闭");
    const recipients = broadcast
      ? this.members(topic)
          .filter((p) => p.id !== as)
          .map((p) => p.id)
          .sort()
      : targets;
    for (const recipient of recipients) {
      this.participant(recipient);
      this.member(topic, recipient);
      if (recipient === as) throw new HttpError(400, "不能定向通知自己");
    }
    if (replyTo !== null) {
      if (this.message(replyTo).topic_id !== topic)
        throw new HttpError(400, "不能引用其他主题的消息");
    }
    this.db.exec("BEGIN");
    try {
      const result = this.db
        .prepare(
          "INSERT INTO messages(topic_id,author_id,body,broadcast,reply_to,request_id) VALUES (?,?,?,?,?,?)",
        )
        .run(topic, as, body, broadcast ? 1 : 0, replyTo, requestId);
      const id = Number(result.lastInsertRowid);
      for (const recipient of recipients)
        this.db
          .prepare(
            "INSERT INTO deliveries(message_id,recipient_id) VALUES (?,?)",
          )
          .run(id, recipient);
      this.db.exec("COMMIT");
      return this.message(id);
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  read(topic, after = 0, limit = 100) {
    this.topic(topic);
    after = number(after, "after");
    limit = number(limit, "limit", 1, 200);
    const ids = this.db
      .prepare(
        "SELECT id FROM messages WHERE topic_id=? AND id>? ORDER BY id LIMIT ?",
      )
      .all(topic, after, limit);
    const messages = ids.map((m) => this.message(m.id));
    const next = messages.at(-1)?.id ?? after;
    const hasMore = !!this.db
      .prepare("SELECT 1 FROM messages WHERE topic_id=? AND id>? LIMIT 1")
      .get(topic, next);
    return { messages, next, hasMore };
  }
  inbox(as) {
    this.participant(as);
    const notifications = this.db
      .prepare(
        `SELECT d.message_id,d.notified_at,d.ack_at,d.error,t.status AS topic_status FROM deliveries d JOIN messages m ON m.id=d.message_id
      JOIN topics t ON t.id=m.topic_id WHERE d.recipient_id=? AND d.ack_at IS NULL ORDER BY d.message_id`,
      )
      .all(as)
      .map((d) => ({
        ...this.message(d.message_id),
        notified_at: d.notified_at,
        ack_at: d.ack_at,
        error: d.error,
        topic_status: d.topic_status,
      }));
    const topics = this.db
      .prepare(
        `SELECT t.id,t.title,mb.read_through,COUNT(m.id) AS unread
      FROM members mb JOIN topics t ON t.id=mb.topic_id
      LEFT JOIN messages m ON m.topic_id=t.id AND m.id>mb.read_through AND m.author_id<>mb.participant_id
      WHERE mb.participant_id=? GROUP BY t.id HAVING COUNT(m.id)>0`,
      )
      .all(as);
    return { notifications, topics };
  }
  ack(topic, as, through) {
    this.topic(topic);
    this.participant(as);
    this.member(topic, as);
    through = number(through, "through", 1);
    if (this.message(through).topic_id !== topic)
      throw new HttpError(400, "确认消息不属于此主题");
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          "UPDATE members SET read_through=MAX(read_through,?) WHERE topic_id=? AND participant_id=?",
        )
        .run(through, topic, as);
      this.db
        .prepare(
          `UPDATE deliveries SET ack_at=COALESCE(ack_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),error=NULL
        WHERE recipient_id=? AND message_id IN (SELECT id FROM messages WHERE topic_id=? AND id<=?)`,
        )
        .run(as, topic, through);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return { topic_id: topic, as, through };
  }
  delivery(id, as, error = null) {
    id = number(id, "message", 1);
    this.participant(as);
    if (!this.message(id).recipients.some((r) => r.recipient_id === as))
      throw new HttpError(400, "不是此消息的接收者");
    if (error !== null) error = required(error, "error", 2000);
    this.db
      .prepare(
        `UPDATE deliveries SET notified_at=CASE WHEN ? IS NULL THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE notified_at END,
      error=? WHERE message_id=? AND recipient_id=?`,
      )
      .run(error, error, id, as);
    return this.message(id);
  }
}
