# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

ClipIQ 是一个 Electron 桌面视频分析工具。看视频 → 抽帧 + 字幕 → LLM 拉片 → 节点时间轴 + 方法论审计。

## Repo overview

- **Electron 桌面应用**,不是纯 Web。React 19 + Vite + Tailwind 4 渲染层,Node main 进程(`electron/main.cjs`)负责本地能力。
- **Main 进程**:ffmpeg / ffprobe / yt-dlp / SQLite 元数据存储 / `media://` 协议 / 本地 sidecar(llama.cpp + whisper.cpp)/ 分析管线编排。
- **Renderer**:SPA 单 React app。屏幕切换用 navigation store 的两层 `AppLocation`(`currentLocation` / `setLocation`),不用 react-router;旧 `ScreenState` / `setCurrentScreen` 是迁移期兼容层。
- **IPC 表面**:只通过 `electron/preload.cjs` 暴露的 `window.videoAnalyzer.*`,类型在 `src/electron-api.d.ts`。renderer 不直接 import `electron`。
- **浏览器预览模式**:`npm run dev` 单跑(不带 Electron)走 fallback,本地能力不可用,UI 显示"浏览器预览环境"提示。这是有意保留的 fallback,不要让代码假设 `window.videoAnalyzer` 一定存在。

## Common commands

| 场景 | 命令 |
|---|---|
| 完整 dev(推荐) | `npm run electron:dev` — 起 Vite + Electron,renderer 有 HMR |
| 仅前端预览 | `npm run dev` (port 5757) |
| 生产 build 联调 | `npm run electron:preview` — 测 `base:"./"` 那条路径,真实加载方式 |
| Type 校验 | `npm run lint` (= `tsc --noEmit`) |
| 测试 | `npm test`(Vitest 一次性)/ `npm run test:watch` |
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

URL 拉取通过 `window.videoAnalyzer.downloadVideo(url)` 调 yt-dlp,返回 `DownloadedVideo`(含 `videoId / title / mediaUrl / filePath / platform / fromCache`)。

`fromCache: true` 表示 url-cache 命中,没真跑 yt-dlp 二次下载。新加 url-cache 入口时不要破坏 fromCache 反馈。

本地文件通过 `inspectVideoPath(filePath)` 取元数据,通过 `getPathForFile(file)` 从 File 对象拿 Electron 真实路径。两条路径都在 `src/screens/HomeScreen.tsx` 的 composer / drop / file-picker 三个入口。

## 不要做的事

- 不要把 `url_pull` screen 当主入口 —— 已合并到 Home composer(`AppLocation` 仍保留该 screen 并路由到 HomeScreen,避免破坏外部引用,但用户不再从那里发起)。
- 不要在拉片管线代码里直接拼 console.log;用 main.cjs 的 progress event 通过 `onAnalysisProgress` 上报,UI 由 Progress 屏的 log feed 累积渲染。
- 不要在 settings 里同时存"deprecated derived getter"和 v2 schema 字段;v2 已完成,getter 是迁移期残留。

## 架构关键文件

- `electron/main.cjs` — IPC 注册 + 项目生命周期 + 分析管线(prefilter → shot-merger → summarizer → 主分析)。
- `electron/ipc-contract.cjs` — IPC channel manifest 的入口(实际 `CHANNELS` 数组定义在 `preload.cjs`,本文件反向 re-export 给 main/测试 + 派生启动校验用的 channel 列表)。
- `electron/preload.cjs` — 唯一 `window.videoAnalyzer.*` 暴露面;**从顶部 `CHANNELS` manifest 循环生成,不手写**。详见下方"渐进式升级约定"。
- `electron/llama-runtime.cjs` — 本地 llama.cpp sidecar。**单例 server,同一时刻只跑一个 model;切换先 stop 再 start**(5–15s 冷启动)。从 `local-models.manifest.cjs` 读模型清单。
- `electron/whisper-cpp-runtime.cjs` — 本地 whisper.cpp sidecar(同样单例结构)。
- `electron/daemon-client.cjs` — ai-model-daemon IPC 客户端(模型下载 / 硬件检测 / fit 计算 / 推荐排序)。
- `src/AppContext.tsx` — 兼容门面(`useApp`),聚合 navigation / selection / config / progress 四个 zustand store + TanStack Query 数据;屏幕路由实际在 navigation store,config 持久化(debounced 250ms `saveConfig`)实际在 `src/stores/config.ts`。
- `src/screens/SettingsScreen.tsx` — 7 个 section(`SECTIONS` 数组):供应商 / 任务分配 / 本地推理 / 本地依赖 / 默认分析 / 浏览器插件桥 / 项目数据。每个 section 独立组件。
- `src/types.ts` — `AppConfig` / `AnalysisOptions` / `LocalModelEntry` / `MachineSpecs` / `TaskSlots` schema source of truth。

## 渐进式升级约定(数据层 / IPC 契约 / TS)

**总原则:不做 big-bang 重写。后面迭代碰到哪块,就把那块升级掉(touch-it-then-upgrade)。** 下面几条都按这个节奏走,不要为了"统一"去全量改 `main.cjs`(1.5 万行,全量改正是回归高发区)。

- **数据层:逐步退役手写 SQL + `rowToX` 映射。** 现状是 `main.cjs` 里 ~95 个 handler 各自 `db.prepare(...)` + 手列字段 + 手写 row↔对象映射,已酿成两次数据丢失 bug(见铁律)。方向是收进一层薄 repo/数据访问层(列↔字段映射读写**共用一份**、upsert 带显式 merge/replace 语义、JSON 列统一序列化),将来可在这层后面换 ORM。**选型已定:Drizzle**(跟 `agentara/` 一致、原生支持 better-sqlite3 sync、schema 即类型)。**碰到哪张表的读写就把它收编进 repo 层,别一次性全迁;repo 层就是以后换 Drizzle 的接缝。**
- **铁律(repo 层存在的根本原因,任何 DB 写法都要守):** ① partial 写 JSON 列(如 `analyses.result`)落库端必须 **merge,不能整列覆盖**;② **"读取"路径绝不能触发"写回"副作用**。两次真实事故:`analyses:updateResult` 整列覆盖 + 缓存分两次 partial 写,冷加载读时把 nodes 冲没(已改合并 + 冷加载用 `hydrateAnalysis` 只灌内存不写回);methodology 存独立 `methodologies` 表但 renderer 从不读回、`accounts:upsert` 又没这列,重启即丢(已在 `accounts:list` 批量回填)。整行 upsert(videos/accounts/sessions/…)目前靠调用方 spread 完整对象才安全,属脆弱,收编时改掉。
- **TS:渐进式切换,地基已就位。** electron 侧已能让 `.ts` 与现存 `.cjs` 共存运行,迁哪块迁哪块、不会"写完 TS 跑不起来":
  - **怎么迁一个模块**:`git mv foo.cjs foo.ts` → 把 `module.exports` 改 `export`、补类型;**调用方的 require 去掉后缀**(`require("./foo")`,不是 `./foo.cjs` 也不是 `./foo.ts`)。范例见 `electron/model-detection-rules.ts` + `main.cjs` 的 require 点。
  - **两条加载路径**:dev(`!app.isPackaged`)走 `main.cjs` 顶部的 `require("tsx/cjs")` hook 直接跑 `.ts`;prod 走 `scripts/build-electron.cjs`(esbuild 逐文件 `format:cjs` 编成同名 `.js`,`npm run build` 自动带上,打进 asar)。两条都靠"无后缀 require"对齐。
  - **关键约束**:① 编译产物 `.js` 必须是 CJS —— 靠 `electron/package.json`(`{"type":"commonjs"}`)把本目录从根的 `type:module` 里拽回 CJS,**别删**;② 编译 `.js`/`.js.map` 已 gitignore(`*.test.js` 是真源码,用否定规则保住);③ `electron:dev` 启动前跑 `clean-electron-ts-js.cjs` 清旧产物,避免 prod build 残留的 `.js` 在 dev 反向遮蔽 `.ts`。
  - **类型检查**:`npm run lint` = root tsc(检 src + electron `.cjs`)+ `electron/tsconfig.json`(CommonJS 语义,只检 electron `.ts`)。新 `.ts` 自动纳入。
  - **不在范围**:preload 暂留 `.cjs`(sandbox 子进程加载,main 的 require-hook 管不到,迁 TS 需单独预编译)。main.cjs(40 万字节)不重写,继续 touch-it-then-upgrade。
- **IPC 契约已 manifest 化:** 加 / 改 IPC **只改 `preload.cjs` 顶部的 `CHANNELS` 数组**(manifest 唯一源)。preload 由它循环生成方法,不要手写;main 启动 `assertIpcContract` 对缺 handler 直接 fail-fast。⚠️ preload 在 Electron sandbox 下只能 `require("electron")`、**不能 require 本地文件**,所以 manifest 定义在 preload 自身、`ipc-contract.cjs` 反向 re-export。
- **测试:已有 Vitest 套件(`npm test` / `npm run test:watch`)。** 改到 stores / 后端纯模块 / IPC 时顺手补测;`test/contract.test.ts` 守 IPC 三层一致(改 manifest 后它会校验),`*.test.{js,ts,tsx}` 就近放。

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

- `config.json` — electron-store 写入;providers / taskSlots / audioSlot / pipelineSlots / defaultAnalysis / localModelOverrides / lastLlamaModelKey
- `data.db` — SQLite 元数据(videos / analyses / collections / accounts / pipelines / methodologies / studio_sessions)
- `videos/<videoId>/` — 抽帧 / 转码 / 分析结果 artifact(如 `analyses/<analysisId>/analysis-result.json`)。统一走 `getVideoDir`(旧 `projects/` 目录与 `getProjectDir` 别名已在一次性迁移中清除)
- `accounts/<accountId>/` — 账号视频下载的媒体文件(`videos.local_path` 指向这里)
- `media://project/<videoId>/<rel>` 协议解析到 `videos/<videoId>/<rel>`(host 字面量仍叫 `project`,是历史命名,URL 存在 DB thumbnail_url 里,未改)
- `models/llama/<modelKey>/` — 本地 LLM 权重(GGUF + mmproj)
- `models/whisper/` — whisper.cpp 模型
- `bin/llama-cpp-<release>/`、`bin/whisper-cpp/` — sidecar 二进制
- `sidecars/*.json` — sidecar PID 文件,用于跨会话接管(electron 重启后自动 adopt orphan 进程)
- `url-cache.json` — yt-dlp 下载缓存,`fromCache: true` 走这里命中
