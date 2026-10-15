import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const destination = resolve(process.argv[2] ?? resolve(root, "artifacts/mailbox-mcp"));
const files = ["bin/mailbox-mcp.js", "src/mcp.js", "src/mailbox-tools.js", "src/client.js",
  "src/connect.js", "src/relay.js", "src/native.js", "src/codex-app.js", "src/notification-recovery.js"];
// 只分发 MCP 路径与既有 SDK 依赖声明，不携带服务器、凭据或数据库。
for (const file of files) {
  await mkdir(dirname(resolve(destination, file)), { recursive: true });
  await copyFile(resolve(root, file), resolve(destination, file));
}
await writeFile(resolve(destination, "package.json"), JSON.stringify({
  name: "agent-mailbox-mcp", version: "0.1.0", private: true, type: "module",
  engines: { node: ">=24" }, bin: { "mailbox-mcp": "./bin/mailbox-mcp.js" },
  dependencies: { "@modelcontextprotocol/sdk": "^1.0.0" },
}, null, 2) + "\n");
await copyFile(resolve(root, "docs/mailbox-mcp.md"), resolve(destination, "README.md"));
console.log(`MCP 包已导出：${destination}（首次使用需 npm install --omit=dev）`);
