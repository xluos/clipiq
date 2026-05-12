import React, { createContext, useContext, useState, ReactNode } from "react";
import { Project, ScreenState, ModelProvider, AnalysisNode, AnalysisReport } from "./types";

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
}

const AppContext = createContext<AppState | undefined>(undefined);

export function AppProvider({ children }: { children: ReactNode }) {
  const [currentScreen, setCurrentScreen] = useState<ScreenState>("home");
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  
  const [providers, setProviders] = useState<ModelProvider[]>([{
    id: "default-qwen",
    name: "Qwen VL Max (Default)",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKeyRef: "", // Empty to simulate setup needed
    model: "qwen-vl-max",
    endpointType: "openai_chat_completions",
    inputMode: "auto"
  }]);
  
  const [activeProviderId, setActiveProviderId] = useState<string | null>("default-qwen");

  const [nodesByProject, setNodesByProject] = useState<Record<string, AnalysisNode[]>>({});
  const [reportByProject, setReportByProject] = useState<Record<string, AnalysisReport>>({});

  const setNodesForProject = (projectId: string, nodes: AnalysisNode[]) => {
    setNodesByProject(prev => ({ ...prev, [projectId]: nodes }));
  };

  const setReportForProject = (projectId: string, report: AnalysisReport) => {
    setReportByProject(prev => ({ ...prev, [projectId]: report }));
  };

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
        setReportForProject
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
