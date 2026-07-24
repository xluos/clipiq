import type {
  Account,
  AccountFetchProgress,
  AccountFetchRange,
  Analysis,
  AnalysisNode,
  AnalysisOptions,
  AnalysisProgressEvent,
  AnalysisBudgetEvent,
  AudioClip,
  AudioBeatAnalysis,
  AnalysisEvidenceQualityReport,
  AnalysisReport,
  AppConfig,
  Collection,
  EditPlan,
  EditFeedbackAction,
  EditFeedbackEvent,
  LocalFitLevel,
  MachineSpecs,
  Methodology,
  ModelDescriptor,
  ModelProvider,
  Person,
  PersonAppearance,
  Pipeline,
  Shot,
  SpeakerTrack,
  StudioSession,
  Video,
  VideoRole,
  VideoContentAnalysis,
} from "./types";

export type QueueTaskStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted";

/** 通用后台任务队列里的一条任务(electron/task-queue.ts 的 Task 镜像) */
export type QueueTask = {
  id: string;
  kind: string;
  status: QueueTaskStatus;
  title: string;
  payload: Record<string, unknown>;
  refId: string | null;
  dedupeKey: string | null;
  progress: number;
  stage: string;
  message: string;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
};

export type EditPlanPreview = {
  version: 1;
  planId: string;
  planVersion: number;
  renderDigest: string;
  outputPath: string;
  mediaUrl: string;
  captionsPath?: string;
  captionsUrl?: string;
  durationUs: number;
  width: number;
  height: number;
  fps: number;
  subtitleMode: "external" | "burn" | "none";
  cacheHits: number;
  renderedSegments: number;
  warnings?: string[];
  createdAt: number;
};

export type EditReplacementCandidate = {
  candidateId: string;
  shotId: string;
  videoId: string;
  startUs: number;
  endUs: number;
  description: string;
  subtitle: string;
  personIds: string[];
  qualityScore: number;
};

export type EditPackageExportWarning = {
  code:
    | "PREVIEW_NOT_INCLUDED"
    | "VOICEOVER_NOT_SYNTHESIZED"
    | "OVERLAY_RESOURCE_NOT_PORTABLE"
    | "FCPXML_TRANSITION_DOWNGRADED"
    | "FCPXML_CROP_NOT_INCLUDED"
    | "FCPXML_TRANSFORM_NOT_INCLUDED"
    | "FCPXML_AUDIO_MIX_PARTIAL"
    | "FCPXML_OVERLAY_NOT_INCLUDED"
    | "FCPXML_CAPTIONS_AS_SRT"
    | "FCPXML_AUDIO_NOT_INCLUDED";
  message: string;
  itemId?: string;
};

export type EditPackageExportResult = {
  cancelled: false;
  packagePath: string;
  manifestPath: string;
  planPath: string;
  fcpxmlPath: string;
  captionsPath?: string;
  previewPath?: string;
  fileCount: number;
  totalBytes: number;
  warnings: EditPackageExportWarning[];
};

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
  thumbnailUrl?: string | null;
  fromCache?: boolean;
};

export type DownloadCompleteEvent =
  | { videoId: string; success: true; video: DownloadedVideo }
  | { videoId: string; success: false; cancelled?: boolean; error: string };

export type ExportFormat = "markdown" | "json" | "csv" | "zip";

export type ExtensionBridgeStatus = {
  port: number;
  portRange?: { start: number; end: number };
  host: string;
  token: string | null;
  pairedOrigin: string | null;
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

export type EditingAppEnvironmentReport = {
  platform: string;
  detectedAt: number;
  readiness:
    | "unsupported_platform"
    | "not_installed"
    | "app_detected"
    | "ready_for_spike";
  exporterReady: boolean;
  installations: Array<{
    kind: "jianying" | "capcut";
    name: string;
    appPath: string;
    bundleId?: string;
    version?: string;
    build?: string;
    readable: boolean;
    compatibility: "verified" | "unverified";
  }>;
  draftRoots: Array<{
    kind: "jianying" | "capcut";
    path: string;
    source: "known_default" | "discovered" | "override";
    exists: boolean;
    isDirectory: boolean;
    readable: boolean;
    writable: boolean;
    projectCount: number;
  }>;
  issues: Array<{
    code: string;
    severity: "info" | "warning" | "error";
    message: string;
    kind?: "jianying" | "capcut";
    path?: string;
  }>;
};

declare global {
  interface Window {
    videoAnalyzer?: {
      getRuntimeStatus: () => Promise<RuntimeStatus>;
      detectEditingAppEnvironment: () => Promise<EditingAppEnvironmentReport>;
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
      listVideos: (filter?: { accountId?: string; collectionId?: string; platform?: string; status?: string; videoRole?: VideoRole; unassigned?: boolean }) => Promise<Video[]>;
      upsertVideo: (video: Video) => Promise<{ ok: true }>;
      deleteVideo: (videoId: string) => Promise<{ ok: true }>;

      // v3: analyses
      listAnalyses: (videoId: string) => Promise<Analysis[]>;
      listAllAnalyses: () => Promise<Analysis[]>;
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
      refreshAccountProfile: (payload: { accountId: string }) => Promise<{
        ok: boolean;
        account?: Account;
        refreshed?: boolean;
        error?: string;
      }>;

      // 抖音登录态
      douyinOpenLogin: () => Promise<{ ok: boolean; cancelled?: boolean; timeout?: boolean }>;
      douyinGetLoginStatus: () => Promise<{ loggedIn: boolean }>;
      douyinLogout: () => Promise<{ ok: boolean }>;

      // studio sessions
      listSessions: () => Promise<StudioSession[]>;
      upsertSession: (session: StudioSession) => Promise<{ ok: true }>;
      deleteSession: (sessionId: string) => Promise<{ ok: true; message?: string }>;

      // shots
      listShots: (videoId?: string) => Promise<Shot[]>;
      setShotsForVideo: (videoId: string, shots: Shot[]) => Promise<{ ok: true }>;

      // 人物 / 说话人证据
      listPeople: () => Promise<Person[]>;
      listPersonAppearances: (videoId?: string) => Promise<PersonAppearance[]>;
      listSpeakerTracks: (videoId?: string) => Promise<SpeakerTrack[]>;
      renamePerson: (personId: string, displayName?: string) => Promise<Person>;
      mergePeople: (
        sourcePersonId: string,
        targetPersonId: string,
      ) => Promise<{ ok: true }>;
      splitPersonAppearance: (
        appearanceId: string,
        person: Person,
      ) => Promise<Person>;
      linkSpeakerTrackPerson: (
        speakerTrackId: string,
        personId?: string,
      ) => Promise<SpeakerTrack>;

      // 剪辑方案
      listEditPlans: (sessionId?: string) => Promise<EditPlan[]>;
      getEditPlan: (planId: string) => Promise<EditPlan | null>;
      saveEditPlan: (plan: EditPlan) => Promise<{ ok: true }>;
      deleteEditPlan: (
        planId: string,
      ) => Promise<{ ok: true; deleted: boolean }>;
      generateEditPlan: (payload: {
        sessionId: string;
        goal?: string;
        targetDurationSec?: number;
        videoIds?: string[];
        methodologyIds?: string[];
        maximumCandidates?: number;
        minimumIdentityConfidence?: number;
        personIds?: string[];
        speakerIds?: string[];
        eventQuery?: string;
        dialogueQuery?: string;
        sourceTimeRanges?: Array<{
          videoId: string;
          startUs: number;
          endUs: number;
        }>;
        maxClipDurationSec?: number;
        canvas?: EditPlan["canvas"];
      }) => Promise<{
        ok: true;
        plan: EditPlan;
        candidateCount: number;
        rejectedCount: number;
        evidenceQuality: AnalysisEvidenceQualityReport;
      }>;
      getEditPlanPreview: (planId: string) => Promise<EditPlanPreview | null>;
      renderEditPlanPreview: (payload: {
        planId: string;
        subtitleMode?: "external" | "burn" | "none";
      }) => Promise<{
        ok: true;
        taskId?: string;
        preview: EditPlanPreview;
      }>;
      exportEditPlanPackage: (payload: {
        planId: string;
        destinationDirectory?: string;
      }) => Promise<EditPackageExportResult | { cancelled: true }>;
      selectEditPlanMusic: (payload: {
        planId: string;
      }) => Promise<
        | { cancelled: true }
        | {
          cancelled: false;
          ok: true;
          taskId?: string;
          taskIds?: string[];
          analysis: AudioBeatAnalysis;
          analyses?: AudioBeatAnalysis[];
          plan: EditPlan;
          event: EditFeedbackEvent;
        }
      >;
      synthesizeEditPlanVoiceover: (payload: {
        planId: string;
        text: string;
        audioClipId?: string;
        anchorClipId?: string;
        voice?: string;
        rateWpm?: number;
      }) => Promise<{
        ok: true;
        taskId: string;
        plan: EditPlan;
        event: EditFeedbackEvent;
        voiceover: AudioClip;
        cacheHit: boolean;
      }>;
      listEditFeedbackEvents: (filter: {
        sessionId?: string;
        planId?: string;
      }) => Promise<EditFeedbackEvent[]>;
      applyEditPlanFeedback: (payload: {
        planId: string;
        action: EditFeedbackAction;
      }) => Promise<{
        ok: true;
        plan: EditPlan;
        event: EditFeedbackEvent;
      }>;
      listEditReplacementCandidates: (payload: {
        planId: string;
        clipId: string;
        limit?: number;
      }) => Promise<EditReplacementCandidate[]>;

      // 后台拉取
      startAccountFetch: (payload: { accountId: string; url: string; range: AccountFetchRange; name?: string }) => Promise<{ ok: true; accepted: boolean; reason?: string; taskId?: string; status?: QueueTaskStatus }>;
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
      resumeAnalysis: (analysisId: string) => Promise<{ resumed: boolean; alreadyRunning?: boolean; analysisId: string }>;
      cancelAnalysis: (videoId: string) => Promise<{ cancelled: boolean }>;
      isAnalysisActive: (videoId: string) => Promise<boolean>;
      getLastAnalysisProgress: (videoId: string) => Promise<AnalysisProgressEvent | null>;
      getLastAnalysisBudget: (videoId: string) => Promise<AnalysisBudgetEvent | null>;
      // 统一任务管理
      listActiveTasks: () => Promise<Array<{ analysisId: string; videoId: string; pipelineId: string; cancelled: boolean; startedAt: number; lastProgress: AnalysisProgressEvent | null }>>;
      cancelTask: (analysisId: string) => Promise<{ cancelled: boolean }>;
      onTaskProgress: (callback: (event: AnalysisProgressEvent & { pipelineId?: string }) => void) => () => void;
      // 通用后台任务队列(task-queue 调度器)
      listQueueTasks: () => Promise<QueueTask[]>;
      cancelQueueTask: (id: string) => Promise<{ cancelled: boolean }>;
      removeQueueTask: (id: string) => Promise<{ removed: boolean }>;
      onQueueTaskUpdate: (callback: (task: QueueTask) => void) => () => void;
      onQueueTaskRemoved: (callback: (payload: { id: string }) => void) => () => void;
      onAnalysisProgress: (callback: (event: AnalysisProgressEvent) => void) => () => void;
      onAnalysisBudget: (callback: (event: AnalysisBudgetEvent) => void) => () => void;

      // 轻量视频摘要 (内容分析管线)
      summarizeVideo: (payload: { videoId: string; slotOverrides?: import("./types").SlotOverrides; customPrompt?: string }) => Promise<{ ok: true; accepted: boolean; reason?: string; taskId?: string; status?: QueueTaskStatus }>;
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
        accountId?: string;
        accountName: string;
        videoSummaries: Array<{ title: string; summary?: string; structure?: unknown; pacing?: string; editingStyle?: string; composition?: string }>;
      }) => Promise<{ ok: true; methodology: import("./types").AccountMethodology }>;
      // 收藏夹维度「创作手册」:服务端按 collectionId 聚合该集合视频的内容分析产物生成
      generateCollectionMethodology: (payload: { collectionId: string }) => Promise<{ ok: true; methodology: import("./types").CollectionMethodology }>;

      // studio
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
      // 批量导出整个账号 / 收藏夹下所有视频的所有分析(多份分析各导一份)
      // includeMedia(仅 zip):额外把本地原视频文件打进压缩包
      exportBundle: (payload: {
        scope: "account" | "collection";
        id: string;
        format: "json" | "zip";
        includeMedia?: boolean;
      }) => Promise<{
        canceled: boolean;
        filePath?: string;
        videoCount?: number;
        analysisCount?: number;
        mediaFileCount?: number;
        mediaMissingCount?: number;
        frameFileCount?: number;
      }>;

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
