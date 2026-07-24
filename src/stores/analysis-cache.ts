import { create } from "zustand";
import type { AnalysisNode, AnalysisReport } from "../types";

interface AnalysisCacheState {
  nodesByAnalysis: Record<string, AnalysisNode[]>;
  reportByAnalysis: Record<string, AnalysisReport>;
  setNodesForAnalysis: (analysisId: string, nodes: AnalysisNode[]) => void;
  setReportForAnalysis: (analysisId: string, report: AnalysisReport) => void;
  /** 从 DB 读出后回灌缓存,不触发回落库(冷加载读取专用,避免读→写自我覆盖)。 */
  hydrateAnalysis: (analysisId: string, data: { nodes?: AnalysisNode[]; report?: AnalysisReport }) => void;
  clearForAnalysisIds: (ids: Set<string>) => void;
  clearForVideo: (videoId: string, analysisIds: string[]) => void;
}

export const useAnalysisCacheStore = create<AnalysisCacheState>((set) => ({
  nodesByAnalysis: {},
  reportByAnalysis: {},

  setNodesForAnalysis: (analysisId, nodes) => {
    set((s) => ({ nodesByAnalysis: { ...s.nodesByAnalysis, [analysisId]: nodes } }));
    window.videoAnalyzer?.updateAnalysisResult(analysisId, { nodes }).catch((err: unknown) =>
      console.warn("updateAnalysisResult(nodes) failed", err),
    );
  },

  setReportForAnalysis: (analysisId, report) => {
    set((s) => ({ reportByAnalysis: { ...s.reportByAnalysis, [analysisId]: report } }));
    window.videoAnalyzer?.updateAnalysisResult(analysisId, { report }).catch((err: unknown) =>
      console.warn("updateAnalysisResult failed", err),
    );
  },

  hydrateAnalysis: (analysisId, { nodes, report }) => set((s) => ({
    nodesByAnalysis: nodes ? { ...s.nodesByAnalysis, [analysisId]: nodes } : s.nodesByAnalysis,
    reportByAnalysis: report ? { ...s.reportByAnalysis, [analysisId]: report } : s.reportByAnalysis,
  })),

  clearForAnalysisIds: (ids) => set((s) => {
    const nextNodes = { ...s.nodesByAnalysis };
    const nextReports = { ...s.reportByAnalysis };
    for (const id of ids) { delete nextNodes[id]; delete nextReports[id]; }
    return { nodesByAnalysis: nextNodes, reportByAnalysis: nextReports };
  }),

  clearForVideo: (_videoId, analysisIds) => set((s) => {
    const nextNodes = { ...s.nodesByAnalysis };
    const nextReports = { ...s.reportByAnalysis };
    for (const id of analysisIds) { delete nextNodes[id]; delete nextReports[id]; }
    return { nodesByAnalysis: nextNodes, reportByAnalysis: nextReports };
  }),
}));
