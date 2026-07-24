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

      // 乐观把视频切到 analyzing,让进度屏立刻进入"分析中"视图(失败/取消/中断重试都走这里)。
      // 不切的话 status 仍是 failed/cancelled,ProgressScreen 头部会卡在终态、按钮显示"重试"。
      const patchVideoStatus = (status: string) => {
        const prev = (qc.getQueryData(["videos", {}]) as any[]) || [];
        qc.setQueryData(["videos", {}], prev.map((v) =>
          v.id === videoId ? { ...v, status, currentAnalysisId: undefined, updatedAt: new Date().toISOString() } : v));
      };
      patchVideoStatus("analyzing");

      if (window.videoAnalyzer?.analyzeVideo) {
        window.videoAnalyzer.analyzeVideo({ videoId, pipelineId, options: optionsOverride })
          .then((analysis) => {
            if (analysis?.id) {
              useSelectionStore.getState().setActiveAnalysisId(analysis.id);
              const result = (analysis as any).result;
              if (result?.nodes?.length) useAnalysisCacheStore.getState().setNodesForAnalysis(analysis.id, result.nodes);
              if (result?.report) useAnalysisCacheStore.getState().setReportForAnalysis(analysis.id, result.report);
            }
            qc.invalidateQueries({ queryKey: ["analyses"] });
            qc.invalidateQueries({ queryKey: ["videos"] });
          })
          .catch((err) => {
            const msg = String(err?.message || err);
            if (/已有.*在运行|already/i.test(msg)) return; // 重复触发,不回退状态
            console.warn("startAnalysis failed:", msg);
            patchVideoStatus("failed");
            qc.invalidateQueries({ queryKey: ["analyses"] });
            qc.invalidateQueries({ queryKey: ["videos"] });
          });
      }
    },
    [qc],
  );
}
