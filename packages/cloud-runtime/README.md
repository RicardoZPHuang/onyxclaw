# Cloud APP runtime

> 状态：**当前参考**。本文件说明云端 APP/BFF 的实现语义；行为冲突时，以本包代码和 `npm run test:cloud` 的回归测试为准。

该包承载云端 APP/BFF 的厂商适配与 OpenClaw 创建编排，不依赖本机 macOS Driver。

当前包含：

- `E2BCompatibleAdapter`：把当前选中的 Provider Registry 配置映射为统一的
  create/connect/pause/commands/files/kill 接口，并在 create 时合并 Provider 固定
  metadata 与实例 trace metadata；
- `OpenClawBootstrapSaga`：创建后立即签发一次性 Channel token 并把
  `openclaw.json` 写到最终路径；首次确认时只写 `SOUL.md`；恢复时先重新签发 Channel
  token、重写非持久化 `openclaw.json` 以启动 OpenClaw，再读取 SFS 挂载目录中的
  `workspace/SOUL.md` 并展示给用户确认；确认后写回 SOUL 并等待 Gateway 和 Channel 就绪；
- 分阶段错误、Secret 脱敏和失败补偿清理；
- `config/providers.huaweicloud-agentsphere.example.json`：Huawei AgentSphere 私网配置示例。

运行云端单元测试：

```bash
npm run test:cloud
```

`E2BCompatibleAdapter` 通过 `clientFactory` 接收底层 E2B Client，使业务编排不绑定 SDK
或具体云厂商。失败调用会向 stderr 输出脱敏后的 JSON 日志，包括 Provider、API、
阶段、异常类型、状态码和云端 request ID；同一份安全错误摘要也会显示在观测面板中。
运行时 Client Bridge 通过标准 E2B-compatible 接口访问 AgentSphere，并由 Adapter 统一封装
SDK 调用。真实 API Key 只从 Provider Registry 的环境变量映射进入，不能写入 JSON 配置、
浏览器状态或日志。

APP 为每个 Sandbox 生成独立的配置对象，直接写入
`${homeDir}/.openclaw/openclaw.json`。workspace 路径来自 Provider Profile，可以通过
Sandbox metadata 挂载到持久存储。所有 E2B-compatible Provider 在 pause 后都保留 Node
wrapper。恢复时只调用一次 `Sandbox.connect(sandbox_id)`，并使用其返回的新 Sandbox
对象替换 Python claimed/routed 缓存，以刷新恢复后 Gateway data session 对应的 domain、
traffic token 和 envd token；后续 Files、Commands 和 kill 使用刷新后的缓存，不再隐式 connect。进程重启
导致缓存丢失时，首次 `session_for()` 同样用 connect 返回值重新接管并建立本地缓存。

控制面与数据面鉴权严格分离：`create/connect/pause/kill` 只使用 E2B API Key；数据面
`traffic_access_token` 只注入该 Sandbox 的 envd Files、Commands 和健康检查请求。
固定 Agent Gateway URL 不包含标准 E2B Sandbox 子域名，因此 routed 数据面还会携带
`E2b-Sandbox-Id: <sandboxId>` 与 `E2b-Sandbox-Port: 49983`，确保 Gateway 的 session ID
与逻辑 Sandbox ID 一致。
恢复时会用 connect 响应刷新 E2B traffic/envd token；恢复 Gateway 时还会签发新的、一次性的
Channel bootstrap token。`create/pause/connect/kill` 均只调用一次对应 SDK 方法，
bridge 不包装控制面重试；若恢复失败，页面保持 `paused`，允许用户决定是否再次恢复。

恢复后 Agent Gateway 尚未识别 session 时，envd 可能短暂返回
`Session ID not found` 或 `Session not found`；bridge 会在 5 秒窗口内对这两种错误退避
重试。若配置写入仍因数据 session 未就绪而失败，Controller 保持已经恢复的 Sandbox 运行并
进入 `resume-data-pending`，页面再次点击只重试 `openclaw.json` 准备，成功后读取 SFS，且不重复
恢复或重新 pause。AgentSphere 有时把控制面 403 只放在
异常文本中；bridge 会原样脱敏上报该错误，不在本地自动重试。其他恢复 bootstrap 失败
不会执行首次创建场景的 kill 补偿，Controller 会尽量重新暂停 Sandbox。
