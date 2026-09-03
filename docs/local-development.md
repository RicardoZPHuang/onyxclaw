# 本地开发与验收

> 状态：**当前指南**。本指南只覆盖当前 Mac 上已安装的 OpenClaw、本地 Simulator 和本地浏览器控制台；它不创建、连接或管理云端 Sandbox。

## 前提

- Node.js 22.19 或更高版本；
- 已安装且可工作的 OpenClaw；
- 已为本机 OpenClaw 配置可响应的模型 Provider。

安装依赖并运行全部自动回归：

```bash
npm install
npm test
```

WebSocket 测试只绑定 loopback；受限开发环境可能需要授予本地网络权限。

## 远端 Docker 构建器与调试边界

`demo-cn-south1` 是受控的 Docker 构建器，不是源码工作区或测试环境。它没有 Git、Node.js
或 npm；不得在其上拉取分支、编辑源码、安装依赖或运行仓库测试。唯一允许的源码输入是本机
[`yqb-dev`](../README.md) 分支中一个干净、固定的 Git 提交。

每次远端构建按以下顺序执行：

1. 在本机 `yqb-dev` 工作区确认 `git status --short` 为空，记录 `git rev-parse HEAD`，并运行所需的回归测试。
2. 使用 `git archive <commit>` 打包该提交的最小构建上下文，通过 SSH 传入远端新建的 `mktemp -d` 临时目录；不要复制本机 `node_modules`、`.git`、配置文件、凭据或旧构建目录。
3. 在远端临时目录只运行 Docker build、容器内语法检查和目标文件 SHA-256 核验。构建参数必须引用明确的基础镜像 `image@sha256`。
4. 将候选镜像 `tag@digest`、覆盖文件哈希和验证结果记录到故障追踪器；构建成功本身不表示已 push 或已部署。
5. 结束后逐个删除该次明确的远端临时构建目录；保留镜像仅作为本地候选，不能替代 registry digest 或已部署镜像的证据。

APP 与 Channel 的 Dockerfile、基线和容器内核验项见
[Huawei Cloud 镜像构建与更新方案](./huaweicloud-image-build-and-update.md)。实际 CCE 更新仍由
[onyxclaw-one-click](https://github.com/KianaBin/onyxclaw-one-click) 负责；在开始 rollout 前，必须
先通过只读 `kubectl` 预检确认集群可达、当前运行 digest 与回滚锚点。

## Phase 0：本机 Channel 生命周期回归

```bash
npm run phase0:local
```

该命令自动链接测试 Channel、启动本机 Simulator、配置临时 Channel、重启 Gateway、完成两轮消息、校验临时 `SOUL.md` 修改并执行清理。它会短暂影响当前 Mac 上其他 Channel；无论成功或失败，runner 都会尝试恢复原 `SOUL.md`、禁用测试 Channel 并再次重启 Gateway。

可独立确认清理结果：

```bash
openclaw config get channels.onyxclaw.enabled
openclaw gateway status
```

预期测试 Channel 为 `false`，Gateway 健康探测成功。每次运行在进程内生成随机 token；token 不写入报告。非敏感的运行报告输出在 `artifacts/`，该目录不提交。

常用非敏感调节项包括 `CHANNEL_HOST`、`CHANNEL_PORT`、`CHANNEL_INSTANCE_ID`、
`CHANNEL_ACCOUNT_ID`、`OPENCLAW_WORKSPACE`、两轮测试提示词和单步超时；默认值及完整
参数以 `phase0:local` 脚本为准。

## Phase 1：本机浏览器控制台

```bash
npm run dev
```

打开 `http://127.0.0.1:3000`。服务仅监听 loopback；停止时按 `Ctrl+C`。若已进入龙虾模式，服务会尝试禁用测试 Channel 并停止 Simulator。

控制台强制执行以下顺序，而不是允许任意跳转的页签：

```text
01 龙虾模式 → 02 性格确认 → 03 和龙虾对话
```

- 建连成功后才可确认性格；未确认性格时，即使直接调用 Chat API 也会被拒绝。
- 浏览器刷新回到第一步展示，但不会重置 BFF 内已经建立的连接和确认状态。
- 首次进入聊天会依据已确认的 `SOUL.md` 产生一次问候；同一 BFF 进程缓存该问候，避免重复调用模型。
- 断开并清理会禁用测试 Channel、重启 Gateway 并停止 Simulator，不会停止本机 OpenClaw 服务。

运行本地 UI 验收：

```bash
npm run phase1:smoke
```

Smoke 覆盖 UI 加载、Gateway probe、`SOUL.md` 的读取/写入/校验/恢复、性格确认门禁、一次性问候、文字消息往返和测试 Channel 清理。

## 本机安全边界

- HTTP 服务默认绑定 `127.0.0.1`，不应改为公网监听。
- 修改型 API 要求 `X-OnyxClaw-Request: local-ui`，以降低跨站页面触发 localhost 操作的风险。
- bootstrap token 每次运行随机生成，不进入浏览器或报告。
- BFF 不提供任意命令执行、任意文件路径读取，且页面不展示 OpenClaw 或模型 Provider 的密钥。
