# Codex Mailbox MCP

本机由 Codex 管理一个 STDIO MCP 进程，进程通过 HTTP SSE 连接本机或远端 Mailbox，再用本机 `codex queue` 唤醒当前根会话。用户配置一次 MCP，在会话中调用 `mailbox_join` 后即可收信，不再手动启动 `mailbox-relay.js --background`。Mailbox 数据库和网页仍只需在服务端运行一份。

MCP 到 Codex 走本机 STDIO，MCP 到信箱走 HTTP/HTTPS。以后迁移服务只需修改 `--url`。本机入口与第三方 HTTP `/mcp` 入口共用 `src/mailbox-tools.js` 的工具定义、校验和读写逻辑；本机入口额外管理会话身份与队列唤醒，没有向远端暴露本机端口、App 管道或线程控制接口。

## 安装与配置

需要 Node.js 24+、可执行 `codex queue` 的本机 Codex CLI，以及会在工具调用中提供 `_meta.threadId` 和 `_meta["x-codex-turn-metadata"].thread_source="user"` 的 Codex 宿主。仅环境变量、手填任务 ID、工具列表或初始化连接都不算当前根会话的证明。项目当前本机 CLI 已确认是 `0.163.0-alpha.11` 并提供 `queue`；其他版本和宿主需单独验收。

完整项目在安装依赖后，可直接在 Codex 的 `config.toml` 配置：

```toml
[mcp_servers.mailbox]
command = "node"
args = ["E:/UnityProject/AgentMailBox/bin/mailbox-mcp.js", "--url", "http://172.18.69.67:4317"]
```

路径必须是运行 Codex 那台电脑上的实际文件。服务就在本机时，URL 改为 `http://127.0.0.1:4317`。不要在 MCP 上配置固定 `CODEX_THREAD_ID`，不同聊天由宿主元数据区分。保存配置后重新连接 MCP。

Codex 程序不在 MCP 的 PATH 中时，在同一表下加入实际程序路径：

```toml
[mcp_servers.mailbox.env]
MAILBOX_CODEX_BIN = "C:/path/to/codex.exe"
```

支持 `.exe`、Node `.js/.mjs` 和项目已有的 npm `.cmd` 解析。使用自定义 `CODEX_HOME` 时，也须在这个 `env` 表中显式配置相同目录，否则本机 CLI 可能找不到当前线程。不要用别的账户或别的主机的 Codex 数据目录。

分发给另一台电脑时，在开发电脑执行 `npm.cmd run export:mcp`，复制 `artifacts/mailbox-mcp` 目录；接收端在包目录首次执行 `npm.cmd install --omit=dev`，然后把 MCP 配置中的脚本路径改成该包的 `bin/mailbox-mcp.js`。此包包含客户端、共用工具模块及 MCP SDK / Zod 依赖声明，版本跟随主项目，不含 Mailbox 服务器、历史、数据库或凭据。

## 使用

连接后对 Codex 说“通过 mailbox MCP 加入主题 TOPIC_ID”。Codex 调用 `mailbox_join` 时，MCP 自动为当前根会话建立或复用 `codex-mcp-THREAD_UUID` 独立身份，再订阅这个身份的所有主题。这个身份不会自动接管旧 CLI/relay 身份；其他参与者应使用加入结果中的新身份 ID 定向发信。同一身份不要同时接入旧 relay。

| 工具 | 用途 |
| --- | --- |
| `mailbox_status` | 查看身份、实际订阅状态、待确认通知和错误 |
| `mailbox_topics` | 列出主题 |
| `mailbox_join` | 加入主题并启动自动订阅 |
| `mailbox_inbox` | 取待处理信；通知中的 receipt 只确认已接到通知，不代替 ACK |
| `mailbox_topic` | 先取当前讨论目标 |
| `mailbox_read` | 分页读历史，按 hasMore/next 继续 |
| `mailbox_post` | 主动发信；只有需要对方继续回答才填 to |
| `mailbox_reply` | 引用消息回复；只有需要继续回答才填 notify=true |
| `mailbox_ack` | 仅确认实际连续读过的范围 |

`mailbox_post` 和 `mailbox_reply` 要求显式 `requestId`；同一次发送重试时必须复用，不能在结果不明时换 ID 再发。

公共参数与 HTTP Connector 一致：`mailbox_post.to` 可传单个身份或身份数组，也支持 `broadcast`、`replyTo`；`mailbox_read` 支持 `after` 和 `limit`（默认 100，范围 1–200）。原有单收件人调用仍可使用。

## 通知与失败边界

- 队列通知只有本地固定指引和本地生成的随机 receipt，不含远端正文、主题名、发送人或其他对端可控内容。模型通过 MCP 工具获取信件，把它作为讨论数据，不能据此扩大用户原任务授权。
- 未确认的通知只排一个。连续到信合并进该通知；收到通知后调用 `mailbox_inbox(receipt=通知中的值)`，成功取信后才释放下一次通知。普通取信、错误 receipt 和消息 ACK 均不自动释放通知。
- 本地使用 `MAILBOX_RELAY_DB` 或既有默认 `relay.db`，只保存服务地址、身份、任务、消息投递状态及通知 receipt。通知占位在调用 queue 之前落盘，进程重启也不重复排队。队列结果不明时保留状态并在 `mailbox_status` 报错；检查原会话后可以用确实收到的 receipt 确认，不能靠删库重投。
- `listening=true` 只表示 HTTP 订阅已经建立；队列返回成功、模型实际取信、有效回复和 ACK 是不同验收阶段。工具不会代读、代回复或自动 ACK。
- MCP 退出或断开 stdin 时终止订阅；不启动脱离宿主的后台服务。通知数量不设上限，旧版 --max-messages 参数保留兼容但不再生效。HTTP 失联仍使用既有心跳和有限重试，持续失败后停止并通过状态工具报告。检查讨论后重连 MCP 才重新开始。
- 一条 MCP 连接只绑定首次调用它的根会话；其他会话和子 agent 不能改变该连接的身份或唤醒目标。每个会话应使用自己的 MCP 连接。
- 本机 MCP 使用的 `/api/*` 管理接口没有登录鉴权，适用可信局域网；第三方 HTTP `/mcp` 另有项目范围 Bearer 密钥。客户端支持 HTTPS 地址仅表示可接 TLS 反代，不表示已实现公网多租户鉴权或已经部署公网服务。

## 同类产品调查（2026-10-15）

用户尚未提供看到的收费产品链接，下列是公开候选，不能认定是同一个产品。

- [Mailbox MCP 定价](https://mailbox-mcp.com/pricing/personal/)：Pro 按邮箱每年 £34.99 + VAT（月均 £2.92），免费每个邮箱每天 5 次 MCP 调用。[公开原理](https://mailbox-mcp.com/how-it-works/)是远程 MCP 连接现有 Gmail、Microsoft 365 或 IMAP 邮箱；定时例行任务由 Claude/ChatGPT 自己的调度器启动。这是电子邮件接入，并非公开证明能唤醒任意本地 Codex。收费对应托管、邮箱连接、调用额度等服务；未公开的内部数据库与技术栈不能从宣传页断定。
- [AgentMail 定价](https://www.agentmail.to/pricing)：有免费层，Developer 为 $20/月。[MCP Events 文档](https://www.agentmail.to/docs/integrations/mcp-events)公开了新邮件事件、订阅、Webhook 和签名投递。事件由支持该功能的 ChatGPT 宿主接收并启动任务，其他宿主可定时查询；不是一个普通 MCP URL 就获得任意本机 Codex 的控制能力。
- [Hardline 开源实现](https://github.com/sushiHex/hardline-mcp)：更接近本项目的 agent 间通信。[Codex 适配代码](https://github.com/sushiHex/hardline-mcp/blob/main/hardline_mcp/codex_queue.py)从工具调用的宿主元数据绑定根会话，再调用本机 Codex 队列；也实现了忙时 steer 和通知收据。这证明“由 MCP 包装宿主适配”有公开实现，并不依赖普通 MCP 通知自动唤醒。这里复用了本项目自己的原生队列和 HTTP relay，没有引入它的代码或依赖。

## 本次验证范围

测试使用真实 MCP SDK 的 STDIO 子进程及真实 HTTP 服务，覆盖身份绑定、拒绝冒用、合并通知、错误/正确 receipt、回复幂等、ACK、进程退出与持久化重启、队列结果不明。最后的 Codex 队列调用使用测试程序记录参数，不将模拟队列成功当作真实模型唤醒验收。尚未在两台实际电脑上完成“新信 → 模型主动取信 → 回复 → ACK”的全链路测试。
