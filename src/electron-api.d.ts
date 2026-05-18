import type {
  Account,
  AnalysisNode,
  AnalysisOptions,
  AnalysisProgressEvent,
  AnalysisReport,
  AppConfig,
  MachineSpecs,
  ModelDescriptor,
  ModelProvider,
  Project,
  ProjectSource,
  Shot,
  StudioSession,
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
  projectId: string;
  platform: Extract<ProjectSource, { type: "url" }>["platform"];
  title?: string | null;    // medium_text 从分享文案提的项目标题 (空 → 用 filename)
  fromCache?: boolean;      // true: 复用了 url-cache 里的本地文件, 没走 yt-dlp
};

export type AnalysisResult = {
  project: Project;
  nodes: AnalysisNode[];
  report: AnalysisReport;
};

export type ExportFormat = "markdown" | "json" | "csv";

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
  stage: "skip" | "start" | "progress" | "done";
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
      loadConfig: () => Promise<AppConfig | null>;
      saveConfig: (config: AppConfig) => Promise<{ ok: true }>;
      listProjects: () => Promise<Project[]>;
      upsertProject: (project: Project) => Promise<{ ok: true }>;
      deleteProject: (projectId: string) => Promise<{ ok: true }>;
      // v2: accounts / sessions / shots
      listAccounts: () => Promise<Account[]>;
      upsertAccount: (account: Account) => Promise<{ ok: true }>;
      deleteAccount: (accountId: string) => Promise<{ ok: true; message?: string }>;
      listSessions: () => Promise<StudioSession[]>;
      upsertSession: (session: StudioSession) => Promise<{ ok: true }>;
      deleteSession: (sessionId: string) => Promise<{ ok: true; message?: string }>;
      listShots: (assetProjectId?: string) => Promise<Shot[]>;
      setShotsForAsset: (assetProjectId: string, shots: Shot[]) => Promise<{ ok: true }>;
      // v2 业务路径
      fetchAccountVideos: (payload: { url: string; limit?: number }) => Promise<{
        ok: true;
        accountTitle?: string | null;
        accountUploader?: string | null;
        totalVideoCount?: number;
        videos: Array<{ id: string; title: string; durationSec: number; uploadDate: string | null; viewCount: number; externalUrl: string }>;
      }>;
      generateAccountMethodology: (payload: {
        accountName: string;
        videoSummaries: Array<{ title: string; summary?: string; structure?: unknown; pacing?: string; editingStyle?: string; composition?: string }>;
      }) => Promise<{ ok: true; methodology: import("./types").AccountMethodology }>;
      generateStudioSteps: (payload: {
        goal: string;
        targetDurationSec: number;
        methodologies?: Array<{ name: string; summary: string }>;
        assets?: Array<{ id: string; name: string; durationSec: number; shotCount: number }>;
      }) => Promise<{ ok: true; steps: import("./types").StudioStep[] }>;
      analyzeAssetShots: (payload: { assetProjectId: string; filePath: string; durationSec: number }) => Promise<{
        ok: true;
        shots: Shot[];
      }>;
      getNodes: (projectId: string) => Promise<AnalysisNode[]>;
      setNodes: (projectId: string, nodes: AnalysisNode[]) => Promise<{ ok: true }>;
      getReport: (projectId: string) => Promise<AnalysisReport | null>;
      setReport: (projectId: string, report: AnalysisReport | null) => Promise<{ ok: true }>;
      analyzeProject: (payload: {
        project: Project;
        provider?: ModelProvider;
        audioProvider?: ModelProvider | null;
        options: AnalysisOptions;
      }) => Promise<AnalysisResult>;
      cancelAnalysis: (projectId: string) => Promise<{ cancelled: boolean }>;
      isAnalysisActive: (projectId: string) => Promise<boolean>;
      getLastAnalysisProgress: (projectId: string) => Promise<AnalysisProgressEvent | null>;
      onAnalysisProgress: (callback: (event: AnalysisProgressEvent) => void) => () => void;
      exportProject: (payload: {
        project: Project;
        nodes: AnalysisNode[];
        report: AnalysisReport;
        provider?: ModelProvider;
        format: ExportFormat;
      }) => Promise<{ canceled: boolean; filePath?: string }>;
      testProvider: (provider: ModelProvider) => Promise<ProviderTestResult>;
      checkYtDlpUpdate: () => Promise<YtDlpUpdateInfo>;
      installYtDlp: () => Promise<YtDlpInstallResult>;
      onYtDlpUpdateStatus: (callback: (info: YtDlpUpdateInfo) => void) => () => void;
      onYtDlpProgress: (callback: (progress: YtDlpProgress) => void) => () => void;
      getDataInfo: () => Promise<{
        userDataPath: string;
        projectsPath: string;
        configPath: string;
        dbPath: string;
        projectCount: number;
        dbProjectCount: number;
        totalBytes: number;
        dbBytes: number;
      }>;
      openDataFolder: (which?: "projects" | "userData") => Promise<{ ok: boolean; path: string }>;
      purgeProjects: () => Promise<{ ok: boolean; message?: string }>;
      mirror: {
        get: () => Promise<{ mirror: "hf-mirror" | "modelscope" }>;
        set: (value: "hf-mirror" | "modelscope") => Promise<{ ok: true; mirror: "hf-mirror" | "modelscope" }>;
      };
      llama: {
        listModels: () => Promise<ModelDescriptor[]>;
        listManifest: () => Promise<{ machine: MachineSpecs; models: ModelDescriptor[] }>;
        getStatus: () => Promise<LlamaStatus>;
        ensureBinary: () => Promise<{ ok: true; binaryPath: string }>;
        ensureModel: (modelKey: string) => Promise<{ ok: true; modelKey: string }>;
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
        start: (modelKey: string) => Promise<{ ok: true; port: number; reused: boolean }>;
        stop: () => Promise<{ ok: true }>;
        onProgress: (callback: (event: WhisperCppProgress) => void) => () => void;
        onLog: (callback: (event: WhisperCppLogEntry) => void) => () => void;
      };
      cache: {
        getStats: () => Promise<CacheStats>;
        list: (params?: { scope?: string; limit?: number; offset?: number }) => Promise<CacheEntry[]>;
        clear: (params?: { scope?: string }) => Promise<CacheClearResult>;
        setMaxBytes: (bytes: number) => Promise<{ ok: true; maxBytes: number }>;
        setDir: (dir: string) => Promise<CacheSetDirResult>;
        browseDir: () => Promise<{ canceled: boolean; dir?: string }>;
        openDir: () => Promise<{ ok: boolean; path: string }>;
      };
    };
  }
}

export {};
