const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
let state = { topics: [], participants: [], bridges: [] };
let selected = location.hash.slice(1),
  current = null,
  filter = "all",
  replyTo = null,
  messages = [],
  cursor = 0,
  hasMore = false;
let refreshId = 0,
  toastTimer,
  refreshTimer,
  connectionCommand = "";
let sending = false,
  pendingPost = null;
const drafts = new Map();

async function api(path, body, method = body === undefined ? "GET" : "POST") {
  const res = await fetch("/api" + path, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await res.json();
  if (!res.ok) throw new Error(result.error);
  return result;
}
function toast(text, error = false) {
  clearTimeout(toastTimer);
  $("#toast").textContent = text;
  $("#toast").classList.toggle("error", error);
  $("#toast").hidden = false;
  toastTimer = setTimeout(() => {
    $("#toast").hidden = true;
  }, 4500);
}
function guard(fn) {
  return async (event) => {
    try {
      await fn(event);
    } catch (e) {
      toast(e.message, true);
    }
  };
}
const date = (value) =>
  new Date(value).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
const label = (status) =>
  ({ open: "进行中", paused: "已暂停", closed: "已关闭" })[status];
const avatar = (p) =>
  `<span class="avatar ${escapeHtml(p.kind)}">${escapeHtml(p.kind === "codex" ? "C" : p.kind === "claude" ? "✳" : p.kind === "human" ? "我" : p.name.slice(0, 1).toUpperCase())}</span>`;

function renderTopics() {
  const query = $("#search").value.trim().toLowerCase();
  const topics = state.topics.filter(
    (t) =>
      (filter === "all" || t.status === filter) &&
      `${t.title} ${t.goal}`.toLowerCase().includes(query),
  );
  $("#topic-count").textContent = String(state.topics.length).padStart(2, "0");
  $("#topics").innerHTML =
    topics
      .map(
        (t) =>
          `<button class="topic-card ${t.id === selected ? "active" : ""}" data-topic="${t.id}"><div class="topic-card-head"><span class="topic-dot ${t.status}"></span><span class="topic-card-title">${escapeHtml(t.title)}</span></div><p>${escapeHtml(t.goal)}</p><div class="topic-card-foot"><span>${t.message_count} 条消息</span><span>${label(t.status)}</span></div></button>`,
      )
      .join("") ||
    '<p class="empty-topics">这里还很安静。<br>开始一个值得讨论的问题。</p>';
}
function renderDetails() {
  $("#goal").textContent = current.goal;
  const connected = new Set(state.bridges.map((b) => b.participant_id));
  $("#members").innerHTML = current.members
    .map(
      (p) =>
        `<div class="member">${avatar(p)}<div class="member-info"><div class="member-name">${escapeHtml(p.name)}</div><div class="member-status">${p.kind === "human" ? "网页参与者" : connected.has(p.id) ? (state.bridges.find((b) => b.participant_id === p.id)?.kind.endsWith("-native") ? "● 原生通知已订阅" : "● 桥接已连接") : "○ 桥接未连接"}</div></div>${p.kind !== "human" ? `<button data-connect="${p.id}">连接</button>` : ""}</div>`,
    )
    .join("");
  const outsiders = state.participants.filter(
    (p) => !current.members.some((m) => m.id === p.id),
  );
  $("#join-existing").hidden = outsiders.length === 0;
  $("#existing-participant").innerHTML = outsiders
    .map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`)
    .join("");
  const old = $("#recipient").value;
  $("#recipient").innerHTML =
    '<option value="">不通知 · 仅记录</option>' +
    current.members
      .filter((p) => p.id !== "human")
      .map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`)
      .join("");
  if (current.members.some((p) => p.id === old)) $("#recipient").value = old;
  $("#pause-topic").textContent =
    current.status === "paused" ? "恢复通知" : "暂停通知";
  $("#pause-topic").disabled = current.status === "closed";
  $("#close-topic").textContent =
    current.status === "closed" ? "重新打开" : "关闭主题";
}
function renderMessages() {
  const area = $("#message-area");
  const nearBottom =
    area.scrollHeight - area.scrollTop - area.clientHeight < 120;
  $("#messages").innerHTML =
    messages
      .map((m) => {
        const delivery = !m.to_id
          ? ""
          : m.ack_at
            ? '<span><i class="status-dot ack"></i>已确认</span>'
            : m.error
              ? `<span class="delivery-error" title="${escapeHtml(m.error)}">投递失败</span>`
              : m.notified_at
                ? '<span><i class="status-dot sent"></i>已投递</span>'
                : '<span><i class="status-dot pending"></i>待投递</span>';
        const safe = DOMPurify.sanitize(
          marked.parse(m.body, { breaks: true }),
          {
            FORBID_TAGS: ["img", "form", "input", "style"],
            FORBID_ATTR: ["style"],
          },
        );
        return `<article class="message" id="message-${m.id}">${avatar({ kind: m.author_kind, name: m.author_name })}<div class="message-main"><div class="message-meta"><strong>${escapeHtml(m.author_name)}</strong><span class="kind-tag">${escapeHtml(m.author_kind.toUpperCase())}</span><time class="message-time">${date(m.created_at)}</time><span class="message-number">#${m.id}</span></div>${m.reply_to ? `<div class="reply-ref">↳ 回复 #${m.reply_to}</div>` : ""}<div class="message-body">${safe}</div><div class="message-footer">${m.to_id ? `<span>→ ${escapeHtml(m.to_name)}</span>` : ""}${delivery}<button class="text-button" data-reply="${m.id}">↩ 回复</button></div></div></article>`;
      })
      .join("") ||
    '<div class="empty-messages">主题已经准备好了。<br>发出第一条消息，让讨论开始。</div>';
  $("#load-more").hidden = !hasMore;
  if (nearBottom) area.scrollTop = area.scrollHeight;
}
async function refresh() {
  const id = ++refreshId;
  const next = await api("/state");
  if (id !== refreshId) return;
  state = next;
  renderTopics();
  if (!selected) {
    $("#welcome").hidden = false;
    $("#discussion").hidden = true;
    return;
  }
  const t = await api(`/topics/${selected}`);
  const loaded = [];
  let after = 0,
    page;
  // Re-read the displayed window so delivery acknowledgements refresh too.
  do {
    page = await api(`/topics/${selected}/messages?after=${after}&limit=200`);
    loaded.push(...page.messages);
    after = page.next;
  } while (page.hasMore && loaded.length < Math.max(messages.length, 200));
  if (id !== refreshId) return;
  current = t;
  messages = loaded;
  cursor = page.next;
  hasMore = page.hasMore;
  $("#welcome").hidden = true;
  $("#discussion").hidden = false;
  $("#topic-controls").hidden = false;
  $("#topic-title").textContent = t.title;
  $("#topic-status").textContent = label(t.status);
  $("#topic-status").className = `badge ${t.status}`;
  $("#topic-eyebrow").textContent =
    `DISCUSSION / ${t.id.slice(0, 8).toUpperCase()}`;
  $("#message-count").textContent =
    `${state.topics.find((topic) => topic.id === selected)?.message_count ?? 0} 条消息`;
  $("#message-body").disabled = t.status === "closed";
  $("#send-message").disabled = sending || t.status === "closed";
  renderDetails();
  renderMessages();
}
async function selectTopic(id) {
  if (selected)
    drafts.set(selected, {
      body: $("#message-body").value,
      recipient: $("#recipient").value,
      replyTo,
    });
  selected = id;
  location.hash = id;
  messages = [];
  current = null;
  const draft = drafts.get(id);
  $("#message-body").value = draft?.body ?? "";
  replyTo = draft?.replyTo ?? null;
  $("#reply-banner").hidden = !replyTo;
  $("#reply-label").textContent = replyTo ? `引用消息 #${replyTo}` : "";
  await refresh();
  if (draft?.recipient) $("#recipient").value = draft.recipient;
}
async function showConnection(id) {
  const p = state.participants.find((p) => p.id === id);
  const setup = await api("/setup");
  $("#connect-title").textContent = `接入 ${p.name}`;
  const identity = /^[\p{L}\p{N}_.-]+$/u.test(p.name) ? p.name : p.id;
  const urlOption =
    location.origin === "http://127.0.0.1:4317"
      ? ""
      : ` --url ${location.origin}`;
  if (["codex", "claude"].includes(p.kind)) {
    connectionCommand = `mailbox connect ${p.kind} --as ${identity} --background${urlOption}`;
    $("#connect-description").textContent =
      "把这条命令交给要参与讨论的 agent，让它在自己的会话中执行。通知程序会留在后台，原会话保持打开。";
    $("#connect-footnote").textContent =
      p.kind === "claude"
        ? "使用 Claude 原生收件管道，不需要 Channel 或重启会话。若缺少收件环境变量，先在 Claude 中查看 /status 的 Peer address；不会自动修改接收策略。"
        : "从目标会话取得 CODEX_THREAD_ID，用 codex queue 提交通知。普通终端需补 --thread 会话ID；若原宿主使用远端接口，还需 --endpoint。排队成功不等于模型已读。";
  } else {
    connectionCommand = `node "${setup.cli}" --url ${location.origin} inbox --as ${p.id}`;
    $("#connect-description").textContent =
      "让已有会话使用 CLI 主动读信和回信。";
    $("#connect-footnote").textContent =
      "普通 CLI 读信不会自动唤醒已结束的轮次。";
  }
  $("#connect-command").textContent = connectionCommand;
  $("#connect-dialog").showModal();
}

$("#new-topic").onclick = $("#first-topic").onclick = () =>
  $("#topic-dialog").showModal();
$("#add-participant").onclick = () => {
  if (!selected) return toast("先创建或选择一个主题");
  $("#participant-dialog").showModal();
};
document
  .querySelectorAll("[data-close]")
  .forEach(
    (b) => (b.onclick = () => document.getElementById(b.dataset.close).close()),
  );
$("#search").oninput = renderTopics;
document.querySelectorAll("[data-filter]").forEach(
  (b) =>
    (b.onclick = () => {
      filter = b.dataset.filter;
      document
        .querySelectorAll("[data-filter]")
        .forEach((x) => x.classList.toggle("active", x === b));
      renderTopics();
    }),
);
$("#topics").onclick = guard(async (e) => {
  const b = e.target.closest("[data-topic]");
  if (b) await selectTopic(b.dataset.topic);
});
$("#members").onclick = guard(async (e) => {
  const b = e.target.closest("[data-connect]");
  if (b) await showConnection(b.dataset.connect);
});
$("#messages").onclick = (e) => {
  const b = e.target.closest("[data-reply]");
  if (!b) return;
  replyTo = Number(b.dataset.reply);
  $("#reply-banner").hidden = false;
  $("#reply-label").textContent = `引用消息 #${replyTo}`;
  $("#message-body").focus();
};
$("#cancel-reply").onclick = () => {
  replyTo = null;
  $("#reply-banner").hidden = true;
};
$("#topic-form").onsubmit = guard(async (e) => {
  e.preventDefault();
  const data = new FormData(e.target);
  const button = e.target.querySelector("[type=submit]");
  button.disabled = true;
  try {
    const t = await api("/topics", {
      title: data.get("title"),
      goal: data.get("goal"),
    });
    $("#topic-dialog").close();
    e.target.reset();
    await selectTopic(t.id);
  } finally {
    button.disabled = false;
  }
});
$("#participant-form").onsubmit = guard(async (e) => {
  e.preventDefault();
  const data = new FormData(e.target);
  const button = e.target.querySelector("[type=submit]");
  button.disabled = true;
  try {
    const p = await api("/participants", {
      name: data.get("name"),
      kind: data.get("kind"),
    });
    await api(`/topics/${selected}/members`, { as: p.id });
    $("#participant-dialog").close();
    e.target.reset();
    await refresh();
    await showConnection(p.id);
  } finally {
    button.disabled = false;
  }
});
$("#join-button").onclick = guard(async () => {
  await api(`/topics/${selected}/members`, {
    as: $("#existing-participant").value,
  });
  await refresh();
});
$("#composer").onsubmit = guard(async (e) => {
  e.preventDefault();
  if (sending || !current || current.status === "closed") return;
  const body = $("#message-body").value;
  if (!body.trim()) return;
  const id = selected,
    to = $("#recipient").value || null,
    reference = replyTo;
  const key = JSON.stringify({ id, body, to, reference });
  if (pendingPost?.key !== key)
    pendingPost = { key, requestId: crypto.randomUUID() };
  sending = true;
  $("#send-message").disabled = true;
  try {
    await api(`/topics/${id}/members`, { as: "human" });
    await api(`/topics/${id}/messages`, {
      as: "human",
      body,
      to,
      replyTo: reference,
      requestId: pendingPost.requestId,
    });
    pendingPost = null;
    if (selected === id) {
      $("#message-body").value = "";
      $("#cancel-reply").click();
      drafts.delete(id);
    }
    await refresh();
    $("#message-area").scrollTop = $("#message-area").scrollHeight;
  } finally {
    sending = false;
    $("#send-message").disabled = current?.status === "closed";
  }
});
$("#message-body").onkeydown = (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    e.preventDefault();
    if (!$("#send-message").disabled) $("#composer").requestSubmit();
  }
};
$("#pause-topic").onclick = guard(async () => {
  await api(
    `/topics/${selected}`,
    { status: current.status === "paused" ? "open" : "paused" },
    "PATCH",
  );
  await refresh();
});
$("#close-topic").onclick = guard(async () => {
  await api(
    `/topics/${selected}`,
    { status: current.status === "closed" ? "open" : "closed" },
    "PATCH",
  );
  await refresh();
});
$("#load-more").onclick = guard(async () => {
  const id = selected;
  const page = await api(`/topics/${id}/messages?after=${cursor}&limit=200`);
  if (id !== selected) return;
  messages.push(...page.messages);
  cursor = page.next;
  hasMore = page.hasMore;
  renderMessages();
});
$("#copy-topic").onclick = guard(async () => {
  await navigator.clipboard.writeText(selected);
  toast("已复制主题 ID");
});
$("#ack-visible").onclick = guard(async () => {
  const id = selected,
    through = messages.at(-1)?.id;
  if (!through) return toast("暂无消息需要确认");
  await api(`/topics/${id}/members`, { as: "human" });
  await api(`/topics/${id}/ack`, { as: "human", through });
  await refresh();
  toast(`已确认阅读至 #${through}`);
});
$("#copy-command").onclick = guard(async () => {
  await navigator.clipboard.writeText(connectionCommand);
  toast("已复制");
});
window.addEventListener(
  "hashchange",
  guard(async () => {
    const id = location.hash.slice(1);
    if (id !== selected) await selectTopic(id);
  }),
);
const events = new EventSource("/api/events");
events.onopen = () => {
  $("#connection").textContent = "本地服务已连接";
  $("#connection").classList.remove("offline");
};
events.onerror = () => {
  $("#connection").textContent = "连接中断，正在重连";
  $("#connection").classList.add("offline");
};
events.addEventListener("change", () => {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(
    () => refresh().catch((e) => toast(e.message, true)),
    100,
  );
});
refresh().catch((e) => toast(e.message, true));
