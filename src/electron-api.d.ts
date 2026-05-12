import type {
  AnalysisNode,
  AnalysisOptions,
  AnalysisProgressEvent,
  AnalysisReport,
  AppConfig,
  ModelProvider,
  Project,
  ProjectSource,
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
};

declare global {
  interface Window {
    videoAnalyzer?: {
      getRuntimeStatus: () => Promise<RuntimeStatus>;
      openVideoFile: () => Promise<InspectedVideo | null>;
      inspectVideoPath: (filePath: string) => Promise<InspectedVideo>;
      getPathForFile: (file: File) => string;
      downloadVideo: (url: string) => Promise<DownloadedVideo>;
      loadConfig: () => Promise<AppConfig | null>;
      saveConfig: (config: AppConfig) => Promise<{ ok: true }>;
      listProjects: () => Promise<Project[]>;
      upsertProject: (project: Project) => Promise<{ ok: true }>;
      deleteProject: (projectId: string) => Promise<{ ok: true }>;
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
    };
  }
}

export {};
