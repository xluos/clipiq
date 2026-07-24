import { describe, it, expect, beforeEach } from "vitest";
import { useProgressStore } from "./progress";
import type { AnalysisProgressEvent } from "../types";

const evt = (p: Partial<AnalysisProgressEvent>): AnalysisProgressEvent =>
  ({ projectId: "v1", analysisId: "a1", progress: 0, stage: "", ...p }) as AnalysisProgressEvent;

beforeEach(() => {
  useProgressStore.setState({
    progressByAnalysis: {},
    pipelineByAnalysis: {},
    budgetByAnalysis: {},
    activeAnalysisForProject: {},
    modelDownloads: {},
    whisperDownloads: {},
    accountFetchUi: {},
  });
});

describe("progress store: setProgress / clearProgress", () => {
  it("setProgress 写入,clearProgress 删除", () => {
    const s = useProgressStore.getState();
    s.setProgress("a1", evt({ progress: 50, stage: "分析" }));
    expect(useProgressStore.getState().progressByAnalysis.a1.progress).toBe(50);
    s.clearProgress("a1");
    expect(useProgressStore.getState().progressByAnalysis.a1).toBeUndefined();
  });
});

describe("progress store: setActiveAnalysisForProject 幂等", () => {
  it("相同值不产生新引用(避免无谓重渲染)", () => {
    const s = useProgressStore.getState();
    s.setActiveAnalysisForProject("v1", "a1");
    const ref1 = useProgressStore.getState().activeAnalysisForProject;
    s.setActiveAnalysisForProject("v1", "a1");
    const ref2 = useProgressStore.getState().activeAnalysisForProject;
    expect(ref2).toBe(ref1); // 同引用
    s.setActiveAnalysisForProject("v1", "a2");
    expect(useProgressStore.getState().activeAnalysisForProject).not.toBe(ref1);
    expect(useProgressStore.getState().activeAnalysisForProject.v1).toBe("a2");
  });
});

describe("progress store: updatePipeline 阶段推进", () => {
  it("stageIndex 为空时不动 pipeline", () => {
    useProgressStore.getState().updatePipeline("a1", evt({ progress: 10 }));
    expect(useProgressStore.getState().pipelineByAnalysis.a1).toBeUndefined();
  });

  it("推进到第 2 阶段:前面阶段标 done,当前阶段 active", () => {
    useProgressStore.getState().updatePipeline("a1", evt({ stageIndex: 2, progress: 40 }));
    const pipe = useProgressStore.getState().pipelineByAnalysis.a1;
    expect(pipe.stages[0].status).toBe("done");
    expect(pipe.stages[1].status).toBe("done");
    expect(pipe.stages[2].status).toBe("active");
    expect(pipe.stages[3].status).toBe("pending");
    expect(pipe.progress).toBe(40);
  });

  it("当前阶段 progress>=100 标 done", () => {
    useProgressStore.getState().updatePipeline("a1", evt({ stageIndex: 1, progress: 100 }));
    const pipe = useProgressStore.getState().pipelineByAnalysis.a1;
    expect(pipe.stages[1].status).toBe("done");
  });

  it("已 failed 的前置阶段不会被回写成 done", () => {
    // 先让 stage0 失败
    useProgressStore.setState((s) => ({
      pipelineByAnalysis: {
        a1: {
          projectId: "v1", analysisId: "a1", progress: 0,
          stages: s.pipelineByAnalysis.a1?.stages
            ? s.pipelineByAnalysis.a1.stages
            : [{ key: "download", label: "下载视频", status: "failed" as const },
               ...Array.from({ length: 9 }, (_, i) => ({ key: `k${i}`, label: `l${i}`, status: "pending" as const }))],
        },
      },
    }));
    useProgressStore.getState().updatePipeline("a1", evt({ stageIndex: 3, progress: 10 }));
    expect(useProgressStore.getState().pipelineByAnalysis.a1.stages[0].status).toBe("failed");
  });
});

describe("progress store: seedFromSnapshot 不覆盖 live 数据", () => {
  it("已有 progress 时,seed 不覆盖", () => {
    useProgressStore.getState().setProgress("a1", evt({ progress: 77 }));
    useProgressStore.getState().seedFromSnapshot({ analysisId: "a1", projectId: "v1", progress: 10, stageIndex: 1 });
    expect(useProgressStore.getState().progressByAnalysis.a1.progress).toBe(77);
  });

  it("无 live 数据时按快照重建 pipeline", () => {
    useProgressStore.getState().seedFromSnapshot({ analysisId: "a2", projectId: "v2", progress: 50, stageIndex: 3 });
    const pipe = useProgressStore.getState().pipelineByAnalysis.a2;
    expect(pipe.stages[0].status).toBe("done");
    expect(pipe.stages[3].status).toBe("active");
    expect(useProgressStore.getState().activeAnalysisForProject.v2).toBe("a2");
  });
});

describe("progress store: 下载进度增删", () => {
  it("setModelDownload 写入,传 null 删除", () => {
    const dl = { modelKey: "m1", label: "M1", stage: "download", percent: 30, receivedBytes: 1, totalBytes: 10, speed: 5 };
    useProgressStore.getState().setModelDownload("m1", dl);
    expect(useProgressStore.getState().modelDownloads.m1.percent).toBe(30);
    useProgressStore.getState().setModelDownload("m1", null);
    expect(useProgressStore.getState().modelDownloads.m1).toBeUndefined();
  });
});

describe("progress store: clearForAnalysisIds 批量清", () => {
  it("一次清掉 progress / pipeline / budget", () => {
    const s = useProgressStore.getState();
    s.setProgress("a1", evt({}));
    s.updatePipeline("a1", evt({ stageIndex: 0, progress: 10 }));
    s.setBudget("a1", { totalMs: 100, stages: [] });
    s.clearForAnalysisIds(new Set(["a1"]));
    const st = useProgressStore.getState();
    expect(st.progressByAnalysis.a1).toBeUndefined();
    expect(st.pipelineByAnalysis.a1).toBeUndefined();
    expect(st.budgetByAnalysis.a1).toBeUndefined();
  });
});
