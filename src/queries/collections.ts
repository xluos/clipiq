import { useQuery } from "@tanstack/react-query";
import { ipc } from "./ipc-client";

export function useCollections() {
  return useQuery({
    queryKey: ["collections"],
    queryFn: () => ipc.listCollections(),
    staleTime: 60_000,
  });
}
