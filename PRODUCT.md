# ClipIQ 产品规划

本文档记录 ClipIQ 当前形态、未来诉求、目标信息架构（IA）、各页面的内容与跳转关系，以及落地路径。

- **现状**：单视频分析工具，从首页 → 准备 → 进度 → 工作台 → 报告的线性流。
- **目标**：演进为"创作者剪辑助手"，包含 **分析 / 素材库 / 对标账号 / 剪辑助手** 四个并列工作流。
- **前提**：项目尚未发布，本地开发阶段，无历史数据迁移包袱 —— 这是做 IA 重构的最佳窗口。

---

## 1. 现状

### 1.1 当前形态

- Electron 桌面应用，React 19 + Vite + Tailwind 渲染层，Node main 进程负责本地能力（ffmpeg / yt-dlp / SQLite / llama.cpp + whisper.cpp sidecar）。
- 屏幕路由不用 react-router，而是 `AppContext` 内的 `ScreenState` 字符串联合（七屏）。
- 单一 Project 实体：`Project = 一条视频 + 一份分析报告`。SQLite 表 `projects` + artifact 目录 `~/Library/Application Support/clipiq/projects/<projectId>/`。
- 已有的弹幕情绪带、节点观众反应、词云属于"分析"模块的子产物，不是独立模块。

### 1.2 现有页面（7 屏）

`ScreenState = "home" | "settings" | "url_pull" | "prepare" | "progress" | "workspace" | "report"`

#### HomeScreen — 首页 / 项目枢纽

- **职责**：创建新项目或管理已有项目的中心枢纽。
- **主要内容**：
  - 品牌头部 + 欢迎文案
  - Composer 输入框（粘贴链接、拖入文件、输入本地路径，三合一）
  - 分析强度预设选择（快速 / 标准 / 深度）
  - 高级参数展开面板（视频类型、分析模式、节点密度、关注重点）
  - 最近项目列表（全部 / 进行中 / 已完成 / 失败 分类）
  - 项目行卡片（缩略图、名称、时长、更新时间、状态徽章、删除）
- **进入**：应用启动。
- **跳转**：→ `progress`（新视频开始分析）/ `prepare`（未分析的项目被点击）/ `workspace`（已完成的项目被点击）。
- **状态读写**：读 `projects` / `activeProjectId`；写 `projects`（增删改）、`activeProjectId`、`analysisOptions`。

#### PrepareScreen — 分析前确认

- **职责**：开跑前的参数确认与环境检查。
- **主要内容**：
  - 视频卡片（预览、时长、名称、来源、分辨率、朝向）
  - Preset 强度卡片（轻 / 标准 / 深度，附节点数、字幕、审计说明）
  - 自定义高级参数展开区（视频类型、节点密度、关注重点、分析模式）
  - 依赖缺失警告（ffmpeg/ffprobe）+ API Key 缺失提示
  - CTA 区块（Preset 摘要 + 开始 / 重新分析按钮）
- **进入**：从 `home` 点击未分析的项目。
- **跳转**：→ `progress`（开始分析）/ `home`（返回）/ `workspace`（项目已完成时跳过看现有结果）/ `settings`（修依赖）。
- **状态读写**：读 `activeProject`、`defaultAnalysis`、`providers`、`runtimeStatus`；写 `projects.analysisOptions`、`status → analyzing`、`providerId`、`model`。

#### ProgressScreen — 分析进度

- **职责**：实时展示分析进度，可后台运行 / 取消。
- **主要内容**：
  - 顶部信息栏（任务名、拉片类型、已用时间）
  - 进度卡片（项目名、时长、进度条、百分比、ETA）
  - 错误提示（失败时）
  - 流水线卡片（8 个分析阶段的进度指示）
  - 实时日志（最新 30 条，含时间戳 / 阶段 / 消息）
  - 操作按钮（取消、后台运行）
- **进入**：`prepare` 点"开始" 或 `home` 点进行中的项目。
- **跳转**：→ `workspace`（完成自动跳）/ `home`（后台运行 / 取消）/ `prepare`（取消后回去）。
- **状态读写**：读 `activeProject`、`providers`；写 `projects.status`、`nodes`、`report`、`updatedAt`。

#### WorkspaceScreen — 视频工作台

- **职责**：交互式视频审片 + 节点浏览与标记。
- **主要内容**：
  - 顶部工具栏（返回、项目名、朝向徽章、来源链接、报告按钮、运行状态）
  - 左侧：视频播放器 + 控制 + 进度条节点标记 + 弹幕情绪条带
  - 右侧节点侧边栏：全局概览 + 三个 Tab
    - 逻辑节点：搜索、高光筛选、节点卡片（缩略图、时间、情绪、方法论命中/违反、观众反应）
    - 镜头：镜头卡片（英雄帧、时间范围、描述、字幕片段）
    - 概览：总节点数、重点比例、平均置信度、情绪分布、节点类型分布、重点速览
- **进入**：`progress` 完成、`home` 点已完成项目、`report` 返回。
- **跳转**：→ `home` / `report`。
- **状态读写**：读 `activeProject`、`nodes`、`report`；写 `nodes.isHighlight`、`nodes.note`、跨屏 `sessionStorage` 待跳时间。

#### ReportScreen — 详细报告

- **职责**：结构化展示分析报告（结构 / 方法论 / 情感 / 节奏 / 剪辑 / 构图 / 观众反应 / 洞察）。
- **主要内容**：
  - 左侧 9 章节目录 + scroll spy
  - 主区：标题、元数据、导出（JSON/CSV/MD）、耗时分布、一句话定调、综合评分、整体摘要
  - 结构拆解（分段时间线）、方法论诊断、情感曲线（SVG）、节奏、剪辑、构图、观众反应（5 维柱 + 词云）、核心洞察
  - 右侧粘性重点节点缩略图导航
- **进入**：`workspace` 点"报告"。
- **跳转**：→ `workspace`（返回 / 点缩略图跳片段）/ `prepare`（改类型重新分析）。
- **状态读写**：读 `activeProject`、`report`、`nodes`；写 `analysisOptions.manualGenre`、`sessionStorage` 跳转时间。

#### SettingsScreen — 设置中心

- **职责**：应用全局设置。
- **主要内容**：左侧 6 段分类导航 + 主区，包含 供应商 / 任务分配 / 本地推理 / 本地依赖 / 默认分析 / 项目数据。
- **进入**：`prepare` 依赖缺失跳入，或全局任意位置打开。
- **跳转**：→ `home`。
- **状态读写**：读写 `providers` / `defaultAnalysis` / `projects` / `runtimeStatus` 等。

#### UrlPullScreen — 已废弃

- 功能已并入 `HomeScreen` 的 composer，文件保留避免破坏外部引用，用户不再从这里发起。

---

## 2. 未来诉求

### 2.1 三块新能力

| 模块 | 用户想做什么 |
|---|---|
| **素材库** | 把拍摄素材上传，自动分镜 + 描述每个镜头的内容，建可检索的镜头索引。 |
| **对标账号** | 输入对标 up 主账号，拉热门视频批量分析，汇总这个人的"视频方法论"。 |
| **剪辑助手** | 输入剪辑目标，结合素材库 + 方法论，自动推荐剪辑思路 / 缺失镜头清单 / 脚本草稿。 |

### 2.2 产品定位的演进

```
现在  →  "视频分析工具" (单条视频拉片出报告)
目标  →  "创作者剪辑助手 / Copilot" (素材 → 学习 → 产出 闭环)
```

定位升级的副作用：原本作为终态产物的"弹幕情绪带 / 方法论审计 / 节点时间轴"，在新定位里位置会调整 ——

- 在"分析"模块下：仍然是终态产物（用户主动开一条视频深入研究的输出）。
- 在"对标账号"模块下：降级为中间步骤（多条视频的分析汇总成账号 methodology 才是终态）。
- 在"剪辑助手"模块下：成为输入素材（被引用，不被消费）。

---

## 3. 未来 IA

### 3.1 顶层四模块

左侧 sidebar 四个 workspace 并列，设置走右上角齿轮不占 sidebar：

```
┌────────────┬───────────────────────────────────────────────┐
│  ClipIQ    │                                               │
│            │                                               │
│  ▸ 分析     │   ← 现有 home/prepare/progress/workspace      │
│            │     /report 收纳到这里作为"分析"模块的子流      │
│  ▸ 素材库   │                                               │
│            │   ← 新:拍摄素材入库 + 自动分镜                │
│  ▸ 对标账号 │                                               │
│            │   ← 新:账号拉片 + 方法论汇总                  │
│  ▸ 剪辑助手 │                                               │
│            │   ← 新:素材 × 方法论 → 剪辑思路 / 脚本         │
│  ─────     │                                               │
│  ⚙ 设置    │   ← 右上角齿轮,不占 sidebar                   │
└────────────┴───────────────────────────────────────────────┘
```

老的"分析项目"作为"分析"模块的当前形态完整保留 —— 七屏内部结构不动，只是外壳从"App 唯一主线"挪到"四个并列工作流之一"。

### 3.2 ScreenState 演进

`ScreenState` 从扁平 string union 改成两层结构：

```ts
type AppLocation =
  | { module: "analysis";  screen: "home" | "prepare" | "progress" | "workspace" | "report" }
  | { module: "library";   screen: "list" | "upload" | "shot-detail" }
  | { module: "account";   screen: "list" | "detail" | "methodology" }
  | { module: "studio";    screen: "list" | "editor" }
  | { module: "settings" };
```

这一步是后续三块能并行开发的前提。继续往扁平 `ScreenState` 里 append 新 string，会很快出现 `"library_shot_detail_from_studio"` 这种屎山。

### 3.3 数据模型演进

现在：`Project = 一条视频 + 一份分析报告`。

演进：在共享底座上分 `kind`：

```
VideoArtifact  (复用现有 projects 表 + artifact 目录)
  ├─ kind: "analysis"        ← 老的分析项目, 全量保留
  ├─ kind: "asset"           ← 素材库的素材, 增加 Shot[] 索引
  └─ kind: "account_video"   ← 对标账号下的某条视频, 增加 accountId 关联

Account (新表)
  ├─ videos: VideoArtifact[]
  └─ methodology: { hooks, pacing, structure, ... }    ← 跨视频汇总产物

StudioSession (新表)
  ├─ goal: string
  ├─ usedAssets: AssetRef[]
  ├─ appliedMethodology: AccountRef
  └─ output: { cutList, missingShots, scriptDraft }
```

迁移：现有 `projects` 表加 `kind` 字段，旧数据默认 `'analysis'`。Artifact 落盘格式三种 kind 共用，目录路径沿用 `projects/<id>/`。

### 3.4 底层能力复用

| 新需求 | 复用的现有能力 | 增量 |
|---|---|---|
| 素材分镜 | `analyzeProject` 全管线 + shot-merger | 新增 `shot` 索引表 + 用途标签 prompt |
| 拉对标账号视频 | yt-dlp + url-cache + B 站弹幕拉取 | 加"按 up 主列视频" yt-dlp 命令 |
| 账号方法论 | 现有的方法论审计输出 | 跨多条视频的 LLM 汇总 prompt |
| 剪辑思路推荐 | 无新底层 | 一组新 prompt + Studio UI |
| 全局任务队列 | llama / whisper 单例 sidecar | 抽出全局"运行中任务"面板,三模块共享 |

---

## 4. 各模块的子页面与跳转

### 4.1 分析模块（保留现状）

子流：

```
home → prepare → progress → workspace ⇄ report
                   ↓
                 (后台运行可回到 home, home 上的 in-progress 项目能再点回 progress)
```

页面内容见 §1.2，不变。

### 4.2 素材库模块（新）

子流：

```
library-list → upload (composer) → progress (共享组件) → shot-list ⇄ shot-detail
```

#### LibraryListScreen — 素材库列表

- **职责**：浏览所有已入库素材，按时间 / 标签 / 用途 / 项目筛选。
- **主要内容**：
  - 顶部 composer：上传按钮 / 拖入区（复用 HomeScreen 输入逻辑）
  - 筛选栏：拍摄日期 / 标签 / 已用过 / 未用过
  - 素材网格：缩略图（首帧 + hover 播放）、文件名、时长、镜头数、入库时间
  - 空状态引导
- **跳转**：→ `upload`（点上传）/ `shot-list`（点单条素材）/ `studio editor`（"用这条做新剪辑"动作）。

#### UploadScreen — 上传 / 分镜中

- **职责**：素材入库的过渡屏，多条同时上传时显示队列。
- **主要内容**：拖入区、队列卡片（每条的进度条 + 当前阶段 + ETA）。
- **跳转**：→ `library-list`（关闭）/ `shot-list`（单条完成后可直接进）。

#### ShotListScreen — 素材的镜头列表

- **职责**：单条素材入库后的核心视图，列出自动分镜结果。
- **主要内容**：
  - 顶部：素材元信息（名称、总时长、拍摄日期、标签编辑）
  - 左侧：视频播放器（同 WorkspaceView 复用）+ 进度条上的镜头边界标记
  - 右侧：Shot 卡片列表（编号、时间范围、缩略图、自动描述、用途标签、镜头类型 wide/medium/close）
  - 每条 Shot 卡片操作：编辑描述 / 改用途标签 / 加入收藏 / 在剪辑助手里用
- **跳转**：→ `library-list`（返回）/ `shot-detail`（点单个 Shot）/ `studio editor`（"用这条/这段做剪辑"）。

#### ShotDetailScreen — 单个镜头详情

- **职责**：单镜头的全部元数据 + 出现在哪些剪辑里。
- **主要内容**：放大预览、完整字幕、自动描述、用途建议、相似镜头推荐（"你的库里还有 3 个相似镜头"）、被引用记录。

### 4.3 对标账号模块（新）

子流：

```
account-list → add-account → batch-progress → account-detail
                                                  ├→ video-list → workspace (壳内复用)
                                                  └→ methodology
```

#### AccountListScreen — 账号列表

- **职责**：管理所有对标账号。
- **主要内容**：
  - 添加账号入口（输入账号链接 / ID，平台自动识别）
  - 账号卡片：头像、昵称、平台、已分析视频数、方法论生成时间、刷新按钮
- **跳转**：→ `add-account` / `account-detail`。

#### AddAccountScreen — 添加账号

- **职责**：粘贴账号链接、选择拉取范围（热门 Top 10 / 最近 N 条 / 全部）、确认开跑。
- **主要内容**：链接输入、平台识别、范围选项、分析配置（视频类型默认值、模型、采样密度，会批量套用到这个账号下所有视频）。
- **跳转**：→ `batch-progress`。

#### BatchProgressScreen — 批量拉片进度

- **职责**：账号下多条视频同时分析的总进度视图。
- **主要内容**：账号信息 + 总进度（X / N 完成）+ 每条视频的子进度行（复用 progress 子组件）+ 失败重试。
- **跳转**：→ `account-detail`（全部完成自动跳）/ `account-list`（后台运行）。

#### AccountDetailScreen — 账号详情

- **职责**：该 up 主的视频列表 + 方法论入口。
- **主要内容**：
  - 顶部：账号元信息、刷新拉取按钮、当前方法论摘要卡片
  - Tab 1 视频列表：每条视频的卡片（缩略图、标题、时长、发布时间、分析状态、关键节点速览）
  - Tab 2 方法论概览：从单条视频跳来的 inline 入口
- **跳转**：→ `account-list`（返回）/ 单条视频壳内 workspace（点视频卡片）/ `methodology`（看方法论详情）。

#### AccountVideoWorkspace（不是新屏，是壳）

- 重要：**与"分析模块"的 WorkspaceScreen 复用同一个 `<WorkspaceView>` 组件**，外面包账号模块的导航壳：

  ```tsx
  <AccountShell breadcrumbs={["对标账号", account.name, video.title]}>
    <WorkspaceView projectId={pid} />
  </AccountShell>
  ```

- 返回键回到 `account-detail`，不跳到分析模块。
- 与分析模块视频的差异：不进"最近分析"列表 / 不出现 PrepareScreen（账号级配置统一）/ 分析结果除单条可看外，还会被汇总进 methodology。

#### MethodologyScreen — 账号方法论

- **职责**：跨该账号多条视频汇总出的方法论。
- **主要内容**：
  - 开头风格（hooks）：常用开场套路 + 引用视频片段
  - 节奏画像（pacing）：平均镜头时长、信息密度、情绪曲线模板
  - 结构模板（structure）：典型段落结构 + 段落占比
  - 标签 / 选题倾向
  - 视觉风格（构图 / 色调 / 字幕模板）
  - 每条结论都可点开看引用了哪些视频的哪些片段
- **跳转**：→ `account-detail` / 点引用片段 → 该视频的壳内 workspace。

### 4.4 剪辑助手模块（新）

子流：

```
studio-list → studio-editor (单页, 多 panel 切换)
```

#### StudioListScreen — 剪辑会话列表

- **职责**：所有正在进行 / 已完成的剪辑会话。
- **主要内容**：会话卡片（目标摘要、用了哪些素材、应用了哪个账号方法论、最后编辑时间、产出状态）+ 新建按钮。
- **跳转**：→ `studio-editor`。

#### StudioEditorScreen — 剪辑助手工作台

- **职责**：单个剪辑会话的工作台。这是整个新功能的"产出屏"。
- **主要内容**（左中右三栏）：
  - **左栏 输入设置**：剪辑目标输入框、目标平台 / 时长、应用的账号方法论选择（可多选）、引用的素材池（从素材库勾选）
  - **中栏 推荐输出**：
    - 剪辑思路（叙事结构骨架）
    - 镜头时间线（推荐用素材库里的哪些 Shot 拼）
    - 缺失镜头清单（按方法论需要但素材库里没有的镜头）
    - 脚本草稿（旁白 / 字幕 / BGM 建议）
  - **右栏 引用面板**：选中某个推荐项时，显示它引用的素材 Shot / 方法论条目（hover 预览片段）
- **跳转**：→ `studio-list`（返回）/ `library-list`（点缺失镜头清单→去库里找）/ 单条素材 / 账号 / 视频片段（点引用）。

### 4.5 设置 + 全局任务面板

#### SettingsScreen — 现状基本保留

- 六段分类不变。新增可能：素材库存储管理、账号默认拉取范围、剪辑助手默认模板。
- 入口从"占一个屏"改成全局右上角齿轮浮层 / 抽屉，不打断当前模块。

#### GlobalTaskQueuePanel — 新增全局任务面板

- **为什么需要**：本地 llama / whisper sidecar 是单例，三个模块都可能下发任务（分析单条视频 / 批量拉账号 / 素材入库），需要一个统一视图。
- **形态**：右上角任务徽章 + 点开浮出抽屉。
- **内容**：
  - 当前运行任务（项目名 + 阶段 + 进度 + ETA）
  - 队列任务（按"所属模块 / 所属账号 / 所属素材批次"分组）
  - 失败重试 / 取消
  - 点任务行可直接跳到对应模块的 progress 视图

---

## 5. 跨模块流动

模块之间留出口，避免变成四个孤岛：

```
账号下的视频  ─ "提取为独立分析项目"  ─→  分析模块 (改 kind 或加 alsoPinAs)
账号下的视频  ─ "截一段加入素材库"    ─→  素材库 (派生 asset)
素材库 shot   ─ "在哪些账号里见过类似镜头" ─→  对标账号 (反查)
素材库 shot   ─ "拿来做剪辑"           ─→  剪辑助手 (新 session 预填)
账号方法论    ─ "应用到剪辑会话"       ─→  剪辑助手 (新 session 预填)
分析项目      ─ "把其中某段加入素材库"  ─→  素材库 (派生 asset)
```

实现上零数据复制，都是 SQLite 引用关系。

---

## 6. 落地路径

### Phase 0 — 骨架迁移（1 个 PR）

- 加 sidebar 组件
- `ScreenState` 改成两层 `AppLocation`
- 现有七屏全部挪到 `module: "analysis"` 下，逻辑不动
- `projects` 表加 `kind` 字段，default `'analysis'`
- 三个新模块入口先留空壳页（"即将上线"）
- 设置改成右上角齿轮入口

**验收**：现有所有功能行为不变，sidebar 可见三个新模块占位。

### Phase 1 — 素材库（独立 feature 分支）

- ShotListScreen / ShotDetailScreen + `kind: 'asset'` 数据流
- 复用 `analyzeProject` 管线 + shot-merger，加 shot 索引表
- 上传 composer 复用 HomeScreen 逻辑
- 全局任务面板初版

### Phase 2 — 对标账号（独立 feature 分支）

- yt-dlp 加"按 up 主列视频"能力
- AccountListScreen / AccountDetailScreen / BatchProgressScreen / MethodologyScreen
- AccountShell 包 WorkspaceView 复用
- 跨多视频的 methodology 汇总 prompt

### Phase 3 — 剪辑助手（独立 feature 分支）

- StudioListScreen / StudioEditorScreen
- StudioSession 表 + 推荐 prompt
- 跨模块流动入口（在素材库 / 账号 / 分析三处都加"加入剪辑会话"动作）

### 不要在哪个 Phase 做的事

- **Phase 0 不要顺手把组件改成 token / 重做设计稿** —— 骨架迁移就只挪文件 + 改 ScreenState，混着改会让 PR 变成无法 review 的 mega diff。
- **Phase 1/2/3 之间不要互相依赖** —— 每个 phase 完成后能独立 ship，避免 "做了一半的素材库要等账号做完才能用"。

---

## 附：术语对照

| 术语 | 含义 |
|---|---|
| Project / VideoArtifact | 视频+分析产物的共享底座，有 kind 区分 |
| analysis | kind = 分析模块下用户主动开的单条视频 |
| asset | kind = 素材库下的拍摄素材 |
| account_video | kind = 对标账号下的某条对标视频 |
| Shot | 素材内的单个镜头，含时间范围 + 描述 + 用途标签 |
| Account | 对标对象，包含 videos[] + methodology |
| Methodology | 跨多视频汇总出的账号方法论 manifest |
| StudioSession | 剪辑助手的单个工作会话 |
| WorkspaceView | 视频审片组件，分析模块和账号模块共用 |
| AppLocation | 两层屏幕路由，替代扁平 ScreenState |
