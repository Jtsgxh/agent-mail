# CloudCone 部署记录

部署日期：2026-10-16（Asia/Taipei）。全新信箱，未复制本机数据库或密钥。

## 入口

- 公网 MCP：`https://ashwellpages.net:8443/mcp`，要求项目范围 Bearer 密钥。
- 管理页面：先运行本目录 `open-admin.ps1` 建立 SSH 隧道，再打开 `http://127.0.0.1:14317`。
- SSH 私钥默认使用 `$env:USERPROFILE\.ssh\reality_debug_ed25519`；可用 `& .\deploy\cloudcone\open-admin.ps1 -KeyPath 'D:\SSH Keys\id_ed25519'` 指定其他路径，省略 `-KeyPath` 时保持默认行为。
- 本次已启动本机 SSH 隧道；Windows 重启或隧道断开后重新运行脚本。
- 公网 `/`、`/api/*` 返回 404。直接用浏览器打开 `/mcp` 返回 401 属于正常鉴权行为。
- 在管理页面创建项目，点击“第三方接入”生成专用身份和密钥，然后把生成配置交给 Paperclip。旧本地信箱与 VPS 信箱各自独立；本次未更改 Paperclip 原连接。

## 服务器布局

- VPS：`148.135.37.235`，Ubuntu 24.04，x86_64。
- 应用：`/opt/agent-mailbox/releases/notifications-20261016-01`，`/opt/agent-mailbox/current` 指向该版本；前一版 `b4a64c8` 保留用于回退。
- Node：`/opt/agent-mailbox/node` → `node-v24.22.0-linux-x64`，官方 SHA-256 验证通过。
- Caddy：`/opt/agent-mailbox/bin/caddy`，v2.11.7，官方 SHA-512 验证通过。
- 配置：`/etc/agent-mailbox/`，对应本目录配置文件。
- SQLite：`/var/lib/agent-mailbox/mailbox.db`，服务用户 `agent-mailbox`。
- HTTPS 状态与证书：`/var/lib/agent-mailbox-https`，独立用户 `agent-mailbox-https`。
- 备份：`/var/backups/agent-mailbox`，SQLite 在线备份，保留最近 14 份。
- 部署前代理服务 PID/启动时间、Xray 配置摘要、网络规则快照：`/opt/agent-mailbox/baseline`，仅 root 可读。

## 端口和证书

- TCP 80：Caddy 的 ACME HTTP 验证；普通请求返回 404。
- TCP 8443：Caddy HTTPS，只转发 `/mcp` 与 `/mcp/events` 到 `127.0.0.1:4318`。后者为同密钥、同项目范围的 WebSocket 通知入口，不提供管理操作。
- TCP 14317：Mailbox 管理接口，仅监听 `127.0.0.1`，供 SSH 隧道使用。
- TCP 4318：MCP 后端，仅监听 `127.0.0.1`。
- Xray 继续使用 TCP 443 / 44323 等原监听，Hysteria 继续使用 UDP 443。
- Caddy 已通过 HTTP-01 从 Let's Encrypt 取得 `ashwellpages.net` 的可信证书，自动续期已启用；明确禁用 TLS-ALPN 验证，避免使用 Xray 的 443。
- VPS 检查结果：UFW 未启用，iptables 默认 ACCEPT；已有 nftables Hysteria UDP 端口跳跃规则。部署没有执行防火墙、路由或 Xray 配置修改。

## 运维

服务已启用开机启动和异常重启：

```sh
systemctl status agent-mailbox agent-mailbox-https
journalctl -u agent-mailbox -u agent-mailbox-https -n 50 --no-pager
systemctl restart agent-mailbox
```

改 HTTPS 配置时先验证，再仅重启本部署的 HTTPS 服务：

```sh
/opt/agent-mailbox/bin/caddy validate --config /etc/agent-mailbox/Caddyfile --adapter caddyfile
systemctl restart agent-mailbox-https
```

每天 UTC 03:30（台北 11:30，另加最多 5 分钟随机延迟）执行备份。定时器已启用；本次手动执行验证被自动审批阻止，未确认首份备份生成。可由管理员执行：

```sh
systemctl start agent-mailbox-backup.service
journalctl -u agent-mailbox-backup -n 10 --no-pager
systemctl list-timers agent-mailbox-backup.timer
```

停用本次部署而保留数据：

```sh
systemctl disable --now agent-mailbox-backup.timer agent-mailbox-https.service agent-mailbox.service
```

不要操作 Xray、Hysteria 或 WARP 服务；本部署与它们没有服务依赖。

## 已完成验证和限制

- 本机通过外网直接访问 HTTPS，TLS 校验成功；无密钥 `/mcp` 返回 401，公网管理路径返回 404。
- 官方 MCP SDK 通过公网 HTTPS 发现 10 个工具，完成身份验证、建主题、收信、分页读信、回复、重试去重、独立 ACK。
- 仅重启 `agent-mailbox.service` 后，临时身份、密钥和消息仍可读取；撤销密钥后调用被拒绝。
- 测试主题、项目、密钥及专用测试身份已清理；最终只剩初始“我”参与者，无讨论、项目或 Connector。
- HTTPS 上线后确认 Xray 仍监听 443，PID 为部署前同一个 `2294927`。
- 最终远端摘要/PID/路由比对命令被自动审批阻止（只读版本也被阻止，未说明原因），因此不把最终完整比对表述为已通过。没有重启 VPS，开机自启仅验证了 systemd 启用操作成功。
