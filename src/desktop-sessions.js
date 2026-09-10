import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { HttpError, required, number } from "./store.js";
import { projectTarget } from "./codex-app.js";
import { sessionPrompt } from "./sessions.js";

export async function launchDesktopSession(store, app, topic, input, { url, signal, changed }) {
  const as = required(input.as, "as");
  const cwd = await realpath(resolve(required(input.cwd, "cwd", 4000)));
  if (!(await stat(cwd)).isDirectory()) throw new HttpError(400, "cwd 必须是目录");
  const maxMessages = number(input.maxMessages ?? 20, "maxMessages", 1);
  if (store.session(topic, "codex")) throw new HttpError(409, "此主题已有 codex 会话记录，请用 session info 查看；不会重复启动");
  store.member(topic, as);
  const context = { ...app.context };
  const target = projectTarget(await app.projects({ signal, context }), cwd);
  await app.prepareSidebar({ signal, context });
  signal.throwIfAborted();
  const session = store.reserveSession(topic, { kind: "codex", as, cwd, transport: "desktop-app" });
  changed();
  let nativeId, launchRef;
  try {
    const result = await app.call("create_thread", {
      target,
      title: `信箱讨论：${store.topic(topic).title}`,
      prompt: sessionPrompt(session, url, maxMessages),
    }, { signal, context });
    nativeId = result?.threadId ?? result?.conversationId;
    launchRef = result?.clientThreadId;
    if (nativeId) app.assertNewTarget(nativeId, context);
    if (result?.hostId !== "local" || (!nativeId && !launchRef) ||
        (result.status && (result.status !== "created" || result.firstTurn?.status !== "accepted")))
      throw new Error("Codex App 未确认新任务和首条指令提交成功，请检查原任务，不要重复创建");
    signal.throwIfAborted();
    store.updateSession(topic, "codex", { nativeId, launchRef, launchStatus: "submitted" });
    changed();
    return store.session(topic, "codex");
  } catch (error) {
    // Keep an uncertain record even if the response was lost; never launch a second task.
    if (store.db.prepare("SELECT 1 FROM topics WHERE id=?").get(topic)) {
      const current = store.session(topic, "codex");
      if (current?.launch_status === "reserved") {
        store.updateSession(topic, "codex", {
          ...(nativeId && nativeId !== context.threadId && (!current.native_id || current.native_id === nativeId) ? { nativeId } : {}),
          launchRef, launchStatus: "uncertain", error: "App 创建结果未确认；检查已有任务和绑定，不要重复创建",
        });
        changed();
      }
    }
    throw error;
  }
}
