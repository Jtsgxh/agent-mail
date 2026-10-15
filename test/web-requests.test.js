import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";
import { networkInterfaces } from "node:os";
import { runInNewContext } from "node:vm";
import { startServer } from "../src/server.js";

const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const helpers = source.slice(0, source.indexOf("async function checkCodexService"));
const composer = source.slice(source.indexOf('$("#composer").onsubmit'), source.indexOf('$("#message-body").onkeydown'));
const lanAddress = Object.values(networkInterfaces()).flat()
  .find((address) => address?.family === "IPv4" && !address.internal)?.address;

// 安全上下文优先保留浏览器原生 UUID 生成方式。
test("request ID prefers native randomUUID", () => {
  const expected = "12345678-1234-4234-8234-123456789abc";
  const id = runInNewContext(helpers + "createRequestId()", {
    location: { hash: "" }, crypto: { randomUUID: () => expected },
  });
  assert.equal(id, expected);
});

// 固定随机字节验证兼容路径的 UUID 版本、变体和前导零格式。
test("request ID fallback creates a version 4 UUID from secure random bytes", () => {
  for (const [byte, expected] of [
    [0xff, "ffffffff-ffff-4fff-bfff-ffffffffffff"],
    [0, "00000000-0000-4000-8000-000000000000"],
  ]) {
    const id = runInNewContext(helpers + "createRequestId()", {
      location: { hash: "" }, crypto: { getRandomValues: (bytes) => bytes.fill(byte) },
    });
    assert.equal(id, expected);
  }
});

// 执行真实表单处理与 API 请求，仅模拟 DOM 和不涉及发送逻辑的页面刷新。
function browserComposer(topic, fetchRequest) {
  const nodes = new Map();
  const document = {
    querySelector(selector) {
      if (!nodes.has(selector)) nodes.set(selector, {
        value: "局域网发送测试",
        classList: { toggle() {} },
        click() {},
      });
      return nodes.get(selector);
    },
  };
  const submit = runInNewContext(helpers + composer + `
    current = { id: selected, status: "open" };
    () => $("#composer").onsubmit({ preventDefault() {} });
  `, {
    document,
    location: { hash: `#${topic}` },
    // 模拟 HTTP 页面：提供 getRandomValues，不提供 randomUUID。
    crypto: { getRandomValues: (bytes) => webcrypto.getRandomValues(bytes) },
    fetch: fetchRequest,
    notificationSelection: () => ({ to: [], broadcast: false }),
    async refresh() {},
    setTimeout() {}, clearTimeout() {},
  });
  return { submit, nodes };
}

// 通过实际网卡访问后端，模拟落库后丢失响应，验证真实表单重试不会重复写入。
test("HTTP composer sends over LAN and reuses request ID after a lost response", {
  skip: !lanAddress && "没有可用于验证的 IPv4 网卡",
}, async (t) => {
  const app = await startServer({ host: "0.0.0.0", port: 0, dbPath: ":memory:" });
  t.after(() => app.close());
  const url = `http://${lanAddress}:${app.server.address().port}`;
  const topicResponse = await fetch(url + "/api/topics", {
    method: "POST", headers: { Origin: url, "Content-Type": "application/json" },
    body: JSON.stringify({ title: "表单兼容测试", goal: "验证 HTTP 页面发送与重试" }),
  });
  assert.equal(topicResponse.status, 201);
  const topic = await topicResponse.json();
  const requests = [];
  let loseResponse = true;
  const page = browserComposer(topic.id, async (path, options) => {
    const response = await fetch(url + path, {
      ...options, headers: { ...options.headers, Origin: url },
    });
    assert.equal(response.ok, true);
    if (path.endsWith("/messages")) {
      requests.push(JSON.parse(options.body));
      if (loseResponse) {
        loseResponse = false;
        await response.arrayBuffer();
        throw new Error("模拟响应丢失");
      }
    }
    return response;
  });
  await page.submit();
  assert.equal(page.nodes.get("#toast").textContent, "模拟响应丢失");
  assert.equal(page.nodes.get("#send-message").disabled, false);
  assert.equal(page.nodes.get("#message-body").value, "局域网发送测试");
  await page.submit();
  assert.equal(requests.length, 2);
  assert.match(requests[0].requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(requests[1].requestId, requests[0].requestId);
  assert.equal(page.nodes.get("#message-body").value, "");
  const firstPage = await (await fetch(`${url}/api/topics/${topic.id}/messages`)).json();
  assert.equal(firstPage.messages.length, 1);
  page.nodes.get("#message-body").value = "下一条消息";
  await page.submit();
  assert.notEqual(requests[2].requestId, requests[0].requestId);
  const nextPage = await (await fetch(`${url}/api/topics/${topic.id}/messages`)).json();
  assert.equal(nextPage.messages.length, 2);
});
