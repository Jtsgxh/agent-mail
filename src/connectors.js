import { createHash, randomBytes, randomUUID } from "node:crypto";
import { HttpError, required } from "./store.js";

const digest = (token) => createHash("sha256").update(token).digest("hex");

// Local administration only. MCP callers never receive this interface.
export class Connectors {
  constructor(store) {
    this.store = store;
    this.db = store.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS connectors (
      id TEXT PRIMARY KEY, name TEXT NOT NULL,
      participant_id TEXT NOT NULL REFERENCES participants(id),
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE, read_only INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      revoked_at TEXT
    )`);
  }

  list() {
    return this.db.prepare(`SELECT c.id,c.name,c.participant_id,c.project_id,
      c.read_only,c.created_at,c.revoked_at,p.name AS project_name
      FROM connectors c JOIN projects p ON p.id=c.project_id ORDER BY c.created_at,c.id`)
      .all().map((c) => ({ ...c, read_only: !!c.read_only }));
  }

  create({ name, as, project, readOnly = false }) {
    name = required(name, "name", 80);
    const participant = this.store.participant(as);
    if (participant.kind === "human") throw new HttpError(400, "Connector 必须绑定 agent 身份，不能冒用用户");
    this.store.project(project);
    if (typeof readOnly !== "boolean") throw new HttpError(400, "readOnly 必须是布尔值");
    const token = `amb_${randomBytes(32).toString("base64url")}`;
    const id = randomUUID();
    this.db.prepare(`INSERT INTO connectors(id,name,participant_id,project_id,token_hash,read_only)
      VALUES (?,?,?,?,?,?)`).run(id, name, as, project, digest(token), readOnly ? 1 : 0);
    return { ...this.list().find((c) => c.id === id), token };
  }

  authenticate(token) {
    if (typeof token !== "string" || !/^amb_[A-Za-z0-9_-]{43}$/.test(token))
      throw new HttpError(401, "需要有效的 Connector Bearer token");
    const row = this.db.prepare(`SELECT id,name,participant_id,project_id,read_only
      FROM connectors WHERE token_hash=? AND revoked_at IS NULL`).get(digest(token));
    if (!row) throw new HttpError(401, "Connector 密钥无效或已撤销");
    return { ...row, read_only: !!row.read_only };
  }

  revoke(id) {
    const result = this.db.prepare(`UPDATE connectors SET revoked_at=COALESCE(revoked_at,
      strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE id=?`).run(id);
    if (!result.changes) throw new HttpError(404, "Connector 不存在");
    return { id, revoked: true };
  }
}
