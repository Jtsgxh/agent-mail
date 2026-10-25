import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { agentCommand } from "./connect.js";
import { queueCodex, writeClaude, validateClaudeAddress } from "./native.js";

// What differs between chat hosts for a connector wake: where the existing HTTP MCP connection is configured,
// which conversation the current tool environment belongs to, and how a notice reaches that conversation.
// Credentials are returned to the caller's memory only.
const exec = promisify(execFile);
const header = (headers, name) => Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name)?.[1];
const samePath = (a, b, platform) => platform === "win32"
  ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);

export function wakeHost(kind, { agentBin, env = process.env, cwd = process.cwd(), platform = process.platform } = {}) {
  if (kind === "codex") {
    let program;
    const codex = () => (program ??= agentCommand("codex", { bin: agentBin }));
    const run = async (args) => {
      const { command, args: base } = await codex();
      return exec(command, [...base, ...args], { windowsHide: true, timeout: 10000 });
    };
    return {
      kind, thread: env.CODEX_THREAD_ID,
      // Let Codex parse its own configuration; never print the credential-bearing JSON.
      async connection(name) {
        let saved;
        try { saved = JSON.parse((await run(["mcp", "get", name, "--json"])).stdout); }
        catch { throw new Error("Cannot load this Codex MCP connection"); }
        if (saved.enabled === false || saved.transport?.type !== "streamable_http") throw new Error("An enabled HTTP MCP connection is required");
        const { url, http_headers: headers, bearer_token_env_var: tokenVar } = saved.transport;
        return { url, authorization: header(headers, "authorization") ?? (tokenVar ? `Bearer ${env[tokenVar] ?? ""}` : undefined) };
      },
      check: () => run(["queue", "--help"]),
      wake: async (text, signal) => queueCodex(await codex(), { thread: env.CODEX_THREAD_ID, text, signal }),
    };
  }
  if (kind === "claude") {
    const socket = env.CLAUDE_CODE_MESSAGING_SOCKET, token = env.CLAUDE_CODE_MESSAGING_TOKEN;
    return {
      kind, thread: env.CLAUDE_CODE_SESSION_ID,
      // Claude Code keeps user- and local-scope servers in .claude.json; local scope for this directory wins.
      async connection(name) {
        let config;
        try { config = JSON.parse(await readFile(join(env.CLAUDE_CONFIG_DIR ?? homedir(), ".claude.json"), "utf8")); }
        catch { throw new Error("Cannot load this Claude MCP connection"); }
        const local = Object.entries(config.projects ?? {}).find(([path]) => samePath(path, cwd, platform))?.[1];
        const server = local?.mcpServers?.[name] ?? config.mcpServers?.[name];
        if (server?.type !== "http") throw new Error("An HTTP MCP connection is required");
        return { url: server.url, authorization: header(server.headers, "authorization") };
      },
      check: async () => validateClaudeAddress(socket, token, platform),
      wake: (text, signal) => writeClaude({ socket, token, text, signal }),
    };
  }
  throw new Error("Host must be codex or claude");
}
