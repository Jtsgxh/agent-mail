import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const destination = resolve(process.argv[2] ?? resolve(root, "artifacts/mailbox-relay"));
const files = ["bin/mailbox-relay.js", "src/client.js", "src/connect.js", "src/relay.js",
  "src/native.js", "src/codex-app.js", "src/notification-recovery.js"];
// 仅导出依赖 Node 标准库的转发路径，不包含数据库、凭据或 node_modules。
for (const file of files) {
  await mkdir(dirname(resolve(destination, file)), { recursive: true });
  await copyFile(resolve(root, file), resolve(destination, file));
}
await writeFile(resolve(destination, "package.json"), JSON.stringify({
  private: true, type: "module", engines: { node: ">=24" },
}, null, 2) + "\n");
await copyFile(resolve(root, "docs/remote-relay.md"), resolve(destination, "README.md"));
console.log(`远端转发包已导出：${destination}（无需 npm install）`);
