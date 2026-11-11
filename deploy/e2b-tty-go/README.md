# AgentSphere E2B 终端工具（Go）

用于连接 AgentSphere E2B 沙箱。生成的 Linux 二进制静态链接，目标机器无需安装 Go、Python、E2B SDK 或共享库。目标机器需要能访问 AgentSphere API 和沙箱网关，并具备 HTTPS 信任的 CA 证书；沙箱内需要 `/bin/bash`。

支持 Linux amd64、Linux arm64、macOS arm64 和 Windows amd64。Windows 版使用原生 Console 的 VT 输入输出，建议在 Windows 10/11 的 Windows Terminal + PowerShell 中运行。无需本机代理、浏览器插件或 WebSocket。

## 直接使用

以下示例使用本地构建的二进制。

本地构建产物：本目录 `bin/e2b-tty-linux-amd64`、`bin/e2b-tty-linux-arm64`、`bin/e2b-tty-darwin-arm64` 和 `bin/e2b-tty-windows-amd64.exe`。选择目标机器的系统和架构，Unix 系统复制过去后 `chmod +x` 即可运行。Windows 直接运行 `.exe`，无需 Python、Go、WSL 或额外 DLL。`bin/` 不提交到 Git，源码可以重新构建。

### Windows 使用方式

在 PowerShell 中切换到 `.exe` 所在目录，设置 API Key，然后连接沙箱：

```powershell
$env:E2B_API_KEY = '你的 API Key'
.\e2b-tty-windows-amd64.exe --sandbox-id '你的 sandboxID' --sandbox-url 'https://你的沙箱网关'
```

非交互命令和查询环境变量：

```powershell
.\e2b-tty-windows-amd64.exe --sandbox-id '你的 sandboxID' --sandbox-url 'https://你的沙箱网关' --exec 'pwd; printenv'
$LASTEXITCODE
```

Windows 同样使用 Ctrl-] 分离、`--pty-pid` 重连。工具启用 [Microsoft VT Console 输入输出模式](https://learn.microsoft.com/windows/console/setconsolemode)，退出时恢复 Console 模式。Windows 没有 SIGWINCH，因此每 250 毫秒检查窗口尺寸，仅在尺寸改变时调用 envd 的 Update。使用原生 PowerShell/CMD 控制台；Git Bash 的 mintty 等管道终端可能无法通过 Console TTY 检查，建议换 Windows Terminal。Windows 版已交叉编译和静态检查，目前没有 Windows 机器上的运行实测。

如果 shell 里自动出现 `35;69;20m` 等不断变化的数字，从格式看通常是 [SGR 鼠标上报序列](https://invisible-island.net/xterm/ctlseqs/ctlseqs.html)被当作键盘输入。完整形式如 `ESC[<35;69;20m`，最后两个数字为鼠标坐标。Windows 版已默认关闭 Console 鼠标输入，并在进入和退出时清理 VT 鼠标跟踪模式；退出时先停止远端输出，再恢复终端，避免残留 TUI 输出重新启用跟踪。键盘 VT 输入继续启用。远端程序主动启用鼠标模式时仍需实机验证兼容性。

先设置 API Key（从自己的凭据获取，仓库不保存密钥）：

```bash
read -rsp 'E2B API key: ' E2B_API_KEY; echo
export E2B_API_KEY
```

进入已有沙箱，只需指定沙箱 ID 和网关 URL：

```bash
./bin/e2b-tty-linux-amd64 \
  --sandbox-id '你的 sandboxID' \
  --sandbox-url 'https://你的沙箱网关'
```

默认 API 为 `https://agentsandbox.cn-north-4.myhuaweicloud.com`，用户为 `root`，工作目录为 `/root`，不需要填写 `--cwd`。API Key、模板、沙箱和网关必须属于匹配的账号及区域。其他区域通过 `--api-url` 或 `E2B_API_URL` 指定。优先级为命令行参数 > 环境变量 > 默认 API；如果之前设置过旧区域的 `E2B_API_URL`，请先 `unset E2B_API_URL`。`--sandbox-url` 没有内置默认值，必须通过参数或 `E2B_SANDBOX_URL` 配置。

也可以设置网关环境变量，之后只输入沙箱 ID：

```bash
export E2B_SANDBOX_URL='https://你的沙箱网关'
./bin/e2b-tty-linux-amd64 --sandbox-id '你的 sandboxID'
```

### 北京四区连接示例

以下示例使用已有沙箱；API Key 使用上文设置的环境变量，不写入命令或源码：

```bash
unset E2B_API_URL  # 使用内置的北京四区 API
export E2B_SANDBOX_URL='https://你的沙箱网关'
./bin/e2b-tty-darwin-arm64 --sandbox-id '你的 sandboxID' \
  --exec 'pwd; id -un; uname -s'
# 交互终端：去掉 --exec 及其命令即可
```

Linux 使用 `./bin/e2b-tty-linux-amd64`（ARM64 使用 `e2b-tty-linux-arm64`）；Windows 使用 `bin\e2b-tty-windows-amd64.exe`。PowerShell 中如设置过旧 API，使用 `Remove-Item Env:E2B_API_URL -ErrorAction SilentlyContinue` 清除；设置 `$env:E2B_SANDBOX_URL` 后只需传 `--sandbox-id`。沙箱 ID 是临时资源，失效后需替换为自己的实例。

## 创建、执行和重连

### 跳过 TLS 证书校验

默认校验 HTTPS 证书。访问自签名证书、私有 CA 或证书域名不匹配的端点时，可显式加 `--insecure`：

```bash
./e2b-tty --sandbox-id '你的 sandboxID' \
  --api-url 'https://你的API域名' \
  --sandbox-url 'https://你的沙箱网关' --insecure
```

也可以设置 `E2B_INSECURE=true`（PowerShell：`$env:E2B_INSECURE = 'true'`）。`--insecure=false` 可覆盖环境变量，恢复校验。该配置同时作用于控制 API 和沙箱网关，包括创建、连接、删除、终端流、输入和窗口缩放；HTTPS 仍加密传输，但不再验证证书信任链、有效期及域名，仅应对可信端点启用。该选项不改变创建请求的 `secure: true` 或沙箱 Token 认证。

不传 `--sandbox-id` 时根据模板创建沙箱，随后进入终端：

```bash
./bin/e2b-tty-linux-amd64 \
  --template '你的北京四区 templateID' \
  --sandbox-url 'https://你的沙箱网关' \
  --env MY_VAR=example
```

`--env NAME=VALUE` 可以重复传入，仅在创建时生效。它写入创建请求的 `envVars`，进程默认继承 envd 的环境变量；TTY 启动请求额外指定 `TERM`、`LANG`、`LC_ALL`。不能用 `--env` 修改已有沙箱。

只创建，不进入终端：

```bash
./e2b-tty --template '你的 templateID' --sandbox-url 'https://你的沙箱网关' --create-only
# stdout: {"sandboxID":"..."}
```

非交互执行命令，可用于 SSH、脚本和 CI，不需要本地 TTY：

```bash
./e2b-tty --sandbox-id '你的 sandboxID' --sandbox-url 'https://你的沙箱网关' \
  --exec 'pwd; id -un; printenv MY_VAR'
```

`--exec` 通过 `/bin/bash -c` 执行，不转发本地 stdin；命令需自行结束。stdout/stderr 输出远端内容，工具退出码与远端退出码一致（0–255），API/通信错误返回 1。

交互模式按 **Ctrl-]** 分离，保留远端进程。启动时 stderr 显示 PID，用它恢复原终端：

```bash
./e2b-tty --sandbox-id '你的 sandboxID' --sandbox-url 'https://你的沙箱网关' --pty-pid 123
```

`exit` 结束远端 shell；默认不删除沙箱。`--kill-on-exit` 在工具退出时删除沙箱，已有沙箱也会被删除，不能与 `--create-only` 同用。分离和重连依赖沙箱仍然存活。

## 参数和与原脚本的差异

| 参数 | 默认值 / 用途 |
| --- | --- |
| `--api-url` | `E2B_API_URL` 或 `https://agentsandbox.cn-north-4.myhuaweicloud.com`（北京四区） |
| `--sandbox-url` | `E2B_SANDBOX_URL`；必须提供 |
| `--insecure` | 默认 `false`；可通过 `E2B_INSECURE=true` 开启，跳过 API 和网关的 TLS 证书校验 |
| `--sandbox-id` | `E2B_SANDBOX_ID`；已有沙箱 |
| `--template` | `E2B_TEMPLATE_ID`；创建时必须提供 |
| `--api-key` | 未指定时读取 `E2B_API_KEY`，再读取 `HUAWEICLOUD_AGENTSPHERE_E2B_API_KEY` |
| `--user` / `--cwd` | `root` / `/root` |
| `--sandbox-timeout` | 3600 秒；连接已有沙箱时也申请续期 |
| `--pty-pid` | 重连已有 PTY；必须同时指定 `--sandbox-id` |
| `--command-mode` | 通过 stdin/stdout 流交互，无 PTY 和窗口缩放；重连命令进程时也需携带 |
| `--shell` | `/bin/bash -li`；仅作用于 `--command-mode`；PTY 使用 `/bin/bash -i -l` |
| `--session-retries` | 5，仅重试启动/连接返回的 `session not found` |
| `--session-retry-interval` | 2 秒，支持小数 |
| `--request-timeout` | `30s`，控制面和一元 RPC，以及流的响应头/首事件超时；不限制终端总时长 |
| `--exec` / `--create-only` / `--env` | Go 版本增加的非交互、只创建和创建环境变量参数 |

保留原脚本的创建/连接、PTY、分离重连、命令模式、窗口缩放和会话重试逻辑。调整默认工作目录为 `/root`，去掉旧脚本中固定模板以及跨区域的默认网关；必须显式配置匹配的模板和网关。连接时显式提交 `--sandbox-timeout`，避免连接使用 SDK 隐含的续期时间。错误直接显示 HTTP 状态和返回正文，不要求返回体有 `code` 字段，避免非标准 401 触发 `KeyError: 'code'`。日志不输出 API Key、envd token 或 traffic token。

## 通信过程

1. 控制面：`POST /sandboxes` 创建，或 `POST /sandboxes/{id}/connect` 连接，使用 `X-API-Key`。获得 sandboxID、envdAccessToken、trafficAccessToken。
2. 数据面：直接访问指定网关，用 `E2b-Sandbox-Id`、`E2b-Sandbox-Port: 49983`、`E2B-Traffic-Access-Token` 路由到 envd，额外传入 `X-Access-Token`。不拼接 `port-sandbox-id` 域名。
3. `process.Process/Start` 或 `Connect` 使用 Connect JSON 的 HTTPS 服务端流。每帧为 1 字节标志、4 字节大端长度、JSON，二进制数据为 Base64。Start 使用 Basic 用户认证。保留流的 keepalive header。
4. `SendInput` 发送键盘字节；PTY 用 `input.pty`，命令模式用 `input.stdin`。`Update` 同步终端窗口尺寸。Ctrl-] 关闭本地流，不杀死远端 PTY。
5. `--kill-on-exit` 调用控制面 `DELETE /sandboxes/{id}`。

网关仍须支持 HTTPS 长连接/流式响应。此工具与旧 Python 脚本一样不使用 WebSocket，因此不涉及浏览器 WS Header 注入。

## 从源码构建

构建机器需要 Go 1.24 或以上，第一次构建需要下载 `golang.org/x/term` 和 `golang.org/x/sys`。依赖编译进可执行文件，运行时无需下载。`go.mod` / `go.sum` 固定依赖版本。

```bash
cd deploy/e2b-tty-go
make test
make build
cat bin/SHA256SUMS
```

单独构建 Linux amd64（无需 C 编译器）：

```bash
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \
  -trimpath -ldflags='-s -w' -o e2b-tty .
```

源码：`main.go` 负责参数、终端和生命周期；`rpc.go` 负责控制 API、路由认证和 Connect RPC；`terminal_unix.go` / `terminal_windows.go` 按平台处理终端、退出信号和窗口尺寸；`rpc_test.go` 验证协议帧、路由 Header、非标准 401、凭据脱敏、非零退出和分离输入。

## 实测记录

2026-11-10：默认控制 API 更新为北京四区 `https://agentsandbox.cn-north-4.myhuaweicloud.com`；`make test`（race 测试及 go vet）通过，四个平台交叉编译完成，归档三份二进制及 SHA256SUMS 已更新。macOS arm64 使用示例沙箱实测：控制面查询状态为 running、connect 返回 200；指定固定网关的 `/process.Process/Start` 返回 `404 sandbox not found`，独立 HTTP 客户端请求 `/health` 也返回同一错误。因此本次尚未完成命令执行、退出码及交互 PTY 的端到端验证，需先核对该沙箱与网关的绑定。Linux/Windows 新构建未进行目标系统实机验证。

2026-09-28，在 Linux amd64 上使用当时的西南二区 API 和模板验证：静态二进制启动、创建/连接沙箱、创建环境变量传递、默认 `/root`、非交互命令及退出码 7、PTY 输入输出、Ctrl-] 分离和同 PID 重连、重连时窗口从 24×80 同步到 40×100、命令模式，以及退出删除测试沙箱（重新连接返回 404）。Linux arm64 尚未在目标机器实测，macOS arm64 已验证 `--help` 启动，未实测连接沙箱。
