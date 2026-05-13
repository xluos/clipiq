export type ModelInputMode = "auto" | "direct_video" | "keyframe_sequence";

export type ProviderKind = "video" | "audio";

export type ModelProvider = {
  id: string;
  name: string;
  baseUrl: string;
  apiKeyRef: string;
  model: string;
  kind: ProviderKind;
  endpointType:
    | "openai_chat_completions"
    | "openai_responses"
    | "openai_audio_transcriptions"
    | "local_whisper_wasm";
  localWhisperModel?: string; // for local_whisper_wasm: HF model id, e.g. "Xenova/whisper-base"
  localWhisperMirror?: string; // override HF mirror, default https://hf-mirror.com
  inputMode: ModelInputMode;
  language?: string; // audio: BCP-47 hint, e.g. "zh", "en"
  maxOutputTokens?: number;
  temperature?: number;
};

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
  activeVideoProviderId: string | null;
  activeAudioProviderId: string | null;
  // 上次启动过的本地推理模型(key)。下次应用启动时自动恢复。
  lastLlamaModelKey?: string | null;
};

export type ScreenState = 
  | "home"
  | "settings"
  | "url_pull"
  | "prepare"
  | "progress"
  | "workspace"
  | "report";
