# Huawei Cloud AgentSphere DeepSeek Harness

本目录说明如何在 AgentSphere 创建 DeepSeek Harness 沙箱并访问 UI。当前镜像基于 v5，已移除镜像内的 envd 二进制及启动逻辑；平台的 envd/runtime 和网关认证由 AgentSphere 管理。

使用镜像：

```text
swr.cn-southwest-2.myhuaweicloud.com/demo-test1/deepseek-harness-envd:20261015-v5-no-envd
```

镜像仓库名仍包含 `envd`，该标签的应用镜像已不自带 envd。浏览器访问 3080 时仍需要平台返回的 `envdAccessToken`，填入 `x-access-token` 请求头。

| 端口 | 用途 |
| --- | --- |
| `3080` | DeepSeek Harness UI、HTTP API 和 WebSocket 的反向代理入口 |
| `3079` | DSH 内部端口，由容器内代理访问 |
| `49983` | 若平台提供 envd/runtime，由平台管理；不是本镜像的应用就绪检查端口 |

## AgentSphere 操作流程

### 1. 创建 Template

登录 AgentSphere 控制台并创建 Template：

| 配置项 | 值 |
| --- | --- |
| 容器镜像 | `swr.cn-southwest-2.myhuaweicloud.com/demo-test1/deepseek-harness-envd:20261015-v5-no-envd` |
| 启动命令 | `/app/start.sh` |
| CPU | `2U` |
| 内存 | `8 GiB` |
| 出站网关 | 纯公网 |
| 存储挂载 | 不配置 |
| Sandbox 超时时间 | `1h` |
| 就绪检查 | 命令检查，填写下方命令 |

启动命令配置为：

```sh
/app/start.sh
```

就绪检查命令配置为：

```sh
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3080 | grep -q "200" && echo "OK" || (echo "ERROR" && exit 1)
```

命令请求 3080 首页，返回 HTTP 200 时输出 `OK`；否则输出 `ERROR` 并退出 1。请在支持 shell 命令的就绪检查字段中配置，不能继续把本应用的就绪检查配置为 49983。

环境变量沿用之前的配置。需要 UI 用户名密码时，在 Template 或 Sandbox 中同时设置：

```text
PROXY_USERNAME=<your-user>
PROXY_PASSWORD=<your-password>
```

两者同时非空才启用 Basic Auth。不配置时没有默认用户名或默认密码；只配置其中一项也不会启用 Basic Auth。

**启用 Basic Auth 时，就绪检查也需要认证**，否则上述匿名请求会返回 401。保留用户名密码配置时，将命令中的 curl 改为带认证的版本：

```sh
curl -s -u "${PROXY_USERNAME}:${PROXY_PASSWORD}" -o /dev/null -w "%{http_code}" http://127.0.0.1:3080 | grep -q "200" && echo "OK" || (echo "ERROR" && exit 1)
```

其他已有 DSH/代理环境变量继续沿用，不需要增加 `ENVD_PORT` 或手工把访问 token 固化到镜像环境变量中。

### 2. 创建 Sandbox 并获取两种 access token

创建 Sandbox 前，在 Chrome 按 `F12` 打开开发者工具的 **Network** 面板，建议启用 **Preserve log**。然后：

1. 使用刚才的 Template 创建 Sandbox。
2. 在 Fetch/XHR 中找到创建成功的请求，打开 Response。
3. 记录 Sandbox ID、traffic access token 和 envd access token。

不同接口可能使用不同字段命名：

| 内容 | E2B API 字段 | 控制台响应也可能使用 |
| --- | --- | --- |
| 沙箱 ID | `sandboxID` | 控制台显示的 Sandbox ID |
| 网关 token | `trafficAccessToken` | `traffic_access_token` |
| runtime token | `envdAccessToken` | `envd_access_token` |

必须使用同一个 Sandbox 当前返回的两种 token。创建、连接或恢复后重新核对，不能沿用其他 Sandbox 的凭据。没有保存响应时，可以使用下方的 token 工具获取。

### 3. 配置 Chrome ModHeader

安装 **ModHeader** 扩展，创建只对当前 Agent Gateway 域名生效的配置，添加以下 **四个**请求头：

| Header | Value |
| --- | --- |
| `E2b-Sandbox-Id` | 当前 Sandbox ID |
| `E2b-Sandbox-Port` | `3080` |
| `E2B-Traffic-Access-Token` | `trafficAccessToken` / `traffic_access_token` |
| `x-access-token` | `envdAccessToken` / `envd_access_token` |

`x-access-token` 不能填写 traffic token、E2B API key 或 DeepSeek API key。虽然应用镜像没有 envd，这个部署的网关访问链路仍需要平台返回的 runtime token。

四项 Header 必须对 **HTTPS 和 WSS** 请求都生效。只匹配 `https://` 的扩展规则可能漏掉 `wss://.../api/remote.mux`，导致页面打开后模型一直加载。

### 4. 访问 DeepSeek Harness

启用 ModHeader，直接访问 AgentSphere 提供的固定 Agent Gateway HTTPS 地址。

```text
https://<当前 Sandbox 对应的 Agent Gateway 域名>
```

以控制台提供的地址为准。Sandbox ID 和端口通过 Header 传递，不使用 `port-sandbox-id` 拼接域名。

如果配置了 `PROXY_USERNAME` 和 `PROXY_PASSWORD`，输入对应的 Basic Auth 用户名和密码；未配置时直接进入 UI。

排查顺序：

1. Sandbox 是否运行、是否已经达到 `1h` 超时。
2. `/app/start.sh` 是否正确配置；3080 的就绪检查是否输出 `OK`。
3. ModHeader 是否作用于当前网关域名，以及 HTTPS/WSS 两种请求。
4. 端口是否是 `3080`，四项 Header 是否齐全、无多余空格、属于同一 Sandbox。
5. 返回 `invalid access token` 时，检查 `x-access-token` 是否填写当前的 **envdAccessToken**，而非 traffic token；若仍不匹配，再检查平台 runtime 初始化状态。

### 模型列表持续加载或 remote.mux 重连

v5 代理保留了 DSH 会话复用：代理从 launch token 换取 `dsh-auth-*` 会话，并在容器内部为 HTTP/WebSocket 注入 Cookie。浏览器仍需携带上述四项网关 Header。

在 Network 的 WS 分类中检查 `/api/remote.mux`：

1. 正常握手应是 `101 Switching Protocols`，Messages/Frames 中应能看到 `ready`。WebSocket 没有普通 HTTP Response Body 属于正常情况。
2. 查看 Request Headers，确认四项 Header 对 WSS 请求也生效。
3. 切换 Sandbox 后若显示旧模型或插件状态，关闭该网关全部标签页、清理站点数据，再从 `/` 进入。
4. 若握手只有“已完成”、没有状态码和 Frames，检查 Windows 代理、安全软件或扩展是否拦截升级请求；必要时用 `chrome://net-export/` 采集复现日志。
5. 若代理返回 502 或 WS 500，检查 DSH 和代理进程及其日志。正常访问仍依赖 WebSocket。

### 5. 配置 DeepSeek 模型密钥

进入 DSH 设置的模型/Provider 页面，选择 DeepSeek，填写 DeepSeek API key，保存并选择默认模型。模型列表加载完成后创建会话验证对话。

DeepSeek API key、traffic access token、envd access token，以及可选 Basic Auth 是不同凭据。默认不挂载存储，配置和工作区文件位于当前 Sandbox 的可写层；需要长期保留时另行配置持久化。

## 同时获取 traffic / envd access token

脚本文件名仍是 `get_traffic_access_token.py`，现在默认输出包含两种 token 的 JSON。脚本直接请求控制面的 `POST /sandboxes/{id}/connect`，使用 Python 3.9+ 标准库，**无需安装 E2B SDK**，也不依赖响应中的 `envdVersion` 是否有值。connect 的续期、恢复行为由平台控制面决定，请求沿用旧 SDK 的 300 秒 timeout 参数。

### 本机运行

在本目录执行，以西南二区为例：

```bash
export E2B_API_KEY='<your-e2b-api-key>'
export E2B_API_URL='https://agentsphere.cn-southwest-2.myhuaweicloud.com'
python3 get_traffic_access_token.py '<sandbox-id>'
```

输出格式：

```json
{
  "sandboxID": "<sandbox-id>",
  "trafficAccessToken": "<traffic-access-token>",
  "envdAccessToken": "<envd-access-token>"
}
```

将两种 token 分别填入 ModHeader 对应的 Header。默认 JSON 输出需要两者均存在；缺少任意一个时退出 1 并说明缺少的字段，不会把不完整凭据当作成功结果。

兼容旧的单 token 用法：

```bash
TRAFFIC_ACCESS_TOKEN="$(python3 get_traffic_access_token.py '<sandbox-id>' --format traffic)"
ENVD_ACCESS_TOKEN="$(python3 get_traffic_access_token.py '<sandbox-id>' --format envd)"
```

以上两行分别发起一次 connect；日常配置四个 Header 时优先一次获取 JSON，使用同一次响应中的两种 token。

PowerShell 中：

```powershell
$env:E2B_API_KEY = '<your-e2b-api-key>'
$env:E2B_API_URL = 'https://agentsphere.cn-southwest-2.myhuaweicloud.com'
$tokens = python .\get_traffic_access_token.py '<sandbox-id>' | ConvertFrom-Json
$tokens.trafficAccessToken
$tokens.envdAccessToken
```

可以通过 `E2B_SANDBOX_ID` 省略位置参数，通过 `--api-url` 覆盖 `E2B_API_URL`。为兼容既有调用，未设置 API URL 时仍默认华南一区 `https://agentsphere.cn-south-1.myhuaweicloud.com`；西南二区请显式设置如上的 URL。镜像仓库地址不是控制面 API 地址。

### 节点 Docker 包装脚本

将本目录最新的 `get_traffic_access_token.py` 和 `e2b-get-traffic-token-2.34.0.sh` 同步到节点同一目录。节点已有 `e2b-sdk-tools:2.34.0` 工具镜像时，可复用它运行更新后的标准库脚本：

```bash
cd /home/hzp/backup
export E2B_API_KEY='<your-e2b-api-key>'
export E2B_API_URL='https://agentsphere.cn-southwest-2.myhuaweicloud.com'
./e2b-get-traffic-token-2.34.0.sh '<sandbox-id>'
```

默认同样输出两个 token 的 JSON；需要旧格式时附加 `--format traffic`。包装脚本只读挂载旁边的 Python 文件，因此必须同时更新 Python 文件。

stdout 只输出选定的 JSON 或单 token，错误写到 stderr。不要把真实 API key 或两种 token 提交到仓库。

## 目录内容

- `README.md`：创建 Template、启动命令、就绪检查、四项 Header 和 token 工具用法。
- `DEEPSEEK_HARNESS_AGENTSPHERE_IMAGE.md`：当前无 envd 镜像与 v5 的关系、内部目录及代理修改。
- `get_traffic_access_token.py`：获取指定 Sandbox 的 traffic/envd token；默认 JSON，支持 `--format traffic|envd`。
- `e2b-get-traffic-token-2.34.0.sh`：复用节点工具镜像运行上述脚本。
- `requirements.txt`：说明 token 脚本无需第三方依赖。
- `test_get_traffic_access_token.py`：控制面请求、输出格式和错误处理测试。
