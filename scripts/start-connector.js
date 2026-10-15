import { startServer } from "../src/server.js";
import { number } from "../src/store.js";

// Docker Desktop reaches this loopback-only listener through host.docker.internal.
// For a different network layout, set an explicit interface and public endpoint.
const mcpPort = number(process.env.MAILBOX_MCP_PORT ?? 4318, "MAILBOX_MCP_PORT", 1, 65535);
const app = await startServer({
  port: number(process.env.MAILBOX_PORT ?? 4317, "MAILBOX_PORT", 1, 65535),
  host: process.env.MAILBOX_HOST ?? "127.0.0.1",
  dbPath: process.env.MAILBOX_DB,
  mcpPort,
  mcpHost: process.env.MAILBOX_MCP_HOST ?? "127.0.0.1",
  mcpPublicUrl: process.env.MAILBOX_MCP_PUBLIC_URL ?? `http://host.docker.internal:${mcpPort}/mcp`,
});
console.log(`Agent Mailbox → ${app.url}`);
console.log(`MCP Connector → ${app.mcpUrl}`);
let closing = false;
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    if (closing) return;
    closing = true;
    await app.close();
    process.exit(0);
  });
