import React, { createContext, useContext, useEffect, useState, ReactNode } from "react";
import {
  ScreenState, ModelProvider, AnalysisNode, AnalysisReport, TaskSlots, TaskSlotKey,
  SlotAssignment, SlotOverrides, DefaultAnalysis, AppLocation, AppModule, AnalysisOptions,
  AnalysisProgressEvent, AnalysisBudget, PipelineState, locationToLegacyScreen,
  Account, AccountVideo, StudioSession, Shot, PipelineId, PipelineSlots, Video,
  Collection, Pipeline, Analysis,
} from "./types";
import { useNavigationStore } from "./stores/navigation";
import { useSelectionStore } from "./stores/selection";
import { useConfigStore } from "./stores/config";
import { useProgressStore, type ModelDownloadProgress, type AccountFetchUiState } from "./stores/progress";
import { useAnalysisCacheStore } from "./stores/analysis-cache";
import { initIpcSubscriptions } from "./stores/subscriptions";
import { queryClient } from "./queries/client";
import { useVideos } from "./queries/videos";
import { useAccounts } from "./queries/accounts";
import { useSessions } from "./queries/sessions";
import { useCollections } from "./queries/collections";
import { usePipelines } from "./queries/pipelines";
import { useShots } from "./queries/shots";
import { useAllAnalyses } from "./queries/analyses";
import { useStartAnalysis } from "./hooks/useStartAnalysis";
import { useRemoveVideo } from "./hooks/useRemoveVideo";

export type { ModelDownloadProgress, AccountFetchUiState };

interface AppState {
  currentLocation: AppLocation;
  setLocation: (loc: AppLocation) => void;
  goModule: (m: AppModule) => void;
  goBack: (fallback?: AppLocation) => void;
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (collapsed: boolean) => void;
  currentScreen: ScreenState;
  setCurrentScreen: (screen: ScreenState) => void;
  videos: Video[];
  setVideos: React.Dispatch<React.SetStateAction<Video[]>>;
  activeVideoId: string | null;
  setActiveVideoId: (id: string | null) => void;
  activeAnalysisId: string | null;
  setActiveAnalysisId: (id: string | null) => void;
  projects: Video[];
  setProjects: React.Dispatch<React.SetStateAction<Video[]>>;
  activeProjectId: string | null;
  setActiveProjectId: (id: string | null) => void;
  providers: ModelProvider[];
  setProviders: (fn: ModelProvider[] | ((prev: ModelProvider[]) => ModelProvider[])) => void;
  taskSlots: TaskSlots;
  setTaskSlot: (key: TaskSlotKey, assignment: SlotAssignment) => void;
  audioSlot: SlotAssignment;
  setAudioSlot: (assignment: SlotAssignment) => void;
  pipelineSlots: PipelineSlots;
  setPipelineSlot: (pipelineId: PipelineId, slotKey: TaskSlotKey | "__audio__", assignment: SlotAssignment) => void;
  getPipelineSlot: (pipelineId: PipelineId, slotKey: TaskSlotKey | "__audio__") => SlotAssignment;
  defaultAnalysis: DefaultAnalysis;
  setDefaultAnalysis: (fn: DefaultAnalysis | ((prev: DefaultAnalysis) => DefaultAnalysis)) => void;
  localModelOverrides: Record<string, { contextSize?: number }>;
  updateLocalModelOverride: (modelKey: string, patch: { contextSize?: number } | null) => void;
  pendingSlotOverrides: Record<string, SlotOverrides>;
  setPendingSlotOverrides: (fn: Record<string, SlotOverrides> | ((prev: Record<string, SlotOverrides>) => Record<string, SlotOverrides>)) => void;
  activeVideoProviderId: string | null;
  setActiveVideoProviderId: (id: string | null) => void;
  activeAudioProviderId: string | null;
  setActiveAudioProviderId: (id: string | null) => void;
  collections: Collection[];
  setCollections: React.Dispatch<React.SetStateAction<Collection[]>>;
  pipelines: Pipeline[];
  analysesByVideo: Record<string, Analysis[]>;
  analysisRecordsByProject: Record<string, Analysis[]>;
  refreshAnalyses: (videoId: string) => Promise<void>;
  refreshAnalysisRecords: (videoId: string) => Promise<void>;
  switchAnalysis: (videoId: string, analysisId: string) => Promise<void>;
  removeVideo: (videoId: string) => void;
  removeProject: (videoId: string) => void;
  startAnalysis: (videoId: string, pipelineId: string, optionsOverride?: AnalysisOptions) => void;
  startAnalysisForProject: (videoId: string, optionsOverride?: AnalysisOptions) => void;
  resumeAnalysis: (analysisId: string, videoId: string) => void;
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
  shotsByAsset: Record<string, Shot[]>;
  setShotsForAsset: (videoId: string, shots: Shot[]) => void;
  accountVideosByAccountId: Record<string, AccountVideo[]>;
  refreshAccountVideos: (accountId: string) => Promise<void>;
  upsertAccountVideoLocal: (av: AccountVideo) => void;
  accountFetchUi: Record<string, AccountFetchUiState>;
  progressByAnalysis: Record<string, AnalysisProgressEvent>;
  pipelineByAnalysis: Record<string, PipelineState>;
  budgetByAnalysis: Record<string, AnalysisBudget>;
  activeAnalysisForProject: Record<string, string>;
  setBudgetForAnalysis: (analysisId: string, budget: AnalysisBudget) => void;
  seedProgressSnapshot: (snapshot: { analysisId: string; projectId: string; progress?: number; stage?: string; stageIndex?: number; message?: string }) => void;
  modelDownloads: Record<string, ModelDownloadProgress>;
  whisperDownloads: Record<string, ModelDownloadProgress>;
}

const HydratedContext = createContext(false);

export function AppProvider({ children }: { children: ReactNode }) {
  const [hydrated, setHydrated] = useState(false);

  // Hydrate stores from IPC on mount
  useEffect(() => {
    const load = async () => {
      try {
        if (window.videoAnalyzer) {
          const config = await window.videoAnalyzer.loadConfig();
          if (config) useConfigStore.getState().hydrate(config);

          // 数据(videos/accounts/sessions/shots/collections/pipelines/analyses)由 useApp 里的
          // useQuery 自行拉取,不再手动 setQueryData。analysis 的 nodes/report(重数据)按需在
          // Workspace/Report 屏冷加载,不在启动预热。

          // Reconnect in-flight account fetch progress
          if (window.videoAnalyzer.listAccountFetchInFlight) {
            try {
              const inflight = await window.videoAnalyzer.listAccountFetchInFlight();
              for (const it of inflight) {
                useProgressStore.getState().setAccountFetchUi(it.accountId, {
                  stage: it.stage, progress: it.progress, message: it.message,
                });
              }
            } catch { /* noop */ }
          }
        } else {
          // Browser preview mode
          const raw = window.localStorage.getItem("video-analyzer-state");
          if (raw) {
            const state = JSON.parse(raw);
            useConfigStore.getState().hydrate(state);
            const videos = state.videos || state.projects || [];
            queryClient.setQueryData(["videos", {}], videos);
            if (state.nodesByAnalysis) {
              useAnalysisCacheStore.setState({ nodesByAnalysis: state.nodesByAnalysis });
            }
            if (state.reportByAnalysis) {
              useAnalysisCacheStore.setState({ reportByAnalysis: state.reportByAnalysis });
            }
          }
        }
      } catch (error) {
        console.warn("Failed to load app state", error);
      } finally {
        setHydrated(true);
      }
    };
    load();
  }, []);

  // IPC event subscriptions
  useEffect(() => {
    return initIpcSubscriptions(queryClient);
  }, []);

  return (
    <HydratedContext.Provider value={hydrated}>
      {children}
    </HydratedContext.Provider>
  );
}

export function useApp(): AppState {
  const nav = useNavigationStore();
  const sel = useSelectionStore();
  const cfg = useConfigStore();
  const prog = useProgressStore();
  const cache = useAnalysisCacheStore();
  const startAnalysis = useStartAnalysis();
  const removeVideo = useRemoveVideo();

  // TanStack Query data — 真正用 useQuery 订阅:缓存变化自动重渲染,invalidateQueries 会真正 refetch。
  // (旧写法是 queryClient.getQueryData 同步读,不订阅,导致到处要手动 setQueryData/refetch。)
  const videos: Video[] = useVideos().data ?? [];
  const accounts: Account[] = useAccounts().data ?? [];
  const sessions: StudioSession[] = useSessions().data ?? [];
  const collections: Collection[] = useCollections().data ?? [];
  const pipelines: Pipeline[] = usePipelines().data ?? [];
  const allShots: Shot[] = useShots(undefined).data ?? [];
  const allAnalyses: Analysis[] = useAllAnalyses().data ?? [];

  // 按 videoId 分组(单 query 的全量数组 → 派生 map)
  const analysesByVideo: Record<string, Analysis[]> = {};
  for (const a of allAnalyses) {
    if (a.videoId) (analysesByVideo[a.videoId] ||= []).push(a);
  }

  const shotsByVideo: Record<string, Shot[]> = {};
  for (const s of allShots) {
    const vid = s.videoId || s.assetProjectId;
    if (vid) (shotsByVideo[vid] ||= []).push(s);
  }

  const refreshAnalyses = async (_videoId?: string) => {
    // useAllAnalyses() 订阅了 ["analyses"],invalidate 会真正 refetch 全量并自动重渲染。
    await queryClient.invalidateQueries({ queryKey: ["analyses"] });
  };

  const switchAnalysis = async (_videoId: string, analysisId: string) => {
    if (!window.videoAnalyzer?.getAnalysis) return;
    try {
      const analysis = await window.videoAnalyzer.getAnalysis(analysisId);
      if (!analysis) return;
      const result = analysis.result as any;
      // 冷加载是"读",用 hydrate 只回灌内存,不要再写回 DB —— 否则分两次 partial 写会自我覆盖。
      cache.hydrateAnalysis(analysisId, { nodes: result?.nodes, report: result?.report });
    } catch (err) {
      console.warn("switchAnalysis failed", err);
    }
  };

  const setVideos: React.Dispatch<React.SetStateAction<Video[]>> = (fn) => {
    const prev: Video[] = queryClient.getQueryData(["videos", {}]) || [];
    const next = typeof fn === "function" ? fn(prev) : fn;
    queryClient.setQueryData(["videos", {}], next);
    // Persist changed videos
    if (window.videoAnalyzer) {
      for (const v of next) {
        if (!prev.find((p) => p === v)) {
          window.videoAnalyzer.upsertVideo(v).catch((err) => console.warn("upsertVideo failed", err));
        }
      }
    }
  };

  const noop = async () => {};

  return {
    // NavigationStore
    currentLocation: nav.currentLocation,
    setLocation: nav.setLocation,
    goModule: nav.goModule,
    goBack: nav.goBack,
    sidebarCollapsed: nav.sidebarCollapsed,
    setSidebarCollapsed: nav.setSidebarCollapsed,
    currentScreen: locationToLegacyScreen(nav.currentLocation),
    setCurrentScreen: nav.setCurrentScreen,
    // SelectionStore
    activeVideoId: sel.activeVideoId,
    setActiveVideoId: sel.setActiveVideoId,
    activeAnalysisId: sel.activeAnalysisId,
    setActiveAnalysisId: sel.setActiveAnalysisId,
    // compat
    activeProjectId: sel.activeVideoId,
    setActiveProjectId: sel.setActiveVideoId,
    projects: videos,
    setProjects: setVideos,
    // ConfigStore
    providers: cfg.providers,
    setProviders: cfg.setProviders,
    taskSlots: cfg.taskSlots,
    setTaskSlot: cfg.setTaskSlot,
    audioSlot: cfg.audioSlot,
    setAudioSlot: cfg.setAudioSlot,
    pipelineSlots: cfg.pipelineSlots,
    setPipelineSlot: cfg.setPipelineSlot,
    getPipelineSlot: cfg.getPipelineSlot,
    defaultAnalysis: cfg.defaultAnalysis,
    setDefaultAnalysis: cfg.setDefaultAnalysis,
    localModelOverrides: cfg.localModelOverrides,
    updateLocalModelOverride: cfg.updateLocalModelOverride,
    pendingSlotOverrides: cfg.pendingSlotOverrides,
    setPendingSlotOverrides: cfg.setPendingSlotOverrides,
    activeVideoProviderId: cfg.taskSlots.complex_vision?.providerId ?? null,
    setActiveVideoProviderId: cfg.setActiveVideoProviderId,
    activeAudioProviderId: cfg.audioSlot?.providerId ?? null,
    setActiveAudioProviderId: cfg.setActiveAudioProviderId,
    // Data from TanStack Query cache
    videos,
    setVideos,
    collections,
    setCollections: (fn) => {
      const prev: Collection[] = queryClient.getQueryData(["collections"]) || [];
      queryClient.setQueryData(["collections"], typeof fn === "function" ? fn(prev) : fn);
    },
    pipelines,
    analysesByVideo,
    analysisRecordsByProject: analysesByVideo,
    refreshAnalyses,
    refreshAnalysisRecords: refreshAnalyses,
    switchAnalysis,
    removeVideo,
    removeProject: removeVideo,
    startAnalysis,
    startAnalysisForProject: (videoId: string, opts?: AnalysisOptions) => startAnalysis(videoId, "builtin-pipeline", opts),
    resumeAnalysis: (analysisId: string, videoId: string) => {
      sel.setActiveVideoId(videoId);
      sel.setActiveAnalysisId(analysisId);
      nav.setLocation({ module: "analysis", screen: "progress" });
      // 乐观把视频切回 analyzing,让进度屏立刻进入"分析中"视图。
      const prevVideos: Video[] = queryClient.getQueryData(["videos", {}]) || [];
      queryClient.setQueryData(["videos", {}], prevVideos.map((v) =>
        v.id === videoId ? { ...v, status: "analyzing" as const, currentAnalysisId: analysisId } : v));
      window.videoAnalyzer?.resumeAnalysis?.(analysisId)
        .then(() => {
          queryClient.invalidateQueries({ queryKey: ["analyses"] });
          queryClient.invalidateQueries({ queryKey: ["videos"] });
        })
        .catch((err) => {
          console.warn("resumeAnalysis failed", err);
          queryClient.invalidateQueries({ queryKey: ["analyses"] });
          queryClient.invalidateQueries({ queryKey: ["videos"] });
        });
    },
    // AnalysisCacheStore
    nodesByAnalysis: cache.nodesByAnalysis,
    setNodesForAnalysis: cache.setNodesForAnalysis,
    reportByAnalysis: cache.reportByAnalysis,
    setReportForAnalysis: cache.setReportForAnalysis,
    // Entity data
    accounts,
    upsertAccount: (a: Account) => {
      window.videoAnalyzer?.upsertAccount(a).catch((err) => console.warn("upsertAccount failed", err));
      queryClient.invalidateQueries({ queryKey: ["accounts"] });
    },
    removeAccount: (id: string) => {
      window.videoAnalyzer?.deleteAccount(id).catch((err) => console.warn("deleteAccount failed", err));
      queryClient.invalidateQueries({ queryKey: ["accounts"] });
      queryClient.invalidateQueries({ queryKey: ["videos"] });
    },
    sessions,
    upsertSession: (s: StudioSession) => {
      // 先更新内存，保证新建/连续勾选时编辑器拿到最新会话；IPC 完成后再回源校准。
      queryClient.setQueryData<StudioSession[]>(["sessions"], (current = []) => {
        const index = current.findIndex((item) => item.id === s.id);
        if (index < 0) return [s, ...current];
        const next = [...current];
        next[index] = s;
        return next;
      });
      window.videoAnalyzer?.upsertSession(s)
        .then(() => queryClient.invalidateQueries({ queryKey: ["sessions"] }))
        .catch((err) => {
          console.warn("upsertSession failed", err);
          queryClient.invalidateQueries({ queryKey: ["sessions"] });
        });
    },
    removeSession: (id: string) => {
      window.videoAnalyzer?.deleteSession(id).catch((err) => console.warn("deleteSession failed", err));
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
    },
    shotsByVideo,
    setShotsForVideo: (videoId: string, shots: Shot[]) => {
      window.videoAnalyzer?.setShotsForVideo(videoId, shots).catch((err) => console.warn("setShotsForVideo failed", err));
      queryClient.invalidateQueries({ queryKey: ["shots"] });
    },
    shotsByAsset: shotsByVideo,
    setShotsForAsset: (videoId: string, shots: Shot[]) => {
      window.videoAnalyzer?.setShotsForVideo(videoId, shots).catch((err) => console.warn("setShotsForVideo failed", err));
      queryClient.invalidateQueries({ queryKey: ["shots"] });
    },
    accountVideosByAccountId: {},
    refreshAccountVideos: noop,
    upsertAccountVideoLocal: () => {},
    // ProgressStore
    accountFetchUi: prog.accountFetchUi,
    progressByAnalysis: prog.progressByAnalysis,
    pipelineByAnalysis: prog.pipelineByAnalysis,
    budgetByAnalysis: prog.budgetByAnalysis,
    activeAnalysisForProject: prog.activeAnalysisForProject,
    setBudgetForAnalysis: prog.setBudget,
    seedProgressSnapshot: prog.seedFromSnapshot,
    modelDownloads: prog.modelDownloads,
    whisperDownloads: prog.whisperDownloads,
  };
}
