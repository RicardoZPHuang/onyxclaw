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

### 3. 在 Chrome 中安装并配置 ModHeader

从 Chrome 网上应用店安装 **ModHeader** 扩展。新建一个只对 Agent Gateway 地址生效的配置，增加以下三个请求头：

| Header | Value |
| --- | --- |
| `E2b-Sandbox-Id` | 创建成功后得到的 Sandbox ID |
| `E2b-Sandbox-Port` | `3080` |
| `E2B-Traffic-Access-Token` | 创建成功响应中的 `traffic_access_token` |

请确认三项 header 都已启用，并将 ModHeader 的 URL filter 限定到当前 Agent Gateway 域名，避免把 Sandbox 凭据发送到其他网站。

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

需要了解镜像内部实现或在其他机器上重新构建时，参阅[镜像实现说明](./DEEPSEEK_HARNESS_AGENTSPHERE_IMAGE.md)。
