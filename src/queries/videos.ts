import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ipc } from "./ipc-client";
import type { Video } from "../types";

type VideoFilter = {
  accountId?: string;
  collectionId?: string;
  platform?: string;
  status?: string;
  /** 既不属于任何账号、也不在任何收藏夹的散视频。 */
  unassigned?: boolean;
};

export function useVideos(filter?: VideoFilter) {
  return useQuery({
    queryKey: ["videos", filter ?? {}],
    queryFn: () => ipc.listVideos(filter),
  });
}

export function useDeleteVideo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (videoId: string) => ipc.deleteVideo(videoId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["videos"] });
      qc.invalidateQueries({ queryKey: ["analyses"] });
    },
  });
}

export function useUpsertVideo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (video: Video) => ipc.upsertVideo(video),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["videos"] }),
  });
}
