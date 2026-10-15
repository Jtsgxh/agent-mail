import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
// 执行真实复制函数和按钮绑定，隔离页面启动时的网络请求与定时刷新。
const copySource = source.slice(0, source.indexOf("async function checkCodexService"))
  + source.slice(source.indexOf('$("#copy-topic").onclick'), source.indexOf('$("#ack-visible").onclick'));

// 模拟浏览器剪贴板和必要 DOM，记录复制内容、焦点恢复和成功/失败提示。
function browser({ clipboard, legacy = true, legacyThrows = false } = {}) {
  const nodes = new Map();
  const record = { copied: null, restored: false, input: null };
  const document = {
    querySelector(selector) {
      if (!nodes.has(selector)) nodes.set(selector, {
        hidden: true,
        classList: { toggle(name, value) { this[name] = value; } },
      });
      return nodes.get(selector);
    },
    activeElement: { focus() { record.restored = true; } },
    body: { append(input) { record.input = input; input.attached = true; } },
    createElement(tag) {
      assert.equal(tag, "textarea");
      return {
        style: {},
        focus() { this.focused = true; },
        select() { this.selected = true; },
        remove() { this.attached = false; },
      };
    },
    execCommand(command) {
      assert.equal(command, "copy");
      assert.ok(record.input.attached && record.input.focused && record.input.selected);
      assert.equal(record.input.readOnly, true);
      if (legacyThrows) throw new Error("blocked");
      if (legacy) record.copied = record.input.value;
      return legacy;
    },
  };
  runInNewContext(copySource, {
    document, navigator: { clipboard }, location: { hash: "#topic-lan-123" },
    // 禁用提示框定时器，便于直接检查按钮执行后的状态。
    setTimeout() {}, clearTimeout() {},
  });
  return { record, nodes, click: () => nodes.get("#copy-topic").onclick() };
}

// 安全上下文继续使用原接口，不创建临时文本框。
test("copy button prefers Clipboard API", async () => {
  let copied;
  const page = browser({ clipboard: { async writeText(text) { copied = text; } } });
  await page.click();
  assert.equal(copied, "topic-lan-123");
  assert.equal(page.record.input, null);
  assert.equal(page.nodes.get("#toast").textContent, "已复制主题 ID");
});

// 局域网 HTTP 无接口、接口不完整和权限拒绝均应尝试兼容复制。
for (const [name, clipboard] of [
  ["missing Clipboard API", undefined],
  ["missing writeText", {}],
  ["denied Clipboard API", { async writeText() { throw new Error("NotAllowedError"); } }],
]) {
  test(`copy button falls back for ${name}`, async () => {
    const page = browser({ clipboard });
    await page.click();
    assert.equal(page.record.copied, "topic-lan-123");
    assert.equal(page.record.input.attached, false);
    assert.equal(page.record.restored, true);
    assert.equal(page.nodes.get("#toast").textContent, "已复制主题 ID");
  });
}

// 兼容命令返回失败或抛错都不能误报成功，且必须清理文本框并恢复焦点。
for (const legacyThrows of [false, true]) {
  test(`copy failure shows ID and cleans up (throws=${legacyThrows})`, async () => {
    const page = browser({ legacy: false, legacyThrows });
    await page.click();
    assert.equal(page.record.copied, null);
    assert.equal(page.record.input.attached, false);
    assert.equal(page.record.restored, true);
    assert.equal(page.nodes.get("#toast").textContent, "复制失败，请手动复制主题 ID：topic-lan-123");
    assert.equal(page.nodes.get("#toast").classList.error, true);
  });
}
