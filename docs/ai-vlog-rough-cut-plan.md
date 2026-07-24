# ClipIQ AI Vlog 粗剪迭代计划

> 状态：待实施  
> 适用分支基线：`feature/v2`  
> 建议实施分支：`feature/ai-vlog-rough-cut`  
> 更新日期：2026-07-24

## 1. 目标与结论

ClipIQ 从“分析视频”继续演进为“理解用户素材并生成可人工精修的 Vlog 粗剪”。

第一阶段产品出口选择：

- ClipIQ 内部维护稳定、与编辑器无关的 `EditPlan`。
- 使用 FFmpeg 生成低清预览，完成粗剪确认。
- 将确认后的方案导出为剪映草稿，交给用户完成花字、贴纸、复杂转场和最终导出。
- 剪映草稿只是导出格式，不作为 ClipIQ 的数据源或业务模型。

本阶段不引入 OpenCut、Palmier Pro、OpenChatCut 等完整编辑器。可以借鉴其镜头排序、自动重构图和 Agent 工具设计，但不接管它们的时间线、项目文件和渲染体系。

## 2. 用户闭环

目标流程：

1. 用户将生活、旅行、工作等拍摄素材加入素材库。
2. ClipIQ 对素材完成技术质量、镜头语义、对白和事件分析。
3. 用户输入目标，例如“生成一条 60 秒周末露营 Vlog”。
4. ClipIQ 从真实 `Shot` 候选中选择镜头并生成 `EditPlan`。
5. ClipIQ 输出低清预览。
6. 用户执行保留、删除、替换、缩短、重排等粗剪反馈。
7. ClipIQ 重新生成预览并保存用户决策。
8. 用户确认后导出剪映草稿。
9. 用户在剪映中做高级包装和最终导出。

成功标准不是“能生成一个 MP4”，而是：

- 所有镜头都来自用户真实素材。
- 不出现模型虚构时间范围、引用不存在镜头等问题。
- 粗剪叙事基本成立，用户只需精修而不是推倒重剪。
- 剪映草稿可稳定打开，媒体、字幕和音轨不丢失。

## 3. 非目标

首期明确不做：

- 在 ClipIQ 内建设完整专业时间线编辑器。
- 覆盖剪映全部动画、特效、滤镜和模板。
- 解析用户在剪映中产生的所有后续修改。
- 自动生成商业可用的音乐、贴纸或字体授权。
- 让大模型直接填写任意原视频时间码。
- 首期同时支持 Vlog、口播、影视混剪、带货等所有类型。

首期只验证生活记录类短 Vlog，建议目标时长为 30～90 秒。

## 4. 当前实现差距

### P0：数据正确性

- 素材角色目前没有稳定落到 v3 `videos` 数据模型，不能继续依赖旧 `kind = asset` 推断。
- `studio_sessions` 没有完整持久化 `mainShotRatio`、方法论引用、素材引用和缺失镜头等字段。
- 已有完整分析结果中的镜头语义没有稳定沉淀到 `shots`，Studio 使用的镜头信息不足。

### P0：剪辑决策可信度

- Studio 当前传给模型的主要是素材名称、时长和镜头数量。
- 模型会直接生成时间范围，无法保证对应真实镜头。
- 当前 `shots:analyze` 主要是 FFmpeg 场景检测，失败时按固定时长切段，不等于素材语义分析。

### P1：执行与预览

- 当前没有编辑器无关的剪辑中间模型。
- 没有对镜头引用、时间范围、轨道冲突和素材路径做统一校验。
- 没有根据剪辑方案生成可观看的代理预览。

### P2：交付

- 没有剪映版本探测、草稿适配和兼容性测试。
- 没有在剪映导出失败时提供稳定的降级产物。

## 5. 核心架构

```text
Video / Analysis / Shot
          ↓
 Candidate Builder
          ↓
 LLM Planner
  只返回 shotId + 剪辑意图
          ↓
 Deterministic Compiler
  将 shotId 编译为真实时间范围
          ↓
 EditPlan Validator
          ↓
 EditPlan
   ├── FFmpeg Proxy Renderer
   ├── Jianying Draft Exporter
   └── Future Exporters
```

关键边界：

- LLM 负责理解、选择和叙事规划。
- 程序负责时间计算、轨道编排、文件解析和合法性校验。
- 导出器只消费已通过校验的 `EditPlan`。
- UI 不直接拼装剪映草稿 JSON。

## 6. 建议数据模型

所有内部时间统一使用整数微秒 `*Us`，避免浮点秒累积误差。数据库现有秒字段可在读写边界转换。

```ts
export type EditPlan = {
  id: string;
  version: 1;
  sessionId: string;
  status: "draft" | "validated" | "rendered" | "exported";
  canvas: {
    width: number;
    height: number;
    fps: number;
  };
  targetDurationUs: number;
  actualDurationUs: number;
  tracks: EditTrack[];
  transitions: EditTransition[];
  provenance: {
    goal: string;
    genre: "vlog";
    methodologyIds: string[];
    generatedAt: number;
    plannerProvider?: string;
    plannerModel?: string;
  };
  validation: {
    valid: boolean;
    warnings: EditPlanIssue[];
    errors: EditPlanIssue[];
  };
};

export type VideoClip = {
  id: string;
  shotId: string;
  videoId: string;
  sourcePath: string;
  sourceInUs: number;
  sourceOutUs: number;
  timelineInUs: number;
  speed: number;
  volume: number;
  crop?: CropSpec;
  transform?: TransformSpec;
  selectionReason: string;
  confidence: number;
};

export type CaptionCue = {
  id: string;
  startUs: number;
  endUs: number;
  text: string;
  styleId: string;
  wordTimings?: Array<{
    text: string;
    startUs: number;
    endUs: number;
  }>;
};

export type AudioClip = {
  id: string;
  kind: "original" | "voiceover" | "music";
  sourcePath?: string;
  ttsText?: string;
  timelineInUs: number;
  sourceInUs: number;
  sourceOutUs: number;
  volume: number;
  fadeInUs?: number;
  fadeOutUs?: number;
  ducking?: {
    enabled: boolean;
    targetVolume: number;
  };
};

export type OverlayItem = {
  id: string;
  kind: "text" | "image" | "sticker";
  assetPath?: string;
  resourceKey?: string;
  startUs: number;
  endUs: number;
  transform: TransformSpec;
  animation?: {
    in?: string;
    out?: string;
  };
};

export type EditTransition = {
  id: string;
  fromClipId: string;
  toClipId: string;
  type: "cut" | "dissolve" | "fade" | "slide";
  durationUs: number;
};
```

建议新增：

- `edit_plans`：保存内部方案、版本、校验结果和渲染状态。
- `edit_feedback_events`：保存用户对粗剪做出的删减、替换、裁切和重排。
- `export_jobs`：保存剪映或其他格式的导出状态、目标版本、产物路径和错误。

`studio_sessions` 继续负责创作目标、素材和方法论上下文；`edit_plans` 负责可执行时间线。二者不要混为同一份 JSON。

## 7. 素材分析要求

### 7.1 复用已有结果

先将现有完整分析流程中的 `ShotContext` 映射到 `shots`，避免重复调用模型。

每个镜头至少具备：

- `startSec` / `endSec`
- 内容描述
- 景别
- 镜头运动
- 对白或自然声摘要
- 用途标签
- 缩略图

### 7.2 为粗剪补充的特征

技术质量：

- 清晰度、失焦、运动模糊
- 过曝、欠曝
- 抖动程度
- 收音质量和噪声
- 横竖屏和可裁切安全区

语义：

- 人物、地点、动作、物体
- 时间、事件和场景簇
- 情绪和精彩度
- 对白、旁白、自然声
- 重复或近重复镜头

叙事角色：

- `hook`
- `establishing`
- `action`
- `detail`
- `reaction`
- `transition`
- `emotion_anchor`
- `ending`

首期不要追求一次分析覆盖所有特征。允许采用“便宜规则先筛选，候选镜头再用视觉模型精排”的两阶段方式。

## 8. LLM 剪辑规划契约

模型输入必须包含真实候选镜头，至少提供：

- `shotId`
- 所属 `videoId`
- 真实起止时间
- 时长
- 描述
- 技术质量分
- 精彩度
- 叙事角色
- 对白摘要
- 事件或场景簇
- 缩略图或代表帧（视觉模型场景）

模型输出只能引用候选 ID：

```json
{
  "structure": [
    {
      "section": "hook",
      "targetDurationSec": 4,
      "clips": [
        {
          "shotId": "shot_123",
          "preferredDurationSec": 2.5,
          "reason": "露营失败的反差画面，适合作为开场"
        }
      ]
    }
  ],
  "voiceover": [
    {
      "afterShotId": "shot_123",
      "text": "本来以为今天会很顺利。"
    }
  ]
}
```

禁止模型输出：

- 本地文件路径
- 不存在的 `shotId`
- 任意 `sourceIn/sourceOut`
- 剪映资源 ID
- 最终轨道坐标

当模型返回非法引用时，应先尝试结构化修复；仍非法则中止生成并显示明确错误，不能静默替换成随机镜头。

## 9. EditPlan 编译与校验

编译器负责：

- 将 `shotId` 解析为真实素材路径和时间范围。
- 根据目标时长裁切镜头，但不得越过原 Shot 边界。
- 处理相邻镜头、转场占用时间和音频衔接。
- 根据画布方向生成初始裁切建议。
- 把配音、字幕、音乐和贴图放到确定轨道。

校验器至少检查：

- 所有 `videoId`、`shotId` 均存在。
- 所有素材路径存在且可读。
- `sourceInUs < sourceOutUs`。
- 时间范围不超出视频和 Shot 边界。
- 时间线上没有非预期空隙或重叠。
- 转场两端存在足够画面余量。
- 实际时长与目标时长偏差在允许范围内。
- 字幕和音频没有负时间或越界。
- 输出画布、帧率和素材编码可被目标导出器处理。

建议目标时长容差：

- 30～90 秒短 Vlog：`±5%`
- 如果素材不足，允许短于目标，但必须将原因写入 `validation.warnings`。

## 10. 分阶段实施

### M0：数据地基修复

任务：

- [ ] 明确 v3 素材归属：优先使用素材收藏夹或显式 `video_role`，不再通过 `account_id` 推导。
- [ ] 修复 Library 和 Studio 重启后素材消失问题。
- [ ] 扩展 `studio_sessions` 持久化契约，保存素材、方法论、缺失镜头等完整上下文。
- [ ] 将完整分析产生的真实镜头语义写入或同步到 `shots`。
- [ ] 为数据库 migration、row mapper 和 upsert 补测试。

验收：

- 素材导入后重启应用仍在素材库和 Studio 可见。
- Studio 保存后重启，选择的素材、方法论、步骤和缺失镜头不丢。
- 每个被用于剪辑的 Shot 都能追溯到真实视频和时间范围。

### M1：真实候选与剪辑规划

任务：

- [ ] 新增 Vlog 候选镜头构建器。
- [ ] 增加基础质量评分和重复镜头过滤。
- [ ] 将 `prompts/methodology/genre/vlog.md` 的规则转成 planner 可消费的约束。
- [ ] 重写 Studio 生成契约：输入真实 Shot，输出 `shotId` 和剪辑意图。
- [ ] 新增确定性编译器，禁止模型直接生成时间段。
- [ ] 新增 `EditPlan` schema、版本号和校验器。
- [ ] 保存 planner 输入摘要、输出和模型信息，便于复现问题。

验收：

- 连续运行相同固定输入时，不出现非法镜头引用。
- 输出中的每个镜头都能在素材库定位和预览。
- 生成失败时提供可解释错误，不退化为猜测时间段。
- 60 秒目标样例的时长误差不超过 5%，或明确提示素材不足。

### M2：FFmpeg 代理预览

任务：

- [ ] 根据 `EditPlan` 生成统一规格的低清代理素材。
- [ ] 支持画面裁切、排序、硬切和淡化。
- [ ] 支持原声、配音、BGM、音量和基础 ducking。
- [ ] 支持 SRT/ASS 字幕烧录或外挂预览。
- [ ] 显示渲染进度，支持取消和失败重试。
- [ ] 缓存未变化的代理片段，避免每次全量重编码。

建议首期代理规格：

- 720p
- H.264
- AAC
- 固定帧率
- 输出只用于预览，不作为最终高质量成片

验收：

- 30～90 秒固定样例可稳定生成并播放。
- 画面、配音、字幕的同步误差不超过 100ms。
- 用户取消后任务状态和临时文件可正确收敛。
- 修改单个镜头后可以复用未变化片段缓存。

### M3：ClipIQ 内粗剪反馈

首期不做自由时间线，只做结构化编辑：

- [ ] 保留/删除镜头。
- [ ] 替换为候选镜头。
- [ ] 调整镜头前后顺序。
- [ ] 缩短镜头。
- [ ] 修改旁白和字幕。
- [ ] 开关某个转场或贴图建议。
- [ ] 重新生成预览。

每次操作记录到 `edit_feedback_events`：

- 操作类型
- 原镜头和新镜头
- 修改前后时间
- 所属 `EditPlan` 版本
- 操作时间

验收：

- 用户修改不会污染原始素材和 Shot。
- 每次修改产生新的可回滚 `EditPlan` 版本。
- 可以统计模型选择被保留、删除和替换的比例。

### M4：剪映兼容性 Spike

在正式接入前，用目标机器和目标剪映版本验证以下固定用例：

1. 两段视频裁切、排序并打开草稿。
2. 增加原声、BGM 和配音。
3. 导入中文字幕。
4. 增加一种转场和一个自定义图片贴图。
5. 重启剪映后重新打开、保存并手工导出。

对候选实现分别记录：

| 方案 | 评估重点 |
|---|---|
| `capcut-cli` | Node/Electron 接入成本、目标剪映版本兼容性、草稿路径和资源复制 |
| `pyJianYingDraft` | 功能覆盖、macOS 生成草稿限制、新版草稿兼容性 |
| 自建 exporter | 最小草稿结构是否可控、后续维护成本 |

Spike 通过条件：

- 五个固定用例全部能被剪映识别。
- 重启后草稿仍可打开。
- 路径包含中文、空格时可用。
- 源素材移动或缺失时有明确诊断。
- 失败不会覆盖用户现有草稿。

如果目标剪映版本无法稳定生成草稿，M5 不进入正式实现，先使用导出素材包降级。

### M5：剪映草稿导出

首期支持：

- [ ] 视频裁切和排序。
- [ ] 原声、BGM、TTS 配音。
- [ ] 基础字幕和字幕样式。
- [ ] 硬切、叠化、淡入淡出。
- [ ] 自定义图片贴图。
- [ ] 草稿名称、封面和基础画布设置。
- [ ] 导出前版本和路径探测。
- [ ] 导出报告和错误诊断。

复杂效果策略：

- 优先维护少量经过验证的剪映模板。
- ClipIQ 的 `resourceKey` 映射到模板槽位。
- 不在业务逻辑中散落硬编码剪映资源 ID。

降级产物：

```text
export-package/
├── edit-plan.json
├── manifest.json
├── captions.srt
├── voiceover.wav
├── music/
├── media/
└── preview.mp4
```

验收：

- 草稿时间线与 ClipIQ 预览的镜头顺序和裁切一致。
- 字幕、配音时间误差不超过 100ms。
- 导出只创建新草稿，不覆盖已有项目。
- 不支持的效果有明确提示，并可降级为硬切或静态贴图。

### M6：效果增强

只在 M0～M5 稳定后继续：

- [ ] 节拍检测和卡点。
- [ ] 基于人物/主体的横竖屏智能重构图。
- [ ] 情绪段落驱动的 BGM 切换。
- [ ] 字幕关键词高亮。
- [ ] 贴纸和花字模板。
- [ ] 多版本粗剪对比。
- [ ] FCPXML 或 DaVinci 导出。

## 11. 首个可交付 MVP

MVP 场景：

> 用户选择 5～20 条生活素材，输入“做一条 60 秒周末记录”，ClipIQ 生成一版带原声、旁白、基础字幕和简单转场的粗剪预览；用户可以删、换、重排镜头；确认后导出剪映草稿。

MVP 必须具备：

- 只从真实 Shot 选镜头。
- 生成并持久化 `EditPlan`。
- FFmpeg 预览。
- 基础结构化调整。
- 剪映草稿导出或明确的兼容性降级。

MVP 可以暂缓：

- 自动贴纸选择。
- 复杂花字。
- 多首 BGM 情绪编排。
- 智能运镜。
- 自动学习剪映内的后续修改。

## 12. 测试素材与评估口径

建立固定、可重复的本地测试集：

- 10～20 条生活记录视频。
- 同一事件包含全景、人物、动作、细节、反应镜头。
- 包含模糊、抖动、重复、无声、强噪声等负样本。
- 包含中文路径、空格路径、横竖屏混合。
- 素材总时长建议 10～30 分钟。

每次迭代固定评估：

技术正确性：

- 非法镜头引用率：目标 `0%`
- 时间越界率：目标 `0%`
- 预览成功率：目标 `100%`
- 剪映草稿可打开率：通过 Spike 后目标 `100%`

粗剪质量：

- 用户保留镜头比例
- 用户重排镜头比例
- 用户替换镜头比例
- 首次生成到可接受版本所需操作次数
- 是否具备明确开场、事件发展、情绪锚点和收尾

第一版不要用“模型觉得好不好”作为唯一评估。用户真实编辑动作才是主要质量信号。

## 13. 风险与应对

### 剪映草稿格式不稳定

应对：

- 内部只认 `EditPlan`。
- exporter 版本化。
- 每个支持的剪映版本维护兼容性记录。
- 默认创建新草稿。
- 始终提供导出素材包降级。

### 过早做效果，粗剪仍不可用

应对：

- M0～M3 只关注选对镜头、叙事顺序和时间正确性。
- 贴纸、花字和复杂转场不能阻塞 MVP。

### LLM 输入过大或成本过高

应对：

- 先用规则和 embedding 初筛。
- 按事件簇分组，只把 Top-K 候选交给 planner。
- 使用缩略图和结构化摘要，不把全部视频帧直接输入。

### 用户在剪映中的修改无法回流

应对：

- 在导出前完成 ClipIQ 内粗剪确认。
- 记录 ClipIQ 内所有编辑反馈。
- 暂不承诺完整导入新版剪映草稿。

### 音乐、字体、贴纸版权

应对：

- 首期只使用用户本地资源和明确可用的内置资源。
- 资源记录来源和授权信息。
- 不自动抓取未知版权素材。

## 14. 建议代码边界

建议逐步建立以下模块，实际文件名可随 Electron TS 迁移调整：

```text
src/
├── types/
│   └── edit-plan.ts
├── screens/
│   └── StudioScreen.tsx
└── queries/
    └── edit-plans.ts

electron/
├── editing/
│   ├── candidate-builder.ts
│   ├── vlog-planner.ts
│   ├── edit-plan-compiler.ts
│   ├── edit-plan-validator.ts
│   ├── proxy-renderer.ts
│   └── exporters/
│       ├── exporter.ts
│       ├── jianying-exporter.ts
│       └── package-exporter.ts
└── migrations/
    └── ...
```

约束：

- 新增 IPC 时以 `electron/preload.cjs` 的 `CHANNELS` manifest 为唯一源。
- preload 继续保持只 `require("electron")`。
- 新 Electron 业务模块优先写 TypeScript，通过无后缀 `require` 接入。
- 数据库 migration 必须可重复执行，并补旧数据回填测试。
- FFmpeg 命令生成与执行分离，便于单测参数和时间线。

## 15. 实施顺序

推荐按以下 PR 边界推进：

1. `M0-1`：素材归属和 Studio 持久化修复。
2. `M0-2`：分析结果到 `shots` 的统一同步。
3. `M1-1`：`EditPlan` schema、编译器和校验器。
4. `M1-2`：真实 Shot 候选和 Vlog planner。
5. `M2`：FFmpeg 代理预览。
6. `M3`：ClipIQ 内结构化粗剪反馈。
7. `M4`：剪映兼容性 Spike。
8. `M5`：正式剪映导出器。

每个 PR 独立迁移、独立测试、可独立回滚。不要在同一 PR 同时修改素材数据模型、LLM prompt、FFmpeg 渲染和剪映草稿格式。

## 16. 开工检查清单

- [ ] 从 `feature/v2` 创建 `feature/ai-vlog-rough-cut`。
- [ ] 保留当前工作区中与本计划无关的未跟踪图标文件。
- [ ] 先完成 M0 数据迁移设计，再动 Studio 生成逻辑。
- [ ] 建立一套固定 Vlog 测试素材。
- [ ] 确认首个目标剪映版本及其安装环境。
- [ ] M4 通过前，不将某个第三方草稿库写死为正式依赖。

