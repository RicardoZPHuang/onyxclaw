# OnyxClaw

> 状态：**当前入口**。实现行为以代码与回归测试为准；本文只导航当前规范、当前指南和历史证据。

OnyxClaw 提供 OpenClaw Channel、APP/BFF 编排与本地验证工具。受支持的云端组合为
Huawei Cloud CCE 承载 APP、AgentSphere 提供 Sandbox；本仓只维护 APP 与 Channel 两类镜像
的构建输入和更新方案。实际部署操作由
[onyxclaw-one-click](https://github.com/KianaBin/onyxclaw-one-click) 维护。

## 快速开始

前提：Node.js 22.19 或更高版本、已安装并配置模型 Provider 的本机 OpenClaw。

```bash
npm install
npm test
```

本机验证和浏览器控制台见 [本地开发与验收](./docs/local-development.md)：

```bash
npm run phase0:local
npm run dev
npm run phase1:smoke
```

## 当前文档

| 类型 | 文档 | 说明 |
| --- | --- | --- |
| 当前规范 | [架构](./docs/architecture.md) | 组件责任、聊天交付、观测与构建边界；附交互式架构图 |
| 当前指南 | [Huawei Cloud 镜像构建与更新](./docs/huaweicloud-image-build-and-update.md) | APP v19、APP 补丁、OpenClaw 基础镜像和完整 Channel 镜像 |
| 当前指南 | [Provider 配置](./docs/provider-config.md) | Huawei AgentSphere 的非敏感样例、环境变量和验证边界 |
| 当前指南 | [本地开发与验收](./docs/local-development.md) | 本机 Phase 0 生命周期回归和 Phase 1 控制台 |
| 当前参考 | [Cloud APP runtime](./packages/cloud-runtime/README.md) | 云端编排、恢复与数据面语义 |
| 术语 | [CONTEXT.md](./CONTEXT.md) | 聊天交付、镜像和文档治理术语 |
| 架构决定 | [ADR](./docs/adr/) | 双镜像发布、Huawei-only 边界和文档治理决定 |
| 历史证据 | [故障追踪器](./docs/huaweicloud-sandbox-resume-bug-tracker.md) | 已脱敏的诊断结论、时间线与镜像可追溯信息，不是操作指南 |

非敏感配置结构见
[`config/providers.huaweicloud-agentsphere.example.json`](./config/providers.huaweicloud-agentsphere.example.json)
和 [`.env.example`](./.env.example)。真实 endpoint、Template/SFS 标识和所有凭据不进入仓库。
