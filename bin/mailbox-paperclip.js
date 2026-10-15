#!/usr/bin/env node
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { startPaperclipNotifier } from "../src/paperclip-notifier.js";

process.umask(0o077);
const path = process.argv[2];
if (!path || process.argv.length !== 3) {
  console.error("Usage: node bin/mailbox-paperclip.js /private/path/notifier.json"); process.exit(1);
}
try {
  const file = resolve(path);
  if (process.platform !== "win32" && ((await stat(file)).mode & 0o077))
    throw new Error("Configuration must be readable only by its service user (chmod 600)");
  const config = JSON.parse(await readFile(file, "utf8"));
  const service = await startPaperclipNotifier(config, { onState: (event) => console.log(JSON.stringify({ at: new Date().toISOString(), ...event })) });
  for (const sig of ["SIGTERM", "SIGINT"]) process.once(sig, () => void service.close());
  await service.done;
} catch {
  console.error("Mailbox notifier failed. Check private configuration, state path and service logs; no credentials are printed.");
  process.exitCode = 1;
}
