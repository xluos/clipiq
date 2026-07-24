import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ipc } from "./ipc-client";
import type { Collection } from "../types";

export function useCollections() {
  return useQuery({
    queryKey: ["collections"],
    queryFn: () => ipc.listCollections(),
    staleTime: 60_000,
  });
}

export function useUpsertCollection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (collection: Collection) => ipc.upsertCollection(collection),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["collections"] }),
  });
}

export function useDeleteCollection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (collectionId: string) => ipc.deleteCollection(collectionId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["collections"] });
      qc.invalidateQueries({ queryKey: ["videos"] });
    },
  });
}

export function useAddVideoToCollection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ collectionId, videoId }: { collectionId: string; videoId: string }) =>
      ipc.addVideoToCollection(collectionId, videoId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["videos"] }),
  });
}

export function useRemoveVideoFromCollection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ collectionId, videoId }: { collectionId: string; videoId: string }) =>
      ipc.removeVideoFromCollection(collectionId, videoId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["videos"] }),
  });
}
