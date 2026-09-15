# Huawei Cloud AgentSphere DeepSeek Harness

本目录记录 DeepSeek Harness + envd 镜像在 Huawei Cloud AgentSphere 上的部署和访问方式。按照下面五步即可从公开镜像创建 Sandbox，并在 Chrome 中打开 DeepSeek Harness。

公开镜像：

```text
swr.cn-south-1.myhuaweicloud.com/demo-test/deepseek-harness-envd:20260913-v4
```

端口用途：

| 端口 | 用途 |
| --- | --- |
| `49983` | AgentSphere Template 健康检查使用的 envd 端口 |
| `3080` | 浏览器访问 DeepSeek Harness UI 的反向代理端口 |
| `3079` | 容器内部 DSH 端口，不直接通过 Agent Gateway 访问 |

## AgentSphere 操作流程

### 1. 创建 Template

登录 Huawei Cloud AgentSphere 控制台并创建 Template，按以下参数配置：

| 配置项 | 值 |
| --- | --- |
| 容器镜像 | `swr.cn-south-1.myhuaweicloud.com/demo-test/deepseek-harness-envd:20260913-v4` |
| CPU | `2U` |
| 内存 | `8 GiB` |
| 出站网关 | 纯公网 |
| 存储挂载 | 不配置 |
| Sandbox 超时时间 | `1h` |
| 健康检查端口 | `49983` |

镜像已经包含默认 `ENTRYPOINT`，不要覆盖启动命令。健康检查使用 envd 的 `49983` 端口；DeepSeek Harness UI 的对外代理端口是 `3080`。

如果需要给 DeepSeek Harness UI 增加一层用户名密码，可以在创建 Template 时增加以下两个环境变量，也可以在创建 Sandbox 时增加：

```text
PROXY_USERNAME=<your-user>
PROXY_PASSWORD=<your-password>
```

两个变量必须同时配置才会启用 Basic Auth。都不配置时 UI 不要求登录，而且不存在默认密码。只配置其中一个变量也不会启用认证。

### 2. 创建 Sandbox 并从响应获取 traffic access token

使用 Template 创建 Sandbox 前，先在 Chrome 中按 `F12` 打开开发者工具并切换到 **Network** 面板。建议启用 **Preserve log**，以免页面跳转后创建请求消失。

然后在 AgentSphere 控制台中使用刚才的 Template 创建 Sandbox：

1. 保持 Network 面板打开；
2. 发起创建 Sandbox；
3. 等待控制台显示创建成功；
4. 在 Network 的 Fetch/XHR 请求中找到创建 Sandbox 成功的请求；
5. 打开该请求的 Response，记录 Sandbox ID 和响应中的 `traffic_access_token`。

`traffic_access_token` 是访问 Agent Gateway 数据面的凭据。每次创建或重新连接 Sandbox 后都应使用当前响应中的值，不要把旧 Sandbox 的 token 复用到新 Sandbox。

如果没有从浏览器 Network 面板保存 token，也可以通过本目录的脚本重新获取，参见后面的“traffic access token 工具”章节。

### 3. 配置 Chrome 请求头扩展

Windows Chrome 建议使用本目录提供的 [AgentSphere Gateway Headers 专用扩展](./chrome-agentgateway-headers/README.md)。它使用 Manifest V3 `declarativeNetRequest`，明确覆盖 `websocket` 资源类型，可以同时给页面、API 和 `/api/remote.mux` WebSocket 握手增加三项 header。

安装步骤：

1. 把 `chrome-agentgateway-headers` 文件夹复制到 Windows；
2. 打开 `chrome://extensions/` 并启用“开发者模式”；
3. 点击“加载已解压的扩展程序”，选择该文件夹；
4. 打开扩展，填写 Gateway URL、Sandbox ID、端口 `3080` 和 traffic access token；
5. 点击“保存并启用”，确认扩展图标显示 `ON`；
6. 暂停 ModHeader 中针对同一 Gateway 的旧配置，避免两个扩展争用同名 header。

也可以继续使用确认能修改 WebSocket 握手的 header 工具。需要增加的请求头为：

从 Chrome 网上应用店安装 **ModHeader** 扩展。新建一个只对 Agent Gateway 地址生效的配置，增加以下三个请求头：

| Header | Value |
| --- | --- |
| `E2b-Sandbox-Id` | 创建成功后得到的 Sandbox ID |
| `E2b-Sandbox-Port` | `3080` |
| `E2B-Traffic-Access-Token` | 创建成功响应中的 `traffic_access_token` |

请确认三项 header 对 HTTPS 和 WSS 请求都生效。只匹配 `https://` 的 URL filter 可能漏掉 `wss://.../api/remote.mux`，表现为页面和静态资源能打开，但模型列表一直加载。

### 4. 访问 DeepSeek Harness

保持 ModHeader 配置启用，直接在 Chrome 中访问 AgentSphere 提供的固定 Agent Gateway HTTPS 地址。例如本次联调使用过：

```text
https://agent-gateway-90is-gztggnjthe.agentgateway.cn-south-1.huaweicloud-agentnetwork.com
```

实际环境应以 AgentSphere 控制台提供的网关地址为准。Sandbox ID 和端口通过 header 传递，不要使用 `port-sandbox-id` 拼接域名的形式。

如果 Template 或 Sandbox 配置了 `PROXY_USERNAME` 和 `PROXY_PASSWORD`，浏览器会先显示 Basic Auth 登录框，输入相应用户名和密码即可。没有配置这两个变量时会直接进入 DeepSeek Harness。

如果页面打开失败，优先检查：

1. Sandbox 状态是否仍为运行中，`1h` 超时是否已经到期；
2. ModHeader 是否对正确的 Agent Gateway 域名生效；
3. `E2b-Sandbox-Port` 是否为 UI 端口 `3080`，而不是健康检查端口 `49983` 或内部 DSH 端口 `3079`；
4. Sandbox ID 和 traffic access token 是否来自同一次创建或最近一次 connect 响应；
5. 三个 header 的名称和值是否包含多余空格。
6. Network 的 WS 分类中 `/api/remote.mux` 是否返回 `101`；如果返回 `Session not found`，检查 WebSocket 握手是否携带三项 header。

### 模型列表持续加载或 `remote.mux` 反复重连

三个 AgentSphere 路由 header 都存在，只能证明网关已经把请求路由到目标 Sandbox。DSH 自身还有一层 `dsh-auth-*` 会话认证：浏览器首次打开 `/` 时，代理用 launch token 换取该会话，后续 HTTP API 和 `/api/remote.mux` WebSocket 都必须携带它。

在 Chrome DevTools 中按下面顺序检查：

1. 在 Network 的 WS 分类中打开 `/api/remote.mux`，确认握手状态是 `101 Switching Protocols`。WebSocket 成功握手本来就没有普通 HTTP Response Body，应在 Messages/Frames 中看到包含 `ready` 的消息。
2. 查看该握手的 Request Headers，确认三项 AgentSphere header 都存在，并检查浏览器是否同时发送了名称以 `dsh-auth-` 开头的 Cookie。
3. 在 Application -> Storage -> Cookies 中检查当前 Gateway 域名下是否存在 `dsh-auth-*`。如果没有或疑似来自旧 Sandbox，关闭该 Gateway 的全部标签页，清除该域名的站点数据，再从 `/` 重新进入一次。
4. 如果握手返回 `500`，响应类似 `[node-proxy] Failed to handle WebSocket: webSocket handshake failed`，而三项路由 header 均存在，通常就是 DSH 会话 Cookie 缺失或失效。

`20260913-v4` 依赖浏览器保存并回传这枚 Cookie。节点上已构建 `20260915-v5` 修订版：它在容器内缓存 launch-token 交换得到的 DSH 会话，并自动注入所有上游 HTTP 和 WebSocket 请求。推送该标签并更新 Template 后，浏览器仍需提供三项 AgentSphere 路由 header，但不再承担 DSH Cookie 的传递。

### 5. 配置 DeepSeek 模型密钥

首次进入 DeepSeek Harness 后，需要在设置界面配置 DeepSeek 模型凭据：

1. 打开 DeepSeek Harness 的设置页面；
2. 进入模型或 Provider 配置；
3. 选择 DeepSeek；
4. 填入 DeepSeek API key，并按需要选择默认模型；
5. 保存后确认模型列表完成加载，再创建会话进行对话验证。

DeepSeek API key 与 AgentSphere 的 traffic access token、可选的 UI Basic Auth 是三套独立凭据。当前 Template 不配置存储挂载，因此配置和工作区文件只存在于当前 Sandbox 的可写层；删除 Sandbox 后需要在新 Sandbox 中重新配置，或者在后续方案中显式增加持久化机制。

## traffic access token 工具

如果创建 Sandbox 时没有从 F12 Network 面板保存 token，可以使用 `Sandbox.connect()` 刷新并输出当前 Sandbox 的 traffic access token。

本地运行要求 Python 3.10 或更高版本：

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
export E2B_API_KEY='<your-e2b-api-key>'
python get_traffic_access_token.py '<sandbox-id>'
```

只需要临时环境变量时：

```bash
TRAFFIC_ACCESS_TOKEN="$(python get_traffic_access_token.py '<sandbox-id>')"
```

节点上使用已经准备好的 E2B 2.34.0 工具镜像：

```bash
cd /home/hzp/backup
export E2B_API_KEY='<your-e2b-api-key>'
./e2b-get-traffic-token-2.34.0.sh '<sandbox-id>'
```

工具只向 stdout 输出 token。API key 和 traffic access token 都不能提交到代码仓库。

## 目录内容

- `DEEPSEEK_HARNESS_AGENTSPHERE_IMAGE.md`：镜像结构、DSH 社区版修改、反向代理、目录规划、构建产物和验证记录；
- `get_traffic_access_token.py`：刷新并输出指定 Sandbox 的 traffic access token；
- `e2b-get-traffic-token-2.34.0.sh`：使用 `e2b-sdk-tools:2.34.0` 运行 token 工具；
- `requirements.txt`：本地运行 Python 工具所需的 E2B SDK 版本。
- `chrome-agentgateway-headers/`：Windows Chrome 专用的 Agent Gateway HTTP + WebSocket header 扩展；

需要了解镜像内部实现或在其他机器上重新构建时，参阅[镜像实现说明](./DEEPSEEK_HARNESS_AGENTSPHERE_IMAGE.md)。
