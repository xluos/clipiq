import { describe, it, expect, beforeEach, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { initIpcSubscriptions } from "./subscriptions";
import { useProgressStore } from "./progress";

// 把每个 onXxx 注册器做成"捕获 callback"的形式,测试里手动触发事件
function makeFakeApi() {
  const handlers: Record<string, (evt: unknown) => void> = {};
  const reg = (name: string) => (cb: (evt: unknown) => void) => {
    handlers[name] = cb;
    return () => { delete handlers[name]; };
  };
  const api = {
    onTaskProgress: reg("task"),
    onAnalysisProgress: reg("analysis"),
    onAnalysisBudget: reg("budget"),
    onAccountFetchProgress: reg("afp"),
    onAccountFetchDone: reg("afd"),
    onAccountFetchFailed: reg("aff"),
    onDownloadComplete: reg("dl"),
    onVideoSummaryStatus: reg("vss"),
    llama: { onProgress: reg("llama") },
    whisperCpp: { onProgress: reg("whisper") },
    upsertVideo: vi.fn(() => Promise.resolve({ ok: true as const })),
    analyzeVideo: vi.fn(() => Promise.resolve({ id: "a-new" })),
  };
  return { api, fire: (name: string, evt: unknown) => handlers[name]?.(evt) };
}

let qc: QueryClient;
let fake: ReturnType<typeof makeFakeApi>;
let cleanup: () => void;

beforeEach(() => {
  useProgressStore.setState({
    progressByAnalysis: {}, pipelineByAnalysis: {}, budgetByAnalysis: {},
    activeAnalysisForProject: {}, modelDownloads: {}, whisperDownloads: {}, accountFetchUi: {},
  });
  qc = new QueryClient();
  fake = makeFakeApi();
  (window as unknown as { videoAnalyzer: unknown }).videoAnalyzer = fake.api;
  cleanup = initIpcSubscriptions(qc);
});

describe("subscriptions: task:progress", () => {
  it("进行中事件写进度", () => {
    fake.fire("task", { analysisId: "a1", videoId: "v1", progress: 40, stage: "分析" });
    expect(useProgressStore.getState().progressByAnalysis.a1.progress).toBe(40);
  });

  it("完成事件清进度 + invalidate analyses/videos", () => {
    const spy = vi.spyOn(qc, "invalidateQueries");
    useProgressStore.getState().setProgress("a1", { projectId: "v1", analysisId: "a1", progress: 90, stage: "分析" });
    fake.fire("task", { analysisId: "a1", videoId: "v1", progress: 100, stage: "完成" });
    expect(useProgressStore.getState().progressByAnalysis.a1).toBeUndefined();
    expect(spy).toHaveBeenCalledWith({ queryKey: ["analyses"] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["videos"] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["shots"] });
  });

  it("无 analysisId 的事件被忽略", () => {
    fake.fire("task", { progress: 50, stage: "x" });
    expect(Object.keys(useProgressStore.getState().progressByAnalysis)).toHaveLength(0);
  });
});

describe("subscriptions: analysis:progress 终态", () => {
  it("终态 stage 触发 invalidate 并更新 pipeline", () => {
    const spy = vi.spyOn(qc, "invalidateQueries");
    fake.fire("analysis", { analysisId: "a1", projectId: "v1", progress: 100, stage: "完成", stageIndex: 9 });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["analyses"] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["shots"] });
    expect(useProgressStore.getState().pipelineByAnalysis.a1.stages[9].status).toBe("done");
  });
});

describe("subscriptions: download:complete 自动发起分析(易漏链路)", () => {
  it("下载成功 → 视频切 analyzing + upsertVideo + analyzeVideo", () => {
    qc.setQueryData(["videos", {}], [{ id: "v1", title: "旧", status: "downloading" }]);
    fake.fire("dl", {
      videoId: "v1",
      success: true,
      video: { title: "新标题", filename: "f.mp4", filePath: "/x/f.mp4", mediaUrl: "media://f", durationSec: 10, width: 1, height: 2, orientation: "portrait" },
    });
    const videos = qc.getQueryData(["videos", {}]) as Array<{ id: string; status: string }>;
    expect(videos[0].status).toBe("analyzing");
    expect(fake.api.upsertVideo).toHaveBeenCalled();
    expect(fake.api.analyzeVideo).toHaveBeenCalledWith({ videoId: "v1", pipelineId: "builtin-pipeline" });
  });

  it("下载失败 → 视频切 download_failed,不发起分析", () => {
    qc.setQueryData(["videos", {}], [{ id: "v1", title: "旧", status: "downloading" }]);
    fake.fire("dl", { videoId: "v1", success: false, error: "boom" });
    const videos = qc.getQueryData(["videos", {}]) as Array<{ id: string; status: string }>;
    expect(videos[0].status).toBe("download_failed");
    expect(fake.api.analyzeVideo).not.toHaveBeenCalled();
  });

  it("下载取消 → 视频切 cancelled", () => {
    qc.setQueryData(["videos", {}], [{ id: "v1", status: "downloading" }]);
    fake.fire("dl", { videoId: "v1", success: false, cancelled: true, error: "用户取消" });
    const videos = qc.getQueryData(["videos", {}]) as Array<{ id: string; status: string }>;
    expect(videos[0].status).toBe("cancelled");
  });
});

describe("subscriptions: 模型下载进度", () => {
  it("llama done 事件清除该 model 的下载态", () => {
    useProgressStore.getState().setModelDownload("m1", { modelKey: "m1", label: "M", stage: "download", percent: 50, receivedBytes: 0, totalBytes: 0, speed: 0 });
    fake.fire("llama", { scope: "model", modelKey: "m1", stage: "done" });
    expect(useProgressStore.getState().modelDownloads.m1).toBeUndefined();
  });

  it("非 model scope 的 llama 事件被忽略", () => {
    fake.fire("llama", { scope: "binary", stage: "progress", percent: 10 });
    expect(Object.keys(useProgressStore.getState().modelDownloads)).toHaveLength(0);
  });
});

describe("subscriptions: cleanup 解绑", () => {
  it("cleanup 后再 fire 不再写 store", () => {
    cleanup();
    fake.fire("task", { analysisId: "a1", videoId: "v1", progress: 40, stage: "分析" });
    expect(useProgressStore.getState().progressByAnalysis.a1).toBeUndefined();
  });
});
