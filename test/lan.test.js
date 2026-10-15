import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { networkInterfaces } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { startServer } from "../src/server.js";
import { Client } from "../src/client.js";

const exec = promisify(execFile);
const lanAddress = Object.values(networkInterfaces()).flat()
  .find((address) => address?.family === "IPv4" && !address.internal)?.address;

// 使用原生 HTTP 显式传入 Host，验证服务端确实拒绝伪造地址。
function statusWithHeaders(url, headers) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
  });
}

// 默认保持回环监听，即使伪造为网卡地址也不能访问。
test("default listener stays local and rejects LAN and unknown hosts", async (t) => {
  const app = await startServer({ port: 0, dbPath: ":memory:" });
  t.after(() => app.close());
  const port = app.server.address().port;
  assert.equal(app.server.address().address, "127.0.0.1");
  assert.equal((await fetch(app.url + "/api/state")).status, 200);
  for (const name of [lanAddress ?? "192.168.1.100", "evil.example", "0.0.0.0"])
    assert.equal(await statusWithHeaders(app.url, { Host: `${name}:${port}` }), 403);
});

// 通配监听保留地址白名单和跨站保护，不因开放局域网而接受任意域名。
test("wildcard listener rejects unknown Host, wrong port and foreign Origin", async (t) => {
  const app = await startServer({ host: "0.0.0.0", port: 0, dbPath: ":memory:" });
  t.after(() => app.close());
  const port = app.server.address().port;
  assert.equal(app.server.address().address, "0.0.0.0");
  assert.equal(app.url, `http://127.0.0.1:${port}`);
  for (const headers of [
    { Host: `evil.example:${port}` },
    { Host: `127.0.0.1:${port + 1}` },
    { Origin: "http://evil.example" },
    { Origin: `http://127.0.0.1:${port + 1}` },
    { Origin: "null" },
  ]) assert.equal(await statusWithHeaders(app.url, headers), 403);
  assert.equal(await statusWithHeaders(app.url, { Origin: app.url }), 200);
});

// 通过实际网卡访问网页、写接口、事件流和子进程 CLI，验证整条局域网路径。
test("LAN address serves web, same-origin writes, SSE and actual CLI", {
  skip: !lanAddress && "没有可用于验证的 IPv4 网卡",
}, async (t) => {
  const app = await startServer({ host: "0.0.0.0", port: 0, dbPath: ":memory:" });
  t.after(() => app.close());
  const url = `http://${lanAddress}:${app.server.address().port}`;
  const client = new Client(url);
  assert.equal((await fetch(url)).status, 200);
  const response = await fetch(url + "/api/topics", {
    method: "POST",
    headers: { Origin: url, "Content-Type": "application/json" },
    body: JSON.stringify({ title: "局域网讨论", goal: "验证局域网写入" }),
  });
  assert.equal(response.status, 201);
  const topic = await response.json();
  assert.equal((await client.request(`/api/topics/${topic.id}`)).title, "局域网讨论");
  const events = client.events("/api/events", AbortSignal.timeout(5000));
  try {
    assert.equal((await events.next()).value.event, "ready");
  } finally {
    await events.return();
  }
  const result = await exec(process.execPath,
    [resolve("bin/mailbox.js"), "--url", url, "topic", "list"], { timeout: 10000 });
  assert.ok(result.stdout.includes(topic.id));
});

// 绑定具体地址时返回同一可连接地址，供内部通知和新建任务使用。
test("specific IPv4 listener returns a reachable URL and validates configuration", async (t) => {
  const app = await startServer({ host: "127.0.0.2", port: 0, dbPath: ":memory:" });
  t.after(() => app.close());
  assert.equal(app.server.address().address, "127.0.0.2");
  assert.equal(app.url, `http://127.0.0.2:${app.server.address().port}`);
  assert.equal((await fetch(app.url + "/api/state", { headers: { Origin: app.url } })).status, 200);
  await assert.rejects(startServer({ host: "evil.example", dbPath: ":memory:" }), /MAILBOX_HOST/);
  assert.equal(new Client("http://192.168.1.100:4317").url, "http://192.168.1.100:4317");
  assert.throws(() => new Client("file:///mailbox"), /HTTP/);
});
