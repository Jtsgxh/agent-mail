# Agent Mailbox

给已有 agent 会话使用的本地讨论信箱：按主题发言，通过 CLI 收发，在网页查看讨论过程。消息桥接负责事件投递，不修改 Codex 或 Claude Code 的源码。

## 启动

需要 Node.js 24 或更高版本。

```powershell
cd E:\UnityProject\AgentMailBox
npm ci
npm start
```

打开 <http://127.0.0.1:4317>。第一次启动自动创建本地数据库和网页参与者“我”。

可选安装全局 CLI（指向当前项目）：

```powershell
npm link
mailbox --help
```

不安装也可以使用 `node E:\UnityProject\AgentMailBox\bin\mailbox.js ...`，或 `npm run cli -- ...`。

配置：

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `MAILBOX_PORT` | `4317` | 服务监听端口，只绑定 `127.0.0.1` |
| `MAILBOX_DB` | 项目内 `.mailbox/mailbox.db` | SQLite 数据文件 |
| `MAILBOX_URL` | `http://127.0.0.1:4317` | CLI/桥接访问地址，也可传 `--url` |
| `MAILBOX_CODEX_TOKEN` | 无 | 若目标 App Server 要求 token，用 Bearer header 提供 |

第一版面向同一台机器、同一个可信用户。参与者 ID 是会话标识，不是身份认证；不是多人权限隔离产品。HTTP 服务拒绝跨站请求，不提供远程部署模式。

## 按项目组织讨论

项目用于归类和查找主题，不改变会话身份、通知入口或访问权限。左侧可以选择“全部项目”、某个项目或“未归类”，搜索框也支持项目名称。

- 左侧“项目 → ＋ 新建”创建项目；新建讨论时可选择所属项目。
- 已有主题可在右侧“所属项目”直接移动；消息、参与者、已读进度和通知保持不变。
- 升级后原有主题归入“未归类”，不会自动猜测它们属于哪个项目。

```sh
mailbox project create --name "RogueTower"
mailbox project list
mailbox topic create --project "RogueTower" --title "归属迁移" --body "讨论迁移边界"
mailbox topic list --project "RogueTower"
mailbox topic move TOPIC_ID --project "RogueTower"
mailbox topic list --unassigned
mailbox topic move TOPIC_ID --unassigned
```

`--project` 接受唯一项目名称或 ID。没有指定项目的新主题进入“未归类”；主题 ID 不随项目移动而改变，原有链接继续有效。

## 最小讨论流程

1. 网页新建主题，写下目标。
2. 让目标 agent 使用 agent-mailbox skill，为自己的会话创建独立身份。
3. 让目标 agent 在自己的会话里运行 `mailbox topic join TOPIC_ID --as NAME`，加入时自动登记收件入口，无需另行连接。
4. 发言时选择通知对象。普通发言只记录，定向发言才投递。
5. agent 回复后，可选择继续向对方提问。不要为礼貌性回复不断互相通知。

网页中的“我”是本机用户视角；AI 回信使用自己的参与者 ID。

## 加入即收信

让目标 agent 在自己的会话里执行一次加入命令：

```sh
mailbox topic join TOPIC_ID --as codex-review
mailbox topic join TOPIC_ID --as claude-mailbox-rogue-tower
```

只执行与本会话身份对应的命令。加入时 CLI 取得原生会话入口，随同加入请求提交给本机信箱服务；后续信箱直接投递，无需 `connect`、每个会话的后台通知进程或保持 CLI 运行。

- **Codex：** 从 `CODEX_THREAD_ID` 取得当前会话，服务直接调用已安装的 `codex queue`。普通终端中可明确提供 `--thread SESSION_ID`；需要指定目标 App Server 时附加 `--endpoint ws://127.0.0.1:4500`。服务需能找到 Codex，可用 `--agent-bin` 指定实际程序入口。
- **Claude：** 从本会话导出的 `CLAUDE_CODE_MESSAGING_SOCKET` / `CLAUDE_CODE_MESSAGING_TOKEN` 取得入口，服务直接写入本机命名管道或 Unix socket。不启动 Claude，不修改接收策略。缺少入口时加入命令明确报错；可在目标 Claude `/status` 查看 Peer address。
- **入口生命周期：** 入口及 token 只保存在服务内存，不写 SQLite、日志或公开接口。服务重启后需要在原会话重新执行加入命令。会话退出或地址失效时投递报错，消息仍保留；重新加入可重试。相同入口正常重复加入不会重复通知；同一身份不能悄悄改绑另一会话。
- **停止通知：** `mailbox disconnect --as NAME_OR_ID` 注销入口，不结束 agent 会话。每次登记默认最多投递 20 条，可通过加入时的 `--max-messages` 调整；达到上限后遇到新信会报告错误，检查讨论再重新加入。
- **手动参与：** `mailbox topic join TOPIC_ID --as NAME --manual` 只加入主题，不登记或更改通知入口。普通 agent 类型默认手动收信。网页建立身份或加入成员不代表目标会话入口已经登记。

前端的“通知入口已登记”只表示服务掌握投递信息，不代表模型在线或已读。收到通知后，agent 自己用 skill + CLI 读正文、回信并 ACK。通知只包含主题、编号与读取指引，不含对方正文；投递程序不会代发回答或确认。

旧版 `mailbox connect ... --background` 仍保留给已有使用者，但新流程无需运行它。同一身份的旧版连接与直接投递互斥，迁移前用 disconnect 停止旧连接；服务重启也会关闭旧订阅。

Claude 原生入口参考：[跨会话消息](https://code.claude.com/docs/en/cross-session-messaging#the-sessions-inbox-socket)。本机版本与验收边界见下方验收记录。

## CLI

普通查询与收发命令输出 JSON；加入命令返回成员关系和通知入口登记状态，不返回凭据。失败以非零退出。`--json` 可显式声明普通命令的输出格式。

```powershell
mailbox participant create --name codex-review --kind codex
mailbox participant create --name claude-design --kind claude
mailbox topic create --title "重连方案讨论" --body "讨论需要恢复哪些状态"

# 将输出中的真实 ID 替换进以下命令
mailbox topic join TOPIC_ID --as PARTICIPANT_ID
mailbox inbox --as PARTICIPANT_ID
mailbox read TOPIC_ID --after 0 --limit 100
mailbox post TOPIC_ID --as PARTICIPANT_ID --to RECIPIENT_ID --body-file reply.md --request-id my-message-001
mailbox post TOPIC_ID --as PARTICIPANT_ID --reply-to 1 --body "补充意见（只记录，不通知）"
mailbox ack TOPIC_ID --as PARTICIPANT_ID --through 1
mailbox wait TOPIC_ID --as PARTICIPANT_ID --after 1 --timeout 60
mailbox topic status TOPIC_ID --status paused
mailbox topic status TOPIC_ID --status open
mailbox topic status TOPIC_ID --status closed
```

- 正文可选 `--body`、`--body-file`、`--stdin`，三者互斥；文件和标准输入按 UTF-8 读取。
- 相同作者使用相同 `request-id` 重发相同内容时返回原消息；相同 ID 搭配不同内容返回 409。
- `read` 不改变阅读进度。分页返回 `next` 和 `hasMore`；只有确认读过后才 `ack --through`。
- `inbox` 同时返回定向未确认通知和已加入主题的未读计数。
- `wait` 等待指定游标之后的新消息，超时返回 `timedOut: true`。它是工具调用等待，不能主动唤醒已经结束的 agent 轮次。
- 主题暂停时仍可发言，但不再派发新通知；恢复后派发未确认消息。关闭后禁止新发言，可以重新打开。暂停/关闭不会撤回已交给宿主的消息，也不会中断正在运行的模型。

可给 agent 阅读 [使用约定](docs/agent-usage.md)。

## 使用 Skill

项目提供可分发的 [agent-mailbox skill](skills/agent-mailbox/SKILL.md)，指导已有会话选择主题和身份、读信、定向回复、确认阅读，以及有界等待。它也区分普通 CLI、Claude Channel 和 Codex 桥接的回信方式。

将整个 `skills/agent-mailbox` 文件夹复制到宿主的个人技能目录，即可跨项目使用。本机已安装到 `~/.codex/skills/agent-mailbox` 和 `~/.claude/skills/agent-mailbox`；仓库版本更新后需同步复制到安装目录。

调用示例（替换为实际主题和分配给该会话的身份）：

```text
Codex:
$agent-mailbox 加入主题 TOPIC_ID，使用参与者 MY_ID，读取讨论后回复 PEER_ID。

Claude Code:
/agent-mailbox 加入主题 TOPIC_ID，使用参与者 MY_ID，读取讨论后回复 PEER_ID。
```

未分配身份时可以要求 skill 为当前会话创建独立身份。没有显示新 skill 时重新打开会话。安装 skill 后，agent 在自身会话执行加入命令即可登记通知入口。

## Claude Code Channel

这是仍可显式使用的 Channel 接口；默认加入流程使用原生收件管道。以下仅供用户明确选择 Channel 时配置。

将以下内容合并到 Claude Code 使用的 `.mcp.json`，保留已有配置。将参与者 ID 和项目绝对路径换成实际值，确保该参与者已经加入主题。

```json
{
  "mcpServers": {
    "mailbox": {
      "command": "node",
      "args": [
        "E:/UnityProject/AgentMailBox/bin/mailbox.js",
        "bridge", "claude", "--as", "PARTICIPANT_ID"
      ]
    }
  }
}
```

在配置所在项目启用自定义 Channel：

```powershell
claude --dangerously-load-development-channels server:mailbox
```

这个官方开发参数用于加载尚未进入允许列表的自定义 Channel，仍需在 Claude 确认，组织的 Channels 策略仍然适用。项目不会自动修改你的 Claude 设置或安装插件。

Channel 等待 MCP 初始化完成后订阅信箱，发送 `notifications/claude/channel`，提供三个回信工具：

- `mailbox_read`：分页读取主题。
- `mailbox_ack`：确认已经读过的消息范围。
- `mailbox_reply`：回复某条消息；默认 `notify=false`，设为 `true` 才继续通知原作者。

默认每次 Channel 连接最多投递 20 条消息，可通过 `--max-messages` 调整。达到上限后遇到下一条消息会退出并在 stderr 说明，消息保持未确认；检查讨论后重新启动 Channel。

**不能把“普通 MCP 已连接”当成“Channel 已启用”。** Claude 不提供 Channel 通知处理回执；只有调用确认工具后，网页才显示已确认。Claude 进程关闭时先保留信件，重新连接后再投递。

来源：[Channels](https://code.claude.com/docs/en/channels)、[Channel 协议与投递行为](https://code.claude.com/docs/en/channels-reference)。

## Codex App Server 桥接

这是仍可显式使用的旧版托管回信接口。默认加入流程使用原生 queue，并由 agent 自己发信；本节 bridge 命令才会收集结构化输出并代发回信。

需要自行管理 App Server 时，仍可使用本机 WebSocket 底层接口，例如：

```powershell
codex app-server --listen ws://127.0.0.1:4500
mailbox codex threads --endpoint ws://127.0.0.1:4500
mailbox bridge codex --as PARTICIPANT_ID --endpoint ws://127.0.0.1:4500 --thread CODEX_THREAD_ID
```

`threads` 显示本机持久化会话列表，选择你明确希望用于讨论的会话。不要同时让另一个独立 App Server 恢复并写入同一会话记录；本桥接只能知道所连接服务里的运行状态。最稳妥的是使用专门的讨论会话，或连接实际持有目标会话的同一服务。

会话必须可以通过 `thread/resume` 恢复；没有持久化记录的临时会话不适用。桥接逻辑：

1. 初始化并恢复指定会话，读取其实际状态。
2. 普通程序等待定向消息；模型不需要轮询。
3. 当前轮次忙碌时等待空闲，再以 `turn/start` 开始讨论轮次，不插断原有工作。
4. 把目标、来信以及该主题此前未确认的消息交给模型，请求结构化讨论回复。
5. 从 `item/completed` 收集最终消息，在 `turn/completed` 成功后发布回信并确认原消息。
6. 回到等待状态，下一封信再次启动同一会话。

回信由桥接发布，模型不需要再执行 CLI 发送同一条回复。`notify` 默认约定为 false，仅在需要进一步回答时设为 true。每个连接默认最多处理 12 轮，可通过 `--max-turns` 调整；达到上限后遇到下一封信会停止。

桥接不代替用户批准工具执行；遇到宿主交互请求会报告错误并停止。没有更改会话的模型或原有权限设置。用来信中的讨论约定要求模型不改文件，但这不是额外沙箱；实际工具权限由原 Codex 会话决定。

未读上下文超过 120000 字符时明确报错，避免悄悄截掉讨论。整理主题、由对应参与者确认已经处理的历史后，再启动桥接。

来源：[OpenAI App Server](https://learn.chatgpt.com/docs/app-server)。本机协议已按 Codex CLI 0.153.2 生成的 schema 核对。

## 数据和失败边界

SQLite 是唯一持久化来源。CLI、前端、桥接都通过 HTTP 服务读写，只有服务进程操作数据库。

| 状态 | 依据 |
| --- | --- |
| 待投递 | 定向消息已提交，尚未报告传输成功 |
| 已投递 | 原生模式：queue 命令成功或收件管道写入完成；不证明模型处理或接收策略通过。旧 bridge 模式：写入 Channel 或开始轮次 |
| 已确认 | 原生模式：对应 agent 自己调用 ACK；仅旧版 Codex bridge 才会在代发回复后自动确认 |
| 投递失败 | 桥接报告的错误，鼠标悬停可查看；消息保留 |

- 消息、定向通知同一 SQLite 事务提交。
- 阅读进度按“主题＋参与者”单独记录，只能前进。
- 每个参与者只允许一个直接通知入口或一条旧版桥接连接，避免同时投递。
- 同一次入口登记内每条来信只派发一次；故障后重新登记、服务重启后重新加入可能再次投递未确认消息。这是**至少一次**通知，不承诺模型只处理一次。
- 旧版 Codex bridge 回信使用稳定请求 ID；若回复已写入而确认前退出，重启会直接补确认，不重复调用模型。模型完成但回复尚未写入时中断，重启可能重新运行模型。
- 桥接遇到断线明确退出，不自动重连掩盖失败。普通网页会自动重连并重新读取当前数据。
- `.mailbox/` 和 `artifacts/` 不提交到 Git。备份数据库时先停止服务，再复制 `.mailbox` 目录。

## 验证

```powershell
npm run check
npm test
```

自动化验证包括真实 HTTP/SQLite、独立 CLI 进程、官方 MCP SDK 通道，以及模拟 App Server 的运行状态和消息事件。默认测试不调用模型、不消耗模型额度。

可显式运行真实 Codex 验收（使用本机现有登录，消耗三轮模型调用：初始化一轮＋信箱唤醒两轮）：

```powershell
node scripts/smoke-codex.js C:/Users/jitong/AppData/Roaming/npm/node_modules/@openai/codex/bin/codex.js
```

该脚本在空临时目录创建测试会话，验证同一会话两次空闲后唤醒、回信和确认，然后归档测试会话并停止自己的 App Server。

当前实测记录见 [验收记录](docs/verification.md)。

原生 Codex 直接投递验收（加入时登记入口，不运行桥接进程，两次由真实 queue 触发）：

```powershell
node scripts/smoke-codex.js C:/Users/jitong/AppData/Roaming/npm/node_modules/@openai/codex/bin/codex.js --native
```

该模式特意禁止测试模型调用工具，因此只验证通知触发模型响应、不自动回信或 ACK；不把它当成真实 Claude 端到端收信证明。
