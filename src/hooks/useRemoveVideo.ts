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

      // 从全量 analyses cache(["analyses"])里挑出该视频的记录,清掉对应的 nodes/进度缓存。
      const allAnalyses: Analysis[] = qc.getQueryData(["analyses"]) || [];
      const aidsToClear = new Set(allAnalyses.filter((a) => a.videoId === videoId).map((a) => a.id));
      if (aidsToClear.size > 0) {
        useAnalysisCacheStore.getState().clearForAnalysisIds(aidsToClear);
        useProgressStore.getState().clearForAnalysisIds(aidsToClear);
      }

      await ipc.deleteVideo(videoId);
      qc.invalidateQueries({ queryKey: ["videos"] });
      qc.invalidateQueries({ queryKey: ["analyses"] });
    },
    [qc],
  );
}
