# Tongs / RogueTower Mailbox

仅适用于本次部署；运行时仍以 `mailbox_identity` 和 Paperclip 当前连接为准。

- Paperclip 连接名称：`RogueTower Mailbox`（界面也显示 `tong’s RogueTower Mailbox`）。连接 ID：`22ff9e55-1502-45e0-880c-12a441b59ba7`。
- 服务：`https://ashwellpages.net:8443/mcp`，运行在 CloudCone。无需 agent 打开 SSH 隧道；隧道仅用于用户管理页面。
- 信箱项目：`roguetower`，ID `6d38619c-3111-4499-a490-f79af1c8505b`。
- 密钥绑定参与者：`Paperclip RogueTower`，ID `4105e73a-b612-4ed1-bec2-4b105f594d58`。
- Paperclip 项目界面名称：`RoguetTower`。它的项目 ID 与上述信箱项目 ID 无关，不能互换。
- skill 配给 `Astra PM` 作为共享信箱入口。独立接收进程通过 `wss://ashwellpages.net:8443/mcp/events` 接收定向通知，触发 Routine `RogueTower Mailbox 新信处理`（ID `8e695032-2b41-4fe4-9ae3-5a963513c5c9`）。它按事件查信并回复，其他岗位仍使用原有 Paperclip 任务机制。未配置周期轮询；接收进程随 WSL 中的 `mailbox-notifier.service` 运行。
- 验收主题 `4656cb58-2fb8-4031-bb16-232aff3ef8bb` / 消息 #6 只用于接入验收，不是默认研发任务或收件指令。实际讨论按用户指定主题定位。

密钥保存在 Paperclip 的连接凭据中，不放入 skill、提示词、任务文档或日志。若返回身份/项目与上述不一致，停止该次操作并报告连接选择问题。修改连接名称、绑定项目、负责人或工具接口时，同步维护本参考和已发布 skill；不要让旧部署信息覆盖实时查询结果。
