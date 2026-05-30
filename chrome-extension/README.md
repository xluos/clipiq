# ClipIQ Bridge (Chrome 插件)

让 ClipIQ 桌面端通过浏览器登录态调 B 站 / 抖音 API,绕开 wbi 风控 (412 / -352)。

## 工作机制

桌面端在 `ws://127.0.0.1:58713/agent` 起一个 WS server,本插件 background service worker 连上去后做通用 fetch 代理 —— 桌面端把签好名的 URL + headers 发过来,插件用浏览器原生 `fetch` (带 cookie / buvid3 / SESSDATA) 代发,把响应回传。

业务逻辑 (wbi 签名 / view API 补全) 全留在桌面端,插件只是个借身份的 fetch 通道。

## 安装

1. 在 Chrome 打开 `chrome://extensions`,右上角开「开发者模式」
2. 点「加载已解压的扩展程序」,选这个 `chrome-extension/` 目录
3. 打开 ClipIQ 桌面端 —— 插件自动配对,工具栏图标 popup 指示灯变绿 = 已连接

不用再手动复制 token。桌面端按 WS `Origin` 头识别出连进来的是浏览器扩展(网页伪造不了 Origin),首次连接自动 TOFU 配对并在 `welcome` 里下发 token,插件存下来供之后重连握手用。仅当自动配对失败时,在 popup 里展开「手动填 Token」,从桌面端「设置 → 浏览器插件桥」复制粘贴。

## 协议

| 方向 | 类型 | 字段 |
|---|---|---|
| 插件 → 桌面 | `hello` | `{type, token, version}` 必须首条;`token` 可空(触发自动配对) |
| 桌面 → 插件 | `welcome` | `{type, serverVersion, token}`(首次配对时下发 token) |
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
- **Origin 闸门**:握手校验 WS `Origin` 头必须是 `chrome-extension://`。任何网页连过来 Origin 都是 `https://...`,直接拒。`Origin` 是 forbidden header,页面 JS 改不了 —— 这条挡住了 localhost CSRF(否则任意网页都能借桥发带你登录 cookie 的请求)
- **TOFU 配对**:记住第一个连上的扩展 origin,之后只认它。防你装的另一个恶意扩展(它也是 `chrome-extension://` 但 id 不同)。持有正确 token 可换绑新 origin
- token 32 字节随机 hex,存桌面端 userData/extension-bridge.json (mode 0600),作纵深防御(防本地非浏览器进程伪造 Origin);首次配对由桌面端在 `welcome` 下发,无需手动复制
- 同一时刻只允许一个插件连接,后连的踢前一个
- 「设置 → 重新配对」会换 token + 清配对,所有现有连接立即断开,下个扩展重新 TOFU

## 开发

修改 `background.js` 后,在 `chrome://extensions` 找到 ClipIQ Bridge,点刷新图标重载插件。

修改 `manifest.json` 后必须重载,否则不生效。

popup 的状态文本会在 background 状态变化时实时更新 (chrome.runtime.sendMessage 推 `bridge-status`)。
