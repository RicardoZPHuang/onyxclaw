# 仅支持 Huawei CCE + AgentSphere，并在开发机人工构建

> 状态：**已采纳（当前规范）**

OnyxClaw 只支持 Huawei Cloud CCE 承载 APP、AgentSphere 提供 Sandbox 的云部署组合。本仓只保留 APP 与 Channel 两类镜像的构建和更新方案：APP 包含稳定 v19 基线及其明确派生补丁，Channel 从干净 AgentSphere OpenClaw 基础镜像构建；不保留其他云厂商内容、具体部署清单、发布工作流或历史部署材料。

镜像在 `demo-cn-south1` 开发机上从已核验的不可变基线镜像构建。构建、镜像 push、CCE rollout 和 Template 创建/替换是彼此独立的人工受控步骤；默认不执行 push 或 rollout。

## 已考虑的方案

- 保留多云实现与自动发布：不采用。它会形成未经维护的第二条部署路径，并让发布责任和运行基线不清晰。
- 只删除旧文件、保留旧默认配置和发布工作流：不采用。未显式配置的 APP 会加载失效 Profile，工作流也会引用已删除的构建入口。

## 后果

通用 E2B-compatible runtime、本地 Console、Simulator 与测试仍被保留，但其默认 Profile、测试术语和运维文档收敛为 Huawei CCE + AgentSphere。发布负责人必须在 `demo-cn-south1` 上完成构建和容器内校验；具体部署操作由 `onyxclaw-one-click` 维护，只有明确授权后才可以继续 push、rollout 或 Template 变更。
