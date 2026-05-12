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
  activeProviderId: string | null;
  setActiveProviderId: (id: string | null) => void;
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
  
  const [providers, setProviders] = useState<ModelProvider[]>([{
    id: "default-openai-compatible",
    name: "OpenAI Compatible",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKeyRef: "",
    model: "qwen3.5-omni-plus",
    endpointType: "openai_chat_completions",
    inputMode: "auto"
  }]);
  
  const [activeProviderId, setActiveProviderId] = useState<string | null>("default-openai-compatible");

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
    setProviders(state.providers?.length ? state.providers : providers);
    setActiveProviderId(state.activeProviderId || state.providers?.[0]?.id || activeProviderId);
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
      activeProviderId,
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
  }, [projects, providers, activeProviderId, nodesByProject, reportByProject]);

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
        activeProviderId,
        setActiveProviderId,
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
