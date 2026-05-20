import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, ReactNode } from "react";
import { Project, ScreenState, ModelProvider, AnalysisNode, AnalysisReport, AppConfig, TaskSlots, TaskSlotKey, SlotAssignment, DefaultAnalysis, AppLocation, AppModule, AnalysisOptions, legacyScreenToLocation, locationToLegacyScreen, defaultPresetToAnalysisOptions, Account, AccountVideo, StudioSession, Shot } from "./types";

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
  /** @deprecated derived from taskSlots.complex_vision; will be removed in PR-3 */
  activeVideoProviderId: string | null;
  /** @deprecated 写入会同步到 taskSlots.complex_vision.providerId,保留是为了在 PR-3 完成前旧 UI 不崩 */
  setActiveVideoProviderId: (id: string | null) => void;
  /** @deprecated derived from audioSlot */
  activeAudioProviderId: string | null;
  /** @deprecated 写入会同步到 audioSlot.providerId */
  setActiveAudioProviderId: (id: string | null) => void;
  nodesByProject: Record<string, AnalysisNode[]>;
  setNodesForProject: (projectId: string, nodes: AnalysisNode[]) => void;
  reportByProject: Record<string, AnalysisReport>;
  setReportForProject: (projectId: string, report: AnalysisReport) => void;
  removeProject: (projectId: string) => void;
  // 把已存在的 project 切到 analyzing 状态并跳进度屏。
  // analysisOptions 来源优先级: override > 项目自带 > defaultAnalysis 推导。
  // providerId / model 始终用当前 active video provider 覆盖。
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
const MODULE_DEFAULT_SCREEN: Record<Exclude<AppModule, "settings">, AppLocation> = {
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

  // ref 始终指向最新 providers,供下面的 setActiveXxxProviderId 在更换 provider 时挑首个 model
  const providersRef = useRef<ModelProvider[]>(providers);
  useEffect(() => {
    providersRef.current = providers;
  }, [providers]);

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
  const [nodesByProject, setNodesByProject] = useState<Record<string, AnalysisNode[]>>({});
  const [reportByProject, setReportByProject] = useState<Record<string, AnalysisReport>>({});
  // v2 状态
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [sessions, setSessions] = useState<StudioSession[]>([]);
  const [shotsByAsset, setShotsByAsset] = useState<Record<string, Shot[]>>({});
  // v2.1: 账号视频独立表
  const [accountVideosByAccountId, setAccountVideosByAccountId] = useState<Record<string, AccountVideo[]>>({});
  const [accountFetchUi, setAccountFetchUi] = useState<Record<string, AccountFetchUiState>>({});

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

  const setNodesForProject = useCallback((projectId: string, nodes: AnalysisNode[]) => {
    setNodesByProject((prev) => ({ ...prev, [projectId]: nodes }));
    if (window.videoAnalyzer) {
      window.videoAnalyzer.setNodes(projectId, nodes).catch((error) => {
        console.warn("setNodes failed", error);
      });
    }
  }, []);

  const setReportForProject = useCallback((projectId: string, report: AnalysisReport) => {
    setReportByProject((prev) => ({ ...prev, [projectId]: report }));
    if (window.videoAnalyzer) {
      window.videoAnalyzer.setReport(projectId, report).catch((error) => {
        console.warn("setReport failed", error);
      });
    }
  }, []);

  const startAnalysisForProject = useCallback(
    (projectId: string, optionsOverride?: AnalysisOptions) => {
      const provider = providersRef.current.find((pr) => pr.id === activeVideoProviderId)
        ?? providersRef.current.find((pr) => pr.kind === "video");
      setProjects((prev) =>
        prev.map((p) => {
          if (p.id !== projectId) return p;
          const analysisOptions = optionsOverride
            ?? p.analysisOptions
            ?? defaultPresetToAnalysisOptions(defaultAnalysis);
          return {
            ...p,
            status: "analyzing",
            providerId: provider?.id,
            model: provider?.model,
            analysisOptions,
            updatedAt: new Date().toISOString(),
          };
        }),
      );
      setActiveProjectId(projectId);
      setCurrentLocation({ module: "analysis", screen: "progress" });
    },
    [defaultAnalysis, activeVideoProviderId],
  );

  const removeProject = useCallback((projectId: string) => {
    setProjects((prev) => prev.filter((p) => p.id !== projectId));
    setNodesByProject((prev) => {
      if (!(projectId in prev)) return prev;
      const next = { ...prev };
      delete next[projectId];
      return next;
    });
    setReportByProject((prev) => {
      if (!(projectId in prev)) return prev;
      const next = { ...prev };
      delete next[projectId];
      return next;
    });
    setActiveProjectId((current) => (current === projectId ? null : current));
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
          const projectList = await window.videoAnalyzer.listProjects();
          setProjects(projectList);
          previousProjectsRef.current = new Map(projectList.map((p) => [p.id, p]));
          const nodesEntries = await Promise.all(
            projectList.map(async (p) => [p.id, await window.videoAnalyzer!.getNodes(p.id)] as const)
          );
          const reportEntries = await Promise.all(
            projectList.map(async (p) => [p.id, await window.videoAnalyzer!.getReport(p.id)] as const)
          );
          setNodesByProject(Object.fromEntries(nodesEntries.filter(([, nodes]) => nodes && nodes.length)));
          setReportByProject(
            Object.fromEntries(reportEntries.filter(([, report]) => report)) as Record<string, AnalysisReport>
          );
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
            setNodesByProject(state.nodesByProject || {});
            setReportByProject(state.reportByProject || {});
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
  }, [providers, taskSlots, audioSlot, defaultAnalysis, hasHydrated]);

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

  // 订阅异步下载完成事件 — 把 yt-dlp 拿到的真实元数据回填进 downloading 项目,
  // 把 status 切到 analyzing 让 ProgressScreen 起分析;失败则切到 download_failed。
  useEffect(() => {
    if (!window.videoAnalyzer?.onDownloadComplete) return;
    const off = window.videoAnalyzer.onDownloadComplete((evt) => {
      setProjects((prev) => prev.map((p) => {
        if (p.id !== evt.projectId) return p;
        const now = new Date().toISOString();
        if (evt.success) {
          const video = evt.video;
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
            status: "analyzing",
            updatedAt: now,
          };
        }
        return {
          ...p,
          status: evt.cancelled ? "not_analyzed" : "download_failed",
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
        JSON.stringify({ ...existing, projects, nodesByProject, reportByProject })
      );
    }
  }, [projects, nodesByProject, reportByProject, hasHydrated]);

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
        activeVideoProviderId,
        setActiveVideoProviderId,
        activeAudioProviderId,
        setActiveAudioProviderId,
        nodesByProject,
        setNodesForProject,
        reportByProject,
        setReportForProject,
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
