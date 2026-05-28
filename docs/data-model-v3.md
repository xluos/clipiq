# ClipIQ 数据模型 v3 设计

## 核心问题

当前模型把"视频"这个概念拆散在三个地方：

- `projects` 表（用户直接丢进来的视频, kind=analysis）
- `projects` 表（素材库视频, kind=asset）
- `account_videos` 表（从账号拉取的视频）

同一个视频在不同上下文里有不同的 ID、不同的存储路径、不同的元数据结构。要回答"这个视频被分析过几次"需要跨两张表查。

未来还要加收藏夹（视频可以跨收藏夹引用）、多种分析管线（同一视频可以跑不同管线）、用户自定义管线，当前模型会更加割裂。

## 设计原则

1. **视频是一等实体**。不管从哪来，一个视频文件/URL 对应一条 `videos` 记录
2. **分析和视频解耦**。分析是对视频的一次操作，带上用了哪条管线、什么参数
3. **收藏夹是视图层**。M:N 关系，不影响视频本身的存储
4. **管线可扩展**。内置管线和用户自定义管线同构，存同一张表
5. **SQL 列存结构化字段，JSON 存非结构化内容**。可查询的字段（platform、status、account_id）提到 SQL 列；nodes/report/methodology 这种大 blob 继续 JSON

---

## ER 图

```
┌──────────────────────┐          ┌──────────────────┐
│      accounts        │          │    pipelines      │
├──────────────────────┤          ├──────────────────┤
│ id             PK    │          │ id           PK  │
│ name                 │          │ name             │
│ platform             │  TEXT    │ builtin     BOOL │
│ external_id          │          │ stages      JSON │ ← 阶段定义
│ external_url         │          │ slot_config JSON │ ← 默认 slot 分配
│ avatar_url           │          │ description      │
│ bio                  │          │ created_at  INT  │
│ followers       TEXT │          │ updated_at  INT  │
│ tags            JSON │          └────────┬─────────┘
│ fetch_range     TEXT │                   │
│ fetch_phase     TEXT │                   │
│ fetch_error     TEXT │                   │
│ last_fetched_at INT  │                   │
│ analysis_config JSON │ ← slotOverrides   │
│ created_at      INT  │                   │
│ updated_at      INT  │                   │
└──────────┬───────────┘                   │
           │ 1                             │
           │                               │
           ▼ N                             │
┌──────────────────────┐                   │
│       videos         │                   │
├──────────────────────┤                   │
│ id             PK    │                   │
│ title          TEXT   │                   │
│ source_type    TEXT   │ ← url | local    │
│ source_url     TEXT   │                   │
│ platform       TEXT   │ ← bilibili | douyin | ...
│ external_id    TEXT   │ ← 平台原生视频ID   │
│ local_path     TEXT   │                   │
│ duration_sec   REAL   │                   │
│ width          INT    │                   │
│ height         INT    │                   │
│ orientation    TEXT   │                   │
│ thumbnail_url  TEXT   │                   │
│ account_id     FK    │──▶ accounts.id (nullable)
│ status         TEXT   │ ← ready | downloading | failed
│ upload_date    TEXT   │ ← 平台发布日期      │
│ view_count     INT    │ ← 播放量           │
│ like_count     INT    │ ← 点赞             │
│ comment_count  INT    │ ← 评论             │
│ share_count    INT    │ ← 分享             │
│ collect_count  INT    │ ← 收藏             │
│ tags           JSON   │ ← 视频标签         │
│ created_at     INT    │                   │
│ updated_at     INT    │                   │
└──┬────┬────┬─────────┘                   │
   │    │    │                             │
   │    │    │ 1                           │
   │    │    ▼ N                           │
   │    │  ┌──────────────────────┐        │
   │    │  │      analyses        │        │
   │    │  ├──────────────────────┤        │
   │    │  │ id             PK    │        │
   │    │  │ video_id       FK    │──▶ videos.id
   │    │  │ pipeline_id    FK    │────────┘
   │    │  │ status         TEXT  │ ← analyzing | completed | failed
   │    │  │ options        JSON  │ ← { mode, density, genre, ... }
   │    │  │ provider_snapshot JSON│ ← 分析时用的 provider 快照
   │    │  │ result         JSON  │ ← 管线自定义输出 (*)
   │    │  │ token_usage    JSON  │
   │    │  │ duration_ms    INT   │
   │    │  │ error_message  TEXT  │
   │    │  │ started_at     INT   │
   │    │  │ completed_at   INT   │
   │    │  │ created_at     INT   │
   │    │  └──────────────────────┘
   │    │
   │    │  (*) result 列存管线输出，不区分 nodes/report。
   │    │      结构拆解: { nodes: AnalysisNode[], report: AnalysisReport }
   │    │      内容分析: { summary, topic, target, tags, frames, transcript }
   │    │      用户自定义管线: 由管线定义决定 schema
   │    │
   │    │ 1
   │    ▼ N
   │  ┌──────────────────────┐
   │  │        shots         │
   │  ├──────────────────────┤
   │  │ id             PK    │
   │  │ video_id       FK    │──▶ videos.id
   │  │ shot_index     INT   │
   │  │ start_sec      REAL  │
   │  │ end_sec        REAL  │
   │  │ thumbnail_url  TEXT  │
   │  │ description    TEXT  │
   │  │ shot_type      TEXT  │
   │  │ camera_movement TEXT │
   │  │ usage_tags     JSON  │
   │  │ is_favorite    BOOL  │
   │  │ subtitle_text  TEXT  │
   │  │ created_at     INT   │
   │  └──────────────────────┘
   │
   │ M:N
   ▼
┌──────────────────────┐     ┌──────────────────────┐
│    collections       │     │  collection_videos    │
├──────────────────────┤     ├──────────────────────┤
│ id             PK    │◀────│ collection_id  FK    │
│ name           TEXT  │     │ video_id       FK    │──▶ videos.id
│ description    TEXT  │     │ position       INT   │ ← 排序位置
│ kind           TEXT  │     │ added_at       INT   │
│ cover_url      TEXT  │     └──────────────────────┘
│ filter_rules   JSON  │ ← 智能收藏夹规则 (nullable)
│ account_id     FK    │──▶ accounts.id (nullable, 账号自动收藏夹)
│ created_at     INT   │
│ updated_at     INT   │
└──────────────────────┘

┌──────────────────────┐
│   methodologies      │
├──────────────────────┤
│ id             PK    │
│ account_id     FK    │──▶ accounts.id
│ version        INT   │ ← 自增版本号
│ data           JSON  │ ← { hooks, pacing, structure, visual }
│ source_video_count INT│
│ created_at     INT   │
└──────────────────────┘

┌──────────────────────┐
│  studio_sessions     │
├──────────────────────┤
│ id             PK    │
│ goal           TEXT  │
│ target_platform TEXT │
│ target_duration INT  │
│ steps          JSON  │ ← StudioStep[] (引用 videos.id + shots.id)
│ script_draft   TEXT  │
│ output         JSON  │
│ created_at     INT   │
│ updated_at     INT   │
└──────────────────────┘
```

### 关系汇总

| 关系 | 类型 | 说明 |
|---|---|---|
| account → videos | 1:N | 一个账号有多个视频 (`account_id` FK，nullable) |
| video → analyses | 1:N | 一个视频可以跑多次分析 |
| analysis → pipeline | N:1 | 每次分析指定用哪条管线 |
| video → shots | 1:N | 一个视频可以拆成多个镜头 |
| collection ↔ videos | M:N | 通过 `collection_videos` 关联 |
| collection → account | N:1 | 可选，账号自动收藏夹 |
| account → methodologies | 1:N | 方法论版本历史 |
| studio_session → videos/shots | 引用 | steps JSON 内引用 video_id + shot_id |

### 关键设计说明

**accounts 表**：存账号自身信息（名字、平台、头像、粉丝数、标签等）。`analysis_config` 存该账号的默认分析配置（slot 覆盖 + 自定义 prompt）。账号不是收藏夹——收藏夹是额外的视图层，账号与视频的归属关系通过 `videos.account_id` FK 直接表达。

**videos 表的互动数据**：`view_count`/`like_count`/`comment_count`/`share_count`/`collect_count` 作为 SQL 列而非 JSON，支持排序和过滤（"按播放量排序"、"找 10w+ 播放的视频"）。用户直接导入的本地视频这些列为 null。

**analyses.result**：统一的 JSON 列，不区分 nodes/report。不同管线写入不同结构：
- 结构拆解管线写 `{ nodes: AnalysisNode[], report: AnalysisReport }`
- 内容分析管线写 `{ summary, topic, target, tags, frames, transcript }`
- 用户自定义管线写其管线定义决定的 schema
- UI 根据 `pipeline_id` 查到管线类型后，决定用哪个 renderer 展示 result

---

## 管线定义 (pipelines 表)

内置管线和用户自定义管线同构：

```json
// 内置: 结构拆解
{
  "id": "builtin-pipeline",
  "name": "结构拆解",
  "builtin": true,
  "stages": [
    { "key": "prefilter",    "label": "抽帧初筛",     "slot": "simple_vision" },
    { "key": "transcript",   "label": "字幕识别",     "slot": "__audio__" },
    { "key": "shot-merger",  "label": "镜头合并",     "slot": "medium_text" },
    { "key": "main",         "label": "主分析",       "slot": "complex_vision" }
  ],
  "slot_config": {
    "simple_vision": { "providerId": "builtin-local-llama", "modelId": "qwen3_5_4b_q4km" },
    "complex_vision": { "providerId": "default-video", "modelId": "gpt-4o-mini" },
    "medium_text": { "providerId": "default-video", "modelId": "gpt-4o-mini" },
    "__audio__": { "providerId": "builtin-local-whisper", "modelId": "whisper-base" }
  }
}

// 内置: 内容分析
{
  "id": "builtin-content",
  "name": "内容分析",
  "builtin": true,
  "stages": [
    { "key": "transcript",   "label": "字幕识别",     "slot": "__audio__" },
    { "key": "summarize",    "label": "内容分析",     "slot": "complex_vision" }
  ],
  "slot_config": { ... }
}

// 用户自定义: 弹幕情绪分析
{
  "id": "user-danmaku-focus",
  "name": "弹幕情绪",
  "builtin": false,
  "stages": [
    { "key": "transcript",      "label": "字幕识别",      "slot": "__audio__" },
    { "key": "danmaku-fetch",   "label": "弹幕拉取",      "slot": null },
    { "key": "danmaku-emotion", "label": "情绪分析",      "slot": "medium_text" },
    { "key": "main",            "label": "综合报告",      "slot": "complex_vision" }
  ],
  "slot_config": { ... }
}
```

### analyses 表的 pipeline_id

每条分析记录关联到一条管线，这样：
- 同一个视频可以用不同管线分析多次
- 查看历史时能看到"这次用的什么管线、什么参数"
- 管线被删除后，历史分析记录仍保留（pipeline_id 作为快照）

---

## 收藏夹设计 (collections)

三种 kind：

| Kind | 说明 | filter_rules | account_id |
|---|---|---|---|
| `manual` | 手动收藏夹，用户拖拽添加 | null | null |
| `smart` | 智能收藏夹，按规则自动填充 | `{ platform, minDuration, tags, ... }` | null |
| `account` | 账号自动收藏夹，拉取账号视频时自动创建 | null | 指向 account |

`account` 类型的收藏夹在创建账号时自动创建，拉取视频时自动把 video 加入。
用户也可以把任意视频手动拖到任何收藏夹里。
一个视频可以同时出现在多个收藏夹中。

---

## 磁盘文件结构

```
userData/
├── config.json                              应用配置
├── data.db                                  SQLite 主库
│
├── videos/<video_id>/                       每个视频一个目录
│   ├── source.mp4                           原始视频文件
│   ├── thumbnail.jpg                        封面缩略图
│   ├── audio.wav                            提取的音频
│   ├── transcript.json                      字幕结果
│   ├── frames/                              抽帧
│   │   ├── full/                            完整尺寸 (分析用)
│   │   │   ├── 001.jpg
│   │   │   └── ...
│   │   └── thumb/                           缩略图 (UI 用)
│   │       ├── 001.jpg
│   │       └── ...
│   ├── danmaku.json                         弹幕原始数据
│   └── analyses/<analysis_id>/              每次分析的产物
│       ├── result.json                      nodes + report 归档
│       ├── token-usage.json                 token 消耗
│       └── timings.json                     各阶段耗时
│
├── cache/                                   LLM 输出缓存
│   ├── index.db                             缓存索引
│   └── blobs/<scope>/<xx>/<rest>.json       缓存文件
│
└── bin/                                     sidecar 二进制
    ├── ffmpeg
    ├── ffprobe
    └── yt-dlp
```

### 与当前结构的区别

| 当前 | 新方案 | 为什么 |
|---|---|---|
| `projects/<projectId>/` | `videos/<videoId>/` | "视频"是核心实体，不是"项目" |
| 账号视频帧存在 `accounts/<aid>/videos/<eid>/` | 统一存在 `videos/<videoId>/frames/` | 一个视频无论从哪来，文件结构一致 |
| `artifacts/keyframe-01.jpg` 和 `prefilter-01.jpg` 混放 | `frames/full/` 和 `frames/thumb/` 分开 | 清晰区分用途 |
| analysis-result.json 包含完整 project 对象 | result.json 只存 nodes + report | 视频元数据在 DB 里，不重复存 |

---

## 从 v2 到 v3 的迁移路径

迁移可以在 app 启动时一次性完成（SQLite 事务内）：

1. **建新表** — `videos`, `collections`, `collection_videos`, `pipelines`, `methodologies`

2. **projects → videos** — 遍历 projects 表：
   - 每条 project 创建对应 video 记录
   - `project.id` → `video.id`（保持 ID 不变，避免 analyses FK 断裂）
   - `project.source` → `video.source_type` + `video.source_url`
   - `project.kind` → 对于 `account_video`，设 `video.account_id`
   - `project.status` → `video.status`
   - 磁盘目录 `projects/<id>/` → `videos/<id>/`（symlink 或 lazy rename）

3. **account_videos → videos** — 遍历 account_videos 表：
   - 已有 `analysisProjectId` 的：对应 video 已在上一步创建，补充平台元数据到 `video.extra`
   - 没有 `analysisProjectId` 的：创建新 video 记录，`status=ready`，把 `videoSummary` 写到 `video.content_summary`
   - 为每个 account 创建 `kind=account` 的 collection，把该账号视频加入

4. **analyses 不变** — `project_id` 列 rename 为 `video_id`（值不变因为用了 project.id）

5. **shots** — `asset_project_id` rename 为 `video_id`

6. **内置管线** — 插入 `builtin-pipeline` 和 `builtin-content` 两条记录

7. **Account.methodology → methodologies 表** — 拆出独立表存版本历史

8. **删旧表** — `DROP TABLE projects; DROP TABLE account_videos;`（事务最后）

---

## 对 UI / IPC 的影响

| 层 | 影响 |
|---|---|
| **IPC 通道** | `projects:*` → `videos:*`；新增 `collections:*`、`pipelines:*` |
| **AppContext** | `projects[]` → `videos[]`；新增 `collections[]`、`pipelines[]` |
| **路由** | `analysis` 模块的 `project` 概念换成 `video` |
| **HomeScreen** | 从"项目列表"变成"视频列表"或"收藏夹视图" |
| **AccountScreen** | 账号视频直接从 `videos` 表查（`WHERE account_id = ?`） |
| **LibraryScreen** | 素材库视频也是 `videos`（可以通过 collection 或 tag 过滤） |
| **Settings 任务分配** | 管线列表从 `pipelines` 表读，每条管线独立 slot_config |
| **分析触发** | 参数加 `pipeline_id`，不再硬编码管线类型 |
