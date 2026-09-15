# DeepSeek Harness + envd AgentSphere 镜像说明

## 1. 目标与基线

本镜像以 DeepSeek Harness（DSH）社区源码为运行主体，参考 `smanx/deepseek-harness-docker` 的容器化思路，加入面向 AgentSphere/E2B 网关的反向代理和节点上的 `envd`，使同一个容器同时提供：

- DeepSeek Harness Web UI、HTTP API 和 WebSocket；
- 对 AgentSphere 固定网关域名可用的代理入口；
- `envd` 服务，供沙箱生命周期和执行环境访问；
- 无桌面 Linux 容器中的配置文件查看能力。

DSH 源码基线提交为 `c291e7961a515f6d7af9304e7fd1d257929aef26`。镜像标签为 `deepseek-harness-envd:source-20260913-headlesssettingsfix`。

## 2. Dockerfile 整体逻辑

Dockerfile 的构建顺序如下：

1. 使用 `node:24-bookworm` 作为基础镜像，获得 Node.js 24、Debian 用户空间和 `curl`。
2. 全局安装固定版本 `pnpm@11.7.0`。
3. 将已经安装依赖并生成 `lib` 产物的 DSH 源码复制到 `/opt/dsh`。
4. 将自定义 Node.js 反向代理复制到 `/app/proxy`，并只安装生产依赖。
5. 将节点 `/home/hzp/envd-dir` 中的 `envd` 经构建上下文的 `envd/` 目录复制到 `/usr/local/bin/envd`。
6. 将多进程入口脚本放到 `/app/start.sh`，创建 `/workspace` 和 `/home/user`。
7. 写入 DSH 源码修订号标签，设置三个服务端口。
8. 暴露代理端口 `3080` 和 envd 端口 `49983`；DSH 的 `3079` 只在容器内部由代理访问。
9. 创建普通用户 `user`，但当前入口仍以 root 运行，以便 DSH 使用 `/root/.dsh` 保存运行配置。
10. 健康检查同时检测 `envd` 的 `/health` 和 DSH 的静态资源。

入口脚本采用一个容器三个进程的方式启动：

```text
/app/start.sh
├── /usr/local/bin/envd -isnotfc -no-cgroups -port 49983
├── DSH Web，监听 127.0.0.1:3079
└── Node.js 反向代理，监听 0.0.0.0:3080
```

任一关键进程退出时入口脚本退出，容器运行时可以据此重启整个服务组；收到退出信号时脚本会清理全部子进程。

## 3. 请求链路与端口

| 端口 | 监听范围 | 服务 | 用途 |
| --- | --- | --- | --- |
| 3079 | 容器回环地址 | DSH Web | 只供容器内代理访问，不应直接暴露给 AgentSphere |
| 3080 | `0.0.0.0` | 自定义反向代理 | AgentSphere/E2B 对外入口，承载页面、API 和 WebSocket |
| 49983 | `0.0.0.0` | envd | 沙箱执行环境服务和健康检查 |

AgentSphere 的访问链路为：

```text
浏览器或 SDK
  -> Agent Gateway 固定 HTTPS 地址
  -> 请求头 E2b-Sandbox-Id + E2b-Sandbox-Port: 3080 + E2B-Traffic-Access-Token
  -> 沙箱容器 0.0.0.0:3080
  -> 反向代理 http://127.0.0.1:3079
  -> DSH Web/API/WebSocket
```

不要使用 `port-sandbox-id` 拼接域名。网关地址保持不变，沙箱 ID、端口和 traffic token 都通过请求头传递。

## 4. 相对 DSH 社区版的修改

### 4.1 DSH 源码修改

#### 客户端插件组合 URL 限长

文件：`packages/client/modules/src/index.ts`

将单个插件组合请求的最大 URL 长度从 `3 * 1024` 调整为 `1536` 字节。Agent Gateway 对请求头和请求行的限制比本地直连严格；较小的分片避免 `/plugins/??...` 请求触发 HTTP 431，解决 “Failed to load plugins” 和模型列表持续加载的问题。

#### 无桌面环境配置文件查看

文件：

- `packages/api/settings-controller/src/index.ts`
- `packages/api/settings-controller/src/types.ts`
- `packages/client/ui-settings-general/src/client/settings-document-store.ts`
- `packages/client/ui-settings-general/src/client/SettingsDocumentAction.tsx`
- `packages/client/ui-settings-general/src/client/SettingsDocumentAction.module.css`
- `packages/client/ui-settings-general/src/client/locales.ts`

社区版的 `openSettingsDocument` 会在 Linux Host 上执行 `xdg-open`。AgentSphere 容器没有桌面会话，也没有 `xdg-open`，因此原先返回 `spawn xdg-open ENOENT`。

现在的行为为：

- 桌面环境存在原生打开能力时，继续调用系统编辑器；
- 无桌面环境时，由 Host 读取已经物化的 `/root/.dsh/settings.yaml`，通过 RPC 返回路径和内容；
- Web UI 在只读弹窗中展示路径与 YAML 内容；
- 修改配置仍通过 DSH 原有设置表单完成。

凭据由独立的 credentials 存储管理，不会作为 settings 描述接口的一部分返回；该弹窗读取的是设置文档，不是 `/root/.dsh/.credentials.yaml`。

### 4.2 反向代理适配

文件：`proxy/index.js`、`proxy/upstream-token.js`、`proxy/compression.js`

代理做了以下兼容处理：

1. **Launch token 自动交换会话**：从 DSH 启动日志提取 launch token，仅在首页首次返回 401 时用 query 参数交换 session cookie。代理内部消费同源 303 跳转并返回最终页面，避免 Agent Gateway 丢失跳转过程中的 Cookie 后产生 `stopped after 10 redirects`。
2. **DSH 会话在代理内复用**：代理保存 launch-token 交换得到的 `dsh-auth-*` 会话，并在转发每个 HTTP 和 WebSocket 请求前注入上游 Cookie。这样即使浏览器或 Windows 扩展没有在 `remote.mux` 握手中回传 DSH Cookie，模型实时通道仍能完成认证。代理会移除请求中的同名旧 Cookie，再使用当前容器刚获得的会话，避免旧 Sandbox 会话污染。
3. **HTTP 与 WebSocket 同源对齐**：把浏览器的 `Origin` 改为 DSH 实际看到的 `http://127.0.0.1:3079`，通过 DSH 的同源检查。
4. **压缩响应改写**：支持 identity、gzip、deflate 和 Brotli；先解压 HTML/JavaScript，注入或改写后再按原编码压缩返回。
5. **`crypto.randomUUID` 兼容**：非 HTTPS 的普通主机名环境可能没有 `crypto.randomUUID`，页面注入基于 `getRandomValues` 的实现，保证 RPC ID 和实时连接正常生成。
6. **设置能力开放**：代理将前端的 loopback 主机判断改写为可用，使通过网关访问时仍显示设置入口。
7. **按沙箱隔离浏览器状态**：AgentSphere 多个沙箱共用固定网关 origin。代理按容器 `HOSTNAME` 生成实例标记；检测到沙箱变化时清理旧的 localStorage 和 sessionStorage，避免复用前一个沙箱的模型和插件状态。
8. **可选 Basic Auth**：只有 `PROXY_USERNAME` 和 `PROXY_PASSWORD` 同时设置时才启用；不设置时没有默认账号或默认密码。
9. **故障兜底**：DSH 未启动或退出时 HTTP 返回 502，WebSocket 连接关闭，同时保留可诊断日志，避免代理进程因未捕获错误退出。

## 5. 文件和工作区目录规划

| 容器目录 | 所有者/用途 | 是否建议持久化 |
| --- | --- | --- |
| `/opt/dsh` | DSH 社区源码、`node_modules` 和已生成的 `lib` 产物 | 镜像内只读使用，不作为用户工作区 |
| `/app/proxy` | 反向代理源码及生产依赖 | 镜像内只读使用 |
| `/app/start.sh` | 容器入口脚本 | 镜像内只读使用 |
| `/app/.dsh-web.log` | DSH Web 启动日志，代理从中提取 launch token | 临时运行状态 |
| `/app/.dsh-launch-token` | 代理自动缓存的 launch token | 临时运行状态，禁止对外暴露 |
| `/usr/local/bin/envd` | 从节点 `/home/hzp/envd-dir` 打入的 envd 可执行文件 | 镜像内只读使用 |
| `/workspace` | 默认工作目录，Agent 和用户项目文件应放在这里 | 需要跨沙箱保留时挂载卷或使用快照 |
| `/root/.dsh/settings.yaml` | DSH 用户设置 | 需要保留设置时持久化 `/root/.dsh` |
| `/root/.dsh/.credentials.yaml` | 模型等凭据 | 敏感目录，只允许容器内 DSH 访问 |
| `/root/.dsh` 其他文件 | profile、会话与 DSH 运行状态 | 按业务持久化要求决定 |
| `/home/user` | 为兼容工具创建的普通用户主目录 | 一般不需要单独持久化 |

Dockerfile 的 `WORKDIR` 是 `/workspace`，所以由 DSH 创建的新任务应优先使用该目录。`/root/.dsh` 是控制面和配置目录，不应混放项目源文件。AgentSphere 沙箱销毁后，容器可写层是否保留由模板、快照和平台生命周期决定；需要长期保留的项目文件应显式挂载或在销毁前制作快照。

## 6. 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DSH_PORT` | `3079` | DSH 内部端口 |
| `PROXY_PORT` | `3080` | 反向代理外部端口 |
| `ENVD_PORT` | `49983` | envd 端口 |
| `PROXY_USERNAME` | 空 | 可选代理 Basic Auth 用户名 |
| `PROXY_PASSWORD` | 空 | 可选代理 Basic Auth 密码 |
| `DSH_TOKEN` | 空 | 可选手工指定 DSH launch token，通常无需设置 |
| `DSH_TOKEN_FILE` | 空 | 可选手工 token 文件 |
| `DSH_WEB_LOG` | `/app/.dsh-web.log` | DSH 日志路径 |

Basic Auth 只有用户名和密码都非空时才启用。未配置时代理直接放行，且没有默认密码。Agent Gateway 的 traffic token 属于网关认证，不能写入镜像或提交到文档。

## 7. 本地 Docker 启动示例

无额外 Basic Auth：

```bash
docker run -d \
  --name deepseek-harness \
  --restart unless-stopped \
  -p 3080:3080 \
  -p 49983:49983 \
  -v dsh-state:/root/.dsh \
  -v dsh-workspace:/workspace \
  deepseek-harness-envd:source-20260913-headlesssettingsfix
```

启用代理 Basic Auth：

```bash
docker run -d \
  --name deepseek-harness \
  --restart unless-stopped \
  -p 3080:3080 \
  -p 49983:49983 \
  -e PROXY_USERNAME='your-user' \
  -e PROXY_PASSWORD='your-password' \
  -v dsh-state:/root/.dsh \
  -v dsh-workspace:/workspace \
  deepseek-harness-envd:source-20260913-headlesssettingsfix
```

AgentSphere 模板通常直接使用镜像默认入口，不需要覆盖 `ENTRYPOINT` 或 `CMD`。对外选择容器端口 `3080`；`49983` 仅在需要直接调用 envd 时开放。

## 8. 构建、导出与验证

源码或客户端代码修改后，要先重建 Host 和对应客户端包，再构建镜像：

```bash
cd /home/hzp/deepseek-image-build/deepseek-harness-master
pnpm run build:lib:host
pnpm --filter @deepseek-ai/dsh-client-ui-settings-general bundle

cd /home/hzp/deepseek-image-build
docker build -t deepseek-harness-envd:source-20260913-headlesssettingsfix .
```

导出镜像：

```bash
docker save deepseek-harness-envd:source-20260913-headlesssettingsfix \
  | gzip -1 > /home/hzp/deepseek-image-build/deepseek-harness-envd-source-20260913-headlesssettingsfix.tar.gz
sha256sum /home/hzp/deepseek-image-build/deepseek-harness-envd-source-20260913-headlesssettingsfix.tar.gz
```

本次验证覆盖：

- 设置控制器、配置文档状态管理和设置 UI 的 39 个测试；
- 容器健康检查；
- `envd` `/health`；
- 经 3080 代理完成 DSH launch token 到 session cookie 的交换；
- `settings/openSettingsDocument` RPC 在无桌面容器内返回 `opened: false`、文件路径和完整内容；
- 返回内容与容器内测试设置文档逐字一致。
- 对同一套 DSH 服务进行 WebSocket 对照验证：旧代理在不携带浏览器 Cookie 时以 `1006` 失败；修复版在同样不携带 Cookie 的条件下收到 `$events` 的 `ready` 消息，并以 `1000` 正常关闭。

2026-09-15 在构建节点生成了包含代理会话复用修复的候选镜像：

```text
deepseek-harness-envd:source-20260915-ws-sessionfix
sha256:faadcf7e2137afdf67c037b3e426d7b32e2253fd4d03f3d3d892e8caf05b6e70
```

该标签目前是节点本地构建产物。推送 SWR 并让 Template 使用新标签后，新的 Sandbox 才会包含此修复。

## 9. 本次产物

- 镜像：`deepseek-harness-envd:source-20260913-headlesssettingsfix`
- 镜像 ID：`sha256:722a6dba8dcc0e1b5ccf93e8c443e695917bcc66409136fc60a1472b2de2692e`
- 导出文件：`/home/hzp/deepseek-image-build/deepseek-harness-envd-source-20260913-headlesssettingsfix.tar.gz`
- 导出文件大小：`1101171908` 字节
- 导出文件 SHA-256：`4c8f4532948e32d311b307148943ff8c83ec1c2bc54160ed8e9ac9914d67399d`

已公开发布到 SWR：

```text
swr.cn-south-1.myhuaweicloud.com/demo-test/deepseek-harness-envd:20260913-v4
```
