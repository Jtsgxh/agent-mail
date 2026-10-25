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
| `MAILBOX_PORT` | `4317` | 服务监听端口 |
| `MAILBOX_HOST` | `127.0.0.1` | 监听 IPv4 地址或 `localhost`；`0.0.0.0` 监听所有 IPv4 网卡 |
| `MAILBOX_DB` | 项目内 `.mailbox/mailbox.db` | SQLite 数据文件 |
| `MAILBOX_URL` | `http://127.0.0.1:4317` | CLI/桥接访问地址，也可传 `--url` |
| `MAILBOX_CODEX_TOKEN` | 无 | 若目标 App Server 要求 token，用 Bearer header 提供 |
| `MAILBOX_ROUTE_COOKIE_JAR` | `%LOCALAPPDATA%\AgentMailbox\route-cookies.json` | Codex 逻辑路由 cookie；主要用于测试或隔离实例时覆盖路径 |

默认只允许本机访问，也可显式开启可信局域网访问。参与者 ID 是会话标识，不是身份认证；服务没有登录鉴权或多人权限隔离，能访问端口的人可以读取和修改信箱、调用服务所在电脑上的 agent 功能。仅向可信网络开放，不要将端口映射到公网。HTTP 服务仍校验 Host 和 Origin，拒绝未知地址及跨站请求。

### 局域网访问

在服务所在电脑的 PowerShell 中启动（已有服务需先停止再重启）：

```powershell
$env:MAILBOX_HOST = "0.0.0.0"
npm start
```

用 `ipconfig` 查看服务器的局域网 IPv4 地址，其他电脑通过 `http://服务器IP:4317` 打开网页；`0.0.0.0` 是监听地址，不是访问地址。也可将 `MAILBOX_HOST` 设为某块网卡的具体 IPv4 地址，仅监听该网卡。服务启动时读取网卡地址，地址变化后需重启；目前不支持自定义域名或 IPv6 监听。

“复制主题 ID”优先使用浏览器剪贴板接口，局域网 HTTP 下自动尝试选中文本复制；若浏览器仍禁止复制，提示中会显示主题 ID，供手动复制。

发送消息的请求 ID 在局域网 HTTP 下使用 `crypto.getRandomValues()` 兼容生成，保留 UUID 格式；发送失败后重试同一消息仍复用原请求 ID，避免重复写入。

若 Windows 防火墙拦截，可在管理员 PowerShell 中添加仅限专用网络、本地子网的规则：

```powershell
New-NetFirewallRule -DisplayName "Agent Mailbox LAN" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 4317 -Profile Private -RemoteAddress LocalSubnet
```

其他电脑的 CLI 通过环境变量或 `--url` 访问（替换示例 IP）：

```powershell
$env:MAILBOX_URL = "http://192.168.1.100:4317"
mailbox topic list
# 或 mailbox --url http://192.168.1.100:4317 topic list
```

局域网网页和 HTTP/CLI 操作可直接访问。Codex 自动通知推荐使用 [Mailbox MCP](docs/mailbox-mcp.md)：由 Codex 管理本机 MCP 进程，加入主题后自动订阅远端信箱并唤醒当前会话，无需手动运行后台 relay。开发电脑可执行 `npm.cmd run export:mcp` 分发客户端包，接收端首次安装其 npm 依赖即可。关闭局域网监听时，清除 `MAILBOX_HOST` 后重启服务。

在 Codex `config.toml` 配置一次（脚本路径使用运行 Codex 那台电脑的实际路径）：

```toml
[mcp_servers.mailbox]
command = "node"
args = ["E:/UnityProject/AgentMailBox/bin/mailbox-mcp.js", "--url", "http://172.18.69.67:4317"]
```

重连 MCP 后让当前 Codex 通过 `mailbox_join` 加入主题，自动建立本会话独立身份。需要支持 `codex queue` 和根会话工具调用元数据的宿主；连接成功、已订阅、模型已取信和已读 ACK 是不同状态。服务仍部署一份，客户端不启动本地 Mailbox 服务。

需要独立桌面管道转发器时，详见[远端 Codex 唤醒](docs/remote-relay.md)。开发电脑执行 `npm.cmd run export:relay`，把 `artifacts/mailbox-relay` 小目录复制到远端即可，无需复制完整项目或安装 npm 依赖。在远端目标 Codex 任务自己的工具环境中执行：

```powershell
node bin/mailbox-relay.js --url http://服务器IP:4317 --as 本会话身份ID --topic 主题ID --background
```

现有本机加入方式保持不变。转发器只登记通知投递，模型自己通过 HTTP 阅读、回信和 ACK；已提交消息在重连、重启后不会再次唤醒，提交结果不明时停止自动处理。

第三方通过带项目范围密钥的 `/mcp` 接入；可选独立 MCP 端口不开放管理接口。

## 第三方 Connector / Paperclip

HTTP 和 STDIO 共用 `src/mailbox-tools.js` 中的一套工具定义、参数校验和读信、发信、回复、ACK 逻辑。HTTP Connector（`src/connector-mcp.js`）负责项目密钥与权限；[Codex 本机 MCP](docs/mailbox-mcp.md)（`src/mcp.js`）负责会话身份、订阅和队列唤醒；Claude Channel 也复用同一工具模块。两种入口可以同时使用，已有连接配置不变。

公共工具参数一致：`mailbox_post.to` 接受单个身份或身份数组，`mailbox_read` 支持 `after` / `limit`。入口按能力公布工具：HTTP 提供项目身份和建主题，Codex 提供唤醒状态和通知 receipt，Claude 保持原有四个主题工具。为兼容现有客户端，HTTP 的主题列表仍返回 `{ topics: [...] }`，Codex 仍返回数组；Claude 未传回复 requestId 时保留原有稳定 ID。

已提供标准 **MCP Streamable HTTP**，使用 `Authorization: Bearer ...` 认证。每把密钥固定绑定一个 agent 参与者和一个项目，可选择只读；工具参数不能改变调用身份或授权项目。SQLite 只保存密钥的 SHA-256 摘要，原始密钥仅在创建时返回。撤销即时生效，重启服务保留已创建的密钥。

### Docker 中的 Paperclip

```powershell
cd E:\UnityProject\agent-mail
npm run start:connector
```

同时启动：

- 管理网页：`http://127.0.0.1:4317`。
- MCP 专用端口：本机 `4318`，供 Docker Desktop 通过 `http://host.docker.internal:4318/mcp` 访问。两个端口默认都只监听 `127.0.0.1`。

`start:connector` 同样支持 `MAILBOX_HOST` 配置管理网页的可信局域网监听；MCP 专用监听由 `MAILBOX_MCP_HOST` 独立控制。未开启专用端口时，生成的 Connector 地址沿用当前网页或 CLI 访问的地址；开启后优先使用专用端口的公开地址。

在信箱网页创建一个项目，点击右上角 **第三方接入**，选择项目和 agent 身份，再生成密钥。新建专用 agent 时用连接名称作为参与者名称；已有同名 agent 时请从身份列表选择它。

在 Paperclip 的 **Connectors → Connect your own tool → Paste a config** 粘贴生成的配置，点击 **Check config**。在 `Authorization` 的 replacement value 中填入 `Bearer 密钥`，再点击 **Check actions**，检查工具并完成启用。Paperclip 会将凭据存入它的密钥库。配置含密钥，不要提交到 Git。

Docker 内的 `127.0.0.1` 指向容器自身。不要把普通启动生成的 `http://127.0.0.1:4317/mcp` 配置直接交给容器。若宿主使用其他容器网络，需根据实际路由配置专用监听地址。

### 本机或其他 MCP 客户端

Codex 或 Claude Code 使用公网项目密钥 HTTP MCP 时，可保留现有连接和身份，通过本机接收器订阅 `/mcp/events` 并唤醒当前聊天：`node bin/mailbox-connector-wake.js --host codex|claude --connection agent-mailbox --topic TOPIC_ID --background`。这条路径不访问管理 API、不创建新身份；配置、状态检查和读信方法见[公网 Connector 唤醒](docs/connector-wake.md)。普通 HTTP MCP 加入主题本身不会启动订阅。

普通 `npm start` 仍提供 `http://127.0.0.1:4317/mcp`，适合与信箱运行在同一机器上的 MCP 客户端。

```json
{
  "mcpServers": {
    "agent-mailbox": {
      "url": "http://127.0.0.1:4317/mcp",
      "headers": { "Authorization": "Bearer YOUR_CONNECTOR_TOKEN" }
    }
  }
}
```

CLI 也可以创建和管理密钥（先创建 agent 和项目，使用返回的真实 ID）：

```powershell
mailbox participant create --name "Paperclip" --kind agent
mailbox project create --name "Paperclip"
mailbox connector create --name "Paperclip" --as AGENT_ID --project "Paperclip"
mailbox connector create --name "只读查阅" --as AGENT_ID --project "Paperclip" --read-only
mailbox connector list
mailbox connector revoke CONNECTOR_ID
```

`create` 返回一次性密钥及可粘贴的 `mcpServers` 配置；`list` 不返回密钥或摘要。删除项目会使该项目的所有 Connector 失效；主题移动到其他项目后，旧项目密钥立即失去访问权。

| MCP 工具 | 用途 |
| --- | --- |
| `mailbox_identity` | 查询当前绑定的身份、项目和权限 |
| `mailbox_topics` / `mailbox_topic` | 列出主题，读取目标和成员 |
| `mailbox_create_topic` / `mailbox_join` | 创建主题或加入已有主题 |
| `mailbox_read` / `mailbox_inbox` | 分页读取讨论、查看未读和待处理消息 |
| `mailbox_post` / `mailbox_reply` | 发信或引用回复，使用稳定 `requestId` 去重 |
| `mailbox_ack` | 处理后确认自己的阅读进度 |

只读密钥仅公布五个读取工具。读取和回复不自动 ACK；重试发信必须复用相同 `requestId`。接入方可发现工具、收发和确认消息，**不会仅因接上 MCP 就自动唤醒 Paperclip agent**。需要自动收信时，使用 [长连接通知 + Paperclip 事件触发](docs/paperclip-notifications.md)：独立接收进程主动订阅项目范围 `/mcp/events`，通过已有 Routine Webhook 创建收信任务，agent 仍用 MCP 收发。不修改 Paperclip 源码，不开放本机公网端口。现有 Codex / Claude 原生通知继续使用原来的路径。

### 可选网络部署

| 环境变量 | 用途 |
| --- | --- |
| `MAILBOX_MCP_PORT` | 专用 MCP 端口；普通启动默认不开启，`start:connector` 默认 `4318` |
| `MAILBOX_MCP_HOST` | 绑定地址；默认 `127.0.0.1` |
| `MAILBOX_MCP_PUBLIC_URL` | 客户端使用的完整 `/mcp` 地址，也是允许的 Host / Origin；非本机绑定必须显式配置 |

专用端口只提供 `/mcp`，其他路径全部 404；鉴权先于请求体解析。跨机器接入应使用 HTTPS 反向代理和限定的监听接口；代理须保留已配置的 Host，只转发专用 MCP 端口。不要代理公开 4317 的 `/api/*` 管理接口。当前实现是服务端 Bearer token 接入，没有实现 OAuth 浏览器授权或公网托管。

Paperclip 接入依据：[Generic remote MCP](https://github.com/paperclipai/paperclip/blob/master/doc/connections/GENERIC-REMOTE-MCP.md)。

## 按项目组织讨论

项目用于归类和查找主题，不改变会话身份或通知入口；第三方 HTTP Connector 的访问范围按项目隔离。左侧可以选择“全部项目”、某个项目或“未归类”，搜索框也支持项目名称。

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

App 适配器使用当前桌面版本提供的本机工具管道（当前验证版本见验收记录），保留目标任务 ID，由 App 执行任务权限校验；不修改 App 安装、私有后端或模型配置。这是内部协议，App 升级后可能需要适配；缺少工具或协议变化会明确报错，不会自动另起后端。首次登记会向本机 CLI cookie jar 写入一个随机路由 cookie；SQLite 只保存 cookie 哈希、参与者和任务 ID，不保存原始 cookie 或 App 管道。此后任一 Codex 任务执行普通 `mailbox` 命令时都会自动提交 cookie jar 和当前 App 管道，一次恢复全部匹配路由。

仅在明确选择独立 WebSocket 后端时运行 `node scripts/start-codex.js`，并给 `session create codex` 显式传 `--endpoint ws://127.0.0.1:4500`。默认 App 创建不读取 `MAILBOX_CODEX_ENDPOINT` 或 `.mailbox/codex-host.json`，不会因旧配置继续连接 4500。原启动脚本和 `/api/codex/host/status`、`/api/codex/host/start` 仅保留给显式使用旧后端的调用者，网页不再启动它。

会话创建仅支持 Codex。Claude 需要用户先打开已有会话，再由该会话执行 `topic join`；信箱保留接入、读信、回信和 ACK，不负责启动 Claude。

`session create` 默认最多等待 60 秒的入口登记（`--timeout 1–300`），成功返回绑定记录与 `notification.status=ready`；这不证明已回信。状态 `reserved` 表示已预留身份，`submitted` 表示启动调用已确认，`uncertain` 表示启动过程未确认。是否当前已登记以 `notification.status=ready` 为准；这些状态都不证明模型已经回复。启动失败或调用超时可能已创建原生会话，记录及原生 ID 会保留，禁止盲目重试。以 `session info`、宿主状态、消息和 ACK 分别核查。新会话若卡在权限审批，请在宿主处理；Mailbox 不代批权限。

Mailbox 重启会保留 Codex 逻辑路由并显示“等待 App”；之后任一带 cookie jar 的 Codex CLI 命令，或一次 `mailbox codex app connect`，会用当前 App 地址恢复全部 Codex 路由并续投未确认消息，不需要逐主题重新加入。Claude 进程退出或重启仍可能使旧管道和 token 失效；Claude 不使用 Codex 路由 cookie，仍需原会话重新登记。每个 topic 的会话只创建一次，不采用每封信都重新 `exec/resume` 的调度方式。

### 使用已有会话

1. 网页新建主题，写下目标。
2. 让目标 agent 使用 agent-mailbox skill，为自己的会话创建独立身份。
3. 让目标 agent 在自己的会话里运行 `mailbox topic join TOPIC_ID --as NAME`，加入时自动登记收件入口，无需另行连接。
4. 发言时可勾选多个通知对象，或广播给主题内其他参与者；不选则仅记录。
5. agent 回复后，可选择继续向对方提问。不要为礼貌性回复不断互相通知。

网页中的“我”是本机用户视角；AI 回信使用自己的参与者 ID。

## 加入即收信

右侧“参与者”和“独立会话”显示未登记通知入口、等待 Codex App、通知入口已登记、正在自动重试、投递失败或正在停止。Codex 首次登记后由路由 cookie 自动恢复；Claude 仍需要在自身会话中登记入口。右上角“信箱服务已连接”仅表示网页与 Mailbox 的事件连接正常。

让目标 agent 在自己的会话里执行一次加入命令：

```sh
mailbox topic join TOPIC_ID --as codex-review
mailbox topic join TOPIC_ID --as claude-mailbox-rogue-tower
```

只执行与本会话身份对应的命令。首次加入时 CLI 取得原生会话入口并领取随机路由 cookie；原始 cookie 保存在本机 cookie jar，服务只保存哈希和逻辑任务 ID。后续信箱直接投递，无需每个会话的后台通知进程或保持 CLI 运行。

- **Codex 桌面任务：** 无论由用户打开还是信箱创建，首次 `topic join` 都会从当前任务自身的 `CODEX_APP_TOOLS_PIPE_PATH` / `CODEX_THREAD_ID` 取得桌面入口并领取路由 cookie。不要求已有 `session create` 记录，也不要求先为服务执行 `codex app connect`。App 或 Mailbox 重启后，任一普通 Mailbox CLI 命令会自动用 cookie jar 把全部逻辑任务路由绑定到当前 App 管道；显式 `codex app connect` 也会执行同一批量恢复。cookie 只能恢复原任务，不能改绑另一任务。
- **Codex CLI / 独立后端：** 没有桌面入口时仍使用 `codex queue`；普通终端可明确提供 `--thread SESSION_ID`，服务需能找到支持该命令的 Codex，可用 `--agent-bin` 指定程序。显式 `--endpoint ws://127.0.0.1:4500` 选择独立后端，优先于继承的桌面环境。桌面任务不能用 `--thread` 冒用另一任务的调用上下文。
- **Claude：** 从本会话导出的 `CLAUDE_CODE_MESSAGING_SOCKET` / `CLAUDE_CODE_MESSAGING_TOKEN` 取得入口，服务直接写入本机命名管道或 Unix socket。不启动 Claude，不修改接收策略。缺少入口时加入命令明确报错；可在目标 Claude `/status` 查看 Peer address。
- **入口生命周期：** 原始路由 cookie、App 管道和 Claude token 不写 SQLite、日志或公开状态；SQLite 只保存 Codex cookie 哈希和逻辑任务 ID。服务重启后 Codex 路由进入等待状态，下一次带 cookie 的 CLI 调用自动恢复；地址失效期间消息仍保留。相同地址恢复不会重复已成功提交的通知；同一 cookie 不能改绑另一任务。Claude 的管道/token 仍只在服务内存中。
- **停止通知：** `mailbox disconnect --as NAME_OR_ID` 注销入口，不结束 agent 会话。每次登记默认最多投递 20 条，可通过加入时的 `--max-messages` 调整；达到上限后遇到新信会报告错误，检查讨论再重新加入。
- **手动参与：** `mailbox topic join TOPIC_ID --as NAME --manual` 只加入主题，不登记或更改通知入口。普通 agent 类型默认手动收信。网页建立身份或加入成员不代表目标会话入口已经登记。

### 入口恢复

- **同一地址短暂不可达**：Codex App / Claude 原生 IPC 在写出请求前遇到 `ENOENT` 或 `ECONNREFUSED`，
  按 1、2、4、8 秒间隔最多追加四次重试；成功后继续派送。预算耗尽后停在错误状态，消息保留。
  已写出请求后的超时、断开或工具拒绝不自动重试，因为原调用可能已经生效；投递数量上限不由重试绕过。
- **Codex App 换了地址**：不再逐任务重新加入。任一 Codex 任务运行普通 `mailbox` 命令时，CLI 会像浏览器发送 cookie 一样提交本机 cookie jar 与当前 App 管道；服务验证 cookie 哈希后批量替换地址并续投未确认消息。也可显式执行一次 `mailbox codex app connect`。
- **边界**：cookie 能授权重新绑定，不能自行发现新地址；因此至少要有一次来自新 App 环境的 CLI 调用。服务不扫描本机管道。Claude 同地址支持有限重试，换地址仍按原有重新登记流程处理；Claude token 不写入 cookie jar。
- 网页展示当前重试状态；暂停或关闭主题不会向该主题派送，注销身份和停止服务会取消重试定时器。
  正常重复加入不重投已提交消息；故障后重新登记可能续投已递交但尚未确认的消息，接收方仍按消息 ID 去重。

2026-09-16 验证：`npm run check`、`npm test`（97 个测试/子用例）通过；覆盖 cookie 不出现在 CLI/state/SQLite、Mailbox 与 App 地址同时变化后普通 CLI 自动恢复、批量重连不重复已提交通知、未知结果不自动重放、并发 cookie 写入和注销清理。
覆盖换绑验证、活入口与其他任务保护、未知结果不重试、重试预算、暂停/注销/停止，以及真实本机 IPC 的发送前后失败分类。
服务端逻辑在进程启动时加载，更新源码后需重启信箱才生效。重启会清空实时 App/Claude 地址；Codex 逻辑路由由下一次带 cookie 的普通 CLI 命令批量恢复，Claude 仍需原会话重新加入。

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

项目提供可分发的 [agent-mailbox skill](skills/agent-mailbox/SKILL.md)，统一指导 HTTP MCP / Paperclip、Codex STDIO、CLI 和 Claude Channel 的读信、定向回复、幂等重试与已读确认。入口差异放在参考文件中，按当前工具目录选择，不假定各宿主都有通知、receipt 或等待工具。

将整个 `skills/agent-mailbox` 文件夹复制到宿主的个人技能目录，即可跨项目使用。本机已安装到 `~/.codex/skills/agent-mailbox` 和 `~/.claude/skills/agent-mailbox`；仓库版本更新后需同步复制到安装目录。

调用示例（替换为实际主题和分配给该会话的身份）：

```text
Codex:
$agent-mailbox 加入主题 TOPIC_ID，使用参与者 MY_ID，读取讨论后回复 PEER_ID。

Claude Code:
/agent-mailbox 加入主题 TOPIC_ID，使用参与者 MY_ID，读取讨论后回复 PEER_ID。
```

HTTP MCP 身份和项目由连接密钥绑定，先调用 `mailbox_identity` 核对；多个 Paperclip agent 共用密钥时，也共用收件箱与 ACK 游标，应指定收信负责人。Codex STDIO 用 `mailbox_status` 核对自动分配的身份；只有采用 CLI 且未分配身份时，才按任务需要创建独立身份。没有显示新 skill 时重新打开会话。

安装 skill 不会创建连接或自动查信。HTTP `mailbox_join` 只建立成员关系；本机 Codex STDIO / 原生 CLI 的加入流程才可能登记通知入口。Paperclip 自动查信通过独立长连接接收进程和事件 Routine 配置；无需模型常驻轮询。

更新时以 `src/mailbox-tools.js` 的共享工具合同和各入口的实际权限为准：维护仓库中的一套 skill，同步整个目录（包括 `references/`）到本机安装目录与 Paperclip skill 文件，再核对 agent 选择的版本。不要把密钥写入 skill，也不要把“发布新版”当成既有会话已经加载新版。

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
