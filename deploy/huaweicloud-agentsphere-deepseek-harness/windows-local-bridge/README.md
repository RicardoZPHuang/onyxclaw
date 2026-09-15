# Windows 本地 Agent Gateway 桥接

该桥接让 Chrome 访问本机 `http://127.0.0.1:13080`，由本机 Node.js 进程把所有 HTTP 和 WebSocket 请求转发到 Agent Gateway，并统一增加三项 Sandbox 路由 header。它用于排除 Chrome 扩展冲突、WebSocket header 注入差异和固定 Gateway 域名下的旧页面状态。

## 使用方法

先安装 Node.js 20 或更高版本。然后打开 PowerShell，进入本目录并执行：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\start-bridge.ps1 `
  -SandboxId '<sandbox-id>' `
  -TrafficToken '<traffic-access-token>'
```

保持 PowerShell 窗口运行，暂停 ModHeader 和 AgentSphere Gateway Headers 扩展，再用 Chrome 打开：

```text
http://127.0.0.1:13080
```

脚本首次运行会在本目录执行 `npm install`。凭据只保存在当前 PowerShell 和 Node.js 进程的环境变量中；关闭进程后会清理 PowerShell 中的变量。按 `Ctrl+C` 停止桥接。

如需指定其他网关或本地端口：

```powershell
.\start-bridge.ps1 `
  -SandboxId '<sandbox-id>' `
  -TrafficToken '<traffic-access-token>' `
  -GatewayUrl 'https://agent-gateway.example.com' `
  -LocalPort 13080
```
