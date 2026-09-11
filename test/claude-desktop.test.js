import test from "node:test";
import assert from "node:assert/strict";
import { claudeDesktopLink, openClaudeDesktop } from "../src/claude-desktop.js";

test("desktop link preserves Unicode, spaces, and shell/query metacharacters", () => {
  const cwd = 'E:\\项目 A\\a&b#%';
  const prompt = '讨论 "引号" & ? # % +\n$(whoami); `text`';
  const link = new URL(claudeDesktopLink(cwd, prompt));
  assert.equal(link.protocol, "claude:");
  assert.equal(link.hostname, "code");
  assert.equal(link.pathname, "/new");
  assert.deepEqual([...link.searchParams], [["q", prompt], ["folder", cwd]]);
  assert.throws(() => claudeDesktopLink(cwd, "a".repeat(12001)), /过长/);
  assert.throws(() => claudeDesktopLink(cwd, "中".repeat(4000)), /链接过长/);
});

for (const [platform, command] of [["win32", "powershell.exe"], ["darwin", "open"], ["linux", "xdg-open"]]) {
  test(`${platform}: open through the OS without invoking Claude CLI or interpreting prompt text`, async () => {
    const url = claudeDesktopLink('/tmp/folder & space', '中文 " $(echo test) & # %');
    const calls = [];
    await openClaudeDesktop(url, { platform,
      env: { PATH: "test-path", CODEX_THREAD_ID: "caller", CLAUDE_CODE_MESSAGING_SOCKET: "caller-socket", CLAUDE_CODE_MESSAGING_TOKEN: "caller-token" },
      run: async (...args) => calls.push(args),
    });
    assert.equal(calls.length, 1);
    const [actual, args, options] = calls[0];
    assert.equal(actual, command);
    assert.equal(options.windowsHide, true);
    assert.equal(options.env.CODEX_THREAD_ID, undefined);
    assert.equal(options.env.CLAUDE_CODE_MESSAGING_SOCKET, undefined);
    assert.equal(options.env.CLAUDE_CODE_MESSAGING_TOKEN, undefined);
    assert.equal(options.env.PATH, "test-path");
    if (platform === "win32") {
      assert.equal(options.env.MAILBOX_CLAUDE_DESKTOP_URL, url);
      assert.ok(!args.some((a) => a.includes(url) || a.includes("echo test")));
    } else assert.deepEqual(args, [url]);
  });
}

test("opener rejects other schemes and redacts failed command output", async () => {
  let calls = 0;
  const run = async () => { calls++; throw Object.assign(new Error("sensitive prompt"), { code: "ENOENT" }); };
  await assert.rejects(openClaudeDesktop("https://example.com", { run }), /无效/);
  assert.equal(calls, 0);
  await assert.rejects(openClaudeDesktop(claudeDesktopLink('/tmp', 'sensitive prompt'), { run, platform: "win32" }),
    (error) => error.message.includes("ENOENT") && !error.message.includes("sensitive prompt"));
  assert.equal(calls, 1);
});
