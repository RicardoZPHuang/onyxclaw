# DeepSeek Harness AgentSphere 镜像实现说明

部署步骤、启动命令、就绪检查和浏览器操作见 [README](./README.md)。本文说明当前镜像结构及其与原 v5 的关系。

## 1. 当前版本与基线

当前使用：

```text
swr.cn-southwest-2.myhuaweicloud.com/demo-test1/deepseek-harness-envd:20261015-v5-no-envd
```

当前版本沿用 DeepSeek Harness（DSH）v5 的源码和反向代理适配，移除了应用镜像内的 envd。仓库名包含 `envd`，不代表该标签仍内置 envd。

- DSH 源码修订：`c291e7961a515f6d7af9304e7fd1d257929aef26`。
- 原 v5：`20260915-v5`，Image ID 为 `sha256:faadcf7e2137afdf67c037b3e426d7b32e2253fd4d03f3d3d892e8caf05b6e70`。
- 当前无 envd 版本保留 v5 的 DSH、代理及依赖产物，避免混入节点目录中后续 v6/httpmux 修改。
- 网关要求的 `x-access-token` 使用平台返回的 `envdAccessToken`，这项平台鉴权与应用镜像是否自带 envd 分开管理。

## 2. Dockerfile 与入口逻辑

无 envd 版本采用多阶段构建：

1. 以固定摘要的原始 v5 镜像作为产物来源阶段。
2. 最终阶段从固定摘要的 `node:24-bookworm` 开始，避免继承包含 envd 的旧运行层。
3. 从 v5 复制 pnpm 11.7.0、`/opt/dsh` 和 `/app/proxy`，保留安装好的依赖及构建产物。
4. 写入移除 envd 后的 `/app/start.sh` 和新的 `/app/healthcheck.mjs`。
5. 创建 `/workspace`、`/home/user`，设置 DSH 源码修订标签。
6. 仅声明 `EXPOSE 3080`，不设置 `ENVD_PORT`，不复制 envd 或 envd-healthcheck.sh。
7. `WORKDIR /workspace`，入口为 `/app/start.sh`。

运行关系：

```text
/app/start.sh
├── DSH Web，端口 3079
└── Node.js 反向代理，0.0.0.0:3080
```

入口监督 DSH 和代理，任一关键进程退出时容器退出；TERM/INT 时清理子进程。没有 envd 启动、健康检查或进程监督逻辑。

镜像自带的 Docker HEALTHCHECK 由 Node.js 检查 DSH 和代理的 `/favicon.svg`，支持自定义端口及可选 Basic Auth。AgentSphere 模板则按 README 显式设置 `/app/start.sh` 和 3080 首页就绪检查命令。启用 Basic Auth 时，平台检查命令需要携带用户名密码。

## 3. 请求链路与凭据

| 端口 | 服务 | 用途 |
| --- | --- | --- |
| 3079 | DSH Web | 容器内部使用 |
| 3080 | 自定义反向代理 | UI、API 和 WebSocket 的外部入口 |
| 49983 | 平台 envd/runtime（若提供） | 平台管理，不由本应用镜像启动，也不用于本应用就绪检查 |

```text
浏览器（HTTPS/WSS）
  -> Agent Gateway 固定地址
     E2b-Sandbox-Id: 当前 Sandbox ID
     E2b-Sandbox-Port: 3080
     E2B-Traffic-Access-Token: trafficAccessToken
     x-access-token: envdAccessToken
  -> 容器 3080 代理
  -> DSH 3079
```

不使用 `port-sandbox-id` 拼接域名。四项 Header 需要对页面、API 和 `remote.mux` 的 WSS 请求都生效。

- E2B API key：仅用于创建/连接沙箱等控制面请求。
- traffic access token：填入 `E2B-Traffic-Access-Token`。
- envd access token：填入 `x-access-token`；不能用 traffic token 代替。
- DSH launch token/session：由容器代理在内部交换、缓存和注入。
- DeepSeek API key：进入 UI 后在模型设置中配置。
- 可选 Basic Auth：由 `PROXY_USERNAME` / `PROXY_PASSWORD` 配置。

## 4. 保留的 DSH 社区版修改

### 插件组合 URL 限长

`packages/client/modules/src/index.ts` 中，将组合插件请求的最大 URL 长度从 `3 * 1024` 调整为 `1536` 字节，减少网关请求行/头长度限制引发的 HTTP 431 和 Failed to load plugins。

### 无桌面配置文件查看

修改了 settings-controller 和 ui-settings-general 的配置文档动作。存在系统编辑能力时使用原生方式；无桌面容器中读取 `/root/.dsh/settings.yaml`，通过 RPC 返回路径和内容，UI 使用只读弹窗展示，避免 `spawn xdg-open ENOENT`。

设置弹窗不读取 `/root/.dsh/.credentials.yaml`。配置修改仍通过 DSH 原有设置表单完成。

相关文件：

- `packages/api/settings-controller/src/index.ts`、`types.ts`。
- `packages/client/ui-settings-general/src/client/settings-document-store.ts`。
- `SettingsDocumentAction.tsx`、`SettingsDocumentAction.module.css`、`locales.ts`。

## 5. 保留的 v5 反向代理适配

`proxy/index.js`、`proxy/upstream-token.js`、`proxy/compression.js` 保留以下行为：

1. 从 DSH 启动日志读取 launch token，首次需要认证时交换 DSH session，在代理内部消费同源重定向，避免网关跳转循环。
2. 缓存 `dsh-auth-*` 会话，并注入 HTTP 和 WebSocket 的上游请求，避免依赖浏览器回传 DSH Cookie；移除同名旧 Cookie 后注入当前会话。
3. 将上游 Origin 对齐到 DSH 的内部地址，通过同源检查。
4. 支持 identity、gzip、deflate、Brotli 响应改写。
5. 注入 `crypto.randomUUID` 兼容逻辑，并开放远程页面的设置入口。
6. 按容器实例标记隔离浏览器状态，切换 Sandbox 时清理旧 localStorage/sessionStorage。
7. 仅在用户名和密码都非空时启用 Basic Auth，没有默认账号密码。
8. 上游不可用时返回可诊断错误，避免代理因未捕获异常退出。

本版本仍使用 WebSocket 实时通道。代理内部管理 DSH 会话，浏览器负责四项网关 Header。

## 6. 工作区与运行目录

| 目录/文件 | 用途 | 持久化建议 |
| --- | --- | --- |
| `/opt/dsh` | DSH 源码、依赖和构建产物 | 镜像内使用 |
| `/app/proxy` | 代理及生产依赖 | 镜像内使用 |
| `/app/start.sh` | DSH 和代理入口 | 镜像内使用 |
| `/app/healthcheck.mjs` | DSH/代理健康检查 | 镜像内使用 |
| `/app/.dsh-web.log` | DSH 启动日志 | 临时状态，可能含 launch token |
| `/app/.dsh-launch-token` | 代理缓存的 launch token | 临时敏感状态，不对外公开 |
| `/workspace` | 默认项目工作目录 | 长期项目应挂载或制作快照 |
| `/root/.dsh/settings.yaml` | DSH 用户设置 | 需保留时持久化 `/root/.dsh` |
| `/root/.dsh/.credentials.yaml` | 模型等凭据 | 敏感目录，按平台能力持久化 |
| `/root/.dsh` 其他文件 | profile、会话、运行状态 | 按业务需要持久化 |
| `/home/user` | 兼容普通用户主目录 | 一般无需单独挂载 |

默认模板不挂载存储。删除 Sandbox 后，配置、模型密钥和工作区文件的保留情况取决于平台快照/存储能力，不能依赖应用镜像保留运行中配置。

## 7. 环境变量

沿用 v5 的 DSH 和代理变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DSH_PORT` | `3079` | DSH 内部端口 |
| `PROXY_PORT` | `3080` | 代理外部端口 |
| `PROXY_USERNAME` | 空 | 可选 Basic Auth 用户名 |
| `PROXY_PASSWORD` | 空 | 可选 Basic Auth 密码 |
| `DSH_TOKEN` | 空 | 可选手工指定 DSH launch token，通常无需设置 |
| `DSH_TOKEN_FILE` | 空 | 可选手工 token 文件 |
| `DSH_WEB_LOG` | `/app/.dsh-web.log` | DSH 日志路径 |

本应用镜像不再使用 `ENVD_PORT`。API key、traffic/envd token 和 DeepSeek 模型密钥不写入镜像。

## 8. 构建与验证记录

此前节点的无 envd 构建目录：

```text
/home/hzp/deepseek-image-build/no-envd-v5-20261015/
```

该目录整理了 Dockerfile、start.sh、healthcheck.mjs、README、验证脚本和构建记录；`build-files-20261015-v5-no-envd.tar.gz` 只包含关键文件，不包含大体积镜像。

此前的验证覆盖：

- 无 envd 文件、启动逻辑和 49983 监听；最终镜像 15 层均扫描无 envd。
- 首页和静态资源 200。
- 模型目录 RPC 返回正常 provider group。
- 无桌面配置文档 RPC 与容器文件内容一致。
- 无浏览器 Cookie 时，`remote.mux` 收到 `$events.ready`，关闭码 1000。
- Basic Auth、自定义端口及 DSH/代理健康检查正常。
- 容器 TERM 信号正常清理进程。

本次使用文档采用开头指定的西南二区镜像地址；平台当前访问需额外携带 envd token。token 工具直接读取 connect 响应中的 `trafficAccessToken` 和 `envdAccessToken`，无需 SDK 解析版本字段。详细操作和输出兼容方式见 README。

## 9. 旧版记录

`20260915-v5` 曾同时内置 DSH、代理和 envd，Docker HEALTHCHECK 会请求 49983；这是历史镜像行为。当前 `20261015-v5-no-envd` 已移除这部分，部署时以 README 中的新启动命令、3080 就绪检查和四项 Header 为准。
