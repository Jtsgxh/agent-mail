const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
let state = {
  topics: [],
  projects: [],
  participants: [],
  bridges: [],
  recipients: [],
};
let selected = location.hash.slice(1),
  current = null,
  currentSession = null,
  filter = "all",
  projectFilter = "all",
  replyTo = null,
  messages = [],
  cursor = 0,
  hasMore = false;
let refreshId = 0,
  toastTimer,
  refreshTimer;
let sending = false,
  pendingPost = null;
const drafts = new Map();
let checkingCodex = false;

async function api(path, body, method = body === undefined ? "GET" : "POST") {
  const res = await fetch("/api" + path, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await res.json();
  if (!res.ok) {
    const error = new Error(result.error);
    error.status = res.status;
    throw error;
  }
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
    const errorBox = event?.target
      ?.closest?.("dialog")
      ?.querySelector(".dialog-error");
    if (errorBox) errorBox.hidden = true;
    try {
      await fn(event);
    } catch (e) {
      if (errorBox) {
        errorBox.textContent = e.message;
        errorBox.hidden = false;
      } else toast(e.message, true);
    }
  };
}
async function checkCodexService(start = false) {
  if (checkingCodex) return;
  checkingCodex = true;
  const label = $("#codex-service-status");
  const button = $("#start-codex-service");
  const check = $("#check-codex-service");
  button.disabled = check.disabled = true;
  label.textContent = start ? "Codex App · 连接中…" : "Codex App · 检查中";
  label.dataset.status = "checking";
  $("#codex-service-error").hidden = true;
  try {
    const host = start ? await api("/codex/connect", {}) : await api("/codex/status");
    if (host.transport !== "desktop-app") throw new Error("信箱后端尚未加载 App 复用接口，请更新并重启 Mailbox 服务。");
    const names = { reachable: "已连接", unreachable: "连接不可用", unconfigured: "未接入" };
    if (!names[host.status]) throw new Error("无法识别服务状态");
    label.textContent = `Codex App · ${names[host.status]}`;
    label.dataset.status = host.status;
    $("#codex-service-address").textContent = host.status === "reachable" ? "当前桌面 App 可接收创建请求" : "等待当前桌面 App 接入";
    $("#codex-service-error").textContent = host.error ?? "";
    $("#codex-service-error").hidden = !host.error;
    $("#codex-service-checked").textContent = `上次检测：${new Date(host.checked_at).toLocaleTimeString("zh-CN", { hour12: false })}`;
    button.hidden = host.status === "reachable";
    if (start && host.status === "reachable") toast("已连接当前 Codex App");
  } catch (error) {
    label.textContent = start ? "Codex App · 连接失败" : "Codex App · 状态未知";
    label.dataset.status = "error";
    $("#codex-service-error").textContent = error.status === 404
      ? "信箱后端尚未加载服务管理接口，请重启 Mailbox 服务后再连接。"
      : error.message;
    $("#codex-service-error").hidden = false;
    $("#codex-service-checked").textContent = "本次操作未完成";
    button.hidden = false;
  } finally {
    checkingCodex = false;
    button.disabled = false;
    check.disabled = false;
  }
}
$("#start-codex-service").onclick = () => checkCodexService(true);
$("#check-codex-service").onclick = () => checkCodexService();
setInterval(() => { if (!document.hidden) checkCodexService(); }, 30000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) checkCodexService(); });

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
const projectName = (id) =>
  id === null
    ? "未归类"
    : (state.projects.find((p) => p.id === id)?.name ?? "");
const matchesProject = (topic) =>
  projectFilter === "all" ||
  (topic.project_id ?? "unassigned") === projectFilter;
function projectOptions() {
  return (
    '<option value="">未归类</option>' +
    state.projects
      .map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`)
      .join("")
  );
}
function renderProjects() {
  if (
    !["all", "unassigned"].includes(projectFilter) &&
    !state.projects.some((project) => project.id === projectFilter)
  )
    projectFilter = "unassigned";
  $("#project-filter").innerHTML =
    '<option value="all">全部项目</option><option value="unassigned">未归类</option>' +
    state.projects
      .map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`)
      .join("");
  $("#project-filter").value = projectFilter;
  $("#project-actions").hidden = ["all", "unassigned"].includes(projectFilter);
}

function renderTopics() {
  const query = $("#search").value.trim().toLowerCase();
  const topics = state.topics.filter(
    (t) =>
      (filter === "all" || t.status === filter) &&
      matchesProject(t) &&
      `${t.title} ${t.goal} ${projectName(t.project_id)}`
        .toLowerCase()
        .includes(query),
  );
  $("#topic-count").textContent = String(topics.length).padStart(2, "0");
  $("#topics").innerHTML =
    topics
      .map(
        (t) =>
          `<button class="topic-card ${t.id === selected ? "active" : ""}" data-topic="${t.id}"><div class="topic-card-head"><span class="topic-dot ${t.status}"></span><span class="topic-card-title">${escapeHtml(t.title)}</span></div><p>${escapeHtml(t.goal)}</p><div class="topic-project-label">${escapeHtml(projectName(t.project_id))}</div><div class="topic-card-foot"><span>${t.message_count} 条消息</span><span>${label(t.status)}</span></div></button>`,
      )
      .join("") ||
    '<p class="empty-topics">这里还很安静。<br>开始一个值得讨论的问题。</p>';
}
function renderDetails() {
  $("#topic-project").innerHTML = projectOptions();
  $("#topic-project").value = current.project_id ?? "";
  $("#goal").textContent = current.goal;
  const memberStatus = (p) => {
    if (p.kind === "human") return "";
    const route = state.recipients.find((r) => r.participant_id === p.id);
    if (route)
      return {
        ready: "通知入口已登记",
        retrying: "入口暂不可达，正在自动重试",
        stopping: "通知正在停止",
        error: "! 投递失败，重新加入可重试",
      }[route.status];
    if (state.bridges.some((b) => b.participant_id === p.id))
      return "● 旧版通知进程在线";
    return ["codex", "claude"].includes(p.kind) ? "未登记通知入口" : "手动收信";
  };
  $("#members").innerHTML = current.members
    .map((p) => {
      const status = memberStatus(p);
      return `<div class="member">${avatar(p)}<div class="member-info"><div class="member-name">${escapeHtml(p.name)}</div>${status ? `<div class="member-status">${status}</div>` : ""}</div></div>`;
    })
    .join("");
  const outsiders = state.participants.filter(
    (p) => !current.members.some((m) => m.id === p.id),
  );
  $("#join-existing").hidden = outsiders.length === 0;
  $("#existing-participant").innerHTML = outsiders
    .map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`)
    .join("");
  const sessionStatus = {
    reserved: "已预留，尚未确认启动",
    submitted: "已提交启动",
    uncertain: "启动结果未确认，请核查原会话",
  };
  $("#topic-sessions").innerHTML = currentSession
    ? `<div class="session-notice"><strong>此主题已有 Codex，不会再开一个。</strong><span>${escapeHtml(sessionStatus[currentSession.launch_status] ?? currentSession.launch_status)}</span><span>${escapeHtml(memberStatus({ id: currentSession.participant_id, kind: "codex" }))}</span></div>`
    : '<p class="muted">此主题尚未创建独立 Codex 会话。</p>';
  renderRecipients();
  $("#pause-topic").textContent =
    current.status === "paused" ? "恢复通知" : "暂停通知";
  $("#pause-topic").disabled = current.status === "closed";
  $("#close-topic").textContent =
    current.status === "closed" ? "重新打开" : "关闭主题";
}
function notificationSelection() {
  const broadcast = $("#broadcast").checked;
  const to = broadcast
    ? []
    : [...document.querySelectorAll("#recipient-list input:checked")]
        .map((input) => input.value)
        .sort();
  return { to, broadcast };
}
function updateRecipientSummary() {
  const selection = notificationSelection();
  $("#recipient-summary").textContent = selection.broadcast
    ? "广播给所有其他参与者"
    : selection.to.length
      ? selection.to
          .map((id) => current.members.find((p) => p.id === id).name)
          .join("、")
      : "不通知 · 仅记录";
  document.querySelectorAll("#recipient-list input").forEach((input) => {
    input.disabled = selection.broadcast;
  });
}
function renderRecipients(selection = notificationSelection()) {
  $("#broadcast").checked = selection.broadcast;
  $("#recipient-list").innerHTML = (current?.members ?? [])
    .filter((p) => p.id !== "human")
    .map(
      (p) =>
        `<label><input type="checkbox" value="${p.id}" ${selection.to.includes(p.id) ? "checked" : ""} />${escapeHtml(p.name)}</label>`,
    )
    .join("");
  updateRecipientSummary();
}
$("#recipient-picker").onchange = updateRecipientSummary;
$("#clear-recipients").onclick = () =>
  renderRecipients({ to: [], broadcast: false });
document.addEventListener("click", (event) => {
  if (!$("#recipient-picker").contains(event.target))
    $("#recipient-picker").open = false;
});
$("#recipient-picker").onkeydown = (event) => {
  if (event.key === "Escape") $("#recipient-picker").open = false;
};
function renderMessages() {
  const area = $("#message-area");
  const nearBottom =
    area.scrollHeight - area.scrollTop - area.clientHeight < 120;
  // This view always loads a prefix of the topic's history, starting at after=0.
  const numbers = new Map(messages.map((message, index) => [message.id, index + 1]));
  $("#messages").innerHTML =
    messages
      .map((m) => {
        const delivery = m.recipients
          .map((recipient) => {
            const retrying = state.recipients.some((route) =>
              route.participant_id === recipient.recipient_id && route.status === "retrying" && route.retry_message_id === m.id);
            const status = recipient.ack_at
              ? "已确认"
              : recipient.error
                ? retrying ? "等待自动重试" : "投递失败"
                : recipient.notified_at
                  ? "已投递"
                  : "待投递";
            return `<span class="recipient-delivery ${recipient.error && !recipient.ack_at ? "delivery-error" : ""}" title="${escapeHtml(recipient.error ?? "")}">→ ${escapeHtml(recipient.recipient_name)} · ${status}</span>`;
          })
          .join("");
        const safe = DOMPurify.sanitize(
          marked.parse(m.body, { breaks: true }),
          {
            FORBID_TAGS: ["img", "form", "input", "style"],
            FORBID_ATTR: ["style"],
          },
        );
        return `<article class="message" id="message-${m.id}">${avatar({ kind: m.author_kind, name: m.author_name })}<div class="message-main"><div class="message-meta"><strong>${escapeHtml(m.author_name)}</strong><span class="kind-tag">${escapeHtml(m.author_kind.toUpperCase())}</span><time class="message-time">${date(m.created_at)}</time><span class="message-number">#${numbers.get(m.id)}</span></div>${m.reply_to ? `<div class="reply-ref">↳ 回复 #${numbers.get(m.reply_to)}</div>` : ""}<div class="message-body">${safe}</div><div class="message-footer">${m.broadcast ? "<span>广播</span>" : ""}${delivery}<button class="text-button" data-reply="${m.id}" data-number="${numbers.get(m.id)}">↩ 回复</button></div></div></article>`;
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
  if (selected && !state.topics.some((topic) => topic.id === selected)) {
    const deleted = selected;
    await selectTopic("");
    drafts.delete(deleted);
    return;
  }
  renderProjects();
  renderTopics();
  $(".details").hidden = !selected;
  if (!selected) {
    currentSession = null;
    $("#welcome").hidden = false;
    $("#discussion").hidden = true;
    return;
  }
  const topicId = selected;
  const loaded = [];
  let t,
    codexSession,
    after = 0,
    page;
  try {
    [t, codexSession] = await Promise.all([
      api(`/topics/${topicId}`),
      api(`/topics/${topicId}/sessions/codex`),
    ]);
    if (id !== refreshId) return;
    // Re-read the displayed window so delivery acknowledgements refresh too.
    do {
      page = await api(`/topics/${topicId}/messages?after=${after}&limit=200`);
      loaded.push(...page.messages);
      after = page.next;
    } while (page.hasMore && loaded.length < Math.max(messages.length, 200));
  } catch (error) {
    if (id !== refreshId) return;
    if (error.status === 404) {
      const topics = await api("/topics");
      if (id !== refreshId) return;
      if (!topics.some((topic) => topic.id === topicId)) {
        await selectTopic("");
        drafts.delete(topicId);
        return;
      }
    }
    throw error;
  }
  if (id !== refreshId) return;
  current = t;
  currentSession = codexSession;
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
    `${projectName(t.project_id)} / ${t.id.slice(0, 8).toUpperCase()}`;
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
      notification: notificationSelection(),
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
  $("#reply-label").textContent = replyTo ? `引用消息 #${replyTo.number}` : "";
  await refresh();
  renderRecipients(draft?.notification ?? { to: [], broadcast: false });
  $("#recipient-picker").open = false;
}
$("#new-topic").onclick = $("#first-topic").onclick = () => {
  $("#create-topic-project").innerHTML = projectOptions();
  $("#create-topic-project").value = ["all", "unassigned"].includes(
    projectFilter,
  )
    ? ""
    : projectFilter;
  $("#topic-dialog").showModal();
};
$("#new-project").onclick = () => {
  $("#project-form").reset();
  $("#project-form").dataset.project = "";
  $("#project-dialog-title").textContent = "创建项目";
  $("#save-project").textContent = "创建项目";
  $("#project-dialog .dialog-error").hidden = true;
  $("#project-dialog").showModal();
};
$("#rename-project").onclick = () => {
  const project = state.projects.find((project) => project.id === projectFilter);
  if (!project) return;
  $("#project-form").dataset.project = project.id;
  $("#project-name").value = project.name;
  $("#project-dialog-title").textContent = "修改项目名称";
  $("#save-project").textContent = "保存名称";
  $("#project-dialog .dialog-error").hidden = true;
  $("#project-dialog").showModal();
};
$("#delete-project").onclick = () => {
  const project = state.projects.find((project) => project.id === projectFilter);
  if (!project) return;
  $("#delete-project-dialog").dataset.project = project.id;
  $("#delete-project-name").textContent = project.name;
  $("#delete-project-count").textContent = project.topic_count;
  $("#delete-project-dialog .dialog-error").hidden = true;
  $("#delete-project-dialog").showModal();
};
$("#delete-project-form").onsubmit = guard(async (event) => {
  event.preventDefault();
  const dialog = $("#delete-project-dialog");
  const button = event.target.querySelector('[type="submit"]');
  if (button.disabled) return;
  button.disabled = true;
  try {
    await api(`/projects/${dialog.dataset.project}`, undefined, "DELETE");
    dialog.close();
    await refresh();
    toast("项目已删除，原有主题已移到未归类");
  } finally {
    button.disabled = false;
  }
});
$("#project-filter").onchange = guard(async (event) => {
  projectFilter = event.target.value;
  renderProjects();
  const visible = state.topics.filter(matchesProject);
  if (!visible.some((topic) => topic.id === selected))
    await selectTopic(visible[0]?.id ?? "");
  else renderTopics();
});
$("#topic-project").onchange = guard(async (event) => {
  const id = selected,
    project = event.target.value || null;
  try {
    await api(`/topics/${id}`, { project }, "PATCH");
    if (selected === id && projectFilter !== "all")
      projectFilter = project ?? "unassigned";
    await refresh();
    toast("已更新所属项目");
  } catch (error) {
    if (current?.id === id) event.target.value = current.project_id ?? "";
    throw error;
  }
});
$("#project-form").onsubmit = guard(async (event) => {
  event.preventDefault();
  const button = event.target.querySelector('[type="submit"]');
  if (button.disabled) return;
  const id = event.target.dataset.project;
  button.disabled = true;
  try {
    const project = await api(
      id ? `/projects/${id}` : "/projects",
      { name: new FormData(event.target).get("name") },
      id ? "PATCH" : "POST",
    );
    $("#project-dialog").close();
    event.target.reset();
    if (id) {
      await refresh();
      toast("项目名称已更新");
    } else {
      projectFilter = project.id;
      await selectTopic("");
      toast("项目已创建，可以开始新讨论");
    }
  } finally {
    button.disabled = false;
  }
});
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
$("#messages").onclick = (e) => {
  const b = e.target.closest("[data-reply]");
  if (!b) return;
  replyTo = { id: Number(b.dataset.reply), number: Number(b.dataset.number) };
  $("#reply-banner").hidden = false;
  $("#reply-label").textContent = `引用消息 #${replyTo.number}`;
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
      project: data.get("project") || null,
    });
    $("#topic-dialog").close();
    e.target.reset();
    if (projectFilter !== "all") projectFilter = t.project_id ?? "unassigned";
    await selectTopic(t.id);
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
    notification = notificationSelection(),
    reference = replyTo?.id ?? null;
  const key = JSON.stringify({ id, body, ...notification, reference });
  if (pendingPost?.key !== key)
    pendingPost = { key, requestId: crypto.randomUUID() };
  sending = true;
  $("#recipient-picker").open = false;
  $("#send-message").disabled = true;
  try {
    await api(`/topics/${id}/members`, { as: "human" });
    await api(`/topics/${id}/messages`, {
      as: "human",
      body,
      ...notification,
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
$("#delete-topic").onclick = () => {
  if (!current) return;
  $("#delete-topic-name").textContent = current.title;
  $("#delete-topic-dialog").dataset.topic = current.id;
  $("#delete-topic-dialog .dialog-error").hidden = true;
  $("#delete-topic-dialog").showModal();
};
$("#delete-topic-form").onsubmit = guard(async (event) => {
  event.preventDefault();
  const dialog = $("#delete-topic-dialog");
  const id = dialog.dataset.topic;
  const button = event.target.querySelector('[type="submit"]');
  if (button.disabled) return;
  button.disabled = true;
  try {
    await api(`/topics/${id}`, undefined, "DELETE");
    dialog.close();
    await refresh();
    drafts.delete(id);
    toast("主题及其消息已删除");
  } finally {
    button.disabled = false;
  }
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
    through = messages.at(-1)?.id,
    throughNumber = messages.length;
  if (!through) return toast("暂无消息需要确认");
  await api(`/topics/${id}/members`, { as: "human" });
  await api(`/topics/${id}/ack`, { as: "human", through });
  await refresh();
  toast(`已确认阅读至 #${throughNumber}`);
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
  $("#connection").textContent = "信箱服务已连接";
  $("#connection").classList.remove("offline");
  checkCodexService();
};
events.onerror = () => {
  $("#connection").textContent = "信箱连接中断，正在重连";
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
checkCodexService();
