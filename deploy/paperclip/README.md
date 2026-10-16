# 本机 Paperclip 独立身份通知

部署于 WSL `Paperclip`，不修改 `/home/paperclip/src/paperclip` 源码，不重启 Paperclip 主服务。

- 服务：`mailbox-notifier@pm`、`@dev`、`@qa`、`@art2d`、`@art3d`、`@ux`，均以 `paperclip` 用户运行并 enable。六个实例复用同一程序，各自独立配置与状态。
- 程序：`/opt/agent-mailbox-notifier/current` → `releases/notifications-20261016-01`。
- Node：`/opt/paperclip-tools/node/bin/node`，要求 Node 24+。
- 私有配置：`/home/paperclip/.config/agent-mailbox/identities/<别名>.notifier.json`，目录 700、文件 600；凭据不会进入仓库。
- 持久化事件与任务回执：`/var/lib/agent-mailbox-notifier/<别名>.db`。不得互换状态库，不要删除它来重试。
- 长连接：`wss://ashwellpages.net:8443/mcp/events`；同属 roguetower 项目，但六个参与者和六把密钥各自独立。
- 每个连接仅安装给所属 agent，自己的十个动作 Allowed；专属连接的身份规则阻止其他 agent 借用广泛的 tools:use 授权冒用身份。管理员仍可管理。映射见 [RogueTower skill 参考](../../skills/agent-mailbox/references/paperclip-roguetower.md)。

| 别名 | agent | 事件 Routine |
| --- | --- | --- |
| pm | Astra PM | d3023aa3-7487-4319-8b58-002457138bce |
| dev | 游戏设计与开发 | 32db16f4-5bcd-451f-88b2-85d1705ae4e4 |
| qa | 独立 QA | 9b3fdadd-5b53-4175-9092-d38d5e26ec0d |
| art2d | 2D 美术负责人 | f382a7c0-29fb-42ca-adab-495aabe38c38 |
| art3d | 3D 资产负责人 | b233c988-7143-403d-bb96-3c5f61c7d8ae |
| ux | 美术与 UX | 16388fde-ff4a-4eaf-b528-18b9bb0b6d28 |

每条定向新信分别启动对应 agent 的可审计任务，没有周期查信触发器。发给多人的同一条信在每个身份下独立回复和 ACK。

Webhook URL 和密钥不写入仓库。部署依赖为本包的 `ws`；仅需复制 `src/paperclip-notifier.js`、`bin/mailbox-paperclip.js`、带 `type:module` 的包元数据与已安装的 `ws`（保留其 LICENSE），或按 lockfile 安装依赖。

```powershell
wsl -d Paperclip -u root -- systemctl status mailbox-notifier@pm
wsl -d Paperclip -u root -- journalctl -u mailbox-notifier@pm -n 30 --no-pager
wsl -d Paperclip -u root -- systemctl restart mailbox-notifier@pm
```

停止某个身份的自动通知用 `systemctl stop mailbox-notifier@pm`（替换别名）；不要删除状态库。重新启动会补收离线期间的未 ACK 定向新信，并复用已有任务回执。Paperclip 中暂停 Routine 会让新触发请求失败并在接收进程中保留待重试事件；已经创建的任务仍由 Paperclip 管理。

Windows 重启后需先启动 WSL/Paperclip；systemd enable 只保证发行版运行后启动该服务，不会自行启动关闭的 WSL。管理页面的 SSH 隧道与这条通知路径无关。

原有 Codex STDIO、Claude Channel、原生 IPC、远端 Codex relay 均仍有独立宿主用途，全部保留。

## 独立身份迁移验收

2026-10-16：138 项回归通过；六个专属连接的真实 MCP identity 均匹配，运行时策略矩阵为 60 项本人动作允许、300 项跨 agent 动作拒绝，六个 agent 均启用新版 skill。重启六个通知实例后，每个身份仍只有一个对应验收任务。

真实验收主题为 `7c2ae462-27c8-42a5-a23d-cfd86c7121f5`，来信 #11。任务对应 QA TON-89、UX TON-90、2D TON-91、PM TON-92、开发 TON-93、3D TON-94。接入与触发已验证，六个模型的实际回复与 ACK 仍待验收，不能将运行中的任务当作完成。

旧共享链路暂保留：`mailbox-notifier.service`、Routine `8e695032-2b41-4fe4-9ae3-5a963513c5c9`、连接 `22ff9e55-1502-45e0-880c-12a441b59ba7`、参与者 `4105e73a-b612-4ed1-bec2-4b105f594d58`。只有新身份真实回复和 ACK 验收通过，且旧链路没有待处理信件或运行任务后，才停用这条共享链路；历史任务、信件、配置和状态库保留，不删除独立宿主适配。
