import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const cookieBytes = 32;

export function createRouteCookie() {
  return randomBytes(cookieBytes).toString("base64url");
}

export function hashRouteCookie(cookie) {
  if (typeof cookie !== "string" || !/^[A-Za-z0-9_-]{40,80}$/.test(cookie))
    return null;
  return createHash("sha256").update(cookie, "utf8").digest("hex");
}

export function routeCookieJarPath(env = process.env) {
  if (env.MAILBOX_ROUTE_COOKIE_JAR)
    return resolve(env.MAILBOX_ROUTE_COOKIE_JAR);
  const base = env.LOCALAPPDATA || env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(base, "AgentMailbox", "route-cookies.json");
}

function normalizedOrigin(url) {
  return new URL(url).origin;
}

async function readJar(path) {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (!value || value.version !== 1 || !Array.isArray(value.routes))
      return { version: 1, routes: [] };
    return {
      version: 1,
      routes: value.routes.filter((route) =>
        route && typeof route.origin === "string" &&
        typeof route.participantId === "string" &&
        typeof route.cookie === "string" && hashRouteCookie(route.cookie)),
    };
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError)
      return { version: 1, routes: [] };
    throw error;
  }
}

async function writeJar(path, jar) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(jar, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(temporary, 0o600).catch(() => {});
  await rename(temporary, path);
}

async function updateJar(path, update) {
  await mkdir(dirname(path), { recursive: true });
  const lockPath = `${path}.lock`;
  let lock;
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      lock = await open(lockPath, "wx", 0o600);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const lockStat = await stat(lockPath).catch(() => null);
      if (lockStat && Date.now() - lockStat.mtimeMs > 30000) {
        await unlink(lockPath).catch(() => {});
        continue;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
  }
  if (!lock) throw new Error("路由 cookie jar 正在被其他进程占用");
  try {
    const jar = await readJar(path);
    const next = await update(jar);
    await writeJar(path, next);
    return next;
  } finally {
    await lock.close();
    await unlink(lockPath).catch(() => {});
  }
}

export async function routeCookiesFor(url, { env = process.env } = {}) {
  const origin = normalizedOrigin(url);
  const jar = await readJar(routeCookieJarPath(env));
  return jar.routes
    .filter((route) => route.origin === origin)
    .map(({ participantId, cookie }) => ({ participantId, cookie }));
}

export async function routeCookieFor(url, participantId, options = {}) {
  return (await routeCookiesFor(url, options))
    .find((route) => route.participantId === participantId)?.cookie ?? null;
}

export async function saveRouteCookie(url, participantId, cookie, { env = process.env } = {}) {
  if (!hashRouteCookie(cookie)) throw new Error("信箱返回了无效的路由 cookie");
  const origin = normalizedOrigin(url);
  const path = routeCookieJarPath(env);
  await updateJar(path, (jar) => {
    jar.routes = jar.routes.filter((route) =>
      route.origin !== origin || route.participantId !== participantId);
    jar.routes.push({ origin, participantId, cookie });
    return jar;
  });
}

export async function removeRouteCookie(url, participantId, { env = process.env } = {}) {
  const origin = normalizedOrigin(url);
  const path = routeCookieJarPath(env);
  let removed = false;
  await updateJar(path, (jar) => {
    const routes = jar.routes.filter((route) =>
      route.origin !== origin || route.participantId !== participantId);
    removed = routes.length !== jar.routes.length;
    return { version: 1, routes };
  });
  return removed;
}
