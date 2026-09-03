# Huawei Cloud AgentSphere Sandbox 历史故障追踪器

> 状态：**历史证据**。本文保留已经完成的诊断结论、未决风险和镜像可追溯信息；它不是当前架构、构建或部署指南。当前操作请从 [README](../README.md) 进入相应文档。

## 脱敏与记录规则

- 可保留与构建可追溯直接相关的镜像 `tag@digest`、源文件哈希、测试结果和日期。
- 不记录真实 endpoint、内部构建目录、集群/Namespace/Pod、Template 或 Sandbox 标识、网络拓扑、request ID、用户消息、聊天正文、token、密码或其他凭据。
- 结论必须区分“已验证”“服务端归属确认”“待查”；不得将假设写成根因。
- 当前行为以代码和回归测试为准。历史实现描述不得覆盖 [Cloud APP runtime](../packages/cloud-runtime/README.md) 的当前语义。

## 已验证结论

1. **恢复后的 re-bootstrap 需要重建非持久化运行配置。** 恢复后重新签发一次性 Channel token、写入运行时 `openclaw.json`、恢复持久化 SOUL 并等待 Gateway/Channel 就绪，已在真实环境完成多轮验证。
2. **恢复控制面与数据面是不同故障域。** `Sandbox.connect` 成功不代表 Files、Commands 或 Gateway 数据面已就绪；短暂的 session 未就绪需要有界等待，不能以固定极短等待替代真实数据面验证。
3. **APP 不能用重复 connect 修复服务端恢复故障。** 多轮恢复中出现的外层 500、且错误指向 Agent Gateway 的场景已被反馈为服务端范围；APP 保持单次显式恢复和可诊断的失败状态。
4. **暂停实例的清理仍是独立风险。** 当恢复失败后清理失败，APP 必须保留可追踪的残留资源状态，不能宣称已经清理成功。
5. **聊天交付必须按入站事件关联。** 全局“下一条出站事件”等待者会在并发请求下错配并产生 `timed out waiting for next outbound event`；回复必须通过 `payload.inReplyTo` 精确匹配入站事件。

## 镜像可追溯基线

以下项目只用于解释已完成验证或构建候选；它们不表示当前已经发布或应被部署。

| 日期 | 目的 | 镜像 `tag@digest` | 结论 |
| --- | --- | --- | --- |
| 2026-08-24 | 恢复 re-bootstrap 验证 | `0.3.8-resume-rebootstrap-v6@sha256:d1ca1cf76ae5da9db85b4bd2e887188ebf34e079fc710dc6960bdeb06df0843f` | APP re-bootstrap 已验证；Agent Gateway 恢复失败另行归属。 |
| 2026-09-02 | 稳定 APP 基线核验 | `0.3.8-session-routing-debug-nodelay-wait5s-v19@sha256:fe0c5274fff79897fce53634756694edc9799f393e3e3dde416d604749788293` | 后续 APP 补丁以该不可变基线明确派生。 |
| 2026-09-02 | Channel 运行基线核验 | `0.3.8-channel-error-fix@sha256:d29c37290298d374dd6438ae92ee2def3dadf9e1f7599704f341483c302442b5` | 完整 Channel 构建以此已核验基线明确派生。 |

## 关键时间线

| 日期 | 类别 | 脱敏证据 | 结论 |
| --- | --- | --- | --- |
| 2026-08-24 | 数据面恢复 | 恢复后文件读取在等待窗口内仍报告 session 未就绪。 | 控制面恢复不等于数据面可用；数据面等待需独立建模。 |
| 2026-08-24 | APP 修复 | 保留 session、单次显式 connect、恢复 re-bootstrap 的定向与完整回归通过；真实验证出现两轮成功恢复。 | APP 生命周期与 re-bootstrap 修复有效。 |
| 2026-08-24 至 2026-08-25 | 服务端边界 | 真实恢复在 APP bootstrap 前返回 Agent Gateway 相关失败，且相关负责人确认其服务端归属。 | 不再把该类 500 作为 APP bootstrap 缺陷继续修改。 |
| 2026-08-25 | 清理风险 | 恢复失败后的暂停实例清理未完成。 | 保留残留资源状态并由服务端/运维流程继续处理。 |
| 2026-09-02 | 聊天并发回归 | 修复前真实 WebSocket 场景稳定复现 outbound 等待超时；按 `inReplyTo` 关联后，定向与全量回归通过。 | 以回复关联键隔离并发等待，缺失回复只让自身超时。 |
| 2026-09-02 | 双镜像候选 | APP 与 Channel 候选均完成容器内语法、目标文件哈希和构建契约校验。 | 候选未推送、未 rollout、未替换 Template；发布须另获明确授权。 |
| 2026-09-03 | 新调试环境候选构建与发布 | 固定提交 `a4895b4` 的最小上下文在受控 Docker 构建机中构建 APP v21、最小 Channel 补丁与完整 Channel 镜像；覆盖文件、插件入口、依赖软链接和模块导入均通过容器内校验。随后已推送 APP `swr.cn-south-1.myhuaweicloud.com/demo-test/onyxclaw-app:0.3.9-chat-delivery-correlation-v21@sha256:9f3bd8bd484c6276add07cf4aa16d1fce8d19ab2c463a10721bf3d9f624a5516` 和完整 Channel `swr.cn-south-1.myhuaweicloud.com/demo-test/onyxclaw-openclaw:0.3.9-channel-full-v21@sha256:0b930587f3d95e428f472c7ec81e45a4a58814f439cfe3cebc9467124d1f9044`。 | 最小 Channel 补丁未推送；尚未 rollout、未替换 Template，需在实际部署环境做端到端验证。 |
| 2026-09-03 | Channel 父镜像纠正 | 复核后确认当前 Channel 发布应从现网 `0.3.8-channel-error-fix@sha256:d29c37290298d374dd6438ae92ee2def3dadf9e1f7599704f341483c302442b5` 派生，而非从干净 AgentSphere 基础层重组。已使用该 digest 重建并推送 `swr.cn-south-1.myhuaweicloud.com/demo-test/onyxclaw-openclaw:0.3.9-channel-error-fix-v21@sha256:8e314ad47a49eb57cab244fcbf52e456c4e8ae6d32e8bf732c6549bb083803e8`；容器内 `inbound.js` SHA-256 与固定提交 `a4895b4` 一致。 | `0.3.9-channel-full-v21` 已存在于 registry，但父镜像不符合当前补丁发布策略，未 rollout、不得用于本次部署；正确候选仍需在实际环境做端到端验证。 |
| 2026-09-03 | 误建完整 Channel 本地清理 | 按发布负责人指示，已从受控构建机移除误建 `0.3.9-channel-full-v21` 的本地构建标签和本地 registry 引用；正确的 `0.3.9-channel-error-fix-v21` 标签仍可用。 | 未调用 SWR 删除接口，远端误建标签由发布负责人自行删除；未 rollout、未替换 Template。 |
| 2026-09-03 | 发布前镜像验收 | 发布负责人确认本次镜像构建、父镜像派生关系、容器内文件校验及误建候选本地清理均验收通过。 | 验收对象为 APP v21 与 `0.3.9-channel-error-fix-v21` 镜像；不等同于 CCE rollout、Template 替换或真实聊天端到端验收。 |
| 2026-09-03 | PR 合并前构建契约修正 | APP v21 Dockerfile 已迁移至 `deploy/huaweicloud-cce/app-v21/`；构建契约测试、构建文档和完整 APP Dockerfile 注释同步改为新路径。 | `npm test` 110/110 通过；修正前测试因读取旧路径而失败，未创建带失败测试的 PR。 |

## 后续验收边界

若继续处理恢复或聊天问题，至少验证：

1. 对实际数据面执行一次 Files、Commands 或 Gateway 就绪检查，而不是只验证 `Sandbox.connect()`。
2. 聊天并发下每个回复的 `inReplyTo` 与入站事件一致；缺失回复不得被其他请求消费。
3. 恢复失败和清理失败都保留可诊断状态，不暴露用户内容或任何凭据。
4. 构建候选先完成测试、镜像内语法和哈希核验；未获发布负责人明确授权不得 push、rollout 或替换 Template。

## 文档治理变更

| 日期 | 变更 | 验证 |
| --- | --- | --- |
| 2026-09-02 | 以 [ADR 0003](./adr/0003-current-document-boundaries.md) 确立当前文档/历史证据边界；将本地开发、架构、镜像构建和 Huawei 配置收敛为单一当前来源，并删除已提取的旧方案与静态报告。 | README 导航、13 份 Markdown 的相对链接、旧文档/旧云厂商引用扫描、`git diff --check`、`npm test` 110/110 通过；交互式架构图完成结构和桌面视觉检查。 |
| 2026-09-03 | 在本地开发指南中明确远端 Docker 构建器边界：源码只来自干净的 `yqb-dev` 固定提交，经最小构建上下文传入临时目录；远端不承担 Git、Node.js、npm 或测试职责。 | 本机与远端运行时盘点确认；`git diff --check` 和 Markdown 相对链接校验通过。 |
| 2026-09-03 | 新增 Huawei APP 全量 Dockerfile 与固定 `e2b==2.24.0` 运行时依赖，保留 v19 最小更新 Dockerfile，形成“新建环境 / 已有 v19 环境更新”两条构建路径。 | 全量 `npm test` 110/110、构建契约测试通过；本机 Docker daemon 未运行，真实镜像构建须在本次改动提交后由远端 Docker 构建器执行。 |
