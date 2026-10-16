# 本机 Paperclip 独立身份通知

部署于 WSL `Paperclip`，通知接入复用现有 MCP、连接权限和 Routine 入口。后续用户授权的 Paperclip 共享根目录性能修复及部署情况见下方验收记录。

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

真实验收主题为 `7c2ae462-27c8-42a5-a23d-cfd86c7121f5`，来信 #11。QA TON-89、UX TON-90、2D TON-91、PM TON-92、开发 TON-93、3D TON-94 均已完成；六个身份各有唯一正确身份/校验码的回复（#12–17），并各自 ACK #11。模型通过真实 MCP 完成，未代替 agent 回复或 ACK。

首次六任务验收曾因 Paperclip 的历史工作区交叉授权和公司级锁排队约 53 分钟，最终在旧代码下完成。数据库事务年龄包含排队时间，不等于精确持锁时长。后端同一目录有 263 条逻辑工作区记录；按 34 条 reader 计算，仅第一层就有 8,942 组权限检查。用户随后明确选择已授权项目根目录内共享文件的规则，WSL Paperclip 仓库提交 `9058574a` 实现并部署该模式（此后允许修改 Paperclip 的授权边界取代本次迁移最初的不改源码约束）。

共享根目录由主机 `/etc/paperclip/shared-workspace-roots.env` 固定到 RogueTower 已登记的客户端和后端目录，项目元数据不能扩大范围。当前身份、项目权限、受限任务和真实路径检查保留，历史任务记录不再作为这些目录内部的文件隔离边界。146 项相关 Paperclip 测试、服务端类型检查和编译通过；六个真实身份只读准入测量为 45 次查询、73–203ms。应用在确认无运行/排队任务后重启；仅部署两个服务模块，保留其他未提交改动。模块回滚备份在 `/var/backups/paperclip/shared-root-20261016-02`。

单身份离线实测：停 QA 通知进程时发送唯一来信 #18，没有新增任务；恢复后仅 QA 补收，创建 TON-95，约 3.4 秒启动模型，实际 MCP 回复 #19 并 ACK #18，其他五个身份任务数不变。主验收重启去重与本次离线补收分别有独立证据。证据在本地 ignored 的 `artifacts/identity-migration/` 和 `artifacts/workspace-root-fix/`，不含原始密钥。

旧共享链路已退役：确认 TON-87/88 完成、旧参与者没有未处理定向消息后，暂停 Routine `8e695032-2b41-4fe4-9ae3-5a963513c5c9`，禁用连接 `22ff9e55-1502-45e0-880c-12a441b59ba7`，停止并 disable `mailbox-notifier.service`，撤销参与者 `4105e73a-b612-4ed1-bec2-4b105f594d58` 的唯一 roguetower 密钥。原配置和状态仍保留，并在 `/var/backups/agent-mailbox-notifier/shared-retired-20261016` 保存私有备份。六个实例保持 active/enabled；历史任务、信件和独立 Codex/Claude/relay 适配保留。Codex 自动跟进保持暂停，完成后不再轮询。
