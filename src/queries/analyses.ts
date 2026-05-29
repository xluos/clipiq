import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ipc } from "./ipc-client";

export function useAnalyses(videoId: string | null | undefined) {
  return useQuery({
    queryKey: ["analyses", videoId],
    queryFn: () => ipc.listAnalyses(videoId!),
    enabled: !!videoId,
  });
}

export function useAnalysis(analysisId: string | null | undefined) {
  return useQuery({
    queryKey: ["analysis", analysisId],
    queryFn: () => ipc.getAnalysis(analysisId!),
    enabled: !!analysisId,
  });
}

export function useDeleteAnalysis() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ analysisId, videoId }: { analysisId: string; videoId: string }) =>
      ipc.deleteAnalysis(analysisId),
    onSuccess: (_data, { videoId }) => {
      qc.invalidateQueries({ queryKey: ["analyses", videoId] });
      qc.invalidateQueries({ queryKey: ["videos"] });
    },
  });
}
