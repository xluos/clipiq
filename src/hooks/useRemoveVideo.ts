import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSelectionStore } from "../stores/selection";
import { useAnalysisCacheStore } from "../stores/analysis-cache";
import { useProgressStore } from "../stores/progress";
import { ipc } from "../queries/ipc-client";
import type { Analysis } from "../types";

export function useRemoveVideo() {
  const qc = useQueryClient();

  return useCallback(
    async (videoId: string) => {
      const { activeVideoId, setActiveVideoId } = useSelectionStore.getState();
      if (activeVideoId === videoId) setActiveVideoId(null);

      const analyses: Analysis[] = qc.getQueryData(["analyses", videoId]) || [];
      const aidsToClear = new Set(analyses.map((a) => a.id));
      if (aidsToClear.size > 0) {
        useAnalysisCacheStore.getState().clearForAnalysisIds(aidsToClear);
        useProgressStore.getState().clearForAnalysisIds(aidsToClear);
      }

      await ipc.deleteVideo(videoId);
      qc.invalidateQueries({ queryKey: ["videos"] });
      qc.removeQueries({ queryKey: ["analyses", videoId] });
    },
    [qc],
  );
}
