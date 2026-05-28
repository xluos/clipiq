import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, ReactNode } from "react";
import { Project, ScreenState, ModelProvider, AnalysisNode, AnalysisReport, AnalysisRecord, AppConfig, TaskSlots, TaskSlotKey, SlotAssignment, SlotOverrides, DefaultAnalysis, AppLocation, AppModule, AnalysisOptions, AnalysisProgressEvent, AnalysisBudget, PIPELINE_STAGE_DEFS, PipelineState, PipelineStage, legacyScreenToLocation, locationToLegacyScreen, defaultPresetToAnalysisOptions, Account, AccountVideo, StudioSession, Shot, PipelineId, PipelineSlots, PipelineSlotConfig, Video, Collection, Pipeline, Analysis } from "./types";
import type { DownloadedVideo } from "./electron-api";

function createEmptyPipeline(projectId: string, analysisId: string): PipelineState {
  return {
    projectId,
    analysisId,
    progress: 0,
    stages: PIPELINE_STAGE_DEFS.map((d) => ({ key: d.key, label: d.label, status: "pending" as const })),
  };
}

export type ModelDownloadProgress = {
  modelKey: string;
  label: string;
  stage: string;
  percent: number;
  receivedBytes: number;
  totalBytes: number;
  speed: number;
};

export type AccountFetchUiState = {
  stage: string;
  progress: number;
  message?: string;
};

interface AppState {
  currentLocation: AppLocation;
  setLocation: (loc: AppLocation) => void;
  goModule: (m: AppModule) => void;
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (collapsed: boolean) => void;
  /** @deprecated v2 use setLocation */
  currentScreen: ScreenState;
  /** @deprecated v2 use setLocation */
  setCurrentScreen: (screen: ScreenState) => void;

  // v3: videos 替代 projects
  videos: Video[];
  setVideos: React.Dispatch<React.SetStateAction<Video[]>>;
  activeVideoId: string | null;
  setActiveVideoId: (id: string | null) => void;
  activeAnalysisId: string | null;
  setActiveAnalysisId: (id: string | null) => void;

  // v3 兼容别名 (旧 UI 用 projects/activeProjectId 的地方不崩)
  /** @deprecated use videos */
  projects: Video[];
  /** @deprecated use setVideos */
  setProjects: React.Dispatch<React.SetStateAction<Video[]>>;
  /** @deprecated use activeVideoId */
  activeProjectId: string | null;
  /** @deprecated use setActiveVideoId */
  setActiveProjectId: (id: string | null) => void;

  providers: ModelProvider[];
  setProviders: React.Dispatch<React.SetStateAction<ModelProvider[]>>;
  taskSlots: TaskSlots;
  setTaskSlot: (key: TaskSlotKey, assignment: SlotAssignment) => void;
  audioSlot: SlotAssignment;
  setAudioSlot: (assignment: SlotAssignment) => void;
  pipelineSlots: PipelineSlots;
  setPipelineSlot: (pipelineId: PipelineId, slotKey: TaskSlotKey | "__audio__", assignment: SlotAssignment) => void;
  getPipelineSlot: (pipelineId: PipelineId, slotKey: TaskSlotKey | "__audio__") => SlotAssignment;
  defaultAnalysis: DefaultAnalysis;
  setDefaultAnalysis: React.Dispatch<React.SetStateAction<DefaultAnalysis>>;
  localModelOverrides: Record<string, { contextSize?: number }>;
  updateLocalModelOverride: (modelKey: string, patch: { contextSize?: number } | null) => void;

  // v3: collections / pipelines
  collections: Collection[];
  setCollections: React.Dispatch<React.SetStateAction<Collection[]>>;
  pipelines: Pipeline[];

  // 分析相关 (v3: result 统一在 Analysis.result)
  analysesByVideo: Record<string, Analysis[]>;
  refreshAnalyses: (videoId: string) => Promise<void>;
  switchAnalysis: (videoId: string, analysisId: string) => Promise<void>;
  removeVideo: (videoId: string) => void;
  startAnalysis: (videoId: string, pipelineId: string, optionsOverride?: AnalysisOptions) => void;

  // v3 兼容别名
  /** @deprecated use analysesByVideo */
  analysisRecordsByProject: Record<string, Analysis[]>;
  /** @deprecated use refreshAnalyses */
  refreshAnalysisRecords: (videoId: string) => Promise<void>;
  /** @deprecated use removeVideo */
  removeProject: (videoId: string) => void;
  /** @deprecated use startAnalysis */
  startAnalysisForProject: (videoId: string, optionsOverride?: AnalysisOptions) => void;

  // analysis result cache
  nodesByAnalysis: Record<string, AnalysisNode[]>;
  setNodesForAnalysis: (analysisId: string, nodes: AnalysisNode[]) => void;
  reportByAnalysis: Record<string, AnalysisReport>;
  setReportForAnalysis: (analysisId: string, report: AnalysisReport) => void;

  accounts: Account[];
  upsertAccount: (a: Account) => void;
  removeAccount: (id: string) => void;
  sessions: StudioSession[];
  upsertSession: (s: StudioSession) => void;
  removeSession: (id: string) => void;
  shotsByVideo: Record<string, Shot[]>;
  setShotsForVideo: (videoId: string, shots: Shot[]) => void;
  /** @deprecated use shotsByVideo */
  shotsByAsset: Record<string, Shot[]>;
  /** @deprecated use setShotsForVideo */
  setShotsForAsset: (videoId: string, shots: Shot[]) => void;

  accountFetchUi: Record<string, AccountFetchUiState>;
  progressByAnalysis: Record<string, AnalysisProgressEvent>;
  pipelineByAnalysis: Record<string, PipelineState>;
  budgetByAnalysis: Record<string, AnalysisBudget>;
  activeAnalysisForProject: Record<string, string>;
  setBudgetForAnalysis: (analysisId: string, budget: AnalysisBudget) => void;
  modelDownloads: Record<string, ModelDownloadProgress>;
  whisperDownloads: Record<string, ModelDownloadProgress>;
  pendingSlotOverrides: Record<string, SlotOverrides>;
  setPendingSlotOverrides: React.Dispatch<React.SetStateAction<Record<string, SlotOverrides>>>;

  /** @deprecated v2 */
  activeVideoProviderId: string | null;
  /** @deprecated v2 */
  setActiveVideoProviderId: (id: string | null) => void;
  /** @deprecated v2 */
  activeAudioProviderId: string | null;
  /** @deprecated v2 */
  setActiveAudioProviderId: (id: string | null) => void;
  /** @deprecated v2, removed in v3 */
  accountVideosByAccountId: Record<string, AccountVideo[]>;
  /** @deprecated v2 */
  refreshAccountVideos: (accountId: string) => Promise<void>;
  /** @deprecated v2 */
  upsertAccountVideoLocal: (av: AccountVideo) => void;
}

const AppContext = createContext<AppState | undefined>(undefined);

// v2 schema 的默认 providers/slots 由 main 进程的 migrateConfigV1ToV2 决定。
// renderer 这里只保留一个空起点(electron 模式下会被 loadConfig 覆盖;
// 浏览器预览模式下没有 main 进程,需要自己挂)。
const DEFAULT_PROVIDERS: ModelProvider[] = [
  {
    id: "default-video",
    name: "默认视觉模型 (示例)",
    source: "remote",
    baseUrl: "https://api.openai.com/v1",
    apiKeyRef: "",
    endpointType: "openai_chat_completions",
    inputMode: "auto",
    models: [
      {
        id: "gpt-4o-mini",
        label: "gpt-4o-mini",
        capabilities: ["vision", "reasoning"],
      },
    ],
    model: "gpt-4o-mini",
    kind: "video",
  },
];

const DEFAULT_ANALYSIS: DefaultAnalysis = {
  preset: "standard",
  manualGenre: "auto",
};

const DEFAULT_TASK_SLOTS: TaskSlots = {
  simple_vision: null,
  simple_text: null,
  medium_vision: null,
  medium_text: null,
  complex_vision: { providerId: "default-video", modelId: "gpt-4o-mini" },
  complex_text: { providerId: "default-video", modelId: "gpt-4o-mini" },
};

function buildDefaultPipelineSlots(ts: TaskSlots, audio: SlotAssignment): PipelineSlots {
  return {
    content: {
      taskSlots: { complex_vision: ts.complex_vision },
      audioSlot: audio,
    },
    pipeline: {
      taskSlots: { simple_vision: ts.simple_vision, medium_text: ts.medium_text, complex_vision: ts.complex_vision },
      audioSlot: audio,
    },
  };
}

const LOCAL_STORAGE_KEY = "video-analyzer-state";
const SIDEBAR_COLLAPSED_KEY = "clipiq-sidebar-collapsed";

// 模块切换时的默认子屏
const MODULE_DEFAULT_SCREEN: Record<Exclude<AppModule, "settings" | "diagnostics">, AppLocation> = {
  analysis: { module: "analysis", screen: "home" },
  video: { module: "video", screen: "list" },
  library: { module: "library", screen: "list" },
  account: { module: "account", screen: "list" },
  studio: { module: "studio", screen: "list" },
};

export function AppProvider({ children }: { children: ReactNode }) {
  const [hasHydrated, setHasHydrated] = useState(false);
  const previousVideosRef = useRef<Map<string, Video>>(new Map());
  const [currentLocation, setCurrentLocation] = useState<AppLocation>({ module: "analysis", screen: "home" });
  const [sidebarCollapsed, setSidebarCollapsedState] = useState<boolean>(() => {
    try { return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1"; } catch { return false; }
  });

  const setSidebarCollapsed = useCallback((collapsed: boolean) => {
    setSidebarCollapsedState(collapsed);
    try { window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? "1" : "0"); } catch { /* noop */ }
  }, []);

  const setLocation = useCallback((loc: AppLocation) => {
    setCurrentLocation(loc);
  }, []);

  const goModule = useCallback((m: AppModule) => {
    if (m === "settings") setCurrentLocation({ module: "settings" });
    else if (m === "diagnostics") setCurrentLocation({ module: "diagnostics" });
    else setCurrentLocation(MODULE_DEFAULT_SCREEN[m]);
  }, []);

  // v1 兼容: setCurrentScreen("home") → currentLocation 同步更新
  const currentScreen = useMemo(() => locationToLegacyScreen(currentLocation), [currentLocation]);
  const setCurrentScreen = useCallback((s: ScreenState) => {
    setCurrentLocation(legacyScreenToLocation(s));
  }, []);
  // 旧 useState<ScreenState>("home") 已被上方 currentLocation/currentScreen useMemo 取代
  const [videos, setVideos] = useState<Video[]>([]);
  const [activeVideoId, setActiveVideoId] = useState<string | null>(null);
  const [activeAnalysisId, setActiveAnalysisId] = useState<string | null>(null);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [providers, setProviders] = useState<ModelProvider[]>(DEFAULT_PROVIDERS);
  const [taskSlots, setTaskSlots] = useState<TaskSlots>(DEFAULT_TASK_SLOTS);
  const [audioSlot, setAudioSlotState] = useState<SlotAssignment>(null);
  const [pipelineSlotsState, setPipelineSlotsState] = useState<PipelineSlots>(
    () => buildDefaultPipelineSlots(DEFAULT_TASK_SLOTS, null),
  );
  const [defaultAnalysis, setDefaultAnalysis] = useState<DefaultAnalysis>(DEFAULT_ANALYSIS);
  const [localModelOverrides, setLocalModelOverrides] = useState<Record<string, { contextSize?: number }>>({});
  const updateLocalModelOverride = useCallback(
    (modelKey: string, patch: { contextSize?: number } | null) => {
      setLocalModelOverrides((prev) => {
        const next = { ...prev };
        if (!patch) {
          delete next[modelKey];
        } else {
          const ctx = Number(patch.contextSize);
          if (ctx > 0) {
            next[modelKey] = { contextSize: ctx };
          } else {
            // patch.contextSize 非正数 → 视为删除 override, 回到 manifest 默认
            delete next[modelKey];
          }
        }
        return next;
      });
    },
    [],
  );

  const providersRef = useRef<ModelProvider[]>(providers);
  useEffect(() => { providersRef.current = providers; }, [providers]);
  const videosRef = useRef<Video[]>(videos);
  useEffect(() => { videosRef.current = videos; }, [videos]);

  const setTaskSlot = useCallback((key: TaskSlotKey, assignment: SlotAssignment) => {
    setTaskSlots((prev) => ({ ...prev, [key]: assignment }));
  }, []);

  const setAudioSlot = useCallback((assignment: SlotAssignment) => {
    setAudioSlotState(assignment);
  }, []);

  const setPipelineSlot = useCallback(
    (pipelineId: PipelineId, slotKey: TaskSlotKey | "__audio__", assignment: SlotAssignment) => {
      setPipelineSlotsState((prev) => {
        const cur = prev[pipelineId] || { taskSlots: {}, audioSlot: null };
        if (slotKey === "__audio__") {
          return { ...prev, [pipelineId]: { ...cur, audioSlot: assignment } };
        }
        return {
          ...prev,
          [pipelineId]: { ...cur, taskSlots: { ...cur.taskSlots, [slotKey]: assignment } },
        };
      });
    },
    [],
  );

  const getPipelineSlot = useCallback(
    (pipelineId: PipelineId, slotKey: TaskSlotKey | "__audio__"): SlotAssignment => {
      const pc = pipelineSlotsState[pipelineId];
      if (slotKey === "__audio__") {
        return pc?.audioSlot !== undefined ? pc.audioSlot : audioSlot;
      }
      const v = pc?.taskSlots?.[slotKey];
      return v !== undefined ? v : taskSlots[slotKey];
    },
    [pipelineSlotsState, taskSlots, audioSlot],
  );

  // Deprecated 兼容层:旧 UI 仍读 activeVideoProviderId / activeAudioProviderId,
  // 我们把它们映射到 taskSlots.complex_vision / audioSlot 上。PR-3 时一并删除。
  const activeVideoProviderId = taskSlots.complex_vision?.providerId ?? null;
  const activeAudioProviderId = audioSlot?.providerId ?? null;

  const setActiveVideoProviderId = useCallback((id: string | null) => {
    setTaskSlots((prev) => {
      if (!id) return { ...prev, complex_vision: null };
      const existing = prev.complex_vision;
      const provider = providersRef.current.find((p) => p.id === id);
      const modelId =
        existing?.providerId === id && existing?.modelId
          ? existing.modelId
          : provider?.models[0]?.id || "";
      return { ...prev, complex_vision: { providerId: id, modelId } };
    });
  }, []);

  const setActiveAudioProviderId = useCallback((id: string | null) => {
    if (!id) {
      setAudioSlotState(null);
      return;
    }
    const provider = providersRef.current.find((p) => p.id === id);
    setAudioSlotState((prev) =>
      prev?.providerId === id && prev?.modelId
        ? prev
        : { providerId: id, modelId: provider?.models[0]?.id || "" },
    );
  }, []);
  const [nodesByAnalysis, setNodesByAnalysis] = useState<Record<string, AnalysisNode[]>>({});
  const [reportByAnalysis, setReportByAnalysis] = useState<Record<string, AnalysisReport>>({});
  const [analysesByVideo, setAnalysesByVideo] = useState<Record<string, Analysis[]>>({});
  const analysesByVideoRef = useRef<Record<string, Analysis[]>>({});
  useEffect(() => { analysesByVideoRef.current = analysesByVideo; }, [analysesByVideo]);
  const analysisRecordRefreshPending = useRef<Set<string>>(new Set());
  const dismissedAnalysisIds = useRef<Set<string>>(new Set());
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [sessions, setSessions] = useState<StudioSession[]>([]);
  const [shotsByVideo, setShotsByVideo] = useState<Record<string, Shot[]>>({});
  const [accountVideosByAccountId, setAccountVideosByAccountId] = useState<Record<string, AccountVideo[]>>({});
  const [accountFetchUi, setAccountFetchUi] = useState<Record<string, AccountFetchUiState>>({});
  const [progressByAnalysis, setProgressByAnalysis] = useState<Record<string, AnalysisProgressEvent>>({});
  const [pipelineByAnalysis, setPipelineByAnalysis] = useState<Record<string, PipelineState>>({});
  const [budgetByAnalysis, setBudgetByAnalysis] = useState<Record<string, AnalysisBudget>>({});
  const [activeAnalysisForProject, setActiveAnalysisForProject] = useState<Record<string, string>>({});
  const [modelDownloads, setModelDownloads] = useState<Record<string, ModelDownloadProgress>>({});
  const [whisperDownloads, setWhisperDownloads] = useState<Record<string, ModelDownloadProgress>>({});
  const [pendingSlotOverrides, setPendingSlotOverrides] = useState<Record<string, SlotOverrides>>({});

  const upsertAccount = useCallback((a: Account) => {
    setAccounts((prev) => {
      const next = prev.filter((x) => x.id !== a.id);
      next.unshift(a);
      return next;
    });
    window.videoAnalyzer?.upsertAccount(a).catch((err) => console.warn("upsertAccount failed", err));
  }, []);

  const removeAccount = useCallback((id: string) => {
    setAccounts((prev) => prev.filter((x) => x.id !== id));
    setAccountVideosByAccountId((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    window.videoAnalyzer?.deleteAccount(id).catch((err) => console.warn("deleteAccount failed", err));
  }, []);

  const upsertSession = useCallback((s: StudioSession) => {
    setSessions((prev) => {
      const next = prev.filter((x) => x.id !== s.id);
      next.unshift(s);
      return next;
    });
    window.videoAnalyzer?.upsertSession(s).catch((err) => console.warn("upsertSession failed", err));
  }, []);

  const removeSession = useCallback((id: string) => {
    setSessions((prev) => prev.filter((x) => x.id !== id));
    window.videoAnalyzer?.deleteSession(id).catch((err) => console.warn("deleteSession failed", err));
  }, []);

  const setShotsForVideo = useCallback((videoId: string, shots: Shot[]) => {
    setShotsByVideo((prev) => ({ ...prev, [videoId]: shots }));
    window.videoAnalyzer?.setShotsForVideo(videoId, shots).catch((err) => console.warn("setShotsForVideo failed", err));
  }, []);
  const setShotsForAsset = setShotsForVideo;

  const refreshAccountVideos = useCallback(async (accountId: string) => {
    // v3: 不再有 accountVideos 独立表,但保留空实现以兼容旧调用
  }, []);

  const upsertAccountVideoLocal = useCallback((av: AccountVideo) => {
    setAccountVideosByAccountId((prev) => {
      const list = prev[av.accountId] || [];
      const next = list.filter((x) => x.id !== av.id);
      next.unshift(av);
      return { ...prev, [av.accountId]: next };
    });
    // v3: accountVideos 已合并到 videos 表，此处保留空操作
  }, []);

  const setNodesForAnalysis = useCallback((analysisId: string, nodes: AnalysisNode[]) => {
    setNodesByAnalysis((prev) => ({ ...prev, [analysisId]: nodes }));
    if (window.videoAnalyzer) {
      window.videoAnalyzer.updateAnalysisResult(analysisId, { nodes }).catch((error) => {
        console.warn("updateAnalysisResult(nodes) failed", error);
      });
    }
  }, []);

  const setBudgetForAnalysis = useCallback((analysisId: string, budget: AnalysisBudget) => {
    setBudgetByAnalysis((prev) => ({ ...prev, [analysisId]: budget }));
  }, []);

  const setReportForAnalysis = useCallback((analysisId: string, report: AnalysisReport) => {
    setReportByAnalysis((prev) => ({ ...prev, [analysisId]: report }));
    if (window.videoAnalyzer) {
      window.videoAnalyzer.updateAnalysisResult(analysisId, { report }).catch((error) => {
        console.warn("updateAnalysisResult failed", error);
      });
    }
  }, []);

  const refreshAnalyses = useCallback(async (videoId: string) => {
    if (!window.videoAnalyzer?.listAnalyses) return;
    try {
      const records = await window.videoAnalyzer.listAnalyses(videoId);
      setAnalysesByVideo((prev) => ({ ...prev, [videoId]: records }));
    } catch (err) {
      console.warn("refreshAnalyses failed", err);
    }
  }, []);

  const switchAnalysis = useCallback(async (videoId: string, analysisId: string) => {
    if (!window.videoAnalyzer?.getAnalysis) return;
    try {
      const analysis = await window.videoAnalyzer.getAnalysis(analysisId);
      if (!analysis) return;
      const result = analysis.result as any;
      if (result?.nodes?.length) setNodesByAnalysis((prev) => ({ ...prev, [analysisId]: result.nodes }));
      if (result?.report) setReportByAnalysis((prev) => ({ ...prev, [analysisId]: result.report }));
    } catch (err) {
      console.warn("switchAnalysis failed", err);
    }
  }, []);

  const startAnalysis = useCallback(
    (videoId: string, pipelineId: string = "builtin-pipeline", optionsOverride?: AnalysisOptions) => {
      setActiveVideoId(videoId);
      setActiveAnalysisId(null);
      setCurrentLocation({ module: "analysis", screen: "progress" });

      // fire-and-forget: 发起 IPC 但不等结果，ProgressScreen 通过 task:progress 监听进度
      if (window.videoAnalyzer?.analyzeVideo) {
        window.videoAnalyzer.analyzeVideo({
          videoId,
          pipelineId,
          options: optionsOverride,
        }).then((analysis) => {
          // 分析完成：刷新记录
          if (analysis?.id) {
            setActiveAnalysisId(analysis.id);
            const result = (analysis as any).result;
            if (result?.nodes?.length) setNodesByAnalysis((prev) => ({ ...prev, [analysis.id]: result.nodes }));
            if (result?.report) setReportByAnalysis((prev) => ({ ...prev, [analysis.id]: result.report }));
          }
          refreshAnalyses(videoId);
        }).catch((err) => {
          const msg = String(err?.message || err);
          // "已有分析在运行"不是错误，只是重复触发
          if (!/已有.*在运行|already/i.test(msg)) {
            console.warn("startAnalysis failed:", msg);
          }
          refreshAnalyses(videoId);
        });
      }
    },
    [],
  );

  const removeVideo = useCallback((projectId: string) => {
    const project = videosRef.current.find((p) => p.id === projectId);
    setVideos((prev) => prev.filter((p) => p.id !== projectId));
    // 清掉该项目所有分析的 nodes/report 缓存
    const records = analysesByVideoRef.current[projectId] || [];
    if (records.length || project?.currentAnalysisId) {
      const idsToClean = new Set<string>(records.map((r) => r.id));
      if (project?.currentAnalysisId) idsToClean.add(project.currentAnalysisId);
      setNodesByAnalysis((prev) => {
        const next = { ...prev };
        for (const id of idsToClean) delete next[id];
        return next;
      });
      setReportByAnalysis((prev) => {
        const next = { ...prev };
        for (const id of idsToClean) delete next[id];
        return next;
      });
    }
    setAnalysesByVideo((prev) => {
      if (!(projectId in prev)) return prev;
      const next = { ...prev };
      delete next[projectId];
      return next;
    });
    setActiveVideoId((current) => (current === projectId ? null : current));
    // 按 analysisId 清理 per-analysis maps
    const aidsToClear = new Set<string>(records.map((r) => r.id));
    if (project?.currentAnalysisId) aidsToClear.add(project.currentAnalysisId);
    if (aidsToClear.size > 0) {
      setProgressByAnalysis((prev) => {
        const next = { ...prev };
        for (const id of aidsToClear) delete next[id];
        return next;
      });
      setPipelineByAnalysis((prev) => {
        const next = { ...prev };
        for (const id of aidsToClear) delete next[id];
        return next;
      });
      setBudgetByAnalysis((prev) => {
        const next = { ...prev };
        for (const id of aidsToClear) delete next[id];
        return next;
      });
    }
    setActiveAnalysisForProject((prev) => {
      if (!(projectId in prev)) return prev;
      const next = { ...prev };
      delete next[projectId];
      return next;
    });
    if (window.videoAnalyzer) {
      window.videoAnalyzer.deleteVideo(projectId).catch((error) => {
        console.warn("deleteVideo failed", error);
      });
    }
  }, []);

  useEffect(() => {
    const load = async () => {
      try {
        if (window.videoAnalyzer) {
          const config = await window.videoAnalyzer.loadConfig();
          if (config?.providers?.length) {
            setProviders(config.providers);
          }
          if (config?.taskSlots) {
            setTaskSlots(config.taskSlots);
          }
          if (config?.audioSlot !== undefined) {
            setAudioSlotState(config.audioSlot);
          }
          if (config?.pipelineSlots) {
            setPipelineSlotsState(config.pipelineSlots);
          } else if (config?.taskSlots) {
            setPipelineSlotsState(buildDefaultPipelineSlots(config.taskSlots, config?.audioSlot ?? null));
          }
          if (config?.defaultAnalysis) {
            setDefaultAnalysis(config.defaultAnalysis);
          }
          if (config?.localModelOverrides && typeof config.localModelOverrides === "object") {
            setLocalModelOverrides(config.localModelOverrides);
          }
          const videoList = await window.videoAnalyzer.listVideos();
          setVideos(videoList);
          previousVideosRef.current = new Map(videoList.map((v) => [v.id, v]));
          // 加载每个视频的分析记录
          const analysesMap: Record<string, Analysis[]> = {};
          const nodesMap: Record<string, AnalysisNode[]> = {};
          const reportsMap: Record<string, AnalysisReport> = {};
          await Promise.all(
            videoList.map(async (v) => {
              if (!window.videoAnalyzer?.listAnalyses) return;
              const records = await window.videoAnalyzer.listAnalyses(v.id).catch(() => [] as Analysis[]);
              if (records.length) analysesMap[v.id] = records;
              // 加载最新完成的分析的 result
              const latest = records.find((r) => r.status === "completed");
              if (latest?.result) {
                const result = latest.result as any;
                if (result.nodes) nodesMap[latest.id] = result.nodes;
                if (result.report) reportsMap[latest.id] = result.report;
              }
            }),
          );
          setAnalysesByVideo(analysesMap);
          setNodesByAnalysis(nodesMap);
          setReportByAnalysis(reportsMap);
          // v2: 加载 accounts / sessions / shots
          if (window.videoAnalyzer.listAccounts) {
            const [accs, sess, allShots] = await Promise.all([
              window.videoAnalyzer.listAccounts().catch(() => []),
              window.videoAnalyzer.listSessions().catch(() => []),
              window.videoAnalyzer.listShots(undefined).catch(() => [] as Shot[]),
            ]);
            setAccounts(accs);
            setSessions(sess);
            const byVideo: Record<string, Shot[]> = {};
            for (const s of allShots) {
              const vid = s.videoId || s.assetProjectId;
              if (vid) (byVideo[vid] ||= []).push(s);
            }
            setShotsByVideo(byVideo);
            // v3: 加载 collections + pipelines
            if (window.videoAnalyzer.listCollections) {
              setCollections(await window.videoAnalyzer.listCollections().catch(() => []));
            }
            if (window.videoAnalyzer.listPipelines) {
              setPipelines(await window.videoAnalyzer.listPipelines().catch(() => []));
            }
            // 重连 in-flight fetch 进度
            if (window.videoAnalyzer.listAccountFetchInFlight) {
              try {
                const inflight = await window.videoAnalyzer.listAccountFetchInFlight();
                setAccountFetchUi((prev) => {
                  const next = { ...prev };
                  for (const it of inflight) {
                    next[it.accountId] = { stage: it.stage, progress: it.progress, message: it.message };
                  }
                  return next;
                });
              } catch { /* noop */ }
            }
          }
        } else {
          const raw = window.localStorage.getItem(LOCAL_STORAGE_KEY);
          if (raw) {
            const state = JSON.parse(raw);
            if (state.providers?.length) setProviders(state.providers);
            if (state.taskSlots) setTaskSlots(state.taskSlots);
            if (state.audioSlot !== undefined) setAudioSlotState(state.audioSlot);
            if (state.pipelineSlots) {
              setPipelineSlotsState(state.pipelineSlots);
            } else if (state.taskSlots) {
              setPipelineSlotsState(buildDefaultPipelineSlots(state.taskSlots, state.audioSlot ?? null));
            }
            if (state.defaultAnalysis) setDefaultAnalysis(state.defaultAnalysis);
            setVideos(state.videos || state.projects || []);
            setNodesByAnalysis(state.nodesByAnalysis || {});
            setReportByAnalysis(state.reportByAnalysis || {});
            previousVideosRef.current = new Map(
              (state.videos || state.projects || []).map((v: Video) => [v.id, v] as const),
            );
          }
        }
      } catch (error) {
        console.warn("Failed to load app state", error);
      } finally {
        setHasHydrated(true);
      }
    };
    load();
  }, []);

  useEffect(() => {
    if (!hasHydrated) return;
    const config: AppConfig = {
      providers,
      taskSlots,
      audioSlot,
      defaultAnalysis,
      localModelOverrides,
      pipelineSlots: pipelineSlotsState,
      schemaVersion: 2,
    };
    const timer = window.setTimeout(() => {
      if (window.videoAnalyzer) {
        window.videoAnalyzer.saveConfig(config).catch((error) => {
          console.warn("saveConfig failed", error);
        });
      } else {
        const existing = JSON.parse(window.localStorage.getItem(LOCAL_STORAGE_KEY) || "{}");
        window.localStorage.setItem(
          LOCAL_STORAGE_KEY,
          JSON.stringify({ ...existing, ...config })
        );
      }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [providers, taskSlots, audioSlot, defaultAnalysis, localModelOverrides, pipelineSlotsState, hasHydrated]);

  // 订阅后台账号拉取事件 (progress / done / failed) — 全局只挂一次
  useEffect(() => {
    if (!window.videoAnalyzer?.onAccountFetchProgress) return;
    const offProgress = window.videoAnalyzer.onAccountFetchProgress((evt) => {
      setAccountFetchUi((prev) => ({
        ...prev,
        [evt.accountId]: { stage: evt.stage, progress: evt.progress, message: evt.message },
      }));
    });
    const offDone = window.videoAnalyzer.onAccountFetchDone?.((evt) => {
      setAccountFetchUi((prev) => {
        if (!(evt.accountId in prev)) return prev;
        const next = { ...prev };
        delete next[evt.accountId];
        return next;
      });
      // 合入视频列表
      setAccountVideosByAccountId((prev) => ({ ...prev, [evt.accountId]: evt.videos || [] }));
      // 合入 Account 元数据
      if (evt.account && evt.account.id) {
        setAccounts((prev) => {
          const merged = { ...(prev.find((a) => a.id === evt.account.id) || {}), ...evt.account } as Account;
          const filtered = prev.filter((a) => a.id !== merged.id);
          filtered.unshift(merged);
          return filtered;
        });
      }
    });
    const offFailed = window.videoAnalyzer.onAccountFetchFailed?.((evt) => {
      setAccountFetchUi((prev) => {
        if (!(evt.accountId in prev)) return prev;
        const next = { ...prev };
        delete next[evt.accountId];
        return next;
      });
      setAccounts((prev) => prev.map((a) => a.id === evt.accountId ? { ...a, fetchPhase: "failed", fetchError: evt.error, updatedAt: new Date().toISOString() } : a));
    });
    return () => {
      offProgress?.();
      offDone?.();
      offFailed?.();
    };
  }, []);

  // 统一任务进度监听：所有管线的 task:progress 走同一个通道
  useEffect(() => {
    if (!window.videoAnalyzer?.onTaskProgress) return;
    const off = window.videoAnalyzer.onTaskProgress((evt: any) => {
      if (!evt.analysisId) return;
      const isComplete = evt.progress >= 100 || evt.stage === "完成";
      const isFailed = evt.stage === "失败";
      if (isComplete || isFailed) {
        setProgressByAnalysis((prev) => { const n = { ...prev }; delete n[evt.analysisId]; return n; });
        if (evt.videoId) refreshAnalyses(evt.videoId);
      } else {
        setProgressByAnalysis((prev) => ({ ...prev, [evt.analysisId]: evt }));
      }
    });
    return () => { off?.(); };
  }, []);

  // 兼容: 旧的 analysis:summary:status 通道（前端某些地方还在监听）
  useEffect(() => {
    if (!window.videoAnalyzer?.onVideoSummaryStatus) return;
    const off = window.videoAnalyzer.onVideoSummaryStatus((evt) => {
      if (evt.videoId && (evt.status === "done" || evt.status === "failed")) {
        refreshAnalyses(evt.videoId);
      }
    });
    return () => { off?.(); };
  }, []);

  // 订阅 main 进程的分析 / 下载进度事件 — 全局只挂一次, 按 analysisId 索引。
  // 每个分析有独立槽位，取消后开新分析不会互踩。
  useEffect(() => {
    if (!window.videoAnalyzer?.onAnalysisProgress) return;
    const off = window.videoAnalyzer.onAnalysisProgress((evt) => {
      const key = evt.analysisId;
      if (key && dismissedAnalysisIds.current.has(key)) {
        console.debug("[AppContext] 忽略已 dismiss 的分析进度事件", key, evt.stage, evt.progress);
        return;
      }
      setProgressByAnalysis((prev) => ({ ...prev, [key]: evt }));
      setActiveAnalysisForProject((prev) => {
        if (prev[evt.projectId] === key) return prev;
        return { ...prev, [evt.projectId]: key };
      });
      // main 进程创建新分析记录后第一条 progress 就带新 analysisId,
      // 同步刷新 project.currentAnalysisId 让 ProgressScreen 的 startedAt 指向新记录。
      setVideos((prev) => prev.map((p) => {
        if (p.id !== evt.projectId || p.currentAnalysisId === key) return p;
        return { ...p, currentAnalysisId: key };
      }));
      if (!analysisRecordRefreshPending.current.has(key)) {
        analysisRecordRefreshPending.current.add(key);
        refreshAnalyses(evt.projectId);
      }
      if (evt.stageIndex != null) {
        const si = evt.stageIndex;
        const now = Date.now();
        setPipelineByAnalysis((prev) => {
          const existing = prev[key];
          const pipeline = existing || createEmptyPipeline(evt.projectId, key);
          const stages: PipelineStage[] = pipeline.stages.map((s, i) => {
            if (i < si) {
              if (s.status === "done" || s.status === "failed") return s;
              return { ...s, status: "done" as const, completedAt: s.completedAt || now };
            }
            if (i === si) {
              const done = evt.progress >= 100;
              return {
                ...s,
                status: done ? "done" as const : "active" as const,
                detail: evt.message || s.detail,
                startedAt: s.startedAt || now,
                fromCache: evt.fromCache || s.fromCache,
                ...(done ? { completedAt: now } : {}),
              };
            }
            return s;
          });
          return { ...prev, [key]: { ...pipeline, progress: evt.progress, stages } };
        });
      }
    });
    return off;
  }, []);

  // 全局订阅 llama:progress — 模型下载进度写入 modelDownloads,任务队列和设置页共享
  useEffect(() => {
    if (!window.videoAnalyzer?.llama?.onProgress) return;
    const off = window.videoAnalyzer.llama.onProgress((evt: any) => {
      if (evt.scope !== "model" || !evt.modelKey) return;
      if (evt.stage === "done" || evt.stage === "cancelled") {
        setModelDownloads((prev) => {
          const next = { ...prev };
          delete next[evt.modelKey];
          return next;
        });
        return;
      }
      setModelDownloads((prev) => {
        const existing = prev[evt.modelKey];
        const isStart = evt.stage === "start";
        return {
          ...prev,
          [evt.modelKey]: {
            modelKey: evt.modelKey,
            label: isStart ? (evt.label || evt.modelKey) : (existing?.label || evt.label || evt.modelKey),
            stage: evt.stage || "download",
            percent: evt.percent ?? 0,
            receivedBytes: evt.receivedBytes ?? 0,
            totalBytes: evt.totalBytes ?? 0,
            speed: evt.speed ?? 0,
          },
        };
      });
    });
    return off;
  }, []);

  // 全局订阅 whisperCpp:progress — whisper 模型下载进度
  useEffect(() => {
    if (!window.videoAnalyzer?.whisperCpp?.onProgress) return;
    const off = window.videoAnalyzer.whisperCpp.onProgress((evt: any) => {
      if (evt.scope !== "model" || !evt.modelKey) return;
      if (evt.stage === "done" || evt.stage === "cancelled" || evt.stage === "skip") {
        setWhisperDownloads((prev) => {
          const next = { ...prev };
          delete next[evt.modelKey];
          return next;
        });
        return;
      }
      setWhisperDownloads((prev) => ({
        ...prev,
        [evt.modelKey]: {
          modelKey: evt.modelKey,
          label: evt.label || evt.modelKey,
          stage: evt.stage || "download",
          percent: evt.percent ?? 0,
          receivedBytes: evt.receivedBytes ?? 0,
          totalBytes: evt.totalBytes ?? 0,
          speed: 0,
        },
      }));
    });
    return off;
  }, []);

  // 订阅 analyzeProject 起来时广播的 ETA budget — 全局只挂一次, 写进 budgetByAnalysis。
  // ProgressScreen 读这里给出比线性外推更准的 ETA; attach 模式重连时通过
  // getLastAnalysisBudget IPC 拉一次补回 cache。
  useEffect(() => {
    if (!window.videoAnalyzer?.onAnalysisBudget) return;
    const off = window.videoAnalyzer.onAnalysisBudget((evt) => {
      const key = evt.analysisId;
      setBudgetByAnalysis((prev) => ({ ...prev, [key]: evt.budget }));
      setActiveAnalysisForProject((prev) => {
        if (prev[evt.projectId] === key) return prev;
        return { ...prev, [evt.projectId]: key };
      });
    });
    return off;
  }, []);

  // 订阅异步下载完成事件 — 把 yt-dlp 拿到的真实元数据回填进 downloading 项目,
  // 把 status 切到 analyzing 让 ProgressScreen 起分析;失败则切到 download_failed。
  useEffect(() => {
    if (!window.videoAnalyzer?.onDownloadComplete) return;
    const off = window.videoAnalyzer.onDownloadComplete((evt) => {
      // 项目 strict 未开,DownloadCompleteEvent 是 discriminated union 但 narrow 不稳。
      // 这里把字段全显式抽出, callback 闭包里只用平铺常量,绕开 TS narrow 失效。
      const videoId = (evt as any).videoId || (evt as any).projectId;
      const success = evt.success;
      let video: DownloadedVideo | null = null;
      let cancelled = false;
      let errorMessage = "";
      if (evt.success) {
        video = evt.video;
      } else {
        const failEvt = evt as { videoId: string; success: false; cancelled?: boolean; error: string };
        cancelled = !!failEvt.cancelled;
        errorMessage = failEvt.error || "视频下载失败";
      }
      setVideos((prev) => prev.map((p) => {
        if (p.id !== videoId) return p;
        const now = new Date().toISOString();
        if (success && video) {
          return {
            ...p,
            localVideoPath: video.mediaUrl,
            localFilePath: video.filePath,
            videoName: video.title || video.filename || p.videoName,
            titleAutoGenerated: !!video.title,
            durationSec: video.durationSec,
            width: video.width,
            height: video.height,
            orientation: video.orientation,
            status: "analyzing" as const,
            updatedAt: now,
          };
        }
        if (cancelled) {
          return { ...p, status: "not_analyzed" as const, updatedAt: now };
        }
        return {
          ...p,
          status: "download_failed" as const,
          updatedAt: now,
        };
      }));
    });
    return off;
  }, []);

  useEffect(() => {
    if (!hasHydrated) return;
    const prev = previousVideosRef.current;
    const nextMap = new Map(videos.map((v) => [v.id, v] as const));
    previousVideosRef.current = nextMap;
    if (window.videoAnalyzer) {
      for (const video of videos) {
        if (prev.get(video.id) === video) continue;
        window.videoAnalyzer.upsertVideo(video).catch((error) => {
          console.warn("upsertVideo failed", error);
        });
      }
    } else {
      const existing = JSON.parse(window.localStorage.getItem(LOCAL_STORAGE_KEY) || "{}");
      window.localStorage.setItem(
        LOCAL_STORAGE_KEY,
        JSON.stringify({ ...existing, videos, nodesByAnalysis, reportByAnalysis })
      );
    }
  }, [videos, nodesByAnalysis, reportByAnalysis, hasHydrated]);

  return (
    <AppContext.Provider
      value={{
        currentLocation,
        setLocation,
        goModule,
        sidebarCollapsed,
        setSidebarCollapsed,
        currentScreen,
        setCurrentScreen,
        // v3 主名
        videos,
        setVideos,
        activeVideoId,
        setActiveVideoId,
        activeAnalysisId,
        setActiveAnalysisId,
        collections,
        setCollections,
        pipelines,
        // v3 兼容别名
        projects: videos,
        setProjects: setVideos,
        activeProjectId: activeVideoId,
        setActiveProjectId: setActiveVideoId,

        providers,
        setProviders,
        taskSlots,
        setTaskSlot,
        audioSlot,
        setAudioSlot,
        pipelineSlots: pipelineSlotsState,
        setPipelineSlot,
        getPipelineSlot,
        defaultAnalysis,
        setDefaultAnalysis,
        localModelOverrides,
        updateLocalModelOverride,
        activeVideoProviderId,
        setActiveVideoProviderId,
        activeAudioProviderId,
        setActiveAudioProviderId,
        nodesByAnalysis,
        setNodesForAnalysis,
        reportByAnalysis,
        setReportForAnalysis,
        analysesByVideo,
        analysisRecordsByProject: analysesByVideo,
        refreshAnalyses,
        refreshAnalysisRecords: refreshAnalyses,
        switchAnalysis,
        removeVideo,
        removeProject: removeVideo,
        startAnalysis,
        startAnalysisForProject: (videoId: string, opts?: AnalysisOptions) => startAnalysis(videoId, "builtin-pipeline", opts),
        accounts,
        upsertAccount,
        removeAccount,
        sessions,
        upsertSession,
        removeSession,
        shotsByVideo,
        setShotsForVideo,
        shotsByAsset: shotsByVideo,
        setShotsForAsset: setShotsForVideo,
        accountVideosByAccountId,
        refreshAccountVideos,
        upsertAccountVideoLocal,
        accountFetchUi,
        progressByAnalysis,
        pipelineByAnalysis,
        budgetByAnalysis,
        activeAnalysisForProject,
        setBudgetForAnalysis,
        modelDownloads,
        whisperDownloads,
        pendingSlotOverrides,
        setPendingSlotOverrides,
      }}
    >
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const context = useContext(AppContext);
  if (context === undefined) {
    throw new Error("useApp must be used within an AppProvider");
  }
  return context;
}
