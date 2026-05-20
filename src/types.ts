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
  quantizations: LocalQuantization[];
  fit?: LocalFitLevel;
  memPercent?: number;
  tps?: number;
  downloaded?: boolean;
  llmBytes?: number;
  mmprojBytes?: number;
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
  ownedBy?: string;                    // 远程 /models 的 owned_by 兜底展示
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
  ownedBy?: string;
  maxOutputTokens?: number;
  temperature?: number;
  // 本地推理 model 专属(冗余,等价于 id,但旧 config 还在用)
  localKey?: string;
  // 本地 whisper 专属
  localWhisperModel?: string;
  localWhisperMirror?: string;
  language?: string;
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

export type SlotAssignment = { providerId: string; modelId: string } | null;
export type TaskSlots = Record<TaskSlotKey, SlotAssignment>;

export type ProjectSource =
  | { type: "local_file"; originalPath: string }
  | {
      type: "url";
      url: string;
      platform: "douyin" | "xiaohongshu" | "bilibili" | "tiktok" | "unknown";
    };

export type ProjectStatus =
  | "not_analyzed"
  | "downloading"
  | "download_failed"
  | "analyzing"
  | "completed"
  | "failed";

export type Project = {
  id: string;
  source: ProjectSource;
  localVideoPath: string; // media:// URL in Electron or Object URL for browser demo
  localFilePath?: string;
  videoName: string;
  durationSec: number;
  width: number;
  height: number;
  orientation: "landscape" | "portrait" | "square";
  status: ProjectStatus;
  providerId?: string;
  model?: string;
  analysisOptions?: AnalysisOptions;
  thumbnailUrl?: string; // For recent projects list
  // 标记: videoName 已被 LLM 自动生成过, 后续分析阶段不要再覆盖。
  // - URL 拉取: yt-dlp 写完 info.json 后 medium_text 直接生成 → true
  // - 本地选取: 缺省 false; 分析跑出 globalSummary 后再生成一次, 同时置 true
  // - 用户手动改名: 也置 true (后续不要 LLM 覆盖人工命名)
  titleAutoGenerated?: boolean;
  createdAt?: string;
  updatedAt?: string;
  // ISO 时间, 分析任务开始时由 AppContext 写入。ProgressScreen 用它算"已用 / 剩余"
  // (而不是 mount 时的 Date.now), 退出再进 / 应用重启都能拿回真实累计耗时。
  // 任务终止 (完成 / 失败 / 取消) 后保留, 让 Workspace 能展示历史耗时。
  analysisStartedAt?: string;
  // v2: 项目类型。analysis=分析模块下用户主动开的视频; asset=素材库; account_video=对标账号下的视频
  // 旧数据没有此字段,renderer 默认按 'analysis' 处理
  kind?: ProjectKind;
  // 仅 kind=asset 时使用: 该素材的镜头索引
  shots?: Shot[];
  // 仅 kind=asset 时使用: 用户给素材打的全局标签
  assetTags?: string[];
  // 仅 kind=account_video 时使用: 关联的对标账号 id
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
  subtitleSegments?: Array<{ start: number; end: number; text: string }>; // 落在该镜头区间内的字幕段
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
  subtitleSegments?: Array<{ start: number; end: number; text: string }>; // 落在该镜头区间的字幕段, 保留分段
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

// 全局默认分析参数: 起分析时若 project.analysisOptions 缺省则用它推导
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
  projectId: string;
  progress: number;
  stage: string;
  message?: string;
};

// 进度屏的"实时日志"一条。absoluteMs 是 Date.now() 记录瞬间, 显示时按当前
// project.analysisStartedAt 算相对偏移 (m:ss) — 这样同一条 log 跨退出再进 /
// 切 project 都不需要重算时基。
export type ProgressLogEntry = {
  absoluteMs: number;
  stage: string;
  message: string;
  tone: "info" | "ok" | "warn";
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
  // 分析阶段结果缓存目录, null/缺省 → userData/cache;
  // 可在设置里改到外部盘 (改路径会触发整目录迁移)。
  cacheDir?: string | null;
  // 缓存总容量上限 (字节), 0 = 无上限, 默认 10 GB。
  cacheMaxBytes?: number;
  schemaVersion: 2;
  // v1 残留字段,仅在 migrateConfigV1ToV2 内读取,迁移后写回时不再产生
  /** @deprecated migrated to taskSlots.complex_vision */
  activeVideoProviderId?: string | null;
  /** @deprecated migrated to audioSlot */
  activeAudioProviderId?: string | null;
};

// v2: 两层路由结构,替代扁平 ScreenState。
// 老的 7 屏全部归到 module: "analysis" 下。新模块作为并列入口。
export type AppModule = "analysis" | "library" | "account" | "studio" | "settings";

export type AppLocation =
  | { module: "analysis";  screen: "home" | "progress" | "workspace" | "report" | "url_pull" }
  | { module: "library";   screen: "list" | "upload" | "shot-list" | "shot-detail" }
  | { module: "account";   screen: "list" | "detail" | "methodology" }
  | { module: "studio";    screen: "list" | "editor" }
  | { module: "settings" };

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
  if (loc.module === "analysis") return loc.screen as ScreenState;
  return "home";
}

// Project.kind: v2 在共享底座上分类。旧数据默认 'analysis'。
export type ProjectKind = "analysis" | "asset" | "account_video";

// 单个镜头(Shot)— 素材分镜后的最小单位
export type Shot = {
  id: string;
  assetProjectId: string;          // 关联到 Project.id (kind=asset)
  shotIndex: number;
  startSec: number;
  endSec: number;
  thumbnailUrl?: string;
  description: string;             // 自动镜头描述
  shotType?: "wide" | "medium" | "close" | "extreme-close" | "establishing";
  cameraMovement?: string;
  usageTags: string[];             // 用户/LLM 标的用途标签: ["开场","转场","B-roll"]
  isFavorite?: boolean;
  subtitleText?: string;
  createdAt?: string;
};

// 对标账号 (UP 主)
export type AccountPlatform = "bilibili" | "douyin" | "xiaohongshu" | "youtube" | "tiktok" | "unknown";

// 首次拉取范围
export type AccountFetchRange = "top10" | "recent20" | "all";

// 账号下挂的"原始视频"。只存元数据,真正分析时再派生 Project。
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
  platform: AccountPlatform;
  addedAt: string;                  // ISO 入库时间
  // 派生的分析项目 id;有值表示已经"开始分析"过。
  analysisProjectId?: string;
};

// 账号当前拉取状态
export type AccountFetchPhase = "idle" | "fetching" | "ready" | "failed";

export type AccountFetchProgress = {
  accountId: string;
  stage: string;
  progress: number;                 // 0-100
  message?: string;
};

// 跨视频汇总产物 — 一份 manifest 描述该 UP 主的方法论
export type AccountMethodology = {
  hooks?: { summary: string; sampleVideoIds?: string[] };
  pacing?: { summary: string; sampleVideoIds?: string[] };
  structure?: { summary: string; sampleVideoIds?: string[] };
  visual?: { summary: string; sampleVideoIds?: string[] };
  generatedAt?: string;
};

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
  // legacy v2.0: 关联视频 Project id 列表;新数据用 account_videos 表存储,不再写这个字段
  videoIds?: string[];
  totalVideoCount?: number;         // 该账号下的视频总数 (含未分析的)
  methodology?: AccountMethodology; // 跨视频汇总产物;null 表示还未生成
  // 首次/上次拉取的范围设置;详情页 dropdown 可改
  fetchRange?: AccountFetchRange;
  // 后台拉取阶段。fetching → ready/failed,UI 用来挂"拉取中"角标
  fetchPhase?: AccountFetchPhase;
  fetchError?: string;              // failed 时的最后错误信息
  lastFetchedAt?: string;           // 上次成功拉取时间
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
  output?: StudioSessionOutput;
  createdAt?: string;
  updatedAt?: string;
};
