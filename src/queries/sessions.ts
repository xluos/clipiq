import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ipc } from "./ipc-client";
import type { StudioSession } from "../types";

export function useSessions() {
  return useQuery({
    queryKey: ["sessions"],
    queryFn: () => ipc.listSessions(),
    staleTime: 60_000,
  });
}

export function useUpsertSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (session: StudioSession) => ipc.upsertSession(session),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sessions"] }),
  });
}

export function useDeleteSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: string) => ipc.deleteSession(sessionId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sessions"] }),
  });
}
