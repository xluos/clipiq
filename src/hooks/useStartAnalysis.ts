import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigationStore } from "../stores/navigation";
import { useSelectionStore } from "../stores/selection";
import { useAnalysisCacheStore } from "../stores/analysis-cache";
import type { AnalysisOptions } from "../types";

export function useStartAnalysis() {
  const qc = useQueryClient();

  return useCallback(
    (videoId: string, pipelineId: string = "builtin-pipeline", optionsOverride?: AnalysisOptions) => {
      useSelectionStore.getState().setActiveVideoId(videoId);
      useSelectionStore.getState().setActiveAnalysisId(null);
      useNavigationStore.getState().setLocation({ module: "analysis", screen: "progress" });

      if (window.videoAnalyzer?.analyzeVideo) {
        window.videoAnalyzer.analyzeVideo({ videoId, pipelineId, options: optionsOverride })
          .then((analysis) => {
            if (analysis?.id) {
              useSelectionStore.getState().setActiveAnalysisId(analysis.id);
              const result = (analysis as any).result;
              if (result?.nodes?.length) useAnalysisCacheStore.getState().setNodesForAnalysis(analysis.id, result.nodes);
              if (result?.report) useAnalysisCacheStore.getState().setReportForAnalysis(analysis.id, result.report);
            }
            qc.invalidateQueries({ queryKey: ["analyses", videoId] });
          })
          .catch((err) => {
            const msg = String(err?.message || err);
            if (!/已有.*在运行|already/i.test(msg)) console.warn("startAnalysis failed:", msg);
            qc.invalidateQueries({ queryKey: ["analyses", videoId] });
          });
      }
    },
    [qc],
  );
}
