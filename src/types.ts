export type ModelInputMode = "auto" | "direct_video" | "keyframe_sequence";

// Legacy: kept for v1 config compatibility. New code should read `source` + capabilities.
export type ProviderKind = "video" | "audio";

export type ModelCapability =
  | "vision"
  | "reasoning"
  | "fast"
  | "audio_transcription";

export type ProviderSource = "remote" | "local_llama" | "local_whisper";

export type ProviderEndpointType =
  | "openai_chat_completions"
  | "openai_responses"
  | "openai_audio_transcriptions"
  | "local_whisper_cpp"
  | "local_whisper_wasm" // 老 config 残留,migrate 后会被改写为 local_whisper_cpp
  | "local_llama_server";

export type ProviderModel = {
  id: string; // provider 内部唯一,如 "gpt-4o-mini" / "qwen3_5_2b_q4km"
  label: string; // 人类可读 "Qwen3.5-2B (Q4_K_M)"
  capabilities: ModelCapability[];
  maxOutputTokens?: number;
  temperature?: number;
  // 本地推理 model 专属
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
  createdAt?: string;
  updatedAt?: string;
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
};

// PR2 金字塔管线: medium_text 合并出来的镜头级上下文, 喂给主分析做评审
export type ShotContext = {
  shotIndex: number;
  startSec: number;
  endSec: number;
  shotDescription: string;          // medium_text 输出: 综合画面+字幕的一段话 (30-80 汉字)
  framesInShot: number;             // 该镜头内抽到的帧数
  subtitleText?: string;            // 该镜头时间段内的拼接字幕
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
  methodologyAudit?: MethodologyAudit;
  // PR2 金字塔管线新增字段
  globalSummary?: string;           // medium_text 在主分析前生成的全局摘要 (优先于 summary 展示)
  shotContexts?: ShotContext[];     // 所有镜头的中间产物, 时间轴渲染 + 调试用
};

export type AnalysisTiming = {
  stage: string;
  durationMs: number;
  note?: string;
};

export type AnalysisOptions = {
  mode: "quick" | "standard" | "detailed";
  density: "sparse" | "standard" | "dense";
  focus: "all" | "narrative" | "rhythm" | "emotion";
  // Hybrid: 用户可在 PrepareScreen 预指定类型；不指定（"auto"）则让 LLM 识别。
  // 分析完成后用户也可在 ReportScreen 改类型并重新分析。
  manualGenre?: VideoGenre | "auto";
};

export type AnalysisProgressEvent = {
  projectId: string;
  progress: number;
  stage: string;
  message?: string;
};

export type AppConfig = {
  providers: ModelProvider[];
  taskSlots: TaskSlots;
  audioSlot: SlotAssignment;
  // 上次启动过的本地推理模型(key)。下次应用启动时自动恢复。
  lastLlamaModelKey?: string | null;
  schemaVersion: 2;
  // v1 残留字段,仅在 migrateConfigV1ToV2 内读取,迁移后写回时不再产生
  /** @deprecated migrated to taskSlots.complex_vision */
  activeVideoProviderId?: string | null;
  /** @deprecated migrated to audioSlot */
  activeAudioProviderId?: string | null;
};

export type ScreenState = 
  | "home"
  | "settings"
  | "url_pull"
  | "prepare"
  | "progress"
  | "workspace"
  | "report";
