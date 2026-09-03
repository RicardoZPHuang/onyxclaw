# Huawei Cloud 镜像构建与更新方案

> 状态：**当前指南**。本指南只覆盖 APP 与 Channel 镜像的构建和更新边界；不会执行 push、CCE rollout 或 Template 变更。

本仓提供两种 APP 构建方式：从 Node 基础镜像完整构建、以及从稳定 APP v19 派生的最小更新。
两者都与干净的 AgentSphere OpenClaw 基础镜像和从其构建的完整 OnyxClaw Channel 镜像配套。
APP 负责请求/回复关联，Channel 负责将模型输出投递为出站事件。

具体的 CCE、AgentSphere、Secret、ConfigMap、网络、Template 和 rollout 操作不在本仓维护，
请使用 [onyxclaw-one-click](https://github.com/KianaBin/onyxclaw-one-click)。

非敏感的 Provider 字段结构和环境变量名见
[`config/providers.huaweicloud-agentsphere.example.json`](../config/providers.huaweicloud-agentsphere.example.json)
与 [`.env.example`](../.env.example)。两者均使用占位符；真实 endpoint、Template/SFS 标识和
所有凭据只由部署账号在 one-click 输入与管理。

## 构建位置和安全边界

- 仅在 `demo-cn-south1` 构建候选镜像；
- 每次构建前，核验 APP v19 与 OpenClaw 基础镜像的 `image@sha256`；
- Dockerfile 必须只覆盖其层次明确的运行文件；
- 构建、push、CCE 更新和 Template 更新是独立步骤；默认只允许构建和容器内校验；
- 不在命令、Dockerfile、文档或日志中保存/输出凭据、token 或密码。

## 1. 新建环境：完整 APP 镜像

构建文件：[Dockerfile.app](../deploy/huaweicloud-cce/Dockerfile.app)。它从
`node:22-bookworm-slim` 开始，安装当前 APP 运行时需要的 Python E2B SDK，并复制完整的
`config/` 与 `packages/`。它适用于新建 Huawei CCE 环境，或不具备已验证 APP 基线的环境。

构建器不需要 Git、Node.js 或 npm：从本机干净的 `yqb-dev` 固定提交打包最小构建上下文后，
远端只执行 Docker build 与容器内核验。具体调试边界见
[本地开发与验收](./local-development.md#远端-docker-构建器与调试边界)。

```bash
docker build \
  -f deploy/huaweicloud-cce/Dockerfile.app \
  -t <registry>/onyxclaw-app:<full-app-tag> \
  .
```

完整 APP 构建不会替代既有 v19 的回滚锚点；首次部署成功后，应记录新镜像的
`tag@digest` 作为该环境后续最小更新的明确基线。

## 2. 已有环境基线：稳定 APP v19

真实 v19 构建上下文位于
[`deploy/huaweicloud-cce/app-v19/`](../deploy/huaweicloud-cce/app-v19/)，由远程开发机中
已验证的 v19 Dockerfile 和 `cloud-controller.js` 原样提取而来。该控制器文件的 SHA-256 已在
构建契约测试中固定校验，防止稳定基线被后续 APP 开发改动悄然替换。

```bash
docker build \
  -f deploy/huaweicloud-cce/app-v19/Dockerfile \
  -t <registry>/onyxclaw-app:<v19-tag> \
  deploy/huaweicloud-cce/app-v19
```

v19 从其父 APP 不可变 digest 继承，只覆盖 `cloud-controller.js`，并固定
`E2B_DATA_SESSION_WAIT_SECONDS=5`。它是稳定基线，不应被聊天补丁覆盖或就地修改。

## 3. 已有 v19 环境更新：APP 聊天交付补丁（v21）

构建文件：[Dockerfile.chat-delivery-v21](../deploy/huaweicloud-cce/app-v21/Dockerfile.chat-delivery-v21)。

它从已核验的 APP 不可变 digest 继承，只覆盖：

- `packages/cloud-runtime/src/cloud-controller.js`
- `packages/test-orchestrator/src/ws-simulator.js`
- `packages/local-console/public/app.js`

构建后应在容器内运行 `node --check`，并逐一比对上述文件的 SHA-256。

```bash
docker build \
  -f deploy/huaweicloud-cce/app-v21/Dockerfile.chat-delivery-v21 \
  -t <registry>/onyxclaw-app:<chat-delivery-tag> \
  .
```

## 4. 干净 AgentSphere OpenClaw 基础镜像

基础镜像上下文为
[`deploy/huaweicloud-agentsphere-openclaw/image/`](../deploy/huaweicloud-agentsphere-openclaw/image/)。
它只负责 OpenClaw Gateway、envd、健康检查和无 Channel 的默认配置。

其中 `envd` 是受 `.gitignore` 排除的二进制输入：在受控构建机上把已经过来源和哈希核验的
`envd` 放到该目录后构建，但不要把二进制提交到 Git。

```bash
test -x deploy/huaweicloud-agentsphere-openclaw/image/envd
docker build \
  -f deploy/huaweicloud-agentsphere-openclaw/image/Dockerfile \
  --build-arg OPENCLAW_IMAGE=<openclaw-base-image@sha256:...> \
  -t <registry>/onyxclaw-openclaw-agentsphere:<base-tag> \
  deploy/huaweicloud-agentsphere-openclaw/image
```

## 5. 当前 Channel 修复镜像：从已验证的 0.3.8 基线派生

当前线上 Channel 更新不是重新组合干净 AgentSphere 基础层，而是以已经验证的
`0.3.8-channel-error-fix` 不可变 digest 为父镜像，只覆盖经过回归验证的
`packages/onyxclaw-channel/src/inbound.js`。这样保留现有 Channel、OpenClaw 和 AgentSphere
运行时的其余层，变更范围严格限于聊天出站事件关联修复。

构建文件：[Dockerfile.channel-chat-delivery-v21](../deploy/huaweicloud-cce/app-v21/Dockerfile.channel-chat-delivery-v21)。
构建时必须使用 digest，而不能只写可变 tag：

```bash
docker build \
  -f deploy/huaweicloud-cce/app-v21/Dockerfile.channel-chat-delivery-v21 \
  --build-arg OPENCLAW_IMAGE=swr.cn-south-1.myhuaweicloud.com/demo-test/onyxclaw-openclaw@sha256:d29c37290298d374dd6438ae92ee2def3dadf9e1f7599704f341483c302442b5 \
  -t <registry>/onyxclaw-openclaw:<channel-patch-tag> \
  .
```

该 Dockerfile 仅复制 `inbound.js` 并校正文件属主；容器内验收至少包括 `node --check`、覆盖文件
SHA-256 与固定源码提交一致、以及既有 `node_modules/openclaw -> /app` 链接仍然存在。

## 6. 完整 Channel 镜像：新建或重建 Template 时使用

构建文件：[Dockerfile.channel](../deploy/huaweicloud-agentsphere-openclaw/Dockerfile.channel)。
它以第 4 步的干净基础镜像为输入，完成以下工作：

- 复制完整的 `packages/onyxclaw-channel` 插件，而非只覆盖单个修复文件；
- 使用锁定的 `ws` 生产依赖运行 `npm ci --omit=dev --ignore-scripts`；
- 将插件的 `openclaw` peer dependency 链接到基础镜像已有的 `/app` 运行时，避免下载第二份 OpenClaw；
- 使用 `openclaw.with-channel.default.json` 在首次启动时加载并启用 `/opt/onyxclaw/channel`。

```bash
docker build \
  -f deploy/huaweicloud-agentsphere-openclaw/Dockerfile.channel \
  --build-arg OPENCLAW_AGENTSPHERE_IMAGE=<registry>/onyxclaw-openclaw-agentsphere:<base-tag> \
  -t <registry>/onyxclaw-openclaw-channel:<channel-tag> \
  .
```

Dockerfile 会在基础镜像不包含 `/app/openclaw.mjs`，或其 `/app/package.json` 不是 `openclaw`
包时立即失败，避免将 Channel 构建到非预期的 OpenClaw 镜像上。

完整构建不替代本节上方的当前线上补丁路径。只有在新建或整体重建 Channel Template，且已另行
验证全部插件组成时，才使用本节的完整 Channel Dockerfile。

## 更新流程

1. 运行完整测试和 Dockerfile 构建契约测试。
2. 明确本次目标：已有 v19 / `0.3.8-channel-error-fix` 环境先核验两者的不可变 digest；新建或重建 Template 时核验第 4 步干净 OpenClaw 基础镜像。若任何基线已变，明确新增版本而不修改既有稳定版本。
3. 当前线上修复：已有 v19 环境按第 3 步构建 APP 聊天补丁，并按第 5 步构建 Channel 最小补丁；两者均完成容器内语法/哈希核验。新建或整体重建 Template 时，才按第 1 步完整 APP 与第 6 步完整 Channel 构建。
4. 将候选的镜像 `tag@digest`、覆盖文件哈希和测试结果追加到
   [bug tracker](./huaweicloud-sandbox-resume-bug-tracker.md)；不记录本地构建目录、endpoint 或运行资源标识。
5. 仅在发布负责人明确授权后，按 [onyxclaw-one-click](https://github.com/KianaBin/onyxclaw-one-click)
   执行镜像推送、CCE 更新、Template 更新及新 Sandbox 验收。

候选镜像未经明确授权不得 push、rollout 或用于替换 AgentSphere Template。
