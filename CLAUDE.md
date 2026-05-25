# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

ClipIQ 是一个 Electron 桌面视频分析工具。看视频 → 抽帧 + 字幕 → LLM 拉片 → 节点时间轴 + 方法论审计。

## Repo overview

- **Electron 桌面应用**,不是纯 Web。React 19 + Vite + Tailwind 4 渲染层,Node main 进程(`electron/main.cjs`)负责本地能力。
- **Main 进程**:ffmpeg / ffprobe / yt-dlp / SQLite 项目存储 / `media://` 协议 / 本地 sidecar(llama.cpp + whisper.cpp)/ 分析管线编排。
- **Renderer**:SPA 单 React app。屏幕切换用 `AppContext` 内的 `ScreenState`,不用 react-router。
- **IPC 表面**:只通过 `electron/preload.cjs` 暴露的 `window.videoAnalyzer.*`,类型在 `src/electron-api.d.ts`。renderer 不直接 import `electron`。
- **浏览器预览模式**:`npm run dev` 单跑(不带 Electron)走 fallback,本地能力不可用,UI 显示"浏览器预览环境"提示。这是有意保留的 fallback,不要让代码假设 `window.videoAnalyzer` 一定存在。

## Common commands

| 场景 | 命令 |
|---|---|
| 完整 dev(推荐) | `npm run electron:dev` — 起 Vite + Electron,renderer 有 HMR |
| 仅前端预览 | `npm run dev` (port 5757) |
| 生产 build 联调 | `npm run electron:preview` — 测 `base:"./"` 那条路径,真实加载方式 |
| Type 校验 | `npm run lint` (= `tsc --noEmit`) |
| 生产 build | `npm run build` |

`electron:dev` 改 renderer 走 HMR;**改 `electron/*.cjs`(main / preload / runtime)必须 kill concurrently 重启,Vite HMR 不重载 main 进程**。

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

**信息密度**:UI 上只写"用户不知道但需要知道"的内容,**不写基础常识**。

- ❌ "数字越小占用越少"、"点击下载按钮开始下载"、"这是 Q4_K_M 量化档" —— 用户能从上下文推出来,塞进 UI 是噪音。
- ✅ "运行中 · 端口 58511"、"占可用内存 15%"、"需 32 GB+ 机器"、"轮到该阶段时会切换 · 预计 ~6s" —— 用户没法自己算出来的事实。

每行 UI 文案先问一句:"如果删掉这句,用户还能完成任务吗?" 能 → 删掉。

**中文优先**。除了真正的专业技术名词(`GGUF` / `Q4_K_M` / `tok/s` / `port` / `OpenAI-compatible` / 模型族名如 `Qwen3-VL` / 文件路径 / API key),其他一律用中文:

- 能力标签 → `视觉` / `音频` / `文本` / `推理` / `长上下文`,不是 `vision` / `audio` / `text` / `reasoning` / `long_context`
- 状态 → `推荐` / `可用` / `紧张` / `不可用` / `已安装` / `运行中`,不是 `Perfect` / `Good` / `Marginal` / `Tight`
- 动作 → `下载` / `启动` / `停止` / `切换`,不是 `Download` / `Start` / `Stop` / `Switch`
- 模型属性如 `tok/s` / `mem` 保留英文符号,但前后描述用中文(`200 tok/s`、`占 9%` 内存)

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

## 架构关键文件

- `electron/main.cjs` — IPC 注册 + 项目生命周期 + 分析管线(prefilter → shot-merger → summarizer → 主分析)。
- `electron/preload.cjs` — 唯一 `window.videoAnalyzer.*` 暴露面。
- `electron/llama-runtime.cjs` — 本地 llama.cpp sidecar。**单例 server,同一时刻只跑一个 model;切换先 stop 再 start**(5–15s 冷启动)。从 `local-models.manifest.cjs` 读模型清单。
- `electron/whisper-cpp-runtime.cjs` — 本地 whisper.cpp sidecar(同样单例结构)。
- `electron/daemon-client.cjs` — ai-model-daemon IPC 客户端(模型下载 / 硬件检测 / fit 计算 / 推荐排序)。
- `src/AppContext.tsx` — 屏幕路由 + projects / providers / taskSlots / audioSlot / defaultAnalysis 持久化。debounced 250ms 后 saveConfig。
- `src/screens/SettingsScreen.tsx` — 6 个 section:供应商 / 任务分配 / 本地推理 / 本地依赖 / 默认分析 / 项目数据。每个 section 独立组件。
- `src/types.ts` — `AppConfig` / `AnalysisOptions` / `LocalModelEntry` / `MachineSpecs` / `TaskSlots` schema source of truth。

## 本地模型扩展

`electron/local-models.manifest.cjs` 是本地模型清单的 source of truth。新加 model = **只编辑这个文件**,UI 不用改:

```js
my_model_key: {
  key: "my_model_key",
  family: "Qwen3.5-VL",
  params: "2B",
  primaryCapabilities: ["vision", "text"],  // 决定任务槽位过滤
  secondaryTags: ["chinese", "fast"],        // 只做 UI hint
  available: true,                            // false = 路线图占位(UI 显示但灰按钮)
  contextSize: 8192,
  quantizations: [{
    key: "q4_k_m", label: "Q4_K_M",
    repo: "unsloth/...", llmFile: "...gguf", mmprojFile: "mmproj-F16.gguf",
    sizeBytes: 1.9 * 1024 * 1024 * 1024,
  }],
},
```

`buildBuiltinLocalLlamaProvider`(在 main.cjs)只把 `available: true` 的模型暴露给任务分配 dropdown。新模型接入前先验证 GGUF + mmproj 文件能 llama.cpp 加载。

## CDP 验证 / 截图

Electron 默认不开 remote-debugging-port。要远程拍图核对 UI:

```bash
VIDEO_ANALYZER_DEBUG_PORT=9223 npm run electron:dev
# 起来后:
node scripts/cdp-screenshot.cjs 9223 .mocks/shot.png      # 截整页
node scripts/cdp-driver.cjs 9223 "document.title"          # 跑 JS,返回值
```

`chrome-devtools` MCP 默认连本机 Chrome(9222),**不会**自动找 Electron 的 9223;只能用上面两个 script 走 ws 协议。

## Vite alias gotcha

`vite.config.ts` 把 `@` 解析到**仓库根目录**,不是 `src/`:

- shadcn UI 在根目录 `components/ui/*`,所以 `@/components/ui/button` 解析正确。
- 想 import 你自己写的 src 内组件:用相对路径,或写 `@/src/foo`。
- **不要假设 `@/` 等于 `src/`**。后续新增子目录别建在根目录,留在 `src/` 里走相对路径或 `@/src/...`。

另一个 gotcha:`vite.config.ts` 设了 `base: "./"`。这是 Electron 加载 `file://` 协议时必需的(默认 `/` 会让 `/assets/*` 找文件系统根而 404 黑屏)。**不要改回 `/`**,只在 `electron:dev`(http://localhost) 模式才看不出问题,`electron:preview` 一上就崩。

## 数据路径

Electron userData(macOS):`~/Library/Application Support/clipiq/`

- `config.json` — providers / taskSlots / audioSlot / defaultAnalysis / lastLlamaModelKey
- `data.db` — SQLite 项目元数据
- `projects/<projectId>/` — 抽帧 / 转码 / 分析结果 artifact
- `models/llama/<modelKey>/` — 本地 LLM 权重(GGUF + mmproj)
- `models/whisper/` — whisper.cpp 模型
- `bin/llama-cpp-<release>/`、`bin/whisper-cpp/` — sidecar 二进制
- `sidecars/*.json` — sidecar PID 文件,用于跨会话接管(electron 重启后自动 adopt orphan 进程)
- `url-cache.json` — yt-dlp 下载缓存,`fromCache: true` 走这里命中
