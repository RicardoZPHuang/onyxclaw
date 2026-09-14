# Huawei Cloud AgentSphere OpenClaw Sandbox

本目录用于配套 Huawei Cloud AgentSphere E2B-compatible Sandbox，包含：

- 连接已有 Sandbox 并打开交互终端的 `e2b_interactive_tty.py`；
- 通过相邻的 `../huaweicloud-agentsphere-deepseek-harness/` 目录刷新并输出 traffic access token；
- 已推送镜像的可复现 Dockerfile、entrypoint 和最小 OpenClaw 配置；
- 进入 Sandbox 后配置 OpenClaw 模型，以及通过 `18789` 访问基础 API 的方法。

## 已验证版本

已推送镜像：

```text
swr.cn-south-1.myhuaweicloud.com/demo-test/openclaw:2026.5.28-envd-http-v1
```

镜像摘要：

```text
sha256:587094700d6921e15b8876da4359c9a469800b34f159c0cc5166bd7776e7c2de
```

该镜像基于开源 **OpenClaw 2026.5.28**。Dockerfile 将下面的镜像摘要作为基础镜像，避免上游 tag 漂移：

```text
swr.cn-north-4.myhuaweicloud.com/ddn-k8s/ghcr.io/openclaw/openclaw@sha256:6212bdac7b9e558bdba7c967e69e4fcea21f0a014b5d8c1e9b8d29fc965a9129
```

相对上游 OpenClaw 镜像，本镜像增加了：

1. `/usr/bin/envd`，以 root 用户运行并监听 `49983`，供 E2B Files、Commands 和 PTY 使用；
2. envd `/health` 健康检查，并使用 `-no-cgroups` 适配 Sandbox 环境；
3. `/home/node/.openclaw/openclaw.json` 的最小初始配置；
4. OpenClaw Gateway 自动监听 `0.0.0.0:18789`；
5. 默认开启 `/v1/models`、`/v1/chat/completions` 和 `/v1/responses` 所需的 HTTP surface；
6. `--allow-unconfigured` 启动方式，使未配置大模型时 Gateway、UI 和基础 API 仍能启动；
7. 每个 Sandbox 独立生成 Gateway token，文件位于 `/home/node/.openclaw/gateway-token`；
8. envd 保持 root 权限，OpenClaw Gateway 使用 `node` 用户运行。

最小配置不包含任何模型 API key，也不包含固定的 Gateway token。未配置大模型时，`18789` 和 `/v1/models` 可用，但对话或 Responses 请求会因没有可用的 Provider 凭据而失败。

## 本地准备

本工具固定使用 `e2b==2.34.0`，该版本要求 Python 3.10 或更高版本：

```bash
cd deploy/huaweicloud-agentsphere-openclaw
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
```

Huawei Cloud EulerOS 2.0 节点的系统 Python 3.9 无法安装 E2B 2.34.0。不要直接替换系统 Python；可使用 Python 3.10+ venv，或者在 Python 3.11 容器中运行脚本。节点 `/home/hzp/backup` 已准备：

```text
Docker image: e2b-sdk-tools:2.34.0
Interactive launcher: /home/hzp/backup/e2b-interactive-2.34.0.sh
Token launcher: /home/hzp/backup/e2b-get-traffic-token-2.34.0.sh
```

节点上使用新版 SDK：

```bash
cd /home/hzp/backup
export E2B_API_KEY='<your-e2b-api-key>'
./e2b-interactive-2.34.0.sh '<sandbox-id>' '<sandbox-url>'
```

包装脚本会把 API URL、Sandbox URL、Sandbox ID 和 API key 环境变量传入隔离容器，但不会将凭据写入镜像。控制面默认使用华南区域地址：

```text
E2B API URL: https://agentsphere.cn-south-1.myhuaweicloud.com
```

固定 Agent Gateway URL 通过第二个位置参数传入，也可以提前设置 `E2B_SANDBOX_URL`。控制面地址可通过 `--api-url` 或 `E2B_API_URL` 覆盖。

## 连接已有 Sandbox

脚本只负责连接已经存在的 Sandbox。先把 API key 放到环境变量，然后传入 Sandbox ID 和固定 Agent Gateway URL：

```bash
export E2B_API_KEY='<your-e2b-api-key>'
python e2b_interactive_tty.py \
  '<sandbox-id>' \
  'https://<agent-gateway-host>'
```

`--cwd` 的默认值已经改为 `/root`，默认用户也是 `root`，所以日常进入 Sandbox 不需要再填写：

```text
--user root --cwd /root
```

也可以把两个位置参数放入环境变量，此时命令不再需要参数：

```bash
export E2B_SANDBOX_ID='<sandbox-id>'
export E2B_SANDBOX_URL='https://<agent-gateway-host>'
python e2b_interactive_tty.py
```

节点上的容器包装脚本使用相同参数：

```bash
cd /home/hzp/backup
./e2b-interactive-2.34.0.sh '<sandbox-id>' 'https://<agent-gateway-host>'
```

常用高级选项：

```text
--cwd /path                 覆盖默认工作目录 /root
--user <user>               覆盖默认用户 root
--command-mode              使用 Commands.run 代替 PTY API
--kill-on-exit              退出脚本时删除 Sandbox
--session-retries 5         Session not found 的重试次数
--session-retry-interval 2  两次重试间隔，单位为秒
--api-url <url>             覆盖 AgentSphere 控制面地址
```

脚本执行 `Sandbox.connect()` 获取最新路由凭据，用返回的 `traffic_access_token`、Sandbox ID 和 envd 端口重建固定 Agent Gateway 数据面连接，再创建新的 PTY。不会打印 API key、traffic token 或完整路由 headers。

在交互终端按 `Ctrl-]` 会关闭当前远程 shell，但不会删除 Sandbox。下次用同一个 Sandbox ID 连接时会再次刷新路由凭据并打开新 PTY。

## 单独获取 traffic access token

需要从浏览器代理、curl 或其他程序访问 Sandbox 端口时，可以只刷新 traffic access token：

```bash
export E2B_API_KEY='<your-e2b-api-key>'
python ../huaweicloud-agentsphere-deepseek-harness/get_traffic_access_token.py '<sandbox-id>'
```

脚本只向 stdout 输出 token，适合直接赋值：

```bash
TRAFFIC_ACCESS_TOKEN="$(python ../huaweicloud-agentsphere-deepseek-harness/get_traffic_access_token.py '<sandbox-id>')"
```

节点上使用配套包装脚本：

```bash
cd /home/hzp/backup
./e2b-get-traffic-token-2.34.0.sh '<sandbox-id>'
```

该 token 属于敏感的短期数据面凭据，不要写入仓库、文档或 shell 脚本。若不希望它进入 shell history，使用上面的命令替换形式并及时 `unset TRAFFIC_ACCESS_TOKEN`。

## 在 Sandbox 中配置 OpenClaw

envd 默认打开的终端用户是 `root`，OpenClaw Gateway 则使用 `node` 用户。因此配置必须以 `node` 用户写入 `/home/node/.openclaw/openclaw.json`，不要误写到 `/root/.openclaw`。

进入 Sandbox 后执行：

```bash
su -s /bin/bash node
export HOME=/home/node
cd /home/node
node /app/openclaw.mjs configure --section model
```

按照 OpenClaw 提示配置模型 Provider、API key 和默认模型。完成后检查：

```bash
node /app/openclaw.mjs config validate
node /app/openclaw.mjs models list
```

Gateway 会监控 `openclaw.json` 并加载有效配置；正常情况下无需重新创建 Sandbox。若要退出 `node` 用户 shell：

```bash
exit
```

## 在 Sandbox 内验证 18789 API

Gateway token 默认保存在：

```text
/home/node/.openclaw/gateway-token
```

在 Sandbox 内验证模型入口：

```bash
OPENCLAW_TEST_TOKEN="$(cat /home/node/.openclaw/gateway-token)"

curl -sS http://127.0.0.1:18789/v1/models \
  -H "Authorization: Bearer ${OPENCLAW_TEST_TOKEN}"
```

`/v1/models` 返回的是 OpenClaw Agent 入口，例如 `openclaw/default`，不是底层 Provider 的完整模型目录。

完成模型配置后可验证对话：

```bash
curl -sS http://127.0.0.1:18789/v1/chat/completions \
  -H "Authorization: Bearer ${OPENCLAW_TEST_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "openclaw/default",
    "messages": [
      {"role": "user", "content": "你好，请介绍一下自己"}
    ]
  }'
```

## 通过 AgentGateway 访问 18789

AgentGateway 是固定域名时，Sandbox ID 不在 hostname 中，因此请求必须同时携带路由信息、Sandbox 数据面凭据和 OpenClaw Gateway 凭据：

```bash
curl -sS \
  'https://agent-gateway-sandbox3-geywmobqmy.agentgateway.cn-south-1.huaweicloud-agentnetwork.com/v1/models' \
  -H 'E2b-Sandbox-Id: <sandbox-id>' \
  -H 'E2b-Sandbox-Port: 18789' \
  -H 'E2B-Traffic-Access-Token: <traffic-access-token>' \
  -H 'Authorization: Bearer <openclaw-gateway-token>'
```

其中：

- E2B API key 只用于 create、connect、kill 等控制面调用；
- `traffic_access_token` 来自 create/connect 响应，用于 AgentGateway 数据面；
- OpenClaw Gateway token 用于 `18789` 上的 OpenClaw 鉴权；
- 启动初期 `18789` 可能尚未监听，调用端应对 `502/503/504/524` 做短间隔重试。

固定 AgentGateway 访问普通浏览器 UI 时，浏览器无法直接给页面和 WebSocket 注入上述路由 header。外部 UI 场景需要反向代理注入这些 header，并在 `gateway.controlUi.allowedOrigins` 中加入代理 Origin；API 客户端则可以直接按上面的 header 调用。

## 重新构建镜像

`envd` 是平台运行时二进制，不提交到 Git。构建前将对应二进制放入 `image/`：

```bash
cd deploy/huaweicloud-agentsphere-openclaw/image
cp /path/to/envd ./envd
chmod 0755 ./envd
sha256sum ./envd
```

本次已验证 envd 的 SHA-256 为：

```text
1eeeb02bccd26bce526fbb3d7db7ba1472354a81d512815a2995f4b7deb9d4af
```

构建：

```bash
docker build \
  -t swr.cn-south-1.myhuaweicloud.com/demo-test/openclaw:2026.5.28-envd-http-v1 \
  .
```

推送：

```bash
docker push \
  swr.cn-south-1.myhuaweicloud.com/demo-test/openclaw:2026.5.28-envd-http-v1
```

使用该镜像在 AgentSphere 创建 Template 和 Sandbox 后，再通过本目录的 `e2b_interactive_tty.py` 连接 Sandbox 并完成 OpenClaw 模型配置。
