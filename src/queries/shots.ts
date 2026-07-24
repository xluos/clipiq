import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ipc } from "./ipc-client";
import type { Shot } from "../types";

export function useShots(videoId?: string) {
  return useQuery({
    queryKey: ["shots", videoId],
    queryFn: () => ipc.listShots(videoId),
    staleTime: 60_000,
  });
}

export function useSetShots() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ videoId, shots }: { videoId: string; shots: Shot[] }) =>
      ipc.setShotsForVideo(videoId, shots),
    onSuccess: (_data, { videoId }) => {
      qc.invalidateQueries({ queryKey: ["shots", videoId] });
      qc.invalidateQueries({ queryKey: ["shots", undefined] });
    },
  });
}
