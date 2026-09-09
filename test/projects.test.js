import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Store } from "../src/store.js";
import { startServer } from "../src/server.js";
import { Client } from "../src/client.js";
const exec = promisify(execFile);

test("old database gains project grouping without losing history or read progress", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mailbox-projects-"));
  const path = join(dir, "old.db");
  let store;
  try {
    // Create the actual pre-project topics schema, then let Store initialize its other tables.
    const db = new DatabaseSync(path);
    db.exec(`CREATE TABLE topics (id TEXT PRIMARY KEY, title TEXT NOT NULL, goal TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL DEFAULT '2026-09-09');
      INSERT INTO topics(id,title,goal) VALUES ('old-topic','旧主题','保留历史');`);
    db.close();
    store = new Store(path);
    store.join("old-topic", "human");
    const msg = store.post("old-topic", {
      as: "human",
      body: "旧消息",
      requestId: "old-msg",
    });
    store.ack("old-topic", "human", msg.id);
    assert.equal(store.topic("old-topic").project_id, null);
    assert.equal(store.topics(null).length, 1);
    const project = store.createProject({ name: "RogueTower 后端" });
    store.setProject("old-topic", project.id);
    store.close();
    store = new Store(path);
    assert.equal(store.topic("old-topic").project_name, project.name);
    assert.equal(store.read("old-topic").messages[0].body, "旧消息");
    assert.equal(store.members("old-topic")[0].read_through, msg.id);
    assert.equal(store.projects()[0].topic_count, 1);
    store.setProject("old-topic", null);
    assert.equal(store.topics(null).length, 1);
    assert.throws(() => store.setProject("old-topic", "missing"), /项目不存在/);
  } finally {
    store?.close();
    assert.equal(dirname(dir), resolve(tmpdir()));
    assert.ok(basename(dir).startsWith("mailbox-projects-"));
    await rm(dir, { recursive: true });
  }
});

test("HTTP and real CLI create, filter and move project topics while preserving delivery", async () => {
  const app = await startServer({ port: 0, dbPath: ":memory:" });
  const client = new Client(app.url);
  const cli = async (...args) =>
    JSON.parse(
      (
        await exec(
          process.execPath,
          [resolve("bin/mailbox.js"), "--url", app.url, ...args],
          { timeout: 10000 },
        )
      ).stdout,
    );
  try {
    const project = await cli("project", "create", "--name", "项目 A");
    await assert.rejects(
      cli("project", "create", "--name", "项目 A"),
      /项目名称已存在/,
    );
    const topic = await cli(
      "topic",
      "create",
      "--title",
      "same",
      "--body",
      "讨论",
      "--project",
      project.name,
    );
    const other = await cli(
      "topic",
      "create",
      "--title",
      "same",
      "--body",
      "另一个主题",
    );
    assert.equal(
      (await cli("topic", "list", "--project", project.name))[0].id,
      topic.id,
    );
    assert.equal((await cli("topic", "list", "--unassigned"))[0].id, other.id);
    const participant = await client.request("/api/participants", {
      name: "reader",
      kind: "agent",
    });
    await client.request(`/api/topics/${topic.id}/members`, {
      as: participant.id,
    });
    const message = await client.request(`/api/topics/${topic.id}/messages`, {
      as: "human",
      to: participant.id,
      body: "仍待投递",
      requestId: "project-message",
    });
    await cli("topic", "move", topic.id, "--unassigned");
    assert.equal(
      (await client.request(`/api/inbox?as=${participant.id}`)).notifications[0]
        .id,
      message.id,
    );
    await cli("topic", "move", other.id, "--project", project.id);
    const state = await client.request("/api/state");
    assert.equal(state.projects[0].topic_count, 1);
    assert.equal(
      state.topics.find((t) => t.id === other.id).project_name,
      "项目 A",
    );
    await assert.rejects(
      client.request(
        `/api/topics/${other.id}`,
        { project: "missing" },
        "PATCH",
      ),
      /404/,
    );
    await assert.rejects(
      client.request(
        `/api/topics/${other.id}`,
        { project: null, status: "closed" },
        "PATCH",
      ),
      /400/,
    );
    await assert.rejects(
      cli("topic", "list", "--project", project.id, "--unassigned"),
      /互斥/,
    );
  } finally {
    await app.close();
  }
});
