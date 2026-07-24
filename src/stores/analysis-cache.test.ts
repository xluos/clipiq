import { describe, it, expect, beforeEach, vi } from "vitest";
import { useAnalysisCacheStore } from "./analysis-cache";
import type { AnalysisNode, AnalysisReport } from "../types";

const node = (id: string): AnalysisNode => ({ id } as unknown as AnalysisNode);
const report = (): AnalysisReport => ({ summary: "s" } as unknown as AnalysisReport);

beforeEach(() => {
  useAnalysisCacheStore.setState({ nodesByAnalysis: {}, reportByAnalysis: {} });
  // 注入 mock IPC,验证写缓存会回落库
  (window as unknown as { videoAnalyzer?: unknown }).videoAnalyzer = {
    updateAnalysisResult: vi.fn(() => Promise.resolve({ ok: true as const })),
  };
});

describe("analysis-cache: setNodesForAnalysis", () => {
  it("写入 store 并触发回落库 updateAnalysisResult(nodes)", () => {
    const nodes = [node("n1"), node("n2")];
    useAnalysisCacheStore.getState().setNodesForAnalysis("a1", nodes);
    expect(useAnalysisCacheStore.getState().nodesByAnalysis.a1).toEqual(nodes);
    const api = (window as unknown as { videoAnalyzer: { updateAnalysisResult: ReturnType<typeof vi.fn> } }).videoAnalyzer;
    expect(api.updateAnalysisResult).toHaveBeenCalledWith("a1", { nodes });
  });
});

describe("analysis-cache: setReportForAnalysis", () => {
  it("写入 store 并触发回落库 updateAnalysisResult(report)", () => {
    const r = report();
    useAnalysisCacheStore.getState().setReportForAnalysis("a1", r);
    expect(useAnalysisCacheStore.getState().reportByAnalysis.a1).toEqual(r);
    const api = (window as unknown as { videoAnalyzer: { updateAnalysisResult: ReturnType<typeof vi.fn> } }).videoAnalyzer;
    expect(api.updateAnalysisResult).toHaveBeenCalledWith("a1", { report: r });
  });

  it("window.videoAnalyzer 不存在时不抛(浏览器预览 fallback)", () => {
    (window as unknown as { videoAnalyzer?: unknown }).videoAnalyzer = undefined;
    expect(() => useAnalysisCacheStore.getState().setReportForAnalysis("a2", report())).not.toThrow();
    expect(useAnalysisCacheStore.getState().reportByAnalysis.a2).toBeDefined();
  });
});

describe("analysis-cache: hydrateAnalysis 不回落库", () => {
  it("写入 nodes/report 到 store,但不触发 updateAnalysisResult(冷加载读取专用)", () => {
    const nodes = [node("n1")];
    const r = report();
    useAnalysisCacheStore.getState().hydrateAnalysis("a1", { nodes, report: r });
    const st = useAnalysisCacheStore.getState();
    expect(st.nodesByAnalysis.a1).toEqual(nodes);
    expect(st.reportByAnalysis.a1).toEqual(r);
    const api = (window as unknown as { videoAnalyzer: { updateAnalysisResult: ReturnType<typeof vi.fn> } }).videoAnalyzer;
    expect(api.updateAnalysisResult).not.toHaveBeenCalled();
  });

  it("只传 nodes 时不动 report", () => {
    useAnalysisCacheStore.setState({ reportByAnalysis: { a1: report() } });
    useAnalysisCacheStore.getState().hydrateAnalysis("a1", { nodes: [node("x")] });
    expect(useAnalysisCacheStore.getState().reportByAnalysis.a1).toBeDefined();
  });
});

describe("analysis-cache: 批量清理", () => {
  it("clearForAnalysisIds 清掉指定 id 的 nodes + report", () => {
    const s = useAnalysisCacheStore.getState();
    s.setNodesForAnalysis("a1", [node("n1")]);
    s.setReportForAnalysis("a1", report());
    s.setNodesForAnalysis("a2", [node("n2")]);
    s.clearForAnalysisIds(new Set(["a1"]));
    const st = useAnalysisCacheStore.getState();
    expect(st.nodesByAnalysis.a1).toBeUndefined();
    expect(st.reportByAnalysis.a1).toBeUndefined();
    expect(st.nodesByAnalysis.a2).toBeDefined();
  });

  it("clearForVideo 按 analysisIds 清", () => {
    const s = useAnalysisCacheStore.getState();
    s.setNodesForAnalysis("a1", [node("n1")]);
    s.clearForVideo("v1", ["a1"]);
    expect(useAnalysisCacheStore.getState().nodesByAnalysis.a1).toBeUndefined();
  });
});
