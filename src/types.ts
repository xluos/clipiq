export type ModelInputMode = "auto" | "direct_video" | "keyframe_sequence";

export type ModelProvider = {
  id: string;
  name: string;
  baseUrl: string;
  apiKeyRef: string;
  model: string;
  endpointType: "openai_chat_completions";
  inputMode: ModelInputMode;
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
  pipelineVersion?: string;
  schemaVersion?: string;
  generatedAt?: string;
};

export type AnalysisOptions = {
  mode: "quick" | "standard" | "detailed";
  density: "sparse" | "standard" | "dense";
  focus: "all" | "narrative" | "rhythm" | "emotion";
};

export type AnalysisProgressEvent = {
  projectId: string;
  progress: number;
  stage: string;
  message?: string;
};

export type AppPersistedState = {
  projects: Project[];
  providers: ModelProvider[];
  activeProviderId: string | null;
  nodesByProject: Record<string, AnalysisNode[]>;
  reportByProject: Record<string, AnalysisReport>;
};

export type ScreenState = 
  | "home"
  | "settings"
  | "url_pull"
  | "prepare"
  | "progress"
  | "workspace"
  | "report";
