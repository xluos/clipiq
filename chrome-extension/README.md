# ClipIQ Bridge (Chrome 插件)

让 ClipIQ 桌面端通过浏览器登录态调 B 站 / 抖音 API,绕开 wbi 风控 (412 / -352)。

## 工作机制

桌面端在 `ws://127.0.0.1:58713/agent` 起一个 WS server,本插件 background service worker 连上去后做通用 fetch 代理 —— 桌面端把签好名的 URL + headers 发过来,插件用浏览器原生 `fetch` (带 cookie / buvid3 / SESSDATA) 代发,把响应回传。

业务逻辑 (wbi 签名 / view API 补全) 全留在桌面端,插件只是个借身份的 fetch 通道。

## 安装

1. 在 Chrome 打开 `chrome://extensions`,右上角开「开发者模式」
2. 点「加载已解压的扩展程序」,选这个 `chrome-extension/` 目录
3. 打开 ClipIQ 桌面端 → 设置 → 浏览器插件桥 → 复制 token
4. 点 Chrome 工具栏的 ClipIQ Bridge 图标,把 token 粘贴进去 → 保存
5. 状态指示灯变绿 = 已连接

## 协议

| 方向 | 类型 | 字段 |
|---|---|---|
| 插件 → 桌面 | `hello` | `{type, token, version}` 必须首条 |
| 桌面 → 插件 | `welcome` | `{type, serverVersion}` |
| 桌面 → 插件 | `request` | `{type, id, method, params}` |
| 插件 → 桌面 | `response` | `{type, id, ok, data?, error?}` |

支持的 `method`:

- `ping` — 心跳测试,返回 `{pong, at}`
- `fetch` — 通用 HTTP 代理 (B 站用),`params: {url, method?, headers?, body?, parse?: "json" \| "text", timeoutMs?}`,带浏览器 cookie 直接 background fetch
- `douyin.userPosts` — 抖音用户投稿列表,`params: {secUid, count?, maxCursor?}`。背后会找一个 `douyin.com` tab(没有就 `chrome.tabs.create({active:false})` 静默开,完事关掉),用 `chrome.scripting.executeScript world:"MAIN"` 在页面上下文调 fetch,借页面 webmssdk 自动签 `a_bogus`

## 平台兼容性

| 平台 | 拉视频列表 | 备注 |
|---|---|---|
| B 站 | ✅ 桥优先,wbi 兜底 | 桥连时几乎 100% 成功;桥未连走 wbi + 随机 dm_img_*,偶发 412 |
| 抖音 | ✅ 桥优先,yt-dlp 兜底 | 桥未连大概率失败 (a_bogus 必须浏览器算) |
| 小红书 / YouTube / TikTok | yt-dlp | 暂未走桥 |

## 安全

- WS server 只绑 `127.0.0.1`,外网访问不到
- 每次连接首条必须是 `hello` 带正确 token,5s 内不发就断
- token 32 字节随机 hex,存桌面端 userData/extension-bridge.json (mode 0600)
- 同一时刻只允许一个插件连接,后连的踢前一个
- 重置 token 后所有现有连接立即断开

## 开发

修改 `background.js` 后,在 `chrome://extensions` 找到 ClipIQ Bridge,点刷新图标重载插件。

修改 `manifest.json` 后必须重载,否则不生效。

popup 的状态文本会在 background 状态变化时实时更新 (chrome.runtime.sendMessage 推 `bridge-status`)。
