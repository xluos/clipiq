import { create } from "zustand";
import type { AnalysisProgressEvent, AnalysisBudget, PipelineState, PipelineStage } from "../types";
import { PIPELINE_STAGE_DEFS } from "../types";

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

function createEmptyPipeline(projectId: string, analysisId: string): PipelineState {
  return {
    projectId,
    analysisId,
    progress: 0,
    stages: PIPELINE_STAGE_DEFS.map((d) => ({ key: d.key, label: d.label, status: "pending" as const })),
  };
}

interface ProgressState {
  progressByAnalysis: Record<string, AnalysisProgressEvent>;
  pipelineByAnalysis: Record<string, PipelineState>;
  budgetByAnalysis: Record<string, AnalysisBudget>;
  activeAnalysisForProject: Record<string, string>;
  modelDownloads: Record<string, ModelDownloadProgress>;
  whisperDownloads: Record<string, ModelDownloadProgress>;
  accountFetchUi: Record<string, AccountFetchUiState>;

  setProgress: (analysisId: string, evt: AnalysisProgressEvent) => void;
  clearProgress: (analysisId: string) => void;
  setBudget: (analysisId: string, budget: AnalysisBudget) => void;
  setActiveAnalysisForProject: (projectId: string, analysisId: string) => void;
  updatePipeline: (analysisId: string, evt: AnalysisProgressEvent) => void;
  setModelDownload: (modelKey: string, dl: ModelDownloadProgress | null) => void;
  setWhisperDownload: (modelKey: string, dl: ModelDownloadProgress | null) => void;
  setAccountFetchUi: (accountId: string, state: AccountFetchUiState | null) => void;
  clearForAnalysisIds: (ids: Set<string>) => void;
}

export const useProgressStore = create<ProgressState>((set) => ({
  progressByAnalysis: {},
  pipelineByAnalysis: {},
  budgetByAnalysis: {},
  activeAnalysisForProject: {},
  modelDownloads: {},
  whisperDownloads: {},
  accountFetchUi: {},

  setProgress: (analysisId, evt) => set((s) => ({
    progressByAnalysis: { ...s.progressByAnalysis, [analysisId]: evt },
  })),

  clearProgress: (analysisId) => set((s) => {
    const next = { ...s.progressByAnalysis };
    delete next[analysisId];
    return { progressByAnalysis: next };
  }),

  setBudget: (analysisId, budget) => set((s) => ({
    budgetByAnalysis: { ...s.budgetByAnalysis, [analysisId]: budget },
  })),

  setActiveAnalysisForProject: (projectId, analysisId) => set((s) => {
    if (s.activeAnalysisForProject[projectId] === analysisId) return s;
    return { activeAnalysisForProject: { ...s.activeAnalysisForProject, [projectId]: analysisId } };
  }),

  updatePipeline: (analysisId, evt) => set((s) => {
    if (evt.stageIndex == null) return s;
    const si = evt.stageIndex;
    const now = Date.now();
    const existing = s.pipelineByAnalysis[analysisId];
    const pipeline = existing || createEmptyPipeline(evt.projectId, analysisId);
    const stages: PipelineStage[] = pipeline.stages.map((st, i) => {
      if (i < si) {
        if (st.status === "done" || st.status === "failed") return st;
        return { ...st, status: "done" as const, completedAt: st.completedAt || now };
      }
      if (i === si) {
        const done = evt.progress >= 100;
        return {
          ...st,
          status: done ? "done" as const : "active" as const,
          detail: evt.message || st.detail,
          startedAt: st.startedAt || now,
          fromCache: evt.fromCache || st.fromCache,
          ...(done ? { completedAt: now } : {}),
        };
      }
      return st;
    });
    return { pipelineByAnalysis: { ...s.pipelineByAnalysis, [analysisId]: { ...pipeline, progress: evt.progress, stages } } };
  }),

  setModelDownload: (modelKey, dl) => set((s) => {
    if (!dl) {
      const next = { ...s.modelDownloads };
      delete next[modelKey];
      return { modelDownloads: next };
    }
    return { modelDownloads: { ...s.modelDownloads, [modelKey]: dl } };
  }),

  setWhisperDownload: (modelKey, dl) => set((s) => {
    if (!dl) {
      const next = { ...s.whisperDownloads };
      delete next[modelKey];
      return { whisperDownloads: next };
    }
    return { whisperDownloads: { ...s.whisperDownloads, [modelKey]: dl } };
  }),

  setAccountFetchUi: (accountId, state) => set((s) => {
    if (!state) {
      if (!(accountId in s.accountFetchUi)) return s;
      const next = { ...s.accountFetchUi };
      delete next[accountId];
      return { accountFetchUi: next };
    }
    return { accountFetchUi: { ...s.accountFetchUi, [accountId]: state } };
  }),

  clearForAnalysisIds: (ids) => set((s) => {
    const nextProg = { ...s.progressByAnalysis };
    const nextPipe = { ...s.pipelineByAnalysis };
    const nextBudget = { ...s.budgetByAnalysis };
    for (const id of ids) { delete nextProg[id]; delete nextPipe[id]; delete nextBudget[id]; }
    return { progressByAnalysis: nextProg, pipelineByAnalysis: nextPipe, budgetByAnalysis: nextBudget };
  }),
}));
