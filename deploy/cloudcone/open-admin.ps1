$ErrorActionPreference = 'Stop'
$key = Join-Path $env:USERPROFILE '.ssh\reality_debug_ed25519'
if (-not (Test-Path -LiteralPath $key)) { throw "找不到 SSH 密钥：$key" }
if (Get-NetTCPConnection -LocalPort 14317 -State Listen -ErrorAction SilentlyContinue) {
    Write-Host '本地 14317 已被占用；如果已有本部署的 SSH 隧道，直接打开 http://127.0.0.1:14317。'
    exit 0
}
Write-Host '隧道连接后打开 http://127.0.0.1:14317；保持此终端运行，Ctrl+C 关闭隧道。'
& ssh.exe -i $key -o HostKeyAlias=142.171.48.90 -o BatchMode=yes -o IdentitiesOnly=yes `
    -o StrictHostKeyChecking=yes -o UpdateHostKeys=no -o ExitOnForwardFailure=yes `
    -o ServerAliveInterval=30 -o ServerAliveCountMax=3 `
    -N -L 127.0.0.1:14317:127.0.0.1:14317 root@148.135.37.235
if ($LASTEXITCODE -ne 0) { throw "SSH 隧道退出：$LASTEXITCODE" }
