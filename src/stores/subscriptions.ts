import type { QueryClient } from "@tanstack/react-query";
import { useProgressStore } from "./progress";
import type { ModelDownloadProgress } from "./progress";
import { useTaskQueueStore } from "./tasks";

type Unsub = (() => void) | undefined;

export function initIpcSubscriptions(queryClient: QueryClient): () => void {
  const api = window.videoAnalyzer;
  if (!api) return () => {};
  const unsubs: Unsub[] = [];

  // 通用后台任务队列:启动拉一次全量,之后增量订阅(单一数据源,与页面挂载无关)。
  if (api.listQueueTasks) {
    api.listQueueTasks().then((tasks) => useTaskQueueStore.getState().replaceAll(tasks)).catch(() => {});
  }
  if (api.onQueueTaskUpdate) {
    unsubs.push(api.onQueueTaskUpdate((task) => useTaskQueueStore.getState().upsert(task)));
  }
  if (api.onQueueTaskRemoved) {
    unsubs.push(api.onQueueTaskRemoved(({ id }) => useTaskQueueStore.getState().remove(id)));
  }

  // useApp 用 useQuery 订阅了 ["analyses"] / ["videos", {}],invalidate 会真正 refetch + 自动重渲染。
  const invalidateAnalyses = () => queryClient.invalidateQueries({ queryKey: ["analyses"] });
  const invalidateVideos = () => queryClient.invalidateQueries({ queryKey: ["videos"] });
  const invalidateShots = () => queryClient.invalidateQueries({ queryKey: ["shots"] });
  // 每个 analysisId 首次出现时刷一次 analyses,让新建的 analyzing 行进入列表(任务队列/进度页才看得到)。
  const seenAnalysisIds = new Set<string>();
  const refreshOnceFor = (analysisId?: string) => {
    if (!analysisId || seenAnalysisIds.has(analysisId)) return;
    seenAnalysisIds.add(analysisId);
    invalidateAnalyses();
  };

  // task:progress → progressStore；首次刷 analyses,完成/失败刷 analyses+videos
  if (api.onTaskProgress) {
    unsubs.push(api.onTaskProgress((evt: any) => {
      if (!evt.analysisId) return;
      const isComplete = evt.progress >= 100 || evt.stage === "完成";
      const isFailed = evt.stage === "失败";
      if (isComplete || isFailed) {
        useProgressStore.getState().clearProgress(evt.analysisId);
        invalidateAnalyses();
        invalidateVideos();
        invalidateShots();
      } else {
        useProgressStore.getState().setProgress(evt.analysisId, evt);
        refreshOnceFor(evt.analysisId);
      }
    }));
  }

  // analysis:progress → progressStore (pipeline stages)
  if (api.onAnalysisProgress) {
    unsubs.push(api.onAnalysisProgress((evt) => {
      const { setProgress, setActiveAnalysisForProject, updatePipeline } = useProgressStore.getState();
      setProgress(evt.analysisId, evt);
      setActiveAnalysisForProject(evt.projectId, evt.analysisId);
      const stage = (evt as { stage?: string }).stage;
      if (stage === "完成" || stage === "失败" || stage === "已结束") {
        // 终态:刷新 analyses + videos,让列表/任务队列从"进行中"挪走。
        invalidateAnalyses();
        invalidateVideos();
        invalidateShots();
      } else {
        refreshOnceFor(evt.analysisId);
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

  // download complete → 回填真实元数据 + 切状态 + 起分析(成功) / 标记失败 / 取消
  if (api.onDownloadComplete) {
    unsubs.push(api.onDownloadComplete((evt) => {
      const videoId = (evt as { videoId: string }).videoId;
      const now = new Date().toISOString();
      const prev = (queryClient.getQueryData(["videos", {}]) as any[]) || [];
      let started: any = null;
      const next = prev.map((p) => {
        if (p.id !== videoId) return p;
        if (evt.success) {
          const v = evt.video;
          started = {
            ...p,
            title: v.title || p.title || v.filename,
            videoName: v.title || v.filename || p.videoName,
            titleAutoGenerated: !!v.title,
            sourceType: "url" as const,
            localPath: v.filePath,
            localVideoPath: v.mediaUrl,
            localFilePath: v.filePath,
            thumbnailUrl: v.thumbnailUrl || p.thumbnailUrl,
            durationSec: v.durationSec,
            width: v.width,
            height: v.height,
            orientation: v.orientation,
            status: "analyzing" as const,
            updatedAt: now,
          };
          return started;
        }
        const failEvt = evt as { cancelled?: boolean };
        return { ...p, status: failEvt.cancelled ? "cancelled" as const : "download_failed" as const, updatedAt: now };
      });
      queryClient.setQueryData(["videos", {}], next);

      if (evt.success && started) {
        // 先落库(带 localPath)再起分析:analysis:start 按 videoId 从 DB 读视频行。
        api.upsertVideo?.(started).catch(() => {});
        api.analyzeVideo?.({ videoId, pipelineId: "builtin-pipeline" })
          .then(() => {
            queryClient.invalidateQueries({ queryKey: ["analyses"] });
            queryClient.invalidateQueries({ queryKey: ["videos"] });
          })
          .catch(() => {
            queryClient.invalidateQueries({ queryKey: ["analyses"] });
          });
      } else {
        const target = next.find((p) => p.id === videoId);
        if (target) api.upsertVideo?.(target).catch(() => {});
      }
    }));
  }

  // video summary status → invalidate analyses
  if (api.onVideoSummaryStatus) {
    unsubs.push(api.onVideoSummaryStatus((evt) => {
      if (evt.videoId && (evt.status === "done" || evt.status === "failed")) {
        queryClient.invalidateQueries({ queryKey: ["analyses"] });
      }
    }));
  }

  return () => { for (const fn of unsubs) fn?.(); };
}
