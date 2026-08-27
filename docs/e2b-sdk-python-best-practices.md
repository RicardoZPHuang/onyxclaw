# E2B Python SDK：管理面与数据面最佳实践

实现位于 [e2b_sdk_best_practices.py](../deploy/huaweicloud-cce/e2b_sdk_best_practices.py)。它是可 import 的轻量封装，不绑定 OpenClaw 或 LTS。

## 配置

```bash
export E2B_API_URL='https://<control-plane-host>'
export E2B_SANDBOX_URL='https://<agent-gateway-data-plane-host>'
export E2B_API_KEY='<secret>'

# 可选：显式代理、超时和附加数据面头
export E2B_PROXY='http://proxy.example.internal:8080'
export E2B_REQUEST_TIMEOUT_SECONDS='30'
export E2B_DATA_HEADERS_JSON='{"X-Trace-Source":"integration-test"}'
```

`E2B_API_URL` 和 `E2B_API_KEY` 用于管理面；`E2B_SANDBOX_URL` 用于 EnvD 数据面。后者必须是当前 Agent Gateway 的数据面地址，不能误填控制面地址或旧网关地址。

## 基础用法

```python
import sys
sys.path.insert(0, "deploy/huaweicloud-cce")
from e2b_sdk_best_practices import E2BClient, E2BConfig

client = E2BClient(E2BConfig.from_env())
sandbox = client.create("<template-id>")
try:
    command = client.run_process(sandbox, "id; pwd", user="node")
    print(command.exit_code, command.stdout)

    client.write_file(sandbox, "/tmp/example.txt", "hello\n", user="node")
    assert client.read_file(sandbox, "/tmp/example.txt", user="node") == "hello\n"
finally:
    client.delete(sandbox)
```

`SandboxHandle.data` 是已完成数据面路由的原始 SDK `Sandbox` 对象。除 `run_process`、`write_file`、`read_file` 外，调用方可通过 `client.envd(sandbox)` 获取它并使用版本特定的其他 EnvD API。

## 暂停与恢复

```python
sandbox = client.create("<template-id>")
try:
    client.pause(sandbox)
    client.resume(sandbox)

    # 恢复后仍使用 create 时返回的 sandbox handle 执行数据面操作。
    result = client.run_process(sandbox, "printf 'resumed\\n'")
finally:
    client.delete(sandbox)
```

部分兼容网关中，`Sandbox.connect()` 的响应缺少完整的 EnvD 路由信息。`resume()` 会触发管理面恢复，但它不会替换 `SandboxHandle.data`；后续 EnvD 文件和进程请求仍保留 create 时的 sandbox ID、EnvD 端口、`X-Access-Token` 和 `E2B-Traffic-Access-Token`。

## 管理面 API

```python
info = client.get("<sandbox-id>")
all_sandboxes = client.list(limit=100)
client.pause(sandbox_handle)
client.resume(sandbox_handle)
client.delete(sandbox_handle)
```

`delete("<sandbox-id>")` 可用于没有原始 handle 的场景；已持有 handle 时优先传入 handle。

## 自由装配操作

```python
from e2b_sdk_best_practices import Workflow, create_operation

flow = Workflow(client)
flow.add("sandbox", create_operation("<template-id>"))
flow.add("pause", lambda ctx: ctx.client.pause(ctx.require("sandbox")))
flow.add("resume", lambda ctx: ctx.client.resume(ctx.require("sandbox")))
flow.add("health", lambda ctx: ctx.client.run_process(ctx.require("sandbox"), "id"))

context = flow.run()
print(context.require("health").stdout)
client.delete(context.require("sandbox"))
```

操作只是接收 `WorkflowContext` 的普通函数，因此可自由加入元数据、SFS、业务配置写入、健康检查或自定义 EnvD 调用。

## 请求头与安全

数据面请求由模块统一保留 SDK 创建时产生的路由头，例如 `E2b-Sandbox-Id`、`E2b-Sandbox-Port` 和 `X-Access-Token`；如存在 traffic access token，还会添加 `E2B-Traffic-Access-Token`。`E2B_DATA_HEADERS_JSON` 只能追加头，不能覆盖上述 SDK 路由头。

`config.safe_summary()` 仅输出端点、代理是否配置和自定义头名称，不输出 API Key 或令牌。日志、异常上报也不应记录这些敏感值。
