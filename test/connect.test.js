import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join, resolve, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { agentCommand, connectMailbox } from "../src/connect.js";
import { startServer } from "../src/server.js";
import { Client } from "../src/client.js";
async function temporary(t) {
  const dir = await mkdtemp(join(tmpdir(), "mailbox-connect-"));
  t.after(async () => {
    assert.equal(dirname(dir), resolve(tmpdir()));
    assert.ok(basename(dir).startsWith("mailbox-connect-"));
    await rm(dir, { recursive: true });
  });
  return dir;
}
test("Windows npm shims resolve to direct executables without shell evaluation or path escape", async (t) => {
  const dir = await temporary(t);
  const binDir = join(dir, "spaces & names", "node_modules", "agent", "bin");
  await mkdir(binDir, { recursive: true });
  const entry = join(binDir, "cli.js");
  await writeFile(entry, "");
  const shimDir = resolve(binDir, "../../..");
  await writeFile(
    join(shimDir, "codex.cmd"),
    '"%dp0%\\node_modules\\agent\\bin\\cli.js" %*',
  );
  const result = await agentCommand("codex", {
    searchPath: shimDir,
    platform: "win32",
  });
  assert.deepEqual(result, { command: process.execPath, args: [entry] });
  await writeFile(
    join(shimDir, "codex.cmd"),
    '"%dp0%\\node_modules\\..\\outside.exe" %*',
  );
  await assert.rejects(
    agentCommand("codex", { searchPath: shimDir, platform: "win32" }),
    /无效/,
  );
});

test("native connect preview does not create an agent or change mailbox state", async (t) => {
  const app = await startServer({ port: 0, dbPath: ":memory:" });
  t.after(() => app.close());
  const c = new Client(app.url);
  const p = await c.request("/api/participants", {
    name: "codex-preview",
    kind: "codex",
  });
  const before = await c.request("/api/state");
  const result = await connectMailbox(c, {
    as: p.name,
    thread: "target-session",
    preview: true,
  });
  assert.equal(result.mode, "codex-native");
  assert.equal(result.thread, "target-session");
  assert.deepEqual(await c.request("/api/state"), before);
  await assert.rejects(
    connectMailbox(c, { as: p.name, kind: "claude", preview: true }),
    /类型一致/,
  );
  const listing = await connectMailbox(c, { list: true });
  assert.equal(listing.participants[0].id, p.id);
});
