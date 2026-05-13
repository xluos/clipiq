import React, { createContext, useCallback, useContext, useEffect, useRef, useState, ReactNode } from "react";
import { Project, ScreenState, ModelProvider, AnalysisNode, AnalysisReport, AppConfig, TaskSlots, TaskSlotKey, SlotAssignment } from "./types";

interface AppState {
  currentScreen: ScreenState;
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

const DEFAULT_TASK_SLOTS: TaskSlots = {
  simple_vision: null,
  simple_text: null,
  medium_vision: null,
  medium_text: null,
  complex_vision: { providerId: "default-video", modelId: "gpt-4o-mini" },
  complex_text: { providerId: "default-video", modelId: "gpt-4o-mini" },
};

const LOCAL_STORAGE_KEY = "video-analyzer-state";

export function AppProvider({ children }: { children: ReactNode }) {
  const [hasHydrated, setHasHydrated] = useState(false);
  const previousProjectsRef = useRef<Map<string, Project>>(new Map());
  const [currentScreen, setCurrentScreen] = useState<ScreenState>("home");
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [providers, setProviders] = useState<ModelProvider[]>(DEFAULT_PROVIDERS);
  const [taskSlots, setTaskSlots] = useState<TaskSlots>(DEFAULT_TASK_SLOTS);
  const [audioSlot, setAudioSlotState] = useState<SlotAssignment>(null);

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
          if (config?.taskSlots) {
            setTaskSlots(config.taskSlots);
          }
          if (config?.audioSlot !== undefined) {
            setAudioSlotState(config.audioSlot);
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
        } else {
          const raw = window.localStorage.getItem(LOCAL_STORAGE_KEY);
          if (raw) {
            const state = JSON.parse(raw);
            if (state.providers?.length) setProviders(state.providers);
            if (state.taskSlots) setTaskSlots(state.taskSlots);
            if (state.audioSlot !== undefined) setAudioSlotState(state.audioSlot);
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
  }, [providers, taskSlots, audioSlot, hasHydrated]);

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
