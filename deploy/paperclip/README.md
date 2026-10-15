# 本机 Paperclip 通知接收进程

部署于 WSL `Paperclip`，不修改 `/home/paperclip/src/paperclip` 源码，不重启 Paperclip 主服务。

- 服务：`mailbox-notifier.service`，以 `paperclip` 用户运行，已 enable。
- 程序：`/opt/agent-mailbox-notifier/current` → `releases/notifications-20261016-01`。
- Node：`/opt/paperclip-tools/node/bin/node`，要求 Node 24+。
- 私有配置：`/home/paperclip/.config/agent-mailbox/notifier.json`，权限 600。
- 持久化事件与任务回执：`/var/lib/agent-mailbox-notifier/state.db`。
- 长连接：`wss://ashwellpages.net:8443/mcp/events`；复用 roguetower 项目范围密钥。
- 事件目标：Paperclip Routine `8e695032-2b41-4fe4-9ae3-5a963513c5c9`，负责人 Astra PM。每条定向新信创建一个可审计任务；没有定时轮询触发器。

Webhook URL 和密钥不写入仓库。部署依赖为本包的 `ws`；仅需复制 `src/paperclip-notifier.js`、`bin/mailbox-paperclip.js`、带 `type:module` 的包元数据与已安装的 `ws`（保留其 LICENSE），或按 lockfile 安装依赖。

```powershell
wsl -d Paperclip -u root -- systemctl status mailbox-notifier
wsl -d Paperclip -u root -- journalctl -u mailbox-notifier -n 30 --no-pager
wsl -d Paperclip -u root -- systemctl restart mailbox-notifier
```

停止自动通知用 `systemctl stop mailbox-notifier`；不要删除 state.db。重新启动会补收离线期间的未 ACK 定向新信，并复用已有任务回执。Paperclip 中暂停 Routine 会让新触发请求失败并在接收进程中保留待重试事件；已经创建的任务仍由 Paperclip 管理。

Windows 重启后需先启动 WSL/Paperclip；systemd enable 只保证发行版运行后启动该服务，不会自行启动关闭的 WSL。管理页面的 SSH 隧道与这条通知路径无关。

原有 Codex STDIO、Claude Channel、原生 IPC、远端 Codex relay 均仍有独立宿主用途，全部保留。本次没有部署旧版轮询进程，没有可删除的重复通知服务。
