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

test("project rename and deletion persist while preserving discussions and session state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mailbox-project-management-"));
  const path = join(dir, "mailbox.db");
  let store = new Store(path);
  try {
    const project = store.createProject({ name: "旧项目" });
    const other = store.createProject({ name: "另一个项目" });
    const topic = store.createTopic({ title: "保留讨论", goal: "保留状态", project: project.id });
    const second = store.createTopic({ title: "暂停讨论", goal: "保留状态", project: project.id });
    const unrelated = store.createTopic({ title: "无关讨论", goal: "保留归属", project: other.id });
    const agent = store.createParticipant({ name: "reader" });
    store.join(topic.id, agent.id);
    const message = store.post(topic.id, {
      as: "human", to: agent.id, body: "仍需保留", requestId: "retained",
    });
    store.delivery(message.id, agent.id);
    store.ack(topic.id, agent.id, message.id);
    store.reserveSession(topic.id, { kind: "codex", as: "human", cwd: dir });
    store.updateSession(topic.id, "codex", { nativeId: "host-session", launchStatus: "submitted" });
    store.setStatus(topic.id, "closed");
    store.setStatus(second.id, "paused");
    const snapshot = () => Object.fromEntries(
      ["messages", "deliveries", "members", "sessions", "participants"].map(
        (table) => [table, store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()],
      ),
    );
    const retained = snapshot();
    for (const name of ["", "   ", "x".repeat(81), null])
      assert.throws(() => store.renameProject(project.id, { name }), (e) => e.status === 400);
    assert.throws(() => store.renameProject(project.id, { name: other.name }), (e) => e.status === 409);
    const renamed = store.renameProject(project.id, { name: "  新项目  " });
    assert.deepEqual({ ...renamed }, { ...project, name: "新项目" });
    assert.deepEqual(store.renameProject(project.id, { name: "新项目" }), renamed);
    assert.equal(store.topic(topic.id).project_name, "新项目");
    assert.equal(store.topics(project.id).length, 2);
    store.close();
    store = new Store(path);
    assert.deepEqual(store.project(project.id), renamed);
    assert.deepEqual(snapshot(), retained);
    const deleted = store.deleteProject(project.id);
    assert.equal(deleted.unassigned_topics, 2);
    store.close();
    store = new Store(path);
    assert.deepEqual(snapshot(), retained);
    assert.equal(store.topic(topic.id).project_id, null);
    assert.equal(store.topic(topic.id).project_name, null);
    assert.equal(store.topic(topic.id).status, "closed");
    assert.equal(store.topic(second.id).status, "paused");
    assert.equal(store.topic(unrelated.id).project_id, other.id);
    assert.equal(store.topics(null).length, 2);
    assert.equal(store.projects().length, 1);
    assert.deepEqual(store.db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.throws(() => store.deleteProject(project.id), (e) => e.status === 404);
    assert.throws(() => store.renameProject(project.id, { name: "不能复活" }), (e) => e.status === 404);
    assert.throws(() => store.setProject(topic.id, project.id), (e) => e.status === 404);
  } finally {
    store.close();
    assert.equal(dirname(dir), resolve(tmpdir()));
    assert.ok(basename(dir).startsWith("mailbox-project-management-"));
    await rm(dir, { recursive: true });
  }
});

test("failed project deletion rolls back topic assignment", () => {
  const store = new Store(":memory:");
  try {
    const project = store.createProject({ name: "原子删除" });
    const topic = store.createTopic({ title: "保留归属", goal: "事务", project: project.id });
    store.db.exec("CREATE TRIGGER reject_project_delete BEFORE DELETE ON projects BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
    assert.throws(() => store.deleteProject(project.id), /injected failure/);
    assert.deepEqual(store.project(project.id), project);
    assert.deepEqual(store.topic(topic.id), topic);
  } finally {
    store.close();
  }
});

test("CLI renames and deletes projects by name or ID and SSE observers see updated grouping", async (t) => {
  const app = await startServer({ port: 0, dbPath: ":memory:" });
  t.after(() => app.close());
  const client = new Client(app.url);
  const cli = async (...args) => JSON.parse((await exec(
    process.execPath, [resolve("bin/mailbox.js"), "--url", app.url, ...args],
    { timeout: 10000 },
  )).stdout);
  const project = await cli("project", "create", "--name", "旧名");
  const other = await cli("project", "create", "--name", "占用名称");
  const topic = await cli("topic", "create", "--title", "保留", "--body", "讨论", "--project", project.id);
  const stop = new AbortController();
  const states = [];
  const watching = (async () => {
    for await (const _ of client.events("/api/events", stop.signal))
      states.push(await client.request("/api/state"));
  })().catch((e) => { if (!stop.signal.aborted) throw e; });
  t.after(async () => { stop.abort(); await watching; });
  const until = async (predicate) => {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error("SSE timed out");
      await new Promise((r) => setTimeout(r, 15));
    }
  };
  await until(() => states.length > 0);
  await assert.rejects(cli("project", "rename", project.id, "--name", other.name), /项目名称已存在/);
  const renamed = await cli("project", "rename", project.name, "--name", "新名");
  assert.equal(renamed.id, project.id);
  await until(() => states.some((state) => state.topics[0].project_name === "新名"));
  assert.equal((await cli("topic", "list", "--project", "新名"))[0].id, topic.id);
  assert.equal((await cli("project", "delete", project.id)).unassigned_topics, 1);
  await until(() => states.some((state) => state.topics[0].project_id === null && state.projects.length === 1));
  assert.equal((await cli("topic", "show", topic.id)).project_id, null);
  assert.equal((await cli("project", "delete", other.name)).unassigned_topics, 0);
  await assert.rejects(client.request(`/api/projects/${project.id}`, undefined, "DELETE"), /404/);
  await assert.rejects(client.request(`/api/projects/${project.id}`, { name: "不存在" }, "PATCH"), /404/);
  await assert.rejects(cli("project", "delete"), /缺少项目/);
  await assert.rejects(cli("project", "rename", "不存在", "--name", "新名"), /唯一项目/);
});
