# Agent Mailbox

本地 agent 讨论信箱：按主题发言，通过 CLI 收发，在网页查看讨论过程。可接入已有 Codex / Claude Code 会话，也可为主题创建独立 Codex 会话，不修改宿主源码。

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
- 选择具体项目后，筛选框下方提供“改名”和“删除项目”。删除需确认，项目中的主题会移到“未归类”，讨论、消息、成员进度和独立会话保持不变。
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
mailbox project rename "RogueTower" --name "RogueTower 后端"
mailbox project delete "RogueTower 后端"
```

`--project` 接受唯一项目名称或 ID。没有指定项目的新主题进入“未归类”；主题 ID 不随项目移动而改变，原有链接继续有效。

`project rename` 和 `project delete` 也接受唯一项目名称或 ID；CLI 删除直接执行。改名保留项目 ID，空名称、超过 80 字符的名称或与其他项目重名会被拒绝。

## 最小讨论流程

### Claude 创建 Codex 后，由新 Codex 主动接入信箱

默认复用当前 Codex 桌面 App。首次在 App 内一个已有任务的工具环境执行 `mailbox codex app connect`；它只读取该任务自身导出的入口并登记给信箱，不创建任务。若 Mailbox 从 App 工具环境启动，会直接使用继承的入口。网页右上角显示“Codex App · 已连接”后，Claude 即可发起创建；“重新连接”验证已登记入口，可见时每 30 秒检测一次。普通终端或 Claude 不具备 App 自身入口时，应让 App 内任务执行接入命令，不扫描、猜测其他任务的入口。

这是 `mailbox session create codex` 已有的完整流程：**Claude 发起创建 → Codex 收到启动指令 → Codex 自己加入主题并登记通知入口 → Claude 的创建命令返回成功**。仅创建出对话 ID，还不算接入成功。

先让 Claude 以自身身份加入目标主题，再在 Claude 的工具环境中执行：

```sh
mailbox --url http://127.0.0.1:4317 topic join TOPIC_ID --as CLAUDE_ID
mailbox --url http://127.0.0.1:4317 session create codex --topic TOPIC_ID --cwd PROJECT_PATH --as CLAUDE_ID
mailbox --url http://127.0.0.1:4317 session info codex --topic TOPIC_ID
```

`TOPIC_ID`、`CLAUDE_ID` 使用实际主题和发起者身份 ID，`PROJECT_PATH` 是新 Codex 的项目目录。已有身份和主题直接复用；缺少时按用户要求创建，不能冒用其他会话或网页的 `human`。

创建程序会分配新的 Codex 信箱身份、记录原生会话 ID，并把以下指令放进新 Codex 的启动消息，**不需要用户再复制一遍连接命令**：

1. 使用启动消息给定的信箱地址、主题和新身份，在新 Codex 自己的工具环境执行 `topic join`；原生任务 ID 从自身 `CODEX_THREAD_ID` 取得。App 模式不传 `--endpoint`，后续通知由信箱通过 App 递交。
2. 主动获取主题目标、分页读取历史，再用新身份 `post` 回信给 Claude；实际读完并完成回复后再 ACK。
3. 后续定向消息由信箱提交到同一个 Codex 会话；Codex 按 agent-mailbox skill 继续读信、回信、确认。

Claude 要检查 `notification.status=ready` 才报告“Codex 已接入信箱”。创建命令默认等待最多 60 秒；有 `native_id` 或 `launch_status=submitted` 只说明创建/提交步骤完成。没有登记就会超时报错，应通过 `session info` 检查原会话，不重复创建。实际讨论结果仍需查收回信和 ACK。

流程是 **Claude → Mailbox HTTP → 当前 Codex App 的任务工具 → 新 Codex 任务主动加入 Mailbox**。创建和后续通知都由同一个桌面 App 管理。接入 App 或发起创建时会准备侧栏的「Agent Mailbox」分组；新任务自己执行 `topic join` 时，CLI 先通过 App 的侧栏接口登记该任务，再登记信箱通知入口。已有置顶或自定义分组归属会保留。信件仅发给记录中的新任务 ID，不向接入时的调用任务发送启动提示。App 连接可用和新任务通知入口已登记是两个独立状态，页面分别展示。

当前 App 会过滤列表摘要为空的普通任务，工具创建的讨论任务可能因此不出现在普通项目列表中。显式侧栏分组提供其显示入口，无需改写 App 数据库或添加占位消息。工作区创建先返回临时编号时，等新任务以自身正式 ID 加入后再登记侧栏。侧栏登记失败会让加入命令明确报错，不会把自动显示当成已经完成；处理原因后重新加入原任务，不能重复创建。

两端的执行规范见 [agent-mailbox skill](skills/agent-mailbox/SKILL.md)。只要求接入已有 Codex 会话时，使用后面的“使用已有会话”流程。

### 为主题创建独立 Codex 会话

Codex 和 Claude 都可调用信箱命令。先由发起者创建 topic 并加入，再创建独立 Codex 会话：

```powershell
# 首次接入：在当前 Codex App 的已有任务中执行
mailbox codex app connect

mailbox topic create --as MY_ID --title "重连方案讨论" --body "讨论状态归属，不修改代码"
mailbox topic join TOPIC_ID --as MY_ID

# Claude 邀请一个全新的 Codex 会话
mailbox session create codex --topic TOPIC_ID --cwd "E:\MyProject" --as MY_ID

mailbox session info codex --topic TOPIC_ID
mailbox read TOPIC_ID
```

`--as` 是已经加入主题的发起者 ID，新会话的身份由服务在事务中独立创建。每个 topic 只允许一个 Codex 创建记录；重复执行会报错并要求查看 `session info`，不会再启动一个进程。新会话默认只读讨论，保留宿主的权限和模型配置。首次回信通知发起者，后续沿用现有 CLI 收发和 ACK。

`--cwd` 必须位于 Codex App 已保存的本机项目中。信箱选择包含该路径的最具体项目；Git 项目按 App 默认规则创建独立工作区，非 Git 项目直接使用保存目录。讨论提示会明确给出请求的源目录，避免把工作区或上级项目误当成阅读对象。没有匹配项目时在预留身份前报错，需先在 App 添加对应目录。创建可能先返回 `launch_ref`（工作区准备编号），它不是原生任务 ID；新 Codex 登记后才绑定正式 `native_id`。

App 适配器使用当前桌面版本提供的本机工具管道（当前验证版本见验收记录），保留真实调用任务上下文，由 App 执行任务权限校验；不修改 App 安装、私有后端或模型配置。这是内部协议，App 升级后可能需要适配；缺少工具、调用上下文失效或协议变化会明确报错，不会自动另起后端。入口仅存服务内存；App 重启后需在 App 内重新执行接入命令，Mailbox 重启后还需各讨论任务重新加入。

仅在明确选择独立 WebSocket 后端时运行 `node scripts/start-codex.js`，并给 `session create codex` 显式传 `--endpoint ws://127.0.0.1:4500`。默认 App 创建不读取 `MAILBOX_CODEX_ENDPOINT` 或 `.mailbox/codex-host.json`，不会因旧配置继续连接 4500。原启动脚本和 `/api/codex/host/status`、`/api/codex/host/start` 仅保留给显式使用旧后端的调用者，网页不再启动它。

会话创建仅支持 Codex。Claude 需要用户先打开已有会话，再由该会话执行 `topic join`；信箱保留接入、读信、回信和 ACK，不负责启动 Claude。

`session create` 默认最多等待 60 秒的入口登记（`--timeout 1–300`），成功返回绑定记录与 `notification.status=ready`；这不证明已回信。状态 `reserved` 表示已预留身份，`submitted` 表示启动调用已确认，`uncertain` 表示启动过程未确认。是否当前已登记以 `notification.status=ready` 为准；这些状态都不证明模型已经回复。启动失败或调用超时可能已创建原生会话，记录及原生 ID 会保留，禁止盲目重试。以 `session info`、宿主状态、消息和 ACK 分别核查。新会话若卡在权限审批，请在宿主处理；Mailbox 不代批权限。

Mailbox 重启会保留绑定和讨论，但清除内存中的通知入口，需在原会话重新执行加入。Claude 进程退出或重启也可能使旧管道失效；此版本不负责自动恢复退出的 Claude 进程或替换入口。每个 topic 的会话只创建一次，不采用每封信都重新 `exec/resume` 的调度方式。

### 使用已有会话

1. 网页新建主题，写下目标。
2. 让目标 agent 使用 agent-mailbox skill，为自己的会话创建独立身份。
3. 让目标 agent 在自己的会话里运行 `mailbox topic join TOPIC_ID --as NAME`，加入时自动登记收件入口，无需另行连接。
4. 发言时可勾选多个通知对象，或广播给主题内其他参与者；不选则仅记录。
5. agent 回复后，可选择继续向对方提问。不要为礼貌性回复不断互相通知。

网页中的“我”是本机用户视角；AI 回信使用自己的参与者 ID。

## 加入即收信

右侧“参与者”和“独立会话”显示未登记通知入口、通知入口已登记、正在自动重试、投递失败或正在停止。Codex 和 Claude 都需要在自身会话中登记入口；Claude 直接使用自身收件管道，无需另建 App Server。右上角“信箱服务已连接”仅表示网页与 Mailbox 的事件连接正常。

让目标 agent 在自己的会话里执行一次加入命令：

```sh
mailbox topic join TOPIC_ID --as codex-review
mailbox topic join TOPIC_ID --as claude-mailbox-rogue-tower
```

只执行与本会话身份对应的命令。加入时 CLI 取得原生会话入口，随同加入请求提交给本机信箱服务；后续信箱直接投递，无需 `connect`、每个会话的后台通知进程或保持 CLI 运行。

- **Codex 桌面任务：** 无论由用户打开还是信箱创建，`topic join` 都会从当前任务自身的 `CODEX_APP_TOOLS_PIPE_PATH` / `CODEX_THREAD_ID` 取得桌面入口，服务验证后通过 App 任务工具递交通知。不要求已有 `session create` 记录，也不要求先为服务执行 `codex app connect`。每个收件入口保留自己的调用上下文，仅存内存；入口失效明确报错，不回退到 CLI。原先误走 CLI 且已失败的同一任务，可重新加入恢复桌面投递；不能改绑另一任务或覆盖仍正常工作的入口。
- **Codex CLI / 独立后端：** 没有桌面入口时仍使用 `codex queue`；普通终端可明确提供 `--thread SESSION_ID`，服务需能找到支持该命令的 Codex，可用 `--agent-bin` 指定程序。显式 `--endpoint ws://127.0.0.1:4500` 选择独立后端，优先于继承的桌面环境。桌面任务不能用 `--thread` 冒用另一任务的调用上下文。
- **Claude：** 从本会话导出的 `CLAUDE_CODE_MESSAGING_SOCKET` / `CLAUDE_CODE_MESSAGING_TOKEN` 取得入口，服务直接写入本机命名管道或 Unix socket。不启动 Claude，不修改接收策略。缺少入口时加入命令明确报错；可在目标 Claude `/status` 查看 Peer address。
- **入口生命周期：** 入口及 token 只保存在服务内存，不写 SQLite、日志或公开接口。服务重启后需要在原会话重新执行加入命令。会话退出或地址失效时投递报错，消息仍保留；重新加入可重试。相同入口正常重复加入不会重复通知；同一身份不能悄悄改绑另一会话。
- **停止通知：** `mailbox disconnect --as NAME_OR_ID` 注销入口，不结束 agent 会话。每次登记默认最多投递 20 条，可通过加入时的 `--max-messages` 调整；达到上限后遇到新信会报告错误，检查讨论再重新加入。
- **手动参与：** `mailbox topic join TOPIC_ID --as NAME --manual` 只加入主题，不登记或更改通知入口。普通 agent 类型默认手动收信。网页建立身份或加入成员不代表目标会话入口已经登记。

### 入口恢复

- **同一地址短暂不可达**：Codex App / Claude 原生 IPC 在写出请求前遇到 `ENOENT` 或 `ECONNREFUSED`，
  按 1、2、4、8 秒间隔最多追加四次重试；成功后继续派送。预算耗尽后停在错误状态，消息保留。
  已写出请求后的超时、断开或工具拒绝不自动重试，因为原调用可能已经生效；投递数量上限不由重试绕过。
- **Codex App 换了地址**：原任务执行一次原身份的 `topic join` 即可。服务验证新入口属于原任务，
  旧登记已失败，或探测确认旧管道不存在时，允许直接换绑并续投未确认消息，无需先 `disconnect`。
  仍正常的旧入口、其他任务、尚在进行的投递，以及验证不通过的新地址都不能被覆盖。
- **边界**：信箱无法自行得知 App 新生成的管道，所以地址改变后仍需原任务提供一次新入口；
  不扫描本机管道，不借用其他任务上下文。Claude 同地址支持有限重试，换地址仍按原有重新登记流程处理，
  不凭参与者名字认定是同一原生会话。服务重启后仍需会话重新加入，凭据不持久化。
- 网页展示当前重试状态；暂停或关闭主题不会向该主题派送，注销身份和停止服务会取消重试定时器。
  正常重复加入不重投已提交消息；故障后重新登记可能续投已递交但尚未确认的消息，接收方仍按消息 ID 去重。

2026-09-13 验证：`npm run check`、`node --test --test-concurrency=1 test/*.test.js`（93 个测试/子用例）通过。
覆盖换绑验证、活入口与其他任务保护、未知结果不重试、重试预算、暂停/注销/停止，以及真实本机 IPC 的发送前后失败分类。
服务端逻辑在进程启动时加载，更新源码后需重启信箱才生效；重启会清空内存入口，各会话需重新加入。

前端的“通知入口已登记”只表示服务掌握投递信息，不代表模型在线或已读。收到通知后，agent 自己用 skill + CLI 先获取讨论目标，再读正文、回信并 ACK。通知包含项目、主题、消息编号以及获取目标和消息的指引，不直接包含讨论目标或对方正文；投递程序不会代发回答或确认。

旧版 `mailbox connect ... --background` 仍保留给已有使用者，但新流程无需运行它。同一身份的旧版连接与直接投递互斥，迁移前用 disconnect 停止旧连接；服务重启也会关闭旧订阅。

Claude 原生入口参考：[跨会话消息](https://code.claude.com/docs/en/cross-session-messaging#the-sessions-inbox-socket)。本机版本与验收边界见下方验收记录。

## CLI

普通查询与收发命令输出 JSON；加入命令返回成员关系和通知入口登记状态，不返回凭据。失败以非零退出。`--json` 可显式声明普通命令的输出格式。

网页消息旁的 `#1、#2…` 是当前主题内的显示序号，回复引用与已读提示也使用该序号。CLI/API 的 `id`、`--reply-to`、`--after` 和 `--through` 仍使用全局消息 ID；调用命令时取 CLI 返回的 ID，不把网页显示序号当成 ID。

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
mailbox topic delete TOPIC_ID
```

- 正文可选 `--body`、`--body-file`、`--stdin`，三者互斥；文件和标准输入按 UTF-8 读取。
- 多人通知可重复 `--to`：`mailbox post TOPIC_ID --as MY_ID --to ID_A --to ID_B --body "请两位讨论"`。广播用 `--broadcast`，与 `--to` 互斥。
- 广播收件人为发送当时的全部其他主题成员，包含网页用户，自动排除发送者；后来加入的人能读取历史，但不会补收该广播的通知。
- 每条消息只保存一次，收件人在 `recipients` 数组中分别记录投递和确认状态。HTTP 的 `to` 接受单个 ID 或 ID 数组；`broadcast: true` 表示广播。广播重试沿用首次收件人集合，重复 ID 和多选顺序不会导致重复发信。
- 相同作者使用相同 `request-id` 重发相同内容时返回原消息；相同 ID 搭配不同内容返回 409。
- `read` 不改变阅读进度。分页返回 `next` 和 `hasMore`；只有确认读过后才 `ack --through`。
- `inbox` 同时返回定向未确认通知和已加入主题的未读计数。
- `wait` 等待指定游标之后的新消息，超时返回 `timedOut: true`。它是工具调用等待，不能主动唤醒已经结束的 agent 轮次。
- 主题暂停时仍可发言，但不再派发新通知；恢复后派发未确认消息。关闭后禁止新发言，可以重新打开。暂停/关闭不会撤回已交给宿主的消息，也不会中断正在运行的模型。
- 网页右侧“删除主题”经确认后永久删除主题、全部消息、成员已读进度、通知回执和会话绑定记录；CLI `topic delete TOPIC_ID` 直接执行删除。项目、参与者身份和其他主题保持不变，删除后原主题 ID 返回 404。已创建或正在启动的 Codex / Claude 原生会话仍由宿主管理，删除不会结束它们或撤回已交给宿主的内容。

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

Channel 等待 MCP 初始化完成后订阅信箱，发送 `notifications/claude/channel`，提供四个讨论工具：

- `mailbox_topic`：主动获取主题当前的讨论目标和元数据。
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
4. 要求模型先用 `topic show` 主动获取目标，再根据来信和该主题此前未确认的消息给出结构化讨论回复。
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

- 消息与所有收件人的通知在同一 SQLite 事务提交；投递、失败、已读确认按“消息＋收件人”独立保存。一人的 ACK 不会清除其他人的未确认消息。
- 阅读进度按“主题＋参与者”单独记录，只能前进。
- 每个参与者只允许一个直接通知入口或一条旧版桥接连接，避免同时投递。
- 同一次入口登记内每条来信最多成功递交一次；明确未写出请求的连接失败可有限重试。故障后重新登记、服务重启后重新加入可能再次投递未确认消息。这是**至少一次**通知，不承诺模型只处理一次。
- 旧版 Codex bridge 回信使用稳定请求 ID；若回复已写入而确认前退出，重启会直接补确认，不重复调用模型。模型完成但回复尚未写入时中断，重启可能重新运行模型。
- 桥接遇到断线明确退出，不自动重连掩盖失败。普通网页会自动重连并重新读取当前数据。
- `.mailbox/` 和 `artifacts/` 不提交到 Git。备份数据库时先停止服务，再复制 `.mailbox` 目录。

## 验证

```powershell
npm run check
npm test
```

自动化验证包括真实 HTTP/SQLite、独立 CLI 进程、官方 MCP SDK 通道，以及模拟 App Server 的运行状态和消息事件。默认测试不调用模型、不消耗模型额度。

当前桌面 App 的真实创建验收需明确授权新建临时任务，运行 `node scripts/smoke-sessions.js codex SAVED_APP_PROJECT_PATH`。它使用隔离信箱验证新任务主动加入、两次回信和 ACK，结束时关闭测试信箱并打印任务 ID；随后在 App 归档该测试任务。测试本身不读取或修改项目代码。显式测试旧 WebSocket 创建流程用 `node scripts/smoke-sessions.js codex-ws`。

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
