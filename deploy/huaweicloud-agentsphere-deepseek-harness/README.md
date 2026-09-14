# Huawei Cloud AgentSphere DeepSeek Harness

本目录记录 DeepSeek Harness + envd 镜像在 Huawei Cloud AgentSphere 上的部署、访问和维护方式。

公开镜像：

```text
swr.cn-south-1.myhuaweicloud.com/demo-test/deepseek-harness-envd:20260913-v4
```

目录内容：

- `DEEPSEEK_HARNESS_AGENTSPHERE_IMAGE.md`：镜像结构、社区版修改、目录规划、构建验证和 AgentSphere 控制台操作说明；
- `get_traffic_access_token.py`：通过 `Sandbox.connect()` 刷新并输出指定 Sandbox 的 traffic access token；
- `e2b-get-traffic-token-2.34.0.sh`：使用节点 `e2b-sdk-tools:2.34.0` 镜像运行 token 工具；
- `requirements.txt`：本地运行 Python 工具所需的 E2B SDK 版本。

AgentSphere 部署时使用 `49983` 作为健康检查端口，使用 `3080` 访问 DeepSeek Harness UI。完整步骤见[镜像与部署说明](./DEEPSEEK_HARNESS_AGENTSPHERE_IMAGE.md#10-agentsphere-控制台部署与浏览器访问)。

本地获取 traffic access token：

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
export E2B_API_KEY='<your-e2b-api-key>'
python get_traffic_access_token.py '<sandbox-id>'
```

节点上使用包装脚本：

```bash
cd /home/hzp/backup
export E2B_API_KEY='<your-e2b-api-key>'
./e2b-get-traffic-token-2.34.0.sh '<sandbox-id>'
```

token 工具只向 stdout 输出 token，便于通过命令替换写入临时环境变量。API key 和 traffic access token 都不能提交到代码仓库。
