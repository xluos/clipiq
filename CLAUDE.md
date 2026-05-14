# ClipIQ — Claude / Cursor 协作指南

## 设计系统

**做 UI 改动前必须先读 `DESIGN.md`。**

DESIGN.md 是本项目设计系统的 source of truth,采用 Google Stitch 的 [DESIGN.md 规范](https://stitch.withgoogle.com/docs/design-md/overview/)(YAML front matter + Markdown rationale)。任何颜色、字号、间距、圆角、组件样式以该文件的 token 为准。

具体约束:

- **颜色**:使用 `colors.*` 定义的 token,不要引入文件外的 hex。Indigo(`tertiary` / `accent-*`)只用于 primary CTA / 当前节点高亮 / active state,不做装饰。状态色(`ok` / `warn` / `error` / `danger`)的 `-soft` 变体用于填充,bare 变体用于文字和小标记。
- **字体**:body 类用系统 sans;时间戳、模型名、端口、文件名、评分、hex 这类&ldquo;可复制粘贴&rdquo;的值用 monospace(`label-*` / `data-*`)。这种 sans+mono 的混排是产品的视觉签名,不要随意打破。
- **间距**:8px 网格(允许 4px 半步)。padding / gap / margin 一律是 4 的倍数。
- **圆角**:`sm 4 / md 6 / lg 8 / xl 12 / 2xl 18 / pill / full` 六档。新增组件从这六档里挑,不要造 10px / 14px 等中间值。子元素的 radius 必须 ≤ 父元素,反之非法。
- **分层**:1px border + 极浅 muted 背景。卡片、按钮、输入框、chip **不加 shadow**。只有 floating overlay(Tweaks 浮层、modal、dialog)允许 shadow。
- **不要的 AI 套路**:purple-pink 渐变 / emoji 当 icon / 左边框 accent 卡片 / Inter Roboto 当 display 字体 / 在 dark 模式上叠 cyber-neon。设计稿里有强势的 editorial / quiet 路线,不要回退。

**校验工具**:`npx @google/design.md lint DESIGN.md` 持续校验 WCAG AA 对比度、token 引用完整性、section 顺序。改 DESIGN.md 后跑一遍。

**导出**:`npx @google/design.md export DESIGN.md --format tailwind` 把 token 导成 `tailwind.config` 的 `theme.extend` 块。后续把现有 tailwind class 切到 token 引用时按这个走。

## UI 文案规则

UI 文案只描述&ldquo;这是什么 / 做什么&rdquo;,不解释&ldquo;为什么这样设计&rdquo;,不推荐&ldquo;怎么用比较好&rdquo;。

反例(改前):

> 粘贴链接、拖入文件、或直接输入本地路径 —— 同一个输入框会自动判断。不需要先选&ldquo;本地&rdquo;还是&ldquo;链接&rdquo;。

正例(改后):

> 粘贴链接、拖入文件,或输入本地路径。

破折号+解释意图的句式、&ldquo;改完立即生效&rdquo;&ldquo;不需要重启&rdquo;这类向用户讲设计的内容,都属于文档语气,不进 UI。

## 视觉验证

UI 改动后用 chrome-devtools 拍图核对:

```bash
npm run dev                # vite 起 dev server (端口 5757,被占则 5758)
```

然后通过 chrome-devtools MCP 截图,核对跟 design-refresh.html 的设计稿是否对齐。

## TypeScript 提示

项目 jsx 配 `react-jsx`,strict 未开。但定义 local component 时如果在 `.map(=> <X key=.../>)` 中使用,需要把 component 显式声明为 `FunctionComponent<Props>`(`import { type FunctionComponent } from "react"`),否则 TS 会报 `Property 'key' does not exist`。

`function FunctionName(props: Type) { return ... }` 形式 + 不在 map 中调用,则不需要 FunctionComponent。

## 链接拉取与本地视频

URL 拉取通过 `window.videoAnalyzer.downloadVideo(url)` 调 yt-dlp,返回 `DownloadedVideo`(含 `projectId / title / mediaUrl / filePath / platform / fromCache`)。

`fromCache: true` 表示 url-cache 命中,没真跑 yt-dlp 二次下载。新加 url-cache 入口时不要破坏 fromCache 反馈。

本地文件通过 `inspectVideoPath(filePath)` 取元数据,通过 `getPathForFile(file)` 从 File 对象拿 Electron 真实路径。两条路径都在 `src/screens/HomeScreen.tsx` 的 composer / drop / file-picker 三个入口。

## 不要做的事

- 不要把 ScreenState 里的 `url_pull` 当主入口 —— 已合并到 Home composer,只保留文件不删,避免破坏外部引用,但用户不再从那里发起。
- 不要在拉片管线代码里直接拼 console.log;用 main.cjs 的 progress event 通过 `onAnalysisProgress` 上报,UI 由 Progress 屏的 log feed 累积渲染。
- 不要在 settings 里同时存"deprecated derived getter"和 v2 schema 字段;v2 已完成,getter 是迁移期残留。
