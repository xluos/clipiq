import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useStartAnalysis } from "./useStartAnalysis";
import { useSelectionStore } from "../stores/selection";
import { useNavigationStore } from "../stores/navigation";

let qc: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function setAnalyzeVideo(impl: (payload: unknown) => Promise<unknown>) {
  (window as unknown as { videoAnalyzer: unknown }).videoAnalyzer = { analyzeVideo: vi.fn(impl) };
  return (window as unknown as { videoAnalyzer: { analyzeVideo: ReturnType<typeof vi.fn> } }).videoAnalyzer.analyzeVideo;
}

beforeEach(() => {
  qc = new QueryClient();
  qc.setQueryData(["videos", {}], [{ id: "v1", status: "idle" }]);
  useSelectionStore.setState({ activeVideoId: null, activeAnalysisId: null });
});

describe("useStartAnalysis: 乐观更新", () => {
  it("立即把视频切 analyzing 并跳到 progress 屏", () => {
    setAnalyzeVideo(() => new Promise(() => {})); // 永不 resolve,只测乐观部分
    const { result } = renderHook(() => useStartAnalysis(), { wrapper });
    act(() => result.current("v1"));
    const videos = qc.getQueryData(["videos", {}]) as Array<{ id: string; status: string }>;
    expect(videos[0].status).toBe("analyzing");
    expect(useSelectionStore.getState().activeVideoId).toBe("v1");
    expect(useNavigationStore.getState().currentLocation).toEqual({ module: "analysis", screen: "progress" });
  });
});

describe("useStartAnalysis: 成功", () => {
  it("resolve 后写 activeAnalysisId 并 invalidate", async () => {
    const spy = vi.spyOn(qc, "invalidateQueries");
    setAnalyzeVideo(() => Promise.resolve({ id: "a-new", result: { nodes: [], report: null } }));
    const { result } = renderHook(() => useStartAnalysis(), { wrapper });
    await act(async () => { result.current("v1"); });
    await waitFor(() => expect(useSelectionStore.getState().activeAnalysisId).toBe("a-new"));
    expect(spy).toHaveBeenCalledWith({ queryKey: ["analyses"] });
  });
});

describe("useStartAnalysis: 失败回退", () => {
  it("普通失败把状态回退成 failed", async () => {
    setAnalyzeVideo(() => Promise.reject(new Error("模型挂了")));
    const { result } = renderHook(() => useStartAnalysis(), { wrapper });
    await act(async () => { result.current("v1"); });
    await waitFor(() => {
      const videos = qc.getQueryData(["videos", {}]) as Array<{ id: string; status: string }>;
      expect(videos[0].status).toBe("failed");
    });
  });

  it("重复触发(已有在运行)不回退状态", async () => {
    setAnalyzeVideo(() => Promise.reject(new Error("已有分析在运行")));
    const { result } = renderHook(() => useStartAnalysis(), { wrapper });
    await act(async () => { result.current("v1"); });
    // 给 catch 一点时间跑
    await new Promise((r) => setTimeout(r, 10));
    const videos = qc.getQueryData(["videos", {}]) as Array<{ id: string; status: string }>;
    expect(videos[0].status).toBe("analyzing"); // 保持乐观态,不回退
  });
});
