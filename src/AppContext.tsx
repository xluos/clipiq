import React, { createContext, useContext, useEffect, useRef, useState, ReactNode } from "react";
import { Project, ScreenState, ModelProvider, AnalysisNode, AnalysisReport, AppPersistedState } from "./types";

interface AppState {
  currentScreen: ScreenState;
  setCurrentScreen: (screen: ScreenState) => void;
  projects: Project[];
  setProjects: React.Dispatch<React.SetStateAction<Project[]>>;
  activeProjectId: string | null;
  setActiveProjectId: (id: string | null) => void;
  providers: ModelProvider[];
  setProviders: React.Dispatch<React.SetStateAction<ModelProvider[]>>;
  activeVideoProviderId: string | null;
  setActiveVideoProviderId: (id: string | null) => void;
  activeAudioProviderId: string | null;
  setActiveAudioProviderId: (id: string | null) => void;
  nodesByProject: Record<string, AnalysisNode[]>;
  setNodesForProject: (projectId: string, nodes: AnalysisNode[]) => void;
  reportByProject: Record<string, AnalysisReport>;
  setReportForProject: (projectId: string, report: AnalysisReport) => void;
  removeProject: (projectId: string) => void;
  hydrateAppState: (state: AppPersistedState) => void;
}

const AppContext = createContext<AppState | undefined>(undefined);

export function AppProvider({ children }: { children: ReactNode }) {
  const hasHydrated = useRef(false);
  const [currentScreen, setCurrentScreen] = useState<ScreenState>("home");
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  
  const [providers, setProviders] = useState<ModelProvider[]>([
    {
      id: "default-video",
      name: "默认视觉模型",
      baseUrl: "https://api.openai.com/v1",
      apiKeyRef: "",
      model: "gpt-4o-mini",
      kind: "video",
      endpointType: "openai_chat_completions",
      inputMode: "auto",
    },
    {
      id: "default-audio",
      name: "默认语音模型",
      baseUrl: "https://api.openai.com/v1",
      apiKeyRef: "",
      model: "whisper-1",
      kind: "audio",
      endpointType: "openai_audio_transcriptions",
      inputMode: "keyframe_sequence",
      language: "zh",
    },
  ]);

  const [activeVideoProviderId, setActiveVideoProviderId] = useState<string | null>("default-video");
  const [activeAudioProviderId, setActiveAudioProviderId] = useState<string | null>(null);

  const [nodesByProject, setNodesByProject] = useState<Record<string, AnalysisNode[]>>({});
  const [reportByProject, setReportByProject] = useState<Record<string, AnalysisReport>>({});

  const setNodesForProject = (projectId: string, nodes: AnalysisNode[]) => {
    setNodesByProject(prev => ({ ...prev, [projectId]: nodes }));
  };

  const setReportForProject = (projectId: string, report: AnalysisReport) => {
    setReportByProject(prev => ({ ...prev, [projectId]: report }));
  };

  const removeProject = (projectId: string) => {
    setProjects(prev => prev.filter(p => p.id !== projectId));
    setNodesByProject(prev => {
      if (!(projectId in prev)) return prev;
      const next = { ...prev };
      delete next[projectId];
      return next;
    });
    setReportByProject(prev => {
      if (!(projectId in prev)) return prev;
      const next = { ...prev };
      delete next[projectId];
      return next;
    });
    setActiveProjectId(current => (current === projectId ? null : current));
  };

  const hydrateAppState = (state: AppPersistedState) => {
    setProjects(state.projects || []);
    const normalizedProviders = (state.providers?.length ? state.providers : providers).map(p =>
      (p as ModelProvider).kind ? (p as ModelProvider) : { ...(p as ModelProvider), kind: "video" as const }
    );
    setProviders(normalizedProviders);
    const videoFromState = state.activeVideoProviderId ?? state.activeProviderId ?? null;
    const audioFromState = state.activeAudioProviderId ?? null;
    setActiveVideoProviderId(
      videoFromState || normalizedProviders.find(p => p.kind === "video")?.id || null
    );
    setActiveAudioProviderId(
      audioFromState && normalizedProviders.some(p => p.id === audioFromState && p.kind === "audio")
        ? audioFromState
        : null
    );
    setNodesByProject(state.nodesByProject || {});
    setReportByProject(state.reportByProject || {});
  };

  useEffect(() => {
    const load = async () => {
      try {
        if (window.videoAnalyzer) {
          const state = await window.videoAnalyzer.loadAppState();
          if (state) hydrateAppState(state);
        } else {
          const raw = window.localStorage.getItem("video-analyzer-state");
          if (raw) hydrateAppState(JSON.parse(raw));
        }
      } catch (error) {
        console.warn("Failed to load persisted app state", error);
      } finally {
        hasHydrated.current = true;
      }
    };
    load();
  }, []);

  useEffect(() => {
    if (!hasHydrated.current) return;
    const state: AppPersistedState = {
      projects,
      providers,
      activeProviderId: activeVideoProviderId,
      activeVideoProviderId,
      activeAudioProviderId,
      nodesByProject,
      reportByProject,
    };
    const timer = window.setTimeout(() => {
      if (window.videoAnalyzer) {
        window.videoAnalyzer.saveAppState(state).catch((error) => {
          console.warn("Failed to save app state", error);
        });
      } else {
        window.localStorage.setItem("video-analyzer-state", JSON.stringify(state));
      }
    }, 350);
    return () => window.clearTimeout(timer);
  }, [projects, providers, activeVideoProviderId, activeAudioProviderId, nodesByProject, reportByProject]);

  return (
    <AppContext.Provider
      value={{
        currentScreen,
        setCurrentScreen,
        projects,
        setProjects,
        activeProjectId,
        setActiveProjectId,
        providers,
        setProviders,
        activeVideoProviderId,
        setActiveVideoProviderId,
        activeAudioProviderId,
        setActiveAudioProviderId,
        nodesByProject,
        setNodesForProject,
        reportByProject,
        setReportForProject,
        removeProject,
        hydrateAppState
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
