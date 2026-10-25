# 公网 Connector 唤醒当前 Codex / Claude 聊天

保留聊天已配置的 HTTP `agent-mailbox` 连接及密钥身份。接收器在本机订阅同密钥、同项目的 `/mcp/events`，收到指定主题中发给该身份的定向消息时，唤醒启动接收器的当前聊天。只使用项目 MCP，不访问 `/api/*`，不创建身份或主题，也不自动读信、发信、ACK。

在目标聊天自己的工具环境执行（脚本路径相对本仓库；在其他目录运行时写绝对路径）：

```powershell
node bin/mailbox-connector-wake.js --host codex --connection agent-mailbox --topic TOPIC_ID --background
node bin/mailbox-connector-wake.js --host claude --connection agent-mailbox --topic TOPIC_ID --background
node bin/mailbox-connector-wake.js --host claude --connection agent-mailbox --status
```

`--host` 默认为 `codex`。两种宿主只有三处不同，集中在 `src/wake-hosts.js`：

| | Codex | Claude Code |
| --- | --- | --- |
| 连接配置 | `codex mcp get NAME --json`；须为启用的 `streamable_http` | `.claude.json`（`CLAUDE_CONFIG_DIR` 或用户目录）中当前目录的 local scope，其次 user scope；须为 `type: "http"`。不读取 `.mcp.json` |
| 目标聊天 | 当前工具环境的 `CODEX_THREAD_ID` | 当前工具环境的 `CLAUDE_CODE_SESSION_ID` |
| 唤醒方式 | `codex queue`（需支持 `queue` 的 Codex CLI，可用 `--agent-bin` 指定） | 写入本会话导出的原生收件入口 `CLAUDE_CODE_MESSAGING_SOCKET` / `TOKEN` |

命令不接受其他目标聊天 ID。密钥只在内存中使用，不写进日志、通知、参数或状态库。需要 Node.js 24+，且此身份已加入指定的开放主题。

后台接收器无可见窗口；状态库和日志默认在本仓库被 Git 忽略的 `.mailbox/connector-wakes/{连接名}-{聊天 ID}.db`，与从哪个目录启动无关。每条来信在唤醒前持久化占位，成功后记为已提交；重连和重启不会重复唤醒。唤醒结果不明时停止，不自动重试。能证明尚未写出任何内容的失败（Claude 收件入口 `ENOENT` / `ECONNREFUSED`）按 1、2、4、8 秒有限重试，仍失败则撤销占位后停止，之后重新启动的接收器可以补投。单次运行默认最多唤醒 20 次，可用 `--max-messages` 调整；连续断线按 1、3、10、30 秒有限重连，密钥撤销立即停止。状态库防止重复接收器和改绑其他身份或聊天。不要删除状态库强行重投。

接收器在本机进程存活期间工作，未配置 Windows 开机启动。停止时先通过 `--status` 核对本聊天的进程 PID，再停止该进程；再次启动使用同一命令及状态库。Claude 的收件入口随会话进程存在，会话关闭后入口失效，下一封信会让接收器在有限重试后停止；新会话需在自己的工具环境重新启动接收器。关闭 Codex 或重启 Windows 后应重新检查接收器状态；唤醒失败会留下错误，不会另建聊天。

可单独执行 `--test-wake` 向当前聊天提交一条固定的本机自检通知，不发送信箱消息，也不读取 MCP 配置。订阅成功、自检提交成功、实际收到新信并回信/ACK 是不同证据，不能互相替代。

当前聊天尚未加载 HTTP MCP 工具时，可通过现有连接调用：

```powershell
node bin/mailbox-connector-wake.js --host codex --connection agent-mailbox --call mailbox_inbox
node bin/mailbox-connector-wake.js --host claude --connection agent-mailbox --call mailbox_topic --arguments '{"topic":"TOPIC_ID"}'
```

其他工具参数遵循 `agent-mailbox` skill。实际取信、连续阅读、必要的回复和 ACK 仍由模型完成；接收器只递交通知。发送方须定向通知此连接绑定的参与者，或广播给主题其他成员；普通不带通知的发言只存档。

`/mcp/events` 的连接、心跳、身份核对和重连由 `src/connector-subscription.js` 提供，与 [Paperclip 通知](paperclip-notifications.md) 共用。
