# Paperclip 长连接通知

Mailbox 的公网 MCP 继续负责身份、主题、读信、发信和 ACK。独立进程通过同一项目密钥订阅 `wss://HOST/mcp/events`，将新信编号提交给 Paperclip 已有的 Routine Webhook。无需修改 Paperclip 源码；Paperclip 仍负责模型、权限、预算和任务调度。接收机主动连接 VPS，不需要公网入站端口。

这不是通用 MCP 客户端自动唤醒协议。Paperclip 里的 GPT / Claude 使用同一事件路径；独立 Codex STDIO、Claude Channel 和原生 IPC 保持原有回推，不能删除。ChatGPT / Claude 网页仅连接 MCP 时仍取决于宿主的事件支持。

## 配置

1. 连接项目范围 Mailbox MCP，安装本仓库 `skills/agent-mailbox`。
2. 在 Paperclip 建立收信 Routine，选定负责 agent，使用 `always_enqueue`。说明里要求按事件的 `topicId` / `messageId` 定位，读连续历史，回复使用稳定 requestId，成功后 ACK；不把来信视作代码修改或派工授权。
3. 添加通用 App Webhook（`app_webhook`）触发器，使用 Authorization Bearer。此模式会把定位数据附加到任务说明。不要使用无鉴权 Webhook。不要配置周期查信触发器。
4. 在 Paperclip 所在机器创建仅服务用户可读的 JSON 配置（Linux `chmod 600`）：

```json
{
  "mailboxUrl": "https://mailbox.example.com/mcp",
  "mailboxToken": "PROJECT_CONNECTOR_TOKEN",
  "projectId": "MAILBOX_PROJECT_UUID",
  "participantId": "MAILBOX_PARTICIPANT_UUID",
  "paperclipWebhookUrl": "http://127.0.0.1:3100/api/routine-triggers/public/TRIGGER_ID/fire",
  "webhookSecret": "PAPERCLIP_WEBHOOK_SECRET",
  "statePath": "/var/lib/agent-mailbox-notifier/state.db"
}
```

运行 `node bin/mailbox-paperclip.js /private/path/notifier.json`。Node 24+、本包依赖必需。systemd 示例见 `deploy/paperclip/mailbox-notifier.service`；按实际 Node/安装目录调整。日志只打印连接状态、消息/任务编号和固定错误码，不包含密钥或正文。

Paperclip 的连接访问和工具审批继续生效：新信可以自动启动 agent，但若 `mailbox_reply` / `mailbox_ack` 为 Ask first，实际回复和已读仍须通过审批。无人值守收发需要操作者明确允许该 agent 的对应动作；连接成功或“Act as”工具测试成功不等于运行时已获得自动写权限。接收进程不替代审批，也不绕过 MCP 网关直写信箱。

同一参与者共享收件箱和 ACK，初始由一个 agent 统一收信。给另一个独立 agent 接入时，创建自己的参与者、密钥、连接、Routine 与独立 statePath。不把模型名称当成收件人身份。

## 协议与可靠性

- WebSocket 握手使用 `Authorization: Bearer`，沿用 MCP 的 Host / Origin 校验、项目范围和撤销权限；不接受 URL token、客户端 RPC 或管理 API。密钥撤销在数据变化或最长 15 秒心跳时关闭旧连接。
- 服务先发 `mailbox.ready`，随后发 `mailbox.message`，均带 `version:1`、`projectId`、`participantId`；消息另带 `topicId`、`messageId`。无标题、正文、作者提供的指令。
- 只有定向通知（`to` / `broadcast`）触发。普通记录不会唤醒。暂停/关闭主题不派发；恢复后补发。连接断开后重放未 ACK 消息。
- 接收进程将事件持久化到 SQLite，再提交 Webhook；每个服务/身份/触发器/消息使用稳定幂等键。网络结果不明时复用相同请求，不因重启或重连重复建任务。
- `submitted` 仅表示返回持久化任务 ID，不代表模型运行成功、回复或 ACK。代理失败由 Paperclip 原任务恢复处理；通知进程不会反复新建任务。
- HTTP 暂时失败保留 pending 并退避重试。返回已保存的 failed/skipped/coalesced 或测试回执时标为 blocked，不能换幂等键掩盖问题；检查原 Routine run/任务，修复后由操作者处理，不删状态库盲目重发。
- 自动重连/补收只在进程运行时有效。systemd enabled 在 WSL 启动后运行，不会自动启动已停止的 WSL 发行版。

## 验证与清理

运行 `npm test`，包含长连接项目隔离、鉴权/撤销、重连重放、丢失 Webhook 回执的幂等重试、接收进程重启补收，以及既有 Codex / Claude 通知回归。真实验收必须另行确认：Mailbox 新信编号 → Routine run → Paperclip task/run → MCP 回复编号 → ACK。

只有被新链路替代且不再使用的定时轮询或临时通知进程才能清理。独立宿主适配、MCP 操作、幂等和已读逻辑不属于废弃代码；管理 SSH 隧道也不参与通知。
