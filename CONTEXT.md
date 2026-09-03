# OnyxClaw 聊天交付

本文界定从 APP 聊天请求，到 OnyxClaw Channel 投递 OpenClaw 回复之间的链路。它定义了保证“请求与回复正确对应”所需的发布单元和身份标识。

## 术语

**聊天交付（Chat Delivery）**：
将一个 APP 入站事件与其对应的 Channel 出站回复关联起来的端到端交换。
_避免使用_：聊天超时、模型回复

**APP 发布镜像（APP Release Image）**：
包含 HTTP Controller、WebSocket Simulator 和浏览器 UI 的 OnyxClaw APP 镜像。
_避免使用_：Channel 镜像、Sandbox 镜像

**稳定 APP v19（Stable APP v19）**：
从已保留的 v19 构建上下文重建的 APP 稳定基线；后续 APP 修复必须以它为父镜像或显式说明替代关系。
_避免使用_：最新源码、隐式 APP 基线

**Channel 模板镜像（Channel Template Image）**：
由 AgentSphere Template 选用、运行 OnyxClaw Channel 和 OpenClaw Runtime 的 Sandbox 镜像。
_避免使用_：APP 镜像、在线热修复

**干净 AgentSphere OpenClaw 基础镜像（Clean AgentSphere OpenClaw Base Image）**：
只包含 OpenClaw Gateway、envd、健康检查和默认运行目录的 Sandbox 镜像；不包含 OnyxClaw Channel。
_避免使用_：Channel 成品、Template 配置

**完整 Channel 构建（Full Channel Build）**：
以干净 AgentSphere OpenClaw 基础镜像为父镜像，安装并启用完整 OnyxClaw Channel 插件的构建过程。
_避免使用_：只覆盖单个插件文件、运行时在线安装

**发布账号（Release Account）**：
拥有 Template、镜像仓库权限，以及用于发布验证的 Sandbox 资源的云账号。
_避免使用_：共享环境、生产账号

**回复关联键（Reply Correlation Key）**：
由实例 ID 与入站事件 ID 组成的复合标识；出站回复通过 `inReplyTo` 引用该入站事件 ID。
_避免使用_：下一条出站消息、FIFO 回复

**受支持的云部署（Supported Cloud Deployment）**：
唯一受支持的云端运行组合：Huawei Cloud CCE 承载 APP，AgentSphere 提供 Sandbox；每个发布账号管理自己的 Template 与运行资源。
_避免使用_：多云部署、默认云 Provider

**开发机构建（Development-machine Build）**：
在 `demo-cn-south1` 上基于已核验的不可变基线镜像构建最小增量候选镜像的过程。
_避免使用_：自动发布、CI 发布

**人工发布（Manual Release）**：
由发布负责人显式执行镜像 push、CCE rollout 和 Template 创建/替换的受控步骤；构建成功本身不构成发布。
_避免使用_：自动 rollout、隐式部署

**当前规范（Current Specification）**：
描述 OnyxClaw 当前支持边界、长期约束或架构决定的唯一文档；若与实现行为冲突，以相关代码和回归测试为准。
_避免使用_：方案草稿、一次性验收记录

**当前指南（Current Guide）**：
针对已支持流程的可执行说明，明确其前提、范围和安全边界。
_避免使用_：历史调查、未来提案

**历史证据（Historical Evidence）**：
用于解释已发生故障和决策的脱敏结论与时间线；不作为当前部署或操作依据。
_避免使用_：当前规范、运行手册
