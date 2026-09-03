# Huawei AgentSphere 配置

> 状态：**当前指南**。本文只说明 Huawei CCE + AgentSphere 组合的非敏感配置结构；实际部署操作由 [onyxclaw-one-click](https://github.com/KianaBin/onyxclaw-one-click) 维护。

OnyxClaw 的云端运行时使用 Huawei AgentSphere 的 E2B-compatible 接口。可提交、可评审的
示例位于
[`config/providers.huaweicloud-agentsphere.example.json`](../config/providers.huaweicloud-agentsphere.example.json)，
环境变量名称见 [`.env.example`](../.env.example)。两者都只包含占位符，不能替代部署账号的
Secret 或真实资源配置。

## 配置与 Secret 的边界

| 类别 | 可以放入示例或受版本控制的配置 | 必须留在部署环境或 Secret Manager |
| --- | --- | --- |
| 控制面 | Provider ID、HTTPS Base URL 的占位符、兼容版本 | 真实控制面 endpoint 和 API Key |
| Sandbox | Template 占位符、超时、HOME/workspace 路径、能力声明 | 真实 Template、Sandbox、SFS 标识与运行时 token |
| Channel | WSS URL 的占位符、非敏感端口和协议选项 | signing secret、bootstrap/session token、connection ID |
| 模型 | 模型 Provider/名称的非敏感选择 | 模型 API Key 和私有 Base URL |

浏览器只能选择受信任部署环境已经加载的 Provider，不能提交任意 API URL、环境变量名或命令。

## 示例配置

将示例复制到部署环境提供的本地配置位置后，替换其中的占位符；不要提交复制出的文件或任何
真实值。启动时的非敏感选择如下：

```text
ONYXCLAW_PROVIDER_CONFIG=config/providers.huaweicloud-agentsphere.example.json
ONYXCLAW_PROVIDER=huaweicloud-agentsphere
```

真实的 API Key 只通过示例配置声明的环境变量名称传入。运行时不会把该值写入 JSON、浏览器
状态、错误摘要、报告或故障追踪器。

## 运行时校验

`ProviderRegistry` 在调用云 API 前执行 fail-fast 校验：

- 对外控制面和数据面地址必须为 HTTPS；仅 loopback mock 可使用 HTTP。
- 对外 Channel 地址必须为 WSS；仅 loopback mock 可使用 WS。
- HOME 与 workspace 必须是绝对路径；超时与 Gateway 端口必须为正整数。
- 配置引用的 Secret 环境变量必须完整存在，但错误输出只报告变量名，不输出值。
- 运行时只向浏览器暴露 Provider 标识、展示名称、协议和 capability flags。

建议先运行云端单元测试，再在部署账号的隔离环境中按 one-click 的流程验证创建、文件、命令、
Channel 与聊天链路。镜像构建与版本更新不在本文执行，见
[Huawei Cloud 镜像构建与更新方案](./huaweicloud-image-build-and-update.md)。
