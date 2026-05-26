import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, ReactNode } from "react";
import { Project, ScreenState, ModelProvider, AnalysisNode, AnalysisReport, AnalysisRecord, AppConfig, TaskSlots, TaskSlotKey, SlotAssignment, DefaultAnalysis, AppLocation, AppModule, AnalysisOptions, AnalysisProgressEvent, AnalysisBudget, PIPELINE_STAGE_DEFS, PipelineState, PipelineStage, legacyScreenToLocation, locationToLegacyScreen, defaultPresetToAnalysisOptions, Account, AccountVideo, StudioSession, Shot } from "./types";
import type { DownloadedVideo } from "./electron-api";

function createEmptyPipeline(projectId: string): PipelineState {
  return {
    projectId,
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
  // v2: 两层路由。新代码全部用 currentLocation/setLocation/goModule
  currentLocation: AppLocation;
  setLocation: (loc: AppLocation) => void;
  goModule: (m: AppModule) => void;
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (collapsed: boolean) => void;
  // v1 兼容层: 旧调用点 (setCurrentScreen("home")) 仍可用,内部同步到 currentLocation
  /** @deprecated v2 use setLocation */
  currentScreen: ScreenState;
  /** @deprecated v2 use setLocation */
  setCurrentScreen: (screen: ScreenState) => void;
  projects: Project[];
  setProjects: React.Dispatch<React.SetStateAction<Project[]>>;
  activeProjectId: string | null;
  setActiveProjectId: (id: string | null) => void;
  providers: ModelProvider[];
  setProviders: React.Dispatch<React.SetStateAction<ModelProvider[]>>;
  taskSlots: TaskSlots;
  setTaskSlot: (key: TaskSlotKey, assignment: SlotAssignment) => void;
  audioSlot: SlotAssignment;
  setAudioSlot: (assignment: SlotAssignment) => void;
  defaultAnalysis: DefaultAnalysis;
  setDefaultAnalysis: React.Dispatch<React.SetStateAction<DefaultAnalysis>>;
  // 本地 llama 模型 ctx 覆盖。落 config.localModelOverrides;
  // main 进程下次启动该 model 时 --ctx-size 用这里的值, 否则用 manifest 默认。
  localModelOverrides: Record<string, { contextSize?: number }>;
  updateLocalModelOverride: (modelKey: string, patch: { contextSize?: number } | null) => void;
  /** @deprecated derived from taskSlots.complex_vision; will be removed in PR-3 */
  activeVideoProviderId: string | null;
  /** @deprecated 写入会同步到 taskSlots.complex_vision.providerId,保留是为了在 PR-3 完成前旧 UI 不崩 */
  setActiveVideoProviderId: (id: string | null) => void;
  /** @deprecated derived from audioSlot */
  activeAudioProviderId: string | null;
  /** @deprecated 写入会同步到 audioSlot.providerId */
  setActiveAudioProviderId: (id: string | null) => void;
  nodesByAnalysis: Record<string, AnalysisNode[]>;
  setNodesForAnalysis: (analysisId: string, nodes: AnalysisNode[]) => void;
  reportByAnalysis: Record<string, AnalysisReport>;
  setReportForAnalysis: (analysisId: string, report: AnalysisReport) => void;
  analysisRecordsByProject: Record<string, AnalysisRecord[]>;
  refreshAnalysisRecords: (projectId: string) => Promise<void>;
  switchAnalysis: (projectId: string, analysisId: string) => Promise<void>;
  removeProject: (projectId: string) => void;
  startAnalysisForProject: (projectId: string, optionsOverride?: AnalysisOptions) => void;
  // v2: accounts / sessions / shots
  accounts: Account[];
  upsertAccount: (a: Account) => void;
  removeAccount: (id: string) => void;
  sessions: StudioSession[];
  upsertSession: (s: StudioSession) => void;
  removeSession: (id: string) => void;
  shotsByAsset: Record<string, Shot[]>;
  setShotsForAsset: (assetProjectId: string, shots: Shot[]) => void;
  // v2.1: 账号视频独立表
  accountVideosByAccountId: Record<string, AccountVideo[]>;
  refreshAccountVideos: (accountId: string) => Promise<void>;
  upsertAccountVideoLocal: (av: AccountVideo) => void;
  // 后台拉取进度,渲染端订阅 main 进程事件汇总到这里
  accountFetchUi: Record<string, AccountFetchUiState>;
  // 分析 / 下载进度的全局快照, 按 projectId 索引。
  // 应用启动时全局订阅一次 onAnalysisProgress, 把每个 event 累加到这里;
  // TaskQueueDrawer / ProgressScreen 都直接读, 避免各自挂 listener 导致 drawer
  // 在打开瞬间订阅 → 错过之前事件 → 显示停留在很旧的 stage。
  progressByProject: Record<string, AnalysisProgressEvent>;
  pipelineByProject: Record<string, PipelineState>;
  // ETA baseline budget: main 在 analyzeProject 开头算一次 broadcast, 这里 cache 给
  // ProgressScreen 用做精准 ETA 估算 (替代之前的 elapsed/progress 线性外推)。
  budgetByProject: Record<string, AnalysisBudget>;
  // attach 模式重连时, ProgressScreen 调 getLastAnalysisBudget 拉一次后用这个写回 cache。
  setBudgetForProject: (projectId: string, budget: AnalysisBudget) => void;
  // 模型下载进度,全局订阅 llama:progress (scope=model) 写入,任务队列和设置页共享读取
  modelDownloads: Record<string, ModelDownloadProgress>;
  // whisper 模型下载进度,全局订阅 whisperCpp:progress 写入
  whisperDownloads: Record<string, ModelDownloadProgress>;
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

const LOCAL_STORAGE_KEY = "video-analyzer-state";
const SIDEBAR_COLLAPSED_KEY = "clipiq-sidebar-collapsed";

// 模块切换时的默认子屏
const MODULE_DEFAULT_SCREEN: Record<Exclude<AppModule, "settings" | "diagnostics">, AppLocation> = {
  analysis: { module: "analysis", screen: "home" },
  library: { module: "library", screen: "list" },
  account: { module: "account", screen: "list" },
  studio: { module: "studio", screen: "list" },
};

export function AppProvider({ children }: { children: ReactNode }) {
  const [hasHydrated, setHasHydrated] = useState(false);
  const previousProjectsRef = useRef<Map<string, Project>>(new Map());
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
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [providers, setProviders] = useState<ModelProvider[]>(DEFAULT_PROVIDERS);
  const [taskSlots, setTaskSlots] = useState<TaskSlots>(DEFAULT_TASK_SLOTS);
  const [audioSlot, setAudioSlotState] = useState<SlotAssignment>(null);
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
  const projectsRef = useRef<Project[]>(projects);
  useEffect(() => { projectsRef.current = projects; }, [projects]);

  const setTaskSlot = useCallback((key: TaskSlotKey, assignment: SlotAssignment) => {
    setTaskSlots((prev) => ({ ...prev, [key]: assignment }));
  }, []);

  const setAudioSlot = useCallback((assignment: SlotAssignment) => {
    setAudioSlotState(assignment);
  }, []);

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
  const [analysisRecordsByProject, setAnalysisRecordsByProject] = useState<Record<string, AnalysisRecord[]>>({});
  const analysisRecordsByProjectRef = useRef<Record<string, AnalysisRecord[]>>({});
  useEffect(() => { analysisRecordsByProjectRef.current = analysisRecordsByProject; }, [analysisRecordsByProject]);
  // v2 状态
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [sessions, setSessions] = useState<StudioSession[]>([]);
  const [shotsByAsset, setShotsByAsset] = useState<Record<string, Shot[]>>({});
  // v2.1: 账号视频独立表
  const [accountVideosByAccountId, setAccountVideosByAccountId] = useState<Record<string, AccountVideo[]>>({});
  const [accountFetchUi, setAccountFetchUi] = useState<Record<string, AccountFetchUiState>>({});
  const [progressByProject, setProgressByProject] = useState<Record<string, AnalysisProgressEvent>>({});
  const [pipelineByProject, setPipelineByProject] = useState<Record<string, PipelineState>>({});
  const [budgetByProject, setBudgetByProject] = useState<Record<string, AnalysisBudget>>({});
  const [modelDownloads, setModelDownloads] = useState<Record<string, ModelDownloadProgress>>({});
  const [whisperDownloads, setWhisperDownloads] = useState<Record<string, ModelDownloadProgress>>({});

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

  const setShotsForAsset = useCallback((assetProjectId: string, shots: Shot[]) => {
    setShotsByAsset((prev) => ({ ...prev, [assetProjectId]: shots }));
    window.videoAnalyzer?.setShotsForAsset(assetProjectId, shots).catch((err) => console.warn("setShotsForAsset failed", err));
  }, []);

  const refreshAccountVideos = useCallback(async (accountId: string) => {
    if (!window.videoAnalyzer?.listAccountVideos) return;
    try {
      const list = await window.videoAnalyzer.listAccountVideos(accountId);
      setAccountVideosByAccountId((prev) => ({ ...prev, [accountId]: list }));
    } catch (err) {
      console.warn("refreshAccountVideos failed", err);
    }
  }, []);

  const upsertAccountVideoLocal = useCallback((av: AccountVideo) => {
    setAccountVideosByAccountId((prev) => {
      const list = prev[av.accountId] || [];
      const next = list.filter((x) => x.id !== av.id);
      next.unshift(av);
      return { ...prev, [av.accountId]: next };
    });
    window.videoAnalyzer?.upsertAccountVideo(av).catch((err) => console.warn("upsertAccountVideo failed", err));
  }, []);

  const setNodesForAnalysis = useCallback((analysisId: string, nodes: AnalysisNode[]) => {
    setNodesByAnalysis((prev) => ({ ...prev, [analysisId]: nodes }));
    if (window.videoAnalyzer) {
      window.videoAnalyzer.setNodes(analysisId, nodes).catch((error) => {
        console.warn("setNodes failed", error);
      });
    }
  }, []);

  const setBudgetForProject = useCallback((projectId: string, budget: AnalysisBudget) => {
    setBudgetByProject((prev) => ({ ...prev, [projectId]: budget }));
  }, []);

  const setReportForAnalysis = useCallback((analysisId: string, report: AnalysisReport) => {
    setReportByAnalysis((prev) => ({ ...prev, [analysisId]: report }));
    if (window.videoAnalyzer) {
      window.videoAnalyzer.setReport(analysisId, report).catch((error) => {
        console.warn("setReport failed", error);
      });
    }
  }, []);

  const refreshAnalysisRecords = useCallback(async (projectId: string) => {
    if (!window.videoAnalyzer?.listAnalyses) return;
    try {
      const records = await window.videoAnalyzer.listAnalyses(projectId);
      setAnalysisRecordsByProject((prev) => ({ ...prev, [projectId]: records }));
    } catch (err) {
      console.warn("refreshAnalysisRecords failed", err);
    }
  }, []);

  const switchAnalysis = useCallback(async (projectId: string, analysisId: string) => {
    if (!window.videoAnalyzer?.getAnalysis) return;
    try {
      const data = await window.videoAnalyzer.getAnalysis(analysisId);
      if (!data) return;
      if (data.nodes?.length) setNodesByAnalysis((prev) => ({ ...prev, [analysisId]: data.nodes }));
      if (data.report) setReportByAnalysis((prev) => ({ ...prev, [analysisId]: data.report! }));
      setProjects((prev) => prev.map((p) =>
        p.id === projectId ? { ...p, currentAnalysisId: analysisId } : p,
      ));
    } catch (err) {
      console.warn("switchAnalysis failed", err);
    }
  }, []);

  const startAnalysisForProject = useCallback(
    (projectId: string, optionsOverride?: AnalysisOptions) => {
      // 如果该项目已有分析在运行，只跳转到进度屏
      const currentProject = projectsRef.current.find((p) => p.id === projectId);
      if (currentProject?.status === "analyzing") {
        setActiveProjectId(projectId);
        setCurrentLocation({ module: "analysis", screen: "progress" });
        return;
      }
      // 清掉旧的进度/pipeline/budget (这些是 per-project 的临时状态)
      setPipelineByProject((prev) => {
        if (!(projectId in prev)) return prev;
        const next = { ...prev };
        delete next[projectId];
        return next;
      });
      setProgressByProject((prev) => {
        if (!(projectId in prev)) return prev;
        const next = { ...prev };
        delete next[projectId];
        return next;
      });
      setBudgetByProject((prev) => {
        if (!(projectId in prev)) return prev;
        const next = { ...prev };
        delete next[projectId];
        return next;
      });
      // 新分析由 main 进程创建 (analysisId 在 analyzeProject 里生成)，
      // 这里只设 project.status 和导航
      setProjects((prev) =>
        prev.map((p) => {
          if (p.id !== projectId) return p;
          return {
            ...p,
            status: "analyzing" as const,
            updatedAt: new Date().toISOString(),
          };
        }),
      );
      setActiveProjectId(projectId);
      setCurrentLocation({ module: "analysis", screen: "progress" });
    },
    [],
  );

  const removeProject = useCallback((projectId: string) => {
    const project = projectsRef.current.find((p) => p.id === projectId);
    setProjects((prev) => prev.filter((p) => p.id !== projectId));
    // 清掉该项目所有分析的 nodes/report 缓存
    const records = analysisRecordsByProjectRef.current[projectId] || [];
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
    setAnalysisRecordsByProject((prev) => {
      if (!(projectId in prev)) return prev;
      const next = { ...prev };
      delete next[projectId];
      return next;
    });
    setActiveProjectId((current) => (current === projectId ? null : current));
    setProgressByProject((prev) => {
      if (!(projectId in prev)) return prev;
      const next = { ...prev };
      delete next[projectId];
      return next;
    });
    setPipelineByProject((prev) => {
      if (!(projectId in prev)) return prev;
      const next = { ...prev };
      delete next[projectId];
      return next;
    });
    setBudgetByProject((prev) => {
      if (!(projectId in prev)) return prev;
      const next = { ...prev };
      delete next[projectId];
      return next;
    });
    if (window.videoAnalyzer) {
      window.videoAnalyzer.deleteProject(projectId).catch((error) => {
        console.warn("deleteProject failed", error);
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
          if (config?.defaultAnalysis) {
            setDefaultAnalysis(config.defaultAnalysis);
          }
          if (config?.localModelOverrides && typeof config.localModelOverrides === "object") {
            setLocalModelOverrides(config.localModelOverrides);
          }
          const projectList = await window.videoAnalyzer.listProjects();
          setProjects(projectList);
          previousProjectsRef.current = new Map(projectList.map((p) => [p.id, p]));
          // 加载每个项目的分析记录列表
          const recordsMap: Record<string, AnalysisRecord[]> = {};
          const nodesMap: Record<string, AnalysisNode[]> = {};
          const reportsMap: Record<string, AnalysisReport> = {};
          await Promise.all(
            projectList.map(async (p) => {
              if (!window.videoAnalyzer?.listAnalyses) return;
              const records = await window.videoAnalyzer.listAnalyses(p.id).catch(() => [] as AnalysisRecord[]);
              if (records.length) recordsMap[p.id] = records;
              // 只加载当前分析的 nodes/report
              const aid = p.currentAnalysisId;
              if (aid) {
                const [nodes, report] = await Promise.all([
                  window.videoAnalyzer!.getNodes(aid).catch(() => [] as AnalysisNode[]),
                  window.videoAnalyzer!.getReport(aid).catch(() => null),
                ]);
                if (nodes?.length) nodesMap[aid] = nodes;
                if (report) reportsMap[aid] = report;
              }
            }),
          );
          setAnalysisRecordsByProject(recordsMap);
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
            const byAsset: Record<string, Shot[]> = {};
            for (const s of allShots) {
              (byAsset[s.assetProjectId] ||= []).push(s);
            }
            setShotsByAsset(byAsset);
            // 每个账号一次性拉视频列表
            if (window.videoAnalyzer.listAccountVideos) {
              const avEntries = await Promise.all(
                accs.map(async (a) => [a.id, await window.videoAnalyzer!.listAccountVideos!(a.id).catch(() => [] as AccountVideo[])] as const),
              );
              setAccountVideosByAccountId(Object.fromEntries(avEntries));
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
            if (state.defaultAnalysis) setDefaultAnalysis(state.defaultAnalysis);
            setProjects(state.projects || []);
            setNodesByAnalysis(state.nodesByAnalysis || {});
            setReportByAnalysis(state.reportByAnalysis || {});
            previousProjectsRef.current = new Map(
              (state.projects || []).map((p: Project) => [p.id, p] as const),
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
  }, [providers, taskSlots, audioSlot, defaultAnalysis, localModelOverrides, hasHydrated]);

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

  // 订阅 main 进程的分析 / 下载进度事件 — 全局只挂一次, 同时写 progressByProject
  // (最新一条快照) 和 pipelineByProject (结构化阶段进度)。
  // 任何屏 (ProgressScreen / TaskQueueDrawer / 首屏卡片) 都从这两个全局 map 读,
  // 避免组件 mount 才订阅导致漏掉之前的 events, 也避免 ProgressScreen 切换 /
  // 退出再进时日志被清掉混在一起。
  useEffect(() => {
    if (!window.videoAnalyzer?.onAnalysisProgress) return;
    const off = window.videoAnalyzer.onAnalysisProgress((evt) => {
      setProgressByProject((prev) => ({ ...prev, [evt.projectId]: evt }));
      if (evt.stageIndex != null) {
        const si = evt.stageIndex;
        const now = Date.now();
        setPipelineByProject((prev) => {
          const existing = prev[evt.projectId];
          const isNewAnalysis = existing && existing.analysisId && existing.analysisId !== evt.analysisId;
          // analysisId 变化 → 新分析开始,丢弃旧 pipeline 避免状态混叠
          const pipeline = (existing && !isNewAnalysis)
            ? existing
            : { ...createEmptyPipeline(evt.projectId), analysisId: evt.analysisId };
          // 新分析 → 旧 budget 无效,一并清掉
          if (isNewAnalysis) {
            setBudgetByProject((bp) => {
              if (!(evt.projectId in bp)) return bp;
              const next = { ...bp };
              delete next[evt.projectId];
              return next;
            });
          }
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
          return { ...prev, [evt.projectId]: { ...pipeline, progress: evt.progress, stages } };
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

  // 订阅 analyzeProject 起来时广播的 ETA budget — 全局只挂一次, 写进 budgetByProject。
  // ProgressScreen 读这里给出比线性外推更准的 ETA; attach 模式重连时通过
  // getLastAnalysisBudget IPC 拉一次补回 cache。
  useEffect(() => {
    if (!window.videoAnalyzer?.onAnalysisBudget) return;
    const off = window.videoAnalyzer.onAnalysisBudget((evt) => {
      setBudgetByProject((prev) => ({ ...prev, [evt.projectId]: evt.budget }));
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
      const projectId = evt.projectId;
      const success = evt.success;
      let video: DownloadedVideo | null = null;
      let cancelled = false;
      let errorMessage = "";
      if (evt.success) {
        video = evt.video;
      } else {
        // strict 未开, union 在 else 分支也不收窄到 success:false; 显式 cast 拍死。
        const failEvt = evt as { projectId: string; success: false; cancelled?: boolean; error: string };
        cancelled = !!failEvt.cancelled;
        errorMessage = failEvt.error || "视频下载失败";
      }
      setProjects((prev) => prev.map((p) => {
        if (p.id !== projectId) return p;
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
    const prev = previousProjectsRef.current;
    const nextMap = new Map(projects.map((p) => [p.id, p] as const));
    previousProjectsRef.current = nextMap;
    if (window.videoAnalyzer) {
      for (const project of projects) {
        if (prev.get(project.id) === project) continue;
        window.videoAnalyzer.upsertProject(project).catch((error) => {
          console.warn("upsertProject failed", error);
        });
      }
    } else {
      const existing = JSON.parse(window.localStorage.getItem(LOCAL_STORAGE_KEY) || "{}");
      window.localStorage.setItem(
        LOCAL_STORAGE_KEY,
        JSON.stringify({ ...existing, projects, nodesByAnalysis, reportByAnalysis })
      );
    }
  }, [projects, nodesByAnalysis, reportByAnalysis, hasHydrated]);

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
        projects,
        setProjects,
        activeProjectId,
        setActiveProjectId,
        providers,
        setProviders,
        taskSlots,
        setTaskSlot,
        audioSlot,
        setAudioSlot,
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
        analysisRecordsByProject,
        refreshAnalysisRecords,
        switchAnalysis,
        removeProject,
        startAnalysisForProject,
        accounts,
        upsertAccount,
        removeAccount,
        sessions,
        upsertSession,
        removeSession,
        shotsByAsset,
        setShotsForAsset,
        accountVideosByAccountId,
        refreshAccountVideos,
        upsertAccountVideoLocal,
        accountFetchUi,
        progressByProject,
        pipelineByProject,
        budgetByProject,
        setBudgetForProject,
        modelDownloads,
        whisperDownloads,
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
