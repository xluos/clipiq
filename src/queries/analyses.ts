import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ipc } from "./ipc-client";

export function useAnalyses(videoId: string | null | undefined) {
  return useQuery({
    queryKey: ["analyses", videoId],
    queryFn: () => ipc.listAnalyses(videoId!),
    enabled: !!videoId,
  });
}

// 单 query 订阅全部分析(列表/状态派生用)。result 列不在此返回,详情走 useAnalysis/getAnalysis。
// 有了这个 active observer,invalidateQueries(["analyses"]) 才会真正 refetch。
export function useAllAnalyses() {
  return useQuery({
    queryKey: ["analyses"],
    queryFn: () => ipc.listAllAnalyses(),
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
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["analyses"] });
      qc.invalidateQueries({ queryKey: ["videos"] });
    },
  });
}
