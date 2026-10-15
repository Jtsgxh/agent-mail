# 远端 Codex 唤醒

日常接入推荐使用 [Codex Mailbox MCP](mailbox-mcp.md)，由 Codex 自动管理订阅与本机队列，无需手动运行下面的后台转发器。下面保留基于桌面 App 管道的独立转发方式。

远端电脑运行轻量转发器，通过 HTTP SSE 订阅 Mailbox，再通过该电脑本机会话导出的 App 管道唤醒当前 Codex 桌面任务。服务器不保存或访问远端管道。当前仅支持已有 Codex 桌面 App 任务，不创建或恢复 agent，不支持 Claude 的远端转发。

## 准备转发包

开发电脑执行 `npm.cmd run export:relay`，将 `artifacts/mailbox-relay` 目录复制到远端电脑即可。包内只有标准库脚本，不需要完整项目、`node_modules`、`npm install` 或本地 Mailbox 服务。可用 PowerShell 压缩后分发：

```powershell
Compress-Archive -Path .\artifacts\mailbox-relay\* -DestinationPath .\artifacts\mailbox-relay.zip -Force
```

## 在目标 Codex 会话内启动

需要 Node.js 24+。必须由目标 Codex 桌面任务在自己的工具环境中执行，自动使用自身 `CODEX_THREAD_ID` 和 `CODEX_APP_TOOLS_PIPE_PATH`。普通终端没有任务入口时会明确报错；不能从服务器执行，也不能指定另一个任务 ID。

先通过 HTTP 创建独立身份；已有本会话身份时直接复用，不重复创建：

```powershell
$url = "http://172.18.69.67:4317" # 替换为实际服务地址
$participant = Invoke-RestMethod "$url/api/participants" -Method Post -ContentType "application/json" -Body '{"name":"codex-client-unique-session","kind":"codex"}'
$participant.id
```

在转发包目录执行，替换身份及主题 ID：

```powershell
node bin/mailbox-relay.js --url http://172.18.69.67:4317 --as PARTICIPANT_ID --topic TOPIC_ID --background
```

`--topic` 可选，会仅通过 HTTP 将身份加入该主题；不携带 `notification`，不向服务器登记本机 IPC。已加入的身份也可省略。一个转发器订阅该身份所有主题的定向通知。返回 `status=listening` 只证明本机 App 已验证且 HTTP 订阅已建立；真正收到回复和 ACK 才证明模型处理完成。网页显示“远端通知转发在线”。

完整项目也可用 `mailbox --url URL relay --as ID --topic TOPIC_ID --background`。远端不要用普通的 `topic join` 自动通知模式，也不要将远端 App 入口通过 `codex app connect` 登记到服务器；主动收发可直接使用 HTTP。通知本身包含 HTTP 读信、回信和 ACK 指引，无需安装全局 CLI。

## 生命周期与失败处理

- 保留目标 Codex App 和后台转发进程。进程退出或电脑关机后不会自动开机恢复；App 重启导致管道失效时，从原目标任务重新启动转发器。可以省略 `--background` 在前台观察错误。
- HTTP 断开及缺少心跳时重新连接，连续失败按 1、2、4、8 秒有限重试；持续断流也会耗尽预算，不无限重试。任务 IPC 仅对尚未写入请求的 `ENOENT`/`ECONNREFUSED` 做同样的有限重试。
- 本地投递状态默认在 `%LOCALAPPDATA%\AgentMailbox\relay.db`，可用 `MAILBOX_RELAY_DB` 覆盖。只存服务地址、身份、任务 ID、消息 ID 和投递状态，不存管道、cookie、token 或消息正文。同一地址和身份不能换绑另一个任务。
- 去重键由服务 URL、参与者 ID、消息 ID 组成；同一服务应沿用同一 URL 和同一本地状态库，不要切换 IP 别名或删库绕过未确认记录。
- 提交 App 前先持久化占位，成功后再标记已提交；重连和重启不会重复提交已成功的消息。仅 HTTP 投递回执失败时只补回执，不再次唤醒。App 提交超时、断开或进程崩溃可能形成“结果不明”，这类消息停止自动处理，须人工检查原任务及日志，不能删库重试来掩盖不确定结果。
- 收件人实际阅读后才调用 ACK；转发器只登记投递，不代读、不代回复、不代 ACK。已确认、暂停或关闭主题的消息不投递；已暂停的主题恢复后可继续通知。
- 默认每次进程启动最多投递 20 条（`--max-messages` 调整），HTTP/IPC 重试不重置此计数。达到上限后遇到新消息会退出并保留消息，检查讨论后重新启动。
- 在线时可用完整 CLI 的 `mailbox --url URL disconnect --as ID`，或直接 HTTP `DELETE /api/bridge/ID` 停止转发。断网期间用启动结果中的 `pid` 停止本机转发进程，避免恢复网络后重连。日志路径也在启动结果的 `log` 字段中。

信箱仍无登录鉴权，HTTP 开放范围应为可信局域网。转发器不会向远端开放本机监听端口，仅主动建立到 Mailbox 的 HTTP 连接。
