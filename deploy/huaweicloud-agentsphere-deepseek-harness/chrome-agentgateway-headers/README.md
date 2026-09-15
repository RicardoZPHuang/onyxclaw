# AgentSphere Gateway Headers Chrome 扩展

这是一个面向 AgentSphere Agent Gateway 的 Manifest V3 扩展。它通过 Chrome `declarativeNetRequest` 动态规则，给同一 Gateway 域名下的普通 HTTP/HTTPS 请求和 WebSocket 握手统一增加：

- `E2b-Sandbox-Id`
- `E2b-Sandbox-Port`
- `E2B-Traffic-Access-Token`

扩展只申请 `*.huaweicloud-agentnetwork.com` 的 HTTP/HTTPS 访问权限。Sandbox ID、端口和 token 保存在当前 Chrome Profile 的 `chrome.storage.local` 中，不会写入本目录文件，也不会同步到 Chrome 账号。

普通页面/API 与 WebSocket 使用两条独立规则。保存时扩展会分别用 `ws://` 和 `wss://` 的 `/api/remote.mux` 模拟请求做规则匹配自检；弹窗显示“HTTP 与 WebSocket 规则均已启用并通过自检”后再打开 Gateway。

## Windows Chrome 安装

1. 将整个 `chrome-agentgateway-headers` 文件夹复制到 Windows 机器；
2. Chrome 打开 `chrome://extensions/`；
3. 开启右上角“开发者模式”；
4. 点击“加载已解压的扩展程序”；
5. 选择这个文件夹；
6. 将扩展固定到 Chrome 工具栏。

加载本地扩展时 Chrome 会显示它可读取和更改 `huaweicloud-agentnetwork.com` 网站数据，这是给 Agent Gateway 请求增加路由 header 所需的权限。

## 使用

打开扩展并填写：

| 字段 | 示例或说明 |
| --- | --- |
| Gateway URL | AgentSphere 提供的完整 `https://agent-gateway-...` 地址 |
| Sandbox ID | 当前运行中的 Sandbox ID |
| Sandbox Port | DeepSeek Harness 使用 `3080` |
| Traffic Access Token | 创建 Sandbox 响应中的 `traffic_access_token` |

点击“保存并启用”，扩展图标显示 `ON` 后，再点击“打开 Gateway”。切换 Sandbox 时必须更新 Sandbox ID 和 token，然后重新保存。

不要同时启用 ModHeader 中的旧规则，以免不同扩展争用同名 header。Chrome 对多个扩展修改同一个 header 的结果存在优先级关系，旧规则可能覆盖当前值。修改扩展文件后，应在 `chrome://extensions/` 点一次“重新加载”，再重新保存配置。

## 验证

在 DeepSeek Harness 页面按 `F12` 打开 Network：

1. `api/remote.mux` 应出现在 WS 分类中，状态为 `101 Switching Protocols`；仅显示“已完成”且没有状态码、Frames 时，握手并未成功；
2. `api/llm/listProviders` 应返回 `200`；
3. WebSocket 握手和模型接口的 Request Headers 都应包含三项 AgentSphere header。

如果页面仍保留旧 Sandbox 状态，关闭同一 Gateway 域名的全部标签页，清除该站点数据后重新打开。

点击扩展里的“清除”会删除动态规则及保存在扩展本地存储里的 Sandbox ID 和 token。
