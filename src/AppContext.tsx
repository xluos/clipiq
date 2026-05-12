import React, { createContext, useCallback, useContext, useEffect, useRef, useState, ReactNode } from "react";
import { Project, ScreenState, ModelProvider, AnalysisNode, AnalysisReport, AppConfig } from "./types";

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
}

const AppContext = createContext<AppState | undefined>(undefined);

const DEFAULT_PROVIDERS: ModelProvider[] = [
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
    id: "local-whisper",
    name: "本地语音识别 (whisper.cpp WASM)",
    baseUrl: "",
    apiKeyRef: "",
    model: "Xenova/whisper-base",
    kind: "audio",
    endpointType: "local_whisper_wasm",
    inputMode: "keyframe_sequence",
    language: "zh",
    localWhisperModel: "Xenova/whisper-base",
    localWhisperMirror: "https://hf-mirror.com",
  },
];

const LOCAL_STORAGE_KEY = "video-analyzer-state";

export function AppProvider({ children }: { children: ReactNode }) {
  const hasHydrated = useRef(false);
  const previousProjectIds = useRef<Set<string>>(new Set());
  const [currentScreen, setCurrentScreen] = useState<ScreenState>("home");
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [providers, setProviders] = useState<ModelProvider[]>(DEFAULT_PROVIDERS);
  const [activeVideoProviderId, setActiveVideoProviderId] = useState<string | null>("default-video");
  const [activeAudioProviderId, setActiveAudioProviderId] = useState<string | null>("local-whisper");
  const [nodesByProject, setNodesByProject] = useState<Record<string, AnalysisNode[]>>({});
  const [reportByProject, setReportByProject] = useState<Record<string, AnalysisReport>>({});

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
          if (config?.activeVideoProviderId !== undefined) {
            setActiveVideoProviderId(config.activeVideoProviderId);
          }
          if (config?.activeAudioProviderId !== undefined) {
            setActiveAudioProviderId(config.activeAudioProviderId);
          }
          const projectList = await window.videoAnalyzer.listProjects();
          setProjects(projectList);
          previousProjectIds.current = new Set(projectList.map((p) => p.id));
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
        } else {
          const raw = window.localStorage.getItem(LOCAL_STORAGE_KEY);
          if (raw) {
            const state = JSON.parse(raw);
            if (state.providers?.length) setProviders(state.providers);
            if (state.activeVideoProviderId !== undefined) setActiveVideoProviderId(state.activeVideoProviderId);
            if (state.activeAudioProviderId !== undefined) setActiveAudioProviderId(state.activeAudioProviderId);
            setProjects(state.projects || []);
            setNodesByProject(state.nodesByProject || {});
            setReportByProject(state.reportByProject || {});
            previousProjectIds.current = new Set((state.projects || []).map((p: Project) => p.id));
          }
        }
      } catch (error) {
        console.warn("Failed to load app state", error);
      } finally {
        hasHydrated.current = true;
      }
    };
    load();
  }, []);

  useEffect(() => {
    if (!hasHydrated.current) return;
    const config: AppConfig = { providers, activeVideoProviderId, activeAudioProviderId };
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
  }, [providers, activeVideoProviderId, activeAudioProviderId]);

  useEffect(() => {
    if (!hasHydrated.current) return;
    const currentIds = new Set(projects.map((p) => p.id));
    previousProjectIds.current = currentIds;
    if (window.videoAnalyzer) {
      for (const project of projects) {
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
  }, [projects, nodesByProject, reportByProject]);

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
