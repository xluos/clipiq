import type {
  Account,
  AccountFetchProgress,
  AccountFetchRange,
  Analysis,
  AnalysisNode,
  AnalysisOptions,
  AnalysisProgressEvent,
  AnalysisBudgetEvent,
  AnalysisReport,
  AppConfig,
  Collection,
  LocalFitLevel,
  MachineSpecs,
  Methodology,
  ModelDescriptor,
  ModelProvider,
  Pipeline,
  Shot,
  StudioSession,
  Video,
  VideoContentAnalysis,
} from "./types";

export type RuntimeStatus = {
  ffmpeg: string | null;
  ffprobe: string | null;
  ytDlp: string | null;
  ffmpegBundled?: boolean;
  ffprobeBundled?: boolean;
  ytDlpBundled?: boolean;
  ytDlpVersion?: string | null;
};

export type YtDlpUpdateInfo = {
  installed: boolean;
  installedVersion: string | null;
  isBundled: boolean;
  latestVersion: string | null;
  publishedAt?: string;
  releaseUrl?: string;
  updateAvailable?: boolean;
  error?: string;
};

export type YtDlpProgress = {
  stage: "resolve" | "download" | "done";
  message: string;
};

export type YtDlpInstallResult = {
  ok: boolean;
  binaryPath: string;
  installedVersion: string | null;
  latestVersion: string | null;
};

export type InspectedVideo = {
  filePath: string;
  mediaUrl: string;
  filename: string;
  durationSec: number;
  width: number;
  height: number;
  rotation?: number;
  orientation: "landscape" | "portrait" | "square";
  hasAudio: boolean;
};

export type DownloadedVideo = InspectedVideo & {
  videoId: string;
  platform: "douyin" | "xiaohongshu" | "bilibili" | "tiktok" | "unknown";
  title?: string | null;
  fromCache?: boolean;
};

export type DownloadCompleteEvent =
  | { videoId: string; success: true; video: DownloadedVideo }
  | { videoId: string; success: false; cancelled?: boolean; error: string };

export type ExportFormat = "markdown" | "json" | "csv";

export type ExtensionBridgeStatus = {
  port: number;
  host: string;
  token: string | null;
  connected: boolean;
  clientVersion: number | null;
  clientUserAgent: string | null;
  connectedAt: string | null;
};

export type ProviderTestResult = {
  ok: boolean;
  message: string;
  // 远程 provider 测试连接成功时,带上 /models 返回的统一 schema
  models?: ModelDescriptor[];
};

export type LlamaStatus = {
  binaryPath: string | null;
  binaryFound: boolean;
  running: boolean;
  status: "idle" | "starting" | "ready" | "stopping" | "error";
  modelKey: string | null;
  port: number | null;
  startedAt: number;
  lastError: string | null;
  recentLogs: Array<{ ts: number; channel: "stdout" | "stderr"; line: string }>;
};

export type LlamaProgress = {
  scope: "binary" | "model";
  modelKey?: string;
  stage:
    | "skip"
    | "start"
    | "progress"
    | "done"
    | "binary-start"
    | "binary-progress"
    | "binary-extract"
    | "binary-done";
  file?: string;
  label: string;
  message: string;
  receivedBytes?: number;
  totalBytes?: number;
  percent?: number;
};

export type LlamaLogEntry = { channel: "stdout" | "stderr"; line: string };

export type LlamaSelfTestResult = {
  ok: true;
  latencyMs: number;
  text: string;
  modelKey: string | null;
  usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
};

export type WhisperCppStatus = {
  binaryPath: string | null;
  binaryFound: boolean;
  running: boolean;
  status: "idle" | "starting" | "ready" | "stopping" | "error";
  modelKey: string | null;
  port: number | null;
  startedAt: number;
  lastError: string | null;
  recentLogs: Array<{ ts: number; channel: "stdout" | "stderr"; line: string }>;
};

export type WhisperCppProgress = {
  scope: "model";
  modelKey?: string;
  stage: "skip" | "start" | "progress" | "done" | "cancelled";
  file?: string;
  label: string;
  message: string;
  receivedBytes?: number;
  totalBytes?: number;
  percent?: number;
};

export type WhisperCppLogEntry = { channel: "stdout" | "stderr"; line: string };

export type SystemStats = {
  cpuPercent: number;
  cpuCount: number;
  memoryPercent: number;
  memoryUsedBytes: number;
  memoryTotalBytes: number;
  memoryPressure: "normal" | "warn" | "critical";
  memoryCompressedBytes?: number;
  swapUsedBytes?: number;
  platform: NodeJS.Platform;
};

export type ProcessEntry = {
  pid: number;
  kind: "main" | "renderer" | "gpu" | "utility" | "sidecar";
  label: string;
  detail?: string;
  cpuPercent: number;
  memoryBytes: number;
};

export type CacheScopeStats = {
  count: number;
  bytes: number;
  lastUsedAt: number;
};

export type CachePolicy = {
  enabled: boolean;
  stages?: Record<string, boolean>;
};

export type CacheStats = {
  totalEntries: number;
  totalBytes: number;
  maxBytes: number;
  cacheDir: string | null;
  byScope: Record<string, CacheScopeStats>;
};

export type CacheEntry = {
  scope: string;
  key: string;
  sizeBytes: number;
  createdAt: number;
  lastUsedAt: number;
  hitCount: number;
  meta: Record<string, unknown> | null;
};

export type FramesCheckpointEntry = {
  index: number;
  startSec: number;
  endSec: number;
  midSec: number;
  framePath: string;
  prefilterFramePath?: string | null;
  hash?: string;
};

export type FramesCheckpoint = {
  frames: FramesCheckpointEntry[];
  skipped: number;
  pipelineVersion?: string;
};

export type TranscriptData = {
  language?: string;
  text: string;
  segments: Array<{ start: number; end: number; text: string }>;
  duration?: number;
};

export type AnalysisSampleStageTokenDelta = {
  stage: string;
  providerId: string | null;
  model: string | null;
  source: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  callCount: number;
};

export type AnalysisSampleStage = {
  stage: string;
  durationMs: number;
  note?: string;
  meta?: Record<string, unknown>;
  tokenDelta?: AnalysisSampleStageTokenDelta[];
};

export type AnalysisSample = {
  schemaVersion: number;
  projectId: string;
  startedAt: string;
  totalDurationMs: number;
  outcome: "ok" | "failed" | "cancelled";
  failureMsg?: string;
  machine: {
    platform: string;
    arch: string;
    cpuModel: string;
    backend: string;
    totalMemoryGB: number;
    availableMemoryGB: number;
  };
  project: {
    platform: string;
    sourceType?: string;
  };
  providers: {
    complexVision: { id: string; name: string; model: string; source?: string; contextSize?: number } | null;
    mediumText: { id: string; name: string; model: string; source?: string; contextSize?: number } | null;
    audio: { id: string; name: string; model: string; source?: string } | null;
  };
  stages: AnalysisSampleStage[];
};

export type CacheClearResult = { freedBytes: number; freedEntries: number };
export type CacheSetDirResult =
  | { ok: true; cacheDir: string; mode: "rename" | "merge" | "copy" | "fresh" | "noop" }
  | { ok: false; message: string };

declare global {
  interface Window {
    videoAnalyzer?: {
      getRuntimeStatus: () => Promise<RuntimeStatus>;
      getSystemStats: () => Promise<SystemStats>;
      getProcessList: () => Promise<ProcessEntry[]>;
      openVideoFile: () => Promise<InspectedVideo | null>;
      inspectVideoPath: (filePath: string) => Promise<InspectedVideo>;
      getPathForFile: (file: File) => string;
      downloadVideo: (url: string) => Promise<DownloadedVideo>;
      downloadVideoAsync: (url: string) => Promise<{
        videoId: string;
        url: string;
        platform: "douyin" | "xiaohongshu" | "bilibili" | "tiktok" | "unknown";
      }>;
      onDownloadComplete: (callback: (payload: DownloadCompleteEvent) => void) => () => void;
      loadConfig: () => Promise<AppConfig | null>;
      saveConfig: (config: AppConfig) => Promise<{ ok: true }>;
      getConfigField: (key: string) => Promise<unknown>;
      saveConfigField: (key: string, value: unknown) => Promise<{ ok: true }>;

      // v3: videos
      listVideos: (filter?: { accountId?: string; collectionId?: string; platform?: string; status?: string }) => Promise<Video[]>;
      upsertVideo: (video: Video) => Promise<{ ok: true }>;
      deleteVideo: (videoId: string) => Promise<{ ok: true }>;

      // v3: analyses
      listAnalyses: (videoId: string) => Promise<Analysis[]>;
      getAnalysis: (analysisId: string) => Promise<Analysis | null>;
      deleteAnalysis: (analysisId: string) => Promise<{ ok: true }>;
      updateAnalysisResult: (analysisId: string, result: unknown) => Promise<{ ok: true }>;

      // v3: collections
      listCollections: () => Promise<Collection[]>;
      upsertCollection: (collection: Collection) => Promise<{ ok: true }>;
      deleteCollection: (collectionId: string) => Promise<{ ok: true }>;
      addVideoToCollection: (collectionId: string, videoId: string) => Promise<{ ok: true }>;
      removeVideoFromCollection: (collectionId: string, videoId: string) => Promise<{ ok: true }>;
      listCollectionVideos: (collectionId: string) => Promise<Video[]>;

      // v3: pipelines
      listPipelines: () => Promise<Pipeline[]>;
      upsertPipeline: (pipeline: Pipeline) => Promise<{ ok: true }>;
      deletePipeline: (pipelineId: string) => Promise<{ ok: true }>;

      // v3: methodologies
      listMethodologies: (accountId: string) => Promise<Methodology[]>;

      // accounts
      listAccounts: () => Promise<Account[]>;
      upsertAccount: (account: Account) => Promise<{ ok: true }>;
      deleteAccount: (accountId: string) => Promise<{ ok: true; message?: string }>;

      // studio sessions
      listSessions: () => Promise<StudioSession[]>;
      upsertSession: (session: StudioSession) => Promise<{ ok: true }>;
      deleteSession: (sessionId: string) => Promise<{ ok: true; message?: string }>;

      // shots
      listShots: (videoId?: string) => Promise<Shot[]>;
      setShotsForVideo: (videoId: string, shots: Shot[]) => Promise<{ ok: true }>;

      // 后台拉取
      startAccountFetch: (payload: { accountId: string; url: string; range: AccountFetchRange }) => Promise<{ ok: true; accepted: boolean; reason?: string }>;
      cancelAccountFetch: (accountId: string) => Promise<{ ok: true; cancelled: boolean }>;
      listAccountFetchInFlight: () => Promise<Array<{ accountId: string; stage: string; progress: number; message?: string }>>;
      onAccountFetchProgress: (callback: (event: AccountFetchProgress) => void) => () => void;
      onAccountFetchDone: (callback: (event: { accountId: string; videos: Video[]; account: Partial<Account>; warnings?: string[] }) => void) => () => void;
      onAccountFetchFailed: (callback: (event: { accountId: string; error: string }) => void) => () => void;

      // 分析
      analyzeVideo: (payload: {
        videoId: string;
        pipelineId: string;
        options?: AnalysisOptions;
        slotOverrides?: import("./types").SlotOverrides;
      }) => Promise<Analysis>;
      cancelAnalysis: (videoId: string) => Promise<{ cancelled: boolean }>;
      isAnalysisActive: (videoId: string) => Promise<boolean>;
      getLastAnalysisProgress: (videoId: string) => Promise<AnalysisProgressEvent | null>;
      getLastAnalysisBudget: (videoId: string) => Promise<AnalysisBudgetEvent | null>;
      onAnalysisProgress: (callback: (event: AnalysisProgressEvent) => void) => () => void;
      onAnalysisBudget: (callback: (event: AnalysisBudgetEvent) => void) => () => void;

      // 轻量视频摘要 (内容分析管线)
      summarizeVideo: (payload: { videoId: string; slotOverrides?: import("./types").SlotOverrides; customPrompt?: string }) => Promise<{ ok: true; accepted: boolean; reason?: string }>;
      cancelSummarizeVideo: (videoId: string) => Promise<{ ok: true; cancelled: boolean }>;
      onVideoSummaryStatus: (callback: (event: {
        videoId: string;
        status: "summarizing" | "done" | "failed" | "idle";
        summary?: VideoContentAnalysis;
        error?: string;
        progress?: number;
        message?: string;
      }) => void) => () => void;

      // 方法论
      generateAccountMethodology: (payload: {
        accountName: string;
        videoSummaries: Array<{ title: string; summary?: string; structure?: unknown; pacing?: string; editingStyle?: string; composition?: string }>;
      }) => Promise<{ ok: true; methodology: import("./types").AccountMethodology }>;

      // studio
      generateStudioSteps: (payload: {
        goal: string;
        targetDurationSec: number;
        methodologies?: Array<{ name: string; summary: string }>;
        assets?: Array<{ id: string; name: string; durationSec: number; shotCount: number }>;
      }) => Promise<{ ok: true; steps: import("./types").StudioStep[] }>;
      analyzeVideoShots: (payload: { videoId: string; filePath: string; durationSec: number }) => Promise<{
        ok: true;
        shots: Shot[];
      }>;

      // 导出
      exportVideo: (payload: {
        video: Video;
        analysis: Analysis;
        format: ExportFormat;
      }) => Promise<{ canceled: boolean; filePath?: string }>;

      // provider
      testProvider: (provider: ModelProvider) => Promise<ProviderTestResult>;

      // yt-dlp
      checkYtDlpUpdate: () => Promise<YtDlpUpdateInfo>;
      installYtDlp: () => Promise<YtDlpInstallResult>;
      onYtDlpUpdateStatus: (callback: (info: YtDlpUpdateInfo) => void) => () => void;
      onYtDlpProgress: (callback: (progress: YtDlpProgress) => void) => () => void;

      // 数据管理
      getDataInfo: () => Promise<{
        userDataPath: string;
        videosPath: string;
        configPath: string;
        dbPath: string;
        videoCount: number;
        totalBytes: number;
        dbBytes: number;
      }>;
      openDataFolder: (which?: "videos" | "userData") => Promise<{ ok: boolean; path: string }>;
      purgeAllData: () => Promise<{ ok: boolean; message?: string }>;

      // 扩展桥
      extensionBridge: {
        getStatus: () => Promise<ExtensionBridgeStatus>;
        rotateToken: () => Promise<{ token: string }>;
        onStatus: (callback: (status: ExtensionBridgeStatus) => void) => () => void;
      };
      mirror: {
        get: () => Promise<{ mirror: "hf-mirror" | "modelscope" }>;
        set: (value: "hf-mirror" | "modelscope") => Promise<{ ok: true; mirror: "hf-mirror" | "modelscope" }>;
      };
      llama: {
        listModels: () => Promise<ModelDescriptor[]>;
        listManifest: () => Promise<{ machine: MachineSpecs; models: ModelDescriptor[] }>;
        recomputeFit: (modelKey: string, contextSize: number) => Promise<{
          fit: LocalFitLevel;
          memPercent: number;
          tps: number;
          totalMemBytes: number;
          weightBytes: number;
          kvBytes: number;
          memCapBytes: number;
          effectiveCtx: number;
        } | null>;
        getStatus: () => Promise<LlamaStatus>;
        ensureBinary: () => Promise<{ ok: true; binaryPath: string }>;
        ensureModel: (modelKey: string) => Promise<{ ok: true; modelKey: string }>;
        cancelDownload: (modelKey: string) => Promise<{ status: string }>;
        start: (modelKey: string) => Promise<{ ok: true; port: number; reused: boolean }>;
        stop: () => Promise<{ ok: true }>;
        selfTest: (payload: { imageDataUrl?: string; prompt?: string }) => Promise<LlamaSelfTestResult>;
        onProgress: (callback: (event: LlamaProgress) => void) => () => void;
        onLog: (callback: (event: LlamaLogEntry) => void) => () => void;
      };
      whisperCpp: {
        listModels: () => Promise<ModelDescriptor[]>;
        getStatus: () => Promise<WhisperCppStatus>;
        ensureModel: (modelKey: string) => Promise<{ ok: true; modelKey: string }>;
        cancelDownload: (modelKey: string) => Promise<{ ok: boolean; modelKey: string }>;
        start: (modelKey: string) => Promise<{ ok: true; port: number; reused: boolean }>;
        stop: () => Promise<{ ok: true }>;
        onProgress: (callback: (event: WhisperCppProgress) => void) => () => void;
        onLog: (callback: (event: WhisperCppLogEntry) => void) => () => void;
      };
      diagnostics: {
        getAnalysisSamples: () => Promise<{ ok: boolean; samples: AnalysisSample[]; error?: string }>;
        getTokenUsage: (analysisId: string) => Promise<{ ok: boolean; data: import("./types").TokenUsageSummary | null }>;
        getFramesCheckpoint: (videoId: string) => Promise<{ ok: boolean; data: FramesCheckpoint | null }>;
        getTranscript: (videoId: string) => Promise<{ ok: boolean; data: TranscriptData | null }>;
        deleteSample: (videoId: string, startedAt: string) => Promise<{ ok: boolean; removed: number; error?: string }>;
        clearAllSamples: () => Promise<{ ok: boolean; error?: string }>;
      };
      cache: {
        getStats: () => Promise<CacheStats>;
        list: (params?: { scope?: string; limit?: number; offset?: number }) => Promise<CacheEntry[]>;
        clear: (params?: { scope?: string }) => Promise<CacheClearResult>;
        setMaxBytes: (bytes: number) => Promise<{ ok: true; maxBytes: number }>;
        setDir: (dir: string) => Promise<CacheSetDirResult>;
        browseDir: () => Promise<{ canceled: boolean; dir?: string }>;
        openDir: () => Promise<{ ok: boolean; path: string }>;
        getPolicy: () => Promise<CachePolicy>;
        setPolicy: (policy: CachePolicy) => Promise<{ ok: true }>;
      };
    };
  }
}

export {};
