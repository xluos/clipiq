import type { QueryClient } from "@tanstack/react-query";
import { useProgressStore } from "./progress";
import type { ModelDownloadProgress } from "./progress";

type Unsub = (() => void) | undefined;

export function initIpcSubscriptions(queryClient: QueryClient): () => void {
  const api = window.videoAnalyzer;
  if (!api) return () => {};
  const unsubs: Unsub[] = [];

  // task:progress → progressStore + invalidate analyses on complete/fail
  if (api.onTaskProgress) {
    unsubs.push(api.onTaskProgress((evt: any) => {
      if (!evt.analysisId) return;
      const isComplete = evt.progress >= 100 || evt.stage === "完成";
      const isFailed = evt.stage === "失败";
      if (isComplete || isFailed) {
        useProgressStore.getState().clearProgress(evt.analysisId);
        if (evt.videoId) {
          queryClient.invalidateQueries({ queryKey: ["analyses", evt.videoId] });
          queryClient.invalidateQueries({ queryKey: ["videos"] });
        }
      } else {
        useProgressStore.getState().setProgress(evt.analysisId, evt);
      }
    }));
  }

  // analysis:progress → progressStore (pipeline stages)
  if (api.onAnalysisProgress) {
    const refreshedKeys = new Set<string>();
    unsubs.push(api.onAnalysisProgress((evt) => {
      const { setProgress, setActiveAnalysisForProject, updatePipeline } = useProgressStore.getState();
      setProgress(evt.analysisId, evt);
      setActiveAnalysisForProject(evt.projectId, evt.analysisId);
      if (!refreshedKeys.has(evt.analysisId)) {
        refreshedKeys.add(evt.analysisId);
        queryClient.invalidateQueries({ queryKey: ["analyses", evt.projectId] });
      }
      updatePipeline(evt.analysisId, evt);
    }));
  }

  // analysis:budget → progressStore
  if (api.onAnalysisBudget) {
    unsubs.push(api.onAnalysisBudget((evt) => {
      const { setBudget, setActiveAnalysisForProject } = useProgressStore.getState();
      setBudget(evt.analysisId, evt.budget);
      setActiveAnalysisForProject(evt.projectId, evt.analysisId);
    }));
  }

  // account fetch events
  if (api.onAccountFetchProgress) {
    unsubs.push(api.onAccountFetchProgress((evt) => {
      useProgressStore.getState().setAccountFetchUi(evt.accountId, {
        stage: evt.stage, progress: evt.progress, message: evt.message,
      });
    }));
  }
  if (api.onAccountFetchDone) {
    unsubs.push(api.onAccountFetchDone((_evt) => {
      const accountId = _evt.accountId;
      useProgressStore.getState().setAccountFetchUi(accountId, null);
      queryClient.invalidateQueries({ queryKey: ["accounts"] });
      queryClient.invalidateQueries({ queryKey: ["videos"] });
    }));
  }
  if (api.onAccountFetchFailed) {
    unsubs.push(api.onAccountFetchFailed((evt) => {
      useProgressStore.getState().setAccountFetchUi(evt.accountId, null);
      queryClient.invalidateQueries({ queryKey: ["accounts"] });
    }));
  }

  // llama model download progress
  if (api.llama?.onProgress) {
    unsubs.push(api.llama.onProgress((evt: any) => {
      if (evt.scope !== "model" || !evt.modelKey) return;
      if (evt.stage === "done" || evt.stage === "cancelled") {
        useProgressStore.getState().setModelDownload(evt.modelKey, null);
        return;
      }
      const existing = useProgressStore.getState().modelDownloads[evt.modelKey];
      const isStart = evt.stage === "start";
      const dl: ModelDownloadProgress = {
        modelKey: evt.modelKey,
        label: isStart ? (evt.label || evt.modelKey) : (existing?.label || evt.label || evt.modelKey),
        stage: evt.stage || "download",
        percent: evt.percent ?? 0,
        receivedBytes: evt.receivedBytes ?? 0,
        totalBytes: evt.totalBytes ?? 0,
        speed: evt.speed ?? 0,
      };
      useProgressStore.getState().setModelDownload(evt.modelKey, dl);
    }));
  }

  // whisper model download progress
  if (api.whisperCpp?.onProgress) {
    unsubs.push(api.whisperCpp.onProgress((evt: any) => {
      if (evt.scope !== "model" || !evt.modelKey) return;
      if (evt.stage === "done" || evt.stage === "cancelled" || evt.stage === "skip") {
        useProgressStore.getState().setWhisperDownload(evt.modelKey, null);
        return;
      }
      useProgressStore.getState().setWhisperDownload(evt.modelKey, {
        modelKey: evt.modelKey,
        label: evt.label || evt.modelKey,
        stage: evt.stage || "download",
        percent: evt.percent ?? 0,
        receivedBytes: evt.receivedBytes ?? 0,
        totalBytes: evt.totalBytes ?? 0,
        speed: 0,
      });
    }));
  }

  // download complete → invalidate videos
  if (api.onDownloadComplete) {
    unsubs.push(api.onDownloadComplete((_evt) => {
      queryClient.invalidateQueries({ queryKey: ["videos"] });
    }));
  }

  // video summary status → invalidate analyses
  if (api.onVideoSummaryStatus) {
    unsubs.push(api.onVideoSummaryStatus((evt) => {
      if (evt.videoId && (evt.status === "done" || evt.status === "failed")) {
        queryClient.invalidateQueries({ queryKey: ["analyses", evt.videoId] });
      }
    }));
  }

  return () => { for (const fn of unsubs) fn?.(); };
}
