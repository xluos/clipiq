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
import { useStartAnalysis } from "./hooks/useStartAnalysis";
import { useRemoveVideo } from "./hooks/useRemoveVideo";

export type { ModelDownloadProgress, AccountFetchUiState };

interface AppState {
  currentLocation: AppLocation;
  setLocation: (loc: AppLocation) => void;
  goModule: (m: AppModule) => void;
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

          // Seed TanStack Query cache with initial data
          const videoList = await window.videoAnalyzer.listVideos();
          queryClient.setQueryData(["videos", {}], videoList);

          if (window.videoAnalyzer.listAccounts) {
            const [accs, sess, allShots] = await Promise.all([
              window.videoAnalyzer.listAccounts().catch(() => []),
              window.videoAnalyzer.listSessions().catch(() => []),
              window.videoAnalyzer.listShots(undefined).catch(() => [] as Shot[]),
            ]);
            queryClient.setQueryData(["accounts"], accs);
            queryClient.setQueryData(["sessions"], sess);
            queryClient.setQueryData(["shots", undefined], allShots);
            if (window.videoAnalyzer.listCollections)
              queryClient.setQueryData(["collections"], await window.videoAnalyzer.listCollections().catch(() => []));
            if (window.videoAnalyzer.listPipelines)
              queryClient.setQueryData(["pipelines"], await window.videoAnalyzer.listPipelines().catch(() => []));
          }

          // Load analyses for each video + populate analysis cache
          const analysesMap: Record<string, Analysis[]> = {};
          await Promise.all(
            videoList.map(async (v) => {
              if (!window.videoAnalyzer?.listAnalyses) return;
              const records = await window.videoAnalyzer.listAnalyses(v.id).catch(() => [] as Analysis[]);
              if (records.length) analysesMap[v.id] = records;
              queryClient.setQueryData(["analyses", v.id], records);
              const latest = records.find((r) => r.status === "completed");
              if (latest?.result) {
                const result = latest.result as any;
                if (result.nodes) useAnalysisCacheStore.getState().setNodesForAnalysis = useAnalysisCacheStore.getState().setNodesForAnalysis; // already stored
                const cache = useAnalysisCacheStore.getState();
                if (result.nodes) cache.nodesByAnalysis[latest.id] = result.nodes;
                if (result.report) cache.reportByAnalysis[latest.id] = result.report;
              }
            }),
          );
          // Bulk set analysis cache (bypass the IPC persist since we just loaded from it)
          useAnalysisCacheStore.setState({
            nodesByAnalysis: { ...useAnalysisCacheStore.getState().nodesByAnalysis },
            reportByAnalysis: { ...useAnalysisCacheStore.getState().reportByAnalysis },
          });

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

  // TanStack Query data — read from cache synchronously for compat
  const videos: Video[] = queryClient.getQueryData(["videos", {}]) || [];
  const accounts: Account[] = queryClient.getQueryData(["accounts"]) || [];
  const sessions: StudioSession[] = queryClient.getQueryData(["sessions"]) || [];
  const collections: Collection[] = queryClient.getQueryData(["collections"]) || [];
  const pipelines: Pipeline[] = queryClient.getQueryData(["pipelines"]) || [];

  // Build analysesByVideo from query cache
  const analysesByVideo: Record<string, Analysis[]> = {};
  for (const v of videos) {
    const data: Analysis[] | undefined = queryClient.getQueryData(["analyses", v.id]);
    if (data?.length) analysesByVideo[v.id] = data;
  }

  // Build shotsByVideo from query cache
  const allShots: Shot[] = queryClient.getQueryData(["shots", undefined]) || [];
  const shotsByVideo: Record<string, Shot[]> = {};
  for (const s of allShots) {
    const vid = s.videoId || s.assetProjectId;
    if (vid) (shotsByVideo[vid] ||= []).push(s);
  }

  const refreshAnalyses = async (videoId: string) => {
    await queryClient.invalidateQueries({ queryKey: ["analyses", videoId] });
  };

  const switchAnalysis = async (_videoId: string, analysisId: string) => {
    if (!window.videoAnalyzer?.getAnalysis) return;
    try {
      const analysis = await window.videoAnalyzer.getAnalysis(analysisId);
      if (!analysis) return;
      const result = analysis.result as any;
      if (result?.nodes?.length) cache.setNodesForAnalysis(analysisId, result.nodes);
      if (result?.report) cache.setReportForAnalysis(analysisId, result.report);
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
      window.videoAnalyzer?.upsertSession(s).catch((err) => console.warn("upsertSession failed", err));
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
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
    modelDownloads: prog.modelDownloads,
    whisperDownloads: prog.whisperDownloads,
  };
}
