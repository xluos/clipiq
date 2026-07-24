export type ModelInputMode = "auto" | "direct_video" | "keyframe_sequence";

// Legacy: kept for v1 config compatibility. New code should read `source` + capabilities.
export type ProviderKind = "video" | "audio";

export type ModelCapability =
  | "vision"
  | "audio_transcription"
  | "reasoning"
  | "fast"
  | "long_context"
  | "text";

// 本地模型 manifest 能力分类
// primary 决定槽位过滤;secondary 大多走 ModelDescriptor.capabilities 直接提升;
// chinese/english/code/video 这种只做 UI hint 的留在 secondary
export type LocalPrimaryCapability = "vision" | "audio" | "text";
export type LocalSecondaryTag =
  | "chinese"
  | "english"
  | "code"
  | "reasoning"
  | "video"
  | "long_context"
  | "fast";

export type LocalQuantization = {
  key: string;
  label: string; // "Q4_K_M"
  sizeBytes: number;
  repo?: string;
  llmFile?: string;
  mmprojFile?: string;
};

export type LocalFitLevel = "perfect" | "good" | "marginal" | "tight";

// manifest 原始条目(磁盘 source of truth); 投影成 ModelDescriptor 给下游消费
export type LocalModelEntry = {
  key: string;
  family: string;
  params: string;
  name: string;
  description: string;
  primaryCapabilities: LocalPrimaryCapability[];
  secondaryTags: LocalSecondaryTag[];
  available: boolean;
  contextSize: number;
  // 权重原生支持的 ctx 上限 (Qwen3.5/3.6 全系 262144 / 256K)。
  // contextSize 字段是"安全默认值"; nativeContextSize 是 slider 上限, 允许用户手动放开。
  nativeContextSize?: number;
  quantizations: LocalQuantization[];
  fit?: LocalFitLevel;
  memPercent?: number;
  tps?: number;
  downloaded?: boolean;
  llmBytes?: number;
  mmprojBytes?: number;
  // 模型是否带 thinking / reasoning 能力 (Qwen3 / DeepSeek-R1 / Kimi-K1.5 / GLM-4-thinking 等)。
  // 业务侧默认会关 thinking 直出 JSON; SlotAssignment.enableThinking 显式 true 时才放开。
  // 非 thinking 模型 (普通 instruct) 留空, 行为不变。
  isThinking?: boolean;
};

// 通用模型描述 - 远程 /models / 本地 llama manifest / 本地 whisper 都统一映射到这里
// 下游一套逻辑判断 capabilities + availability,不再分 source 分叉
export type ModelAvailability =
  | { state: "ready" }
  | { state: "needs_install"; sizeBytes?: number }
  | { state: "coming_soon" }
  | { state: "unknown"; reason?: string };

export type ModelDescriptorSource = "remote" | "local_llama" | "local_whisper";

export type ModelDescriptor = {
  source: ModelDescriptorSource;
  id: string;                          // 远程: OpenAI id; 本地: manifest key
  label: string;
  family?: string;
  params?: string;
  description?: string;
  capabilities: ModelCapability[];
  // inferred = id 正则推断 (远程); manifest = 本地 manifest 派生; manual = 用户手改覆盖
  capabilitiesSource: "inferred" | "manifest" | "manual";
  availability: ModelAvailability;
  contextSize?: number;
  // 权重原生支持的 ctx 上限 (本地 manifest 直接读, 远程模型暂不可知留 undefined)
  nativeContextSize?: number;
  ownedBy?: string;                    // 远程 /models 的 owned_by 兜底展示
  // 同 LocalModelEntry.isThinking: 模型支持 thinking 时这里也置 true。
  // 远程 (OpenAI o1/o3 / DeepSeek-R1 / Qwen DashScope qwen3-* / 火山方舟 deepseek-r1 等) 通过 id 正则推断,
  // 本地从 manifest 直接读, 上层 UI / 任务分配可以基于这个字段决定要不要给"启用思考"开关。
  isThinking?: boolean;
  local?: {
    fit?: LocalFitLevel;
    memPercent?: number;
    tps?: number;
    downloaded?: boolean;
    downloadedBytes?: number;
    quantizations?: LocalQuantization[];
    secondaryTags?: LocalSecondaryTag[]; // chinese/english/code/video - UI hint
  };
};

export type MachineSpecs = {
  platform: NodeJS.Platform;
  arch: string;
  totalMemoryBytes: number;
  availableMemoryBytes: number;
  isAppleSilicon: boolean;
  cpuModel: string;
  backend: "metal" | "cuda" | "rocm" | "cpu";
  speedConstant: number; // K factor used in TPS estimate
  recommendedQuant: string; // 默认推荐量化档 label
};

export type ProviderSource = "remote" | "local_llama" | "local_whisper";

export type ProviderEndpointType =
  | "openai_chat_completions"
  | "openai_responses"
  | "openai_audio_transcriptions"
  | "local_whisper_cpp"
  | "local_whisper_wasm" // 老 config 残留,migrate 后会被改写为 local_whisper_cpp
  | "local_llama_server";

// 持久化在 config.providers[*].models[] 内的用户选定 model.
// 字段是 ModelDescriptor 的子集 + 用户配置(maxOutputTokens/temperature/language)
// 运行时的 availability/fit/tps 不写入 config,每次 IPC 重新拉取
export type ProviderModel = {
  id: string;
  label: string;
  capabilities: ModelCapability[];
  capabilitiesSource?: "inferred" | "manifest" | "manual";
  family?: string;
  params?: string;
  contextSize?: number;
  // 本地模型在 manifest 里的默认 contextSize, 跟 contextSize (effective, 可能被 override) 对比。
  // 只有 builtin local_llama provider 会填这个字段;远端 provider 留空。
  defaultContextSize?: number;
  // 权重原生支持的 ctx 上限 (256K 等)。settings UI 的 ctx slider 用它做上限。
  nativeContextSize?: number;
  ownedBy?: string;
  maxOutputTokens?: number;
  temperature?: number;
  // 本地推理 model 专属(冗余,等价于 id,但旧 config 还在用)
  localKey?: string;
  // 本地 whisper 专属
  localWhisperModel?: string;
  localWhisperMirror?: string;
  language?: string;
  // 同 ModelDescriptor.isThinking: model 是否带 thinking 能力
  // (local llama 走 manifest, 远端走 inferCapabilitiesFromRemoteId 推断)
  isThinking?: boolean;
};

export type ModelProvider = {
  id: string;
  name: string;
  source: ProviderSource;
  builtin?: boolean; // builtin local_llama/local_whisper 不可删
  baseUrl: string;
  apiKeyRef: string;
  endpointType: ProviderEndpointType;
  inputMode: ModelInputMode;
  models: ProviderModel[];
  // 以下字段是 v1 schema 残留,仅用于兼容性读取(配置迁移完成后从 models[0] 反推)
  /** @deprecated use models[0].id */
  model?: string;
  /** @deprecated derived from source + endpointType */
  kind?: ProviderKind;
  /** @deprecated use models[0].localWhisperModel */
  localWhisperModel?: string;
  /** @deprecated use models[0].localWhisperMirror */
  localWhisperMirror?: string;
  /** @deprecated use models[0].language */
  language?: string;
  /** @deprecated use models[0].maxOutputTokens */
  maxOutputTokens?: number;
  /** @deprecated use models[0].temperature */
  temperature?: number;
};

export type TaskDifficulty = "simple" | "medium" | "complex";
export type TaskAxis = "vision" | "text";
export type TaskSlotKey =
  | "simple_vision"
  | "simple_text"
  | "medium_vision"
  | "medium_text"
  | "complex_vision"
  | "complex_text";

// enableThinking: 任务分配维度的"是否启用思考"开关。
// - undefined / false: 默认行为, 关 thinking 直出 JSON (chat_template_kwargs.enable_thinking=false)
// - true: 用户在任务分配 UI 上显式打开, 允许模型 thinking (调试 / 复杂推理场景)
// 模型是否支持 thinking 看 ModelDescriptor.isThinking; 不支持的模型这个开关无意义不显示。
export type SlotAssignment = { providerId: string; modelId: string; enableThinking?: boolean } | null;
export type TaskSlots = Record<TaskSlotKey, SlotAssignment>;

export type SlotOverrides = {
  simple_vision?: SlotAssignment;
  complex_vision?: SlotAssignment;
  medium_text?: SlotAssignment;
  audio?: SlotAssignment;
};

export type PipelineId = "content" | "pipeline";

export type PipelineSlotConfig = {
  taskSlots: Partial<TaskSlots>;
  audioSlot: SlotAssignment;
};

export type PipelineSlots = Record<PipelineId, PipelineSlotConfig>;

/** @deprecated v3: use Video.sourceType/sourceUrl/platform */
export type ProjectSource =
  | { type: "local_file"; originalPath: string }
  | {
      type: "url";
      url: string;
      platform: "douyin" | "xiaohongshu" | "bilibili" | "tiktok" | "unknown";
    };

/** @deprecated v3: use VideoStatus */
export type ProjectStatus =
  | "not_analyzed"
  | "downloading"
  | "download_failed"
  | "analyzing"
  | "completed"
  | "failed";

export type AnalysisStatus = "analyzing" | "completed" | "failed" | "cancelled" | "interrupted";

/** @deprecated use Analysis */
export type AnalysisRecord = {
  id: string;
  videoId?: string;
  /** @deprecated use videoId */
  projectId: string;
  status: AnalysisStatus;
  providerId?: string;
  model?: string;
  analysisOptions?: AnalysisOptions;
  startedAt: string;
  completedAt?: string;
  totalDurationMs?: number;
  lastErrorMessage?: string;
  lastErrorAt?: string;
  createdAt: string;
};

/** @deprecated v3: use Video */
export type Project = {
  id: string;
  source: ProjectSource;
  localVideoPath: string;
  localFilePath?: string;
  videoName: string;
  durationSec: number;
  width: number;
  height: number;
  orientation: "landscape" | "portrait" | "square";
  status: ProjectStatus;
  currentAnalysisId?: string;
  thumbnailUrl?: string;
  titleAutoGenerated?: boolean;
  createdAt?: string;
  updatedAt?: string;
  kind?: ProjectKind;
  shots?: Shot[];
  assetTags?: string[];
  accountId?: string;
};

export type AnalysisNodeType =
  | "shot_change"
  | "emotion_turn"
  | "info_point"
  | "edit_intent"
  | "audio_change";

export type VideoGenre =
  | "vlog"
  | "review"
  | "travel"
  | "tutorial"
  | "knowledge"
  | "documentary"
  | "short-drama"
  | "other";

export type LengthBucket = "short" | "mid" | "long" | "deep";

export type MethodologyRuleCategory =
  | "hook"
  | "structure"
  | "pacing"
  | "engagement"
  | "sound"
  | "density"
  | "completion"
  | "visual";

export type MethodologyTagStatus = "hit" | "violation";

export type MethodologyTag = {
  ruleId: string; // e.g. "R-HOOK-001"
  ruleName: string; // 人类可读名
  category: MethodologyRuleCategory;
  status: MethodologyTagStatus;
  evidence: string; // 引用具体画面/旁白/时间段
  confidence: number; // 0-1
  fixSuggestion?: string; // 仅 violation 必填
};

export type MethodologyMiss = {
  ruleId: string;
  ruleName: string;
  category: MethodologyRuleCategory;
  expectedAt?: string; // 应该出现的位置/时间段描述
  reason: string; // 为什么判定缺失
  fixSuggestion: string;
};

export type MethodologyAudit = {
  detectedGenre: VideoGenre; // LLM 推断的视频类型
  lengthBucket: LengthBucket; // 根据 duration 推断
  appliedRuleSets: string[]; // 加载了哪些规则集，如 ["_common", "length/long", "genre/review"]
  hits: MethodologyTag[]; // 命中（节点级 hit 的聚合）
  violations: MethodologyTag[]; // 违反（节点级 violation 的聚合）
  misses: MethodologyMiss[]; // 缺失（报告级判定，没有对应节点）
  overallScore?: number; // 0-100 综合评分（可选）
  genreConfidence?: number; // 0-1 LLM 对类型推断的信心
};

export type PrefilterSceneType =
  | "outdoor"
  | "indoor"
  | "transition"
  | "text_card"
  | "person"
  | "product"
  | "ui"
  | "landscape"
  | "other";

export type PrefilterTag = {
  sceneType: PrefilterSceneType;
  subject: string;       // 主体一句话(≤8 汉字)
  hasText: "none" | "chinese" | "english" | "mixed";
  salience: number;      // 0-10,信息量
  isEmpty: boolean;
  signature: string;     // 3-5 汉字概括,用于 dedup
  caption?: string;      // 一句话画面描述(≤30 汉字),给下游 shot 合并 / 节点详情用
};

// 单帧的轻量上下文 (本地初筛产物), 用作 shot 合并 / 节点详情展示
export type FrameContext = {
  thumbnailUrl: string;     // media:// URL
  framePath: string;        // 磁盘路径
  midSec: number;           // 抽帧时刻
  caption?: string;         // 来自 prefilterTag.caption
  salience?: number;        // 来自 prefilterTag.salience
  signature?: string;       // 来自 prefilterTag.signature
};

// 弹幕情绪 5 维强度 (0-1)。LLM 一次评一桶,产出整组分布。
export type DanmakuEmotionAxis = "joy" | "surprise" | "anger" | "sadness" | "disgust";
export type DanmakuEmotionScores = Record<DanmakuEmotionAxis, number>;

// 单条节点上的观众反应聚合。danmaku 块缺失时整体为 undefined。
export type AudienceReaction = {
  dominantEmotion: DanmakuEmotionAxis | "neutral";
  intensities: DanmakuEmotionScores;
  danmakuCount: number;
  summary: string;                       // 一句话(≤30 汉字): "集体笑场 + 少量吐槽"
  topTerms?: WordCloudEntry[];           // 该节点时间区间的 mini 词云 (top 5-10)
};

export type AnalysisNode = {
  id: string;
  startSec: number;
  endSec: number;
  title: string;
  nodeTypes: AnalysisNodeType[];
  shotDescription: string;
  shotType?: string;
  cameraMovement?: string;
  visualElements: string[];
  audioElements: string[];
  subtitleText?: string;
  editIntent: string;
  emotionLabel: string;
  emotionIntensity: number; // 0-10
  narrativeFunction: string;
  confidence: number; // 0-1
  isHighlight: boolean;
  note?: string;
  thumbnailUrl?: string; // Captured from video for the node
  methodologyTags?: MethodologyTag[]; // 该节点命中/违反的方法论规则
  prefilterTag?: PrefilterTag; // 本地初筛打标(若启用)
  // 金字塔管线新增字段 (PR2)
  representativeFrames?: FrameContext[];   // 由 medium_text 选出的该镜头代表帧 (1-3 张)
  framesInShot?: FrameContext[];           // 该镜头内所有抽帧候选, 调试/详情面板用
  subtitleSegments?: Array<{
    start: number;
    end: number;
    text: string;
    speakerId?: string;
    words?: Array<{ text: string; start: number; end: number; confidence?: number; speakerId?: string }>;
  }>; // 落在该镜头区间内的字幕段
  audienceReaction?: AudienceReaction;     // B 站弹幕情绪聚合(可选; 仅 platform=bilibili 项目产出)
};

// PR2 金字塔管线: medium_text 合并出来的镜头级上下文, 喂给主分析做评审 + UI 镜头时间线渲染
export type ShotContext = {
  shotIndex: number;
  startSec: number;
  endSec: number;
  shotDescription: string;          // medium_text 输出: 综合画面+字幕的一段话 (30-80 汉字)
  frames?: FrameContext[];          // 该镜头内全部抽帧 (带 thumbnailUrl + caption + midSec), 严格拉片时间线渲染用
  representativeFrames?: FrameContext[]; // 由 medium_text 挑出的 1-3 张代表帧 (frames 的子集)
  subtitleSegments?: Array<{
    start: number;
    end: number;
    text: string;
    speakerId?: string;
    words?: Array<{ text: string; start: number; end: number; confidence?: number; speakerId?: string }>;
  }>; // 落在该镜头区间的字幕段, 保留分段
  subtitleText?: string;            // 该镜头时间段内的拼接字幕 (向后兼容老 report)
  framesInShot?: number;            // 兼容字段: 旧 report 只存了帧数; 新 report 用 frames.length
};

// 词云一条目 (text + 频次/权重)
export type WordCloudEntry = {
  text: string;
  value: number;            // 频次 (归一化前的原始计数)
};

// 单个时间桶的弹幕聚合 + 情绪打分
export type DanmakuEmotionWindow = {
  shotIndex?: number;                    // 若按 shot 切; 退化到固定桶时为 undefined
  startSec: number;
  endSec: number;
  danmakuCount: number;
  dominantEmotion: DanmakuEmotionAxis | "neutral";
  intensities: DanmakuEmotionScores;
  sampleTexts: string[];                 // 代表性弹幕 (≤5 条)
  summary?: string;
};

// 顶层 report.danmaku 块: 仅 bilibili 项目产出
export type DanmakuReport = {
  platform: "bilibili";
  totalCount: number;
  windows: DanmakuEmotionWindow[];
  wordCloud: WordCloudEntry[];
  fetchedAt: string;                     // ISO 时间, 用于判断"是否过期"
  summary?: string;                      // 一句话(≤120 汉字): 整体观众反应总结
};

export type AnalysisReport = {
  summary: string;
  structure: {
    hook: string;
    development: string;
    turn: string;
    climax: string;
    ending: string;
  };
  pacing: string;
  editingStyle: string;
  composition: string;
  takeaways: string[];
  providerSnapshot?: Pick<ModelProvider, "name" | "baseUrl" | "model" | "inputMode">;
  audioProviderSnapshot?: Pick<ModelProvider, "name" | "baseUrl" | "model"> | null;
  transcript?: {
    language?: string;
    segmentCount?: number;
    textPreview?: string;
  } | null;
  personAnalysis?: {
    status: "completed" | "unavailable";
    videoId: string;
    analyzedFrameCount: number;
    trackCount: number;
    appearanceCount: number;
    embeddingTrackCount: number;
    modelId?: string;
    sampledFrameCount: number;
    sampleIntervalSec: number;
    downsampled: boolean;
    reason?: string;
  };
  speakerAnalysis?: {
    status: "completed" | "unavailable";
    videoId: string;
    speakerCount: number;
    trackCount: number;
    reason?: string;
  };
  pipelineVersion?: string;
  schemaVersion?: string;
  generatedAt?: string;
  timings?: AnalysisTiming[];
  totalDurationMs?: number;
  tokenUsage?: TokenUsageSummary;
  methodologyAudit?: MethodologyAudit;
  // PR2 金字塔管线新增字段
  globalSummary?: string;           // medium_text 在主分析前生成的全局摘要 (优先于 summary 展示)
  shotContexts?: ShotContext[];     // 所有镜头的中间产物, 时间轴渲染 + 调试用
  // B 站弹幕情绪分析 + 词云 (仅 platform=bilibili 项目)
  danmaku?: DanmakuReport;
};

export type AnalysisTiming = {
  stage: string;
  durationMs: number;
  note?: string;
};

// 单个阶段 + 模型维度的 token 消耗。同一分析里若一个阶段调用了多个不同
// provider/model (理论上不会, 但留 schema 余地), 会拆成多条。
export type StageTokenUsage = {
  // 机器名: "prefilter" | "shot-merger" | "summarizer" | "detect-genre"
  //         | "main-analysis" | "danmaku-emotion" | "title-gen"
  stage: string;
  providerId: string | null;
  providerName: string | null;
  model: string | null;
  // remote (OpenAI 兼容) / local_llama / local_whisper
  source: "remote" | "local_llama" | "local_whisper";
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;     // API 级 prompt cache 命中的 token 数
  cacheCreationTokens?: number; // API 级 prompt cache 写入的 token 数
  callCount: number;   // 真正发起的 LLM 调用次数 (不含缓存命中)
  cacheHits: number;   // 该阶段命中分析缓存的次数
};

export type TokenUsageSummary = {
  stages: StageTokenUsage[];
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
};

export type AnalysisOptions = {
  mode: "quick" | "standard" | "detailed";
  density: "sparse" | "standard" | "dense";
  focus: "all" | "narrative" | "rhythm" | "emotion";
  // Hybrid: 用户可在主入口 composer 预指定类型；不指定（"auto"）则让 LLM 识别。
  // 分析完成后用户也可在 ReportScreen 改类型并重新分析。
  manualGenre?: VideoGenre | "auto";
};

// 全局默认分析参数
export type DefaultAnalysisPreset = "quick" | "standard" | "deep";
export type DefaultAnalysis = {
  preset: DefaultAnalysisPreset;
  manualGenre: VideoGenre | "auto";
};

// 把全局默认 preset 折算成 AnalysisOptions
// quick → mode:quick / density:sparse; standard → standard; deep → detailed+dense
export function defaultPresetToAnalysisOptions(d: DefaultAnalysis): AnalysisOptions {
  const base: Pick<AnalysisOptions, "mode" | "density" | "focus"> =
    d.preset === "quick" ? { mode: "quick", density: "sparse", focus: "all" }
    : d.preset === "deep" ? { mode: "detailed", density: "dense", focus: "all" }
    : { mode: "standard", density: "standard", focus: "all" };
  return { ...base, manualGenre: d.manualGenre };
}

export type AnalysisProgressEvent = {
  videoId?: string;
  /** @deprecated use videoId */
  projectId: string;
  analysisId: string;
  progress: number;
  stage: string;
  message?: string;
  stageIndex?: number;
  fromCache?: boolean;
};

// analyzeProject 起来时 broadcast 一次, 把各 stage 的 baseline 耗时预算发给 renderer。
// ProgressScreen 用它替代 elapsed/progress 线性外推, 给出更稳定的 ETA。
// stage 字符串是 main.cjs send(stage) 用的 prefix, renderer 用 stageLabel.startsWith() 关联。
export type AnalysisBudgetStage = {
  stage: string;
  estMs: number;
  kind: "cpu" | "ffmpeg" | "whisper" | "llm-text" | "llm-vision" | "network";
  note?: string;
};

export type AnalysisBudget = {
  totalMs: number;
  stages: AnalysisBudgetStage[];
  inputs?: {
    durationSec?: number;
    candidateFrames?: number;
    shotsCount?: number;
    chunksCount?: number;
    framesPerChunk?: number;
    contextSize?: number | null;
  };
};

export type AnalysisBudgetEvent = {
  videoId?: string;
  /** @deprecated use videoId */
  projectId: string;
  analysisId: string;
  budget: AnalysisBudget;
};

export const PIPELINE_STAGE_DEFS = [
  { key: "download", label: "下载视频" },
  { key: "read_video", label: "读取视频信息" },
  { key: "detect_scenes", label: "检测镜头切换" },
  { key: "extract_frames", label: "挑选关键画面" },
  { key: "transcribe", label: "识别字幕" },
  { key: "shot_merge", label: "镜头合并" },
  { key: "prepare", label: "整理分析素材" },
  { key: "analyze", label: "模型分析画面" },
  { key: "finalize", label: "整理结果" },
  { key: "report", label: "生成最终报告" },
] as const;

export type PipelineStageStatus = "pending" | "active" | "done" | "failed";

export type PipelineStage = {
  key: string;
  label: string;
  status: PipelineStageStatus;
  detail?: string;
  startedAt?: number;
  completedAt?: number;
  fromCache?: boolean;
};

export type PipelineState = {
  videoId?: string;
  /** @deprecated use videoId */
  projectId: string;
  analysisId: string;
  progress: number;
  stages: PipelineStage[];
};

export type AppConfig = {
  providers: ModelProvider[];
  taskSlots: TaskSlots;
  audioSlot: SlotAssignment;
  // 上次启动过的本地推理模型(key)。下次应用启动时自动恢复。
  lastLlamaModelKey?: string | null;
  // 全局默认分析参数; 起分析时若 project.analysisOptions 缺省则用它推导
  defaultAnalysis?: DefaultAnalysis;
  // 本地模型下载镜像选择: hf-mirror (默认) 或 modelscope (魔搭/国内 CDN)
  localModelMirror?: "hf-mirror" | "modelscope";
  // 本地 llama 模型 ctx 覆盖, 启动 server 时 --ctx-size 用这里的值; 缺省走 manifest。
  // 调大需要更多内存 (主要是 KV cache), 小机器跑大 ctx 容易 OOM。
  localModelOverrides?: Record<string, { contextSize?: number }>;
  // 在线模型 LLM 并发数,控制 shot-merger 等批量阶段同时发几个请求。
  // 本地模型始终为 1 (单 server 实例)。0/缺省 = 自动 (在线 3, 本地 1)。
  pipelineConcurrency?: number;
  // 分析阶段结果缓存目录, null/缺省 → userData/cache;
  // 可在设置里改到外部盘 (改路径会触发整目录迁移)。
  cacheDir?: string | null;
  // 缓存总容量上限 (字节), 0 = 无上限, 默认 10 GB。
  cacheMaxBytes?: number;
  // 缓存策略: enabled 总开关, stages 按阶段细控。缺省 = 全部启用。
  cachePolicy?: {
    enabled: boolean;
    stages?: Record<string, boolean>;
  };
  pipelineSlots?: PipelineSlots;
  schemaVersion: 2;
  // v1 残留字段,仅在 migrateConfigV1ToV2 内读取,迁移后写回时不再产生
  /** @deprecated migrated to taskSlots.complex_vision */
  activeVideoProviderId?: string | null;
  /** @deprecated migrated to audioSlot */
  activeAudioProviderId?: string | null;
};

// v2: 两层路由结构,替代扁平 ScreenState。
// 老的 7 屏全部归到 module: "analysis" 下。新模块作为并列入口。
export type AppModule = "analysis" | "video" | "library" | "account" | "studio" | "settings" | "diagnostics";

export type AppLocation =
  | { module: "analysis";  screen: "home" | "progress" | "workspace" | "report" | "url_pull" }
  | { module: "video";     screen: "list" | "detail" }
  | { module: "library";   screen: "list" | "upload" | "shot-list" | "shot-detail" }
  | { module: "account";   screen: "hub" | "list" | "detail" | "methodology" | "collection" }
  | { module: "studio";    screen: "list" | "editor" }
  | { module: "settings" }
  | { module: "diagnostics" };

// v1 兼容:老 ScreenState 字符串仍在部分调用点出现,逐步迁移到 AppLocation
export type ScreenState =
  | "home"
  | "settings"
  | "url_pull"
  | "progress"
  | "workspace"
  | "report";

// 把扁平 ScreenState 转成 AppLocation;迁移期临时用,后续 setCurrentScreen 调用点改完可删
export function legacyScreenToLocation(s: ScreenState): AppLocation {
  if (s === "settings") return { module: "settings" };
  return { module: "analysis", screen: s };
}

export function locationToLegacyScreen(loc: AppLocation): ScreenState {
  if (loc.module === "settings") return "settings";
  if (loc.module === "diagnostics") return "settings";
  if (loc.module === "analysis") return loc.screen as ScreenState;
  return "home";
}

// Project.kind: v2 在共享底座上分类。旧数据默认 'analysis'。
/** @deprecated v3: videos 表不再区分 kind */
export type ProjectKind = "analysis" | "asset" | "account_video";

export type ShotTranscriptSegment = {
  startSec: number;
  endSec: number;
  text: string;
  speakerId?: string;
  words?: Array<{
    text: string;
    startSec: number;
    endSec: number;
    confidence?: number;
    speakerId?: string;
  }>;
};

export type ShotEventSegment = {
  startSec: number;
  endSec: number;
  summary: string;
  granularity: "shot" | "segment";
  source: "analysis_node" | "shot_description";
  sourceNodeId?: string;
  confidence?: number;
};

// 单个镜头(Shot)— 素材分镜后的最小单位
export type Shot = {
  id: string;
  videoId?: string;                 // v3: 关联到 videos.id
  assetProjectId: string;           // v2 兼容
  shotIndex: number;
  startSec: number;
  endSec: number;
  thumbnailUrl?: string;
  description: string;             // 自动镜头描述
  shotType?: string;
  cameraMovement?: string;
  usageTags: string[];             // 用户/LLM 标的用途标签: ["开场","转场","B-roll"]
  isFavorite?: boolean;
  eventSegments?: ShotEventSegment[];
  subtitleText?: string;
  subtitleSegments?: ShotTranscriptSegment[];
  transcriptGranularity?: "segment" | "word";
  audioSummary?: string;
  createdAt?: string;
};

export type PersonStatus = "auto" | "confirmed" | "merged";

export type Person = {
  id: string;
  displayName?: string;
  representativeThumbnailUrl?: string;
  status: PersonStatus;
  mergedIntoPersonId?: string;
  appearanceCount?: number;
  createdAt?: string;
  updatedAt?: string;
};

export type PersonAppearance = {
  id: string;
  personId?: string;
  videoId: string;
  shotId?: string;
  trackId: string;
  startSec: number;
  endSec: number;
  confidence: number;
  identityConfidence?: number;
  thumbnailUrl?: string;
  focusBounds?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  source: "face_track" | "manual";
  manualLocked?: boolean;
  speakingConfidence?: number;
  createdAt?: string;
  updatedAt?: string;
};

export type SpeakerTrack = {
  id: string;
  videoId: string;
  shotId?: string;
  speakerId: string;
  personId?: string;
  startSec: number;
  endSec: number;
  confidence: number;
  linkConfidence?: number;
  transcriptText?: string;
  manualLocked?: boolean;
  createdAt?: string;
  updatedAt?: string;
};

export type CropSpec = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type TransformSpec = {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  rotationDeg: number;
  opacity: number;
};

export type EditPlanIssue = {
  code: string;
  message: string;
  path?: string;
  meta?: Record<string, unknown>;
};

export type AnalysisEvidenceQualityIssue = {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
};

export type AnalysisEvidenceQualityReport = {
  generatedAt: number;
  videoCount: number;
  shotCount: number;
  semantic: {
    capability: "none" | "shot" | "segment";
    describedShotCount: number;
    coverageRatio: number;
    eventSegmentCount: number;
    segmentEventCount: number;
    invalidEventSegmentCount: number;
    segmentCoverageRatio: number;
  };
  transcript: {
    capability: "none" | "segment" | "word";
    segmentCount: number;
    wordTimedSegmentCount: number;
    wordTimingCoverageRatio: number;
    invalidSegmentCount: number;
    videosWithTranscript: number;
    shotCoverageRatio: number;
  };
  identity: {
    capability: "none" | "tracking" | "cross_video";
    appearanceCount: number;
    trustedAppearanceCount: number;
    unassignedAppearanceCount: number;
    untrustedAppearanceCount: number;
    invalidAppearanceCount: number;
    videosWithTracks: number;
    crossVideoPersonCount: number;
  };
  speakers: {
    capability: "none" | "diarized" | "linked";
    trackCount: number;
    invalidTrackCount: number;
    linkedTrackCount: number;
    speakingEvidenceAppearanceCount: number;
    videosWithTracks: number;
  };
  planning: {
    readiness: "ready" | "partial" | "blocked";
    eligibleCandidateCount: number;
    rejectedCandidateCount: number;
    issues: AnalysisEvidenceQualityIssue[];
  };
};

export type TimedWordEvidence = {
  text: string;
  startUs: number;
  endUs: number;
  confidence?: number;
  speakerId?: string;
};

export type VideoClipEventEvidence = {
  startUs: number;
  endUs: number;
  summary: string;
  granularity: "shot" | "segment";
  source: "analysis_node" | "shot_description";
  sourceNodeId?: string;
  confidence?: number;
};

export type VideoClipSubtitleEvidence = {
  startUs: number;
  endUs: number;
  text: string;
  speakerId?: string;
  words?: TimedWordEvidence[];
};

export type VideoClipPersonEvidence = {
  appearanceId: string;
  trackId: string;
  personId?: string;
  startUs: number;
  endUs: number;
  detectionConfidence: number;
  identityConfidence?: number;
  manualConfirmed?: boolean;
  focusBounds?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
};

export type VideoClipSpeakerEvidence = {
  trackId: string;
  speakerId: string;
  personId?: string;
  startUs: number;
  endUs: number;
  confidence: number;
  linkConfidence?: number;
  manualConfirmed?: boolean;
};

export type VideoClipEvidenceSegment = {
  startUs: number;
  endUs: number;
  eventSummary?: string;
  eventGranularity?: "shot" | "segment";
  subtitleText?: string;
  transcriptGranularity?: "segment" | "word";
  visiblePeople: Array<{
    appearanceId: string;
    trackId: string;
    personId?: string;
  }>;
  activeSpeakers: Array<{
    trackId: string;
    speakerId: string;
    personId?: string;
  }>;
};

export type VideoClipEvidence = {
  eventSummary?: string;
  eventSegments?: VideoClipEventEvidence[];
  transcriptGranularity?: "segment" | "word";
  subtitleSegments?: VideoClipSubtitleEvidence[];
  personAppearances?: VideoClipPersonEvidence[];
  speakerTracks?: VideoClipSpeakerEvidence[];
  personIds?: string[];
  speakerIds?: string[];
  alignedSegments?: VideoClipEvidenceSegment[];
};

export type EmotionTone =
  | "neutral"
  | "calm"
  | "warm"
  | "upbeat"
  | "tense"
  | "reflective";

export type ClipEmotion = {
  tone: EmotionTone;
  intensity: number;
  confidence: number;
  reason: string;
  source: "planner";
};

export type VideoClip = {
  id: string;
  candidateId?: string;
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
  emotion?: ClipEmotion;
  evidence?: VideoClipEvidence;
};

export type CaptionCue = {
  id: string;
  startUs: number;
  endUs: number;
  text: string;
  styleId: string;
  sourceClipId?: string;
  sourceStartUs?: number;
  sourceEndUs?: number;
  wordTimings?: Array<{
    text: string;
    startUs: number;
    endUs: number;
    confidence?: number;
    speakerId?: string;
  }>;
  highlights?: Array<{
    text: string;
    startOffset: number;
    endOffset: number;
    startUs: number;
    endUs: number;
    reason: "event_keyword" | "number";
    confidence: number;
  }>;
};

export type AudioClip = {
  id: string;
  kind: "original" | "voiceover" | "music";
  sourcePath?: string;
  ttsText?: string;
  anchorClipId?: string;
  timelineInUs: number;
  sourceInUs: number;
  sourceOutUs: number;
  volume: number;
  emotionSegmentId?: string;
  mood?: EmotionTone;
  fadeInUs?: number;
  fadeOutUs?: number;
  ducking?: {
    enabled: boolean;
    targetVolume: number;
  };
  synthesis?: {
    engine: "macos-say";
    voice?: string;
    rateWpm: number;
    textDigest: string;
    synthesizedAt: number;
  };
  beatAnalysis?: AudioBeatAnalysis;
  beatSyncSuggestions?: BeatSyncSuggestion[];
};

export type AudioBeatAnalysis = {
  algorithmVersion: "energy-onset-v1";
  status: "usable" | "low_confidence" | "insufficient_audio";
  sampleRate: number;
  analyzedStartUs: number;
  analyzedEndUs: number;
  bpm?: number;
  confidence: number;
  beatTimesUs: number[];
  reason?: string;
};

export type BeatSyncSuggestion = {
  fromClipId: string;
  toClipId: string;
  boundaryTimeUs: number;
  beatTimeUs: number;
  offsetUs: number;
  confidence: number;
};

export type OverlayTemplateDefinition = {
  key: string;
  version: 1;
  label: string;
  description: string;
  kind: "text" | "sticker";
  textRequired: boolean;
  maxTextLength?: number;
  defaultDurationUs: number;
};

export type OverlayItem = {
  id: string;
  kind: "text" | "image" | "sticker";
  assetPath?: string;
  resourceKey?: string;
  text?: string;
  anchorClipId?: string;
  anchorOffsetUs?: number;
  startUs: number;
  endUs: number;
  transform: TransformSpec;
  animation?: {
    in?: string;
    out?: string;
  };
};

export type EditTrack =
  | { id: string; kind: "video"; items: VideoClip[] }
  | { id: string; kind: "audio"; items: AudioClip[] }
  | { id: string; kind: "caption"; items: CaptionCue[] }
  | { id: string; kind: "overlay"; items: OverlayItem[] };

export type EditTransition = {
  id: string;
  fromClipId: string;
  toClipId: string;
  type: "cut" | "dissolve" | "fade" | "slide";
  durationUs: number;
};

export type EditPlanVariant = {
  groupId: string;
  key: "balanced" | "pace" | "character";
  label: string;
  description: string;
  index: number;
  count: number;
  selectionSignature: string;
};

export type EditPlan = {
  id: string;
  version: 1;
  revision?: number;
  parentPlanId?: string;
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
  emotionSegments?: Array<{
    id: string;
    startUs: number;
    endUs: number;
    tone: EmotionTone;
    intensity: number;
    confidence: number;
    clipIds: string[];
    reason: string;
  }>;
  provenance: {
    goal: string;
    genre: "vlog";
    methodologyIds: string[];
    generatedAt: number;
    plannerProvider?: string;
    plannerModel?: string;
    plannerInputDigest?: string;
    plannerOutput?: unknown;
    evidenceQuality?: AnalysisEvidenceQualityReport;
    variant?: EditPlanVariant;
  };
  validation: {
    valid: boolean;
    warnings: EditPlanIssue[];
    errors: EditPlanIssue[];
  };
};

export type EditFeedbackAction =
  | { type: "restore_plan"; targetPlanId: string }
  | { type: "keep_clip"; clipId: string }
  | { type: "delete_clip"; clipId: string }
  | { type: "move_clip"; clipId: string; toIndex: number }
  | { type: "trim_clip"; clipId: string; sourceInUs: number; sourceOutUs: number }
  | {
    type: "replace_clip";
    clipId: string;
    replacementCandidateId: string;
    intent?: string;
  }
  | { type: "update_caption"; cueId: string; text: string }
  | { type: "set_music"; music: AudioClip }
  | { type: "set_music_sequence"; music: AudioClip[] }
  | { type: "remove_music"; audioClipId: string }
  | {
    type: "apply_beat_sync";
    audioClipId: string;
    fromClipId: string;
    toClipId: string;
    beatTimeUs: number;
  }
  | { type: "set_voiceover"; voiceover: AudioClip }
  | { type: "remove_voiceover"; audioClipId: string }
  | {
    type: "set_transition";
    fromClipId: string;
    toClipId: string;
    transitionType: EditTransition["type"];
    durationUs: number;
  }
  | {
    type: "set_overlay_template";
    anchorClipId: string;
    templateKey: string;
    text?: string;
  }
  | { type: "remove_overlay"; overlayId: string };

export type EditFeedbackEvent = {
  id: string;
  sessionId: string;
  planId: string;
  resultingPlanId: string;
  action: EditFeedbackAction;
  beforeRevision: number;
  afterRevision: number;
  createdAt: number;
};

// 对标账号 (UP 主)
export type AccountPlatform = "bilibili" | "douyin" | "xiaohongshu" | "youtube" | "tiktok" | "unknown";

// 首次拉取范围
export type AccountFetchRange = "top10" | "recent20" | "all";

// 账号下挂的"原始视频"。只存元数据,真正分析时再派生 Project。
/** @deprecated v3: merged into Video table; kept for compat */
export type AccountVideo = {
  id: string;                       // 内部 id: `av-${accountId}-${externalId}`
  accountId: string;
  externalId: string;               // 平台视频 id (BV / aweme_id / yt watch id)
  externalUrl: string;
  title: string;
  durationSec: number;
  thumbnailUrl?: string;
  uploadDate?: string | null;       // YYYYMMDD or ISO
  viewCount?: number;
  likeCount?: number;
  commentCount?: number;
  shareCount?: number;
  collectCount?: number;
  playUrl?: string;
  platform: AccountPlatform;
  addedAt: string;                  // ISO 入库时间
  // 派生的分析项目 id;有值表示已经"开始分析"过。
  analysisProjectId?: string;
  // 轻量内容分析
  videoSummary?: VideoContentAnalysis;
  summaryStatus?: "idle" | "summarizing" | "done" | "failed";
  summaryError?: string;
  localVideoPath?: string;
  localPath?: string;
  sourceUrl?: string;
};

export type VideoContentAnalysis = {
  summary: string;
  topic: string;
  target: string;
  tags: string[];
  frames?: Array<{ url: string; timeSec: number }>;
  transcript?: {
    text: string;
    segments: Array<{ text: string; startSec: number; endSec: number }>;
  } | null;
  durationSec?: number;
};

// 账号当前拉取状态
export type AccountFetchPhase = "idle" | "fetching" | "ready" | "failed";

export type AccountFetchProgress = {
  accountId: string;
  stage: string;
  progress: number;                 // 0-100
  message?: string;
};

// 旧版方法论(偏结构拆解的 4 维)。保留以兼容渲染历史记录。
export type AccountMethodology = {
  hooks?: { summary: string; sampleVideoIds?: string[] };
  pacing?: { summary: string; sampleVideoIds?: string[] };
  structure?: { summary: string; sampleVideoIds?: string[] };
  visual?: { summary: string; sampleVideoIds?: string[] };
  generatedAt?: string;
  sourceVideoCount?: number;
};

// 收藏夹/集合维度的方法论 — 抽共性 + 给可复用创作方法,辅助创作。
// 每条 item 可挂样本视频(sampleVideoIds 从该集合的视频里选)。
export type MethodologyItem = {
  title: string;
  detail: string;
  sampleVideoIds?: string[];
};

export type CollectionMethodology = {
  commonalities?: MethodologyItem[]; // 共性洞察:选题/钩子/结构/节奏/视觉 的反复模式
  playbook?: MethodologyItem[];      // 创作方法:可照做的公式/模板
  generatedAt?: string;
  sourceVideoCount?: number;
};

// 渲染层会同时遇到新老两种形态(老记录是 AccountMethodology)。
export type AnyMethodology = CollectionMethodology & Partial<AccountMethodology>;

export type Account = {
  id: string;
  name: string;
  platform: AccountPlatform;
  externalId?: string;             // UP 主在该平台的 id (如 B 站 UID)
  externalUrl?: string;            // 账号主页 URL
  avatarUrl?: string;               // 真实头像 URL (B 站 face / yt-dlp thumbnails 最大尺寸)
  avatarHint?: string;              // 头像 URL 加载失败时显示的 2-3 字 fallback
  bio?: string;                     // 账号简介 / sign
  followers?: string;               // 格式化字符串 "1238万"
  tags?: string[];                  // ["科技", "影视"]
  /** @deprecated v3: videos 表按 account_id 查 */
  videoIds?: string[];
  totalVideoCount?: number;
  secUid?: string;
  /** accounts:list 回填(来自该账号 col-account 收藏夹的 methodology);新老结构兼容 */
  methodology?: AnyMethodology;
  /** accounts:list 回填 */
  methodologyHistory?: AnyMethodology[];
  // 首次/上次拉取的范围设置;详情页 dropdown 可改
  fetchRange?: AccountFetchRange;
  // 后台拉取阶段。fetching → ready/failed,UI 用来挂"拉取中"角标
  fetchPhase?: AccountFetchPhase;
  fetchError?: string;              // failed 时的最后错误信息
  lastFetchedAt?: string;           // 上次成功拉取时间
  // 账号级内容分析配置（高级设置持久化）
  analysisConfig?: {
    slotOverrides?: SlotOverrides;
    customPrompt?: string;
  };
  createdAt?: string;
  updatedAt?: string;
};

// 剪辑会话 — 用户输入目标 + 应用方法论 + 引用素材,产出剪辑思路 / 缺失镜头 / 脚本
export type StudioSessionOutput =
  | { kind: "draft" }
  | { kind: "cut-list" }
  | { kind: "idea" };

export type StudioStep = {
  index: number;
  label: string;                // "开场钩子 · 0:00 - 0:30"
  startSec?: number;
  endSec?: number;
  body: string;                 // 文案 / 旁白建议
  shotRefs: Array<{
    assetProjectId: string;     // 引用 Project.id (kind=asset)
    shotId?: string;
    rangeStart?: number;
    rangeEnd?: number;
    note?: string;              // 显示 "IMG_2104.MOV · 主播半身 0:00-0:08"
  }>;
  missing?: string;             // 缺失镜头描述
};

// ==================== v3 数据模型 ====================

export type VideoStatus = "ready" | "downloading" | "download_failed" | "failed" | "cancelled" | "interrupted" | "analyzing" | "not_analyzed" | "completed";
export type VideoRole = "analysis" | "asset" | "account_video";

export type Video = {
  id: string;
  title: string;
  sourceType: "url" | "local";
  sourceUrl?: string;
  playUrl?: string;
  platform?: AccountPlatform;
  externalId?: string;
  localPath?: string;
  durationSec: number;
  width: number;
  height: number;
  orientation: "landscape" | "portrait" | "square";
  thumbnailUrl?: string;
  accountId?: string;
  videoRole: VideoRole;
  status: VideoStatus;
  uploadDate?: string;
  viewCount?: number;
  likeCount?: number;
  commentCount?: number;
  shareCount?: number;
  collectCount?: number;
  tags?: string[];
  createdAt: string;
  updatedAt: string;
  // UI 层用, 不落 DB
  currentAnalysisId?: string;
  /** @deprecated v2 compat — use sourceType/sourceUrl */
  source?: { type: string; url?: string; platform?: string; originalPath?: string };
  /** @deprecated v2 compat */
  videoName?: string;
  /** @deprecated v2 compat */
  localVideoPath?: string;
  /** @deprecated v2 compat */
  localFilePath?: string;
  /** @deprecated v2 compat */
  kind?: string;
  /** @deprecated v2 compat */
  assetTags?: string[];
  /** @deprecated v2 compat */
  shots?: Shot[];
  /** @deprecated v2 compat */
  titleAutoGenerated?: boolean;
};

export type CollectionKind = "manual" | "smart" | "account";

export type Collection = {
  id: string;
  name: string;
  description?: string;
  kind: CollectionKind;
  coverUrl?: string;
  filterRules?: Record<string, unknown>;
  accountId?: string;
  createdAt: string;
  updatedAt: string;
  // 方法论(创作手册)— collections:list 回填,最新一份 + 历史快照
  methodology?: AnyMethodology;
  methodologyHistory?: AnyMethodology[];
};

export type PipelineStageDefinition = {
  key: string;
  label: string;
  slot: string | null;
};

export type Pipeline = {
  id: string;
  name: string;
  builtin: boolean;
  stages: PipelineStageDefinition[];
  slotConfig?: Record<string, SlotAssignment>;
  description?: string;
  createdAt: string;
  updatedAt: string;
};

export type Analysis = {
  id: string;
  videoId: string;
  pipelineId: string;
  status: AnalysisStatus;
  options?: AnalysisOptions;
  providerSnapshot?: Record<string, unknown>;
  result?: unknown;
  tokenUsage?: TokenUsageSummary;
  durationMs?: number;
  errorMessage?: string;
  startedAt: string;
  completedAt?: string;
  createdAt: string;
  // 运行时进度快照(持久化在 analyses 行,供前端纯视图 / 重启恢复读取)
  progress?: number;
  stage?: string;
  stageIndex?: number;
  message?: string;
  heartbeatAt?: number;
  /** @deprecated v2 compat — use options */
  analysisOptions?: AnalysisOptions;
  /** @deprecated v2 compat — use providerSnapshot */
  providerId?: string;
  /** @deprecated v2 compat */
  lastErrorMessage?: string;
};

export type Methodology = {
  id: string;
  collectionId: string;   // 主绑定:方法论挂在收藏夹上
  accountId?: string;     // 冗余:col-account 收藏夹才有,便于按账号查/兼容
  version: number;
  data: AnyMethodology;
  sourceVideoCount: number;
  createdAt: string;
};

// ==================== end v3 ====================

export type StudioSession = {
  id: string;
  goal: string;
  targetPlatform?: string;       // "B 站知识区"
  targetDurationSec?: number;
  mainShotRatio?: number;        // 0-1
  appliedMethodologies?: string[]; // Account.id[]
  usedAssetIds?: string[];        // Project.id (kind=asset)[]
  steps?: StudioStep[];
  scriptDraft?: string;
  missingShots?: string[];
  currentEditPlanId?: string;
  output?: StudioSessionOutput;
  createdAt?: string;
  updatedAt?: string;
};
