import { useQuery } from "@tanstack/react-query";
import { ipc } from "./ipc-client";

export function usePipelines() {
  return useQuery({
    queryKey: ["pipelines"],
    queryFn: () => ipc.listPipelines(),
    staleTime: 60_000,
  });
}
