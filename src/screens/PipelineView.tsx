import { Button } from "@/components/ui/button";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { type FunctionComponent, useCallback, useEffect, useState } from "react";
import type { FramesCheckpoint, TranscriptData } from "../electron-api";
import type { AnalysisNode, AnalysisReport, Project, TokenUsageSummary } from "../types";
import { PipelineStagePanel, fmtDuration, fmtTokens, type StageStat } from "./pipeline/PipelineStagePanel";
import { StageExtractFrames } from "./pipeline/StageExtractFrames";
import { StagePrefilter } from "./pipeline/StagePrefilter";
import { StageShotMerge } from "./pipeline/StageShotMerge";
import { StageTranscribe } from "./pipeline/StageTranscribe";
import { StageSummarizer } from "./pipeline/StageSummarizer";
import { StageMainAnalysis } from "./pipeline/StageMainAnalysis";
import { StageMethodologyAudit } from "./pipeline/StageMethodologyAudit";

type Props = {
  projectId: string;
  project?: Project;
  onBack: () => void;
};

type PipelineData = {
  report: AnalysisReport | null;
  nodes: AnalysisNode[];
  checkpoint: FramesCheckpoint | null;
  transcript: TranscriptData | null;
  tokenUsage: TokenUsageSummary | null;
};

// 从 report.timings 中按中文 stage 名查找 meta
type TimingEntry = { stage: string; durationMs: number; meta?: Record<string, unknown>; tokenDelta?: Array<Record<string, unknown>> };

const TIMING_STAGE_MAP: Record<string, string[]> = {
  extract: ["抽取关键画面", "挑选关键画面"],
  prefilter: ["本地初筛"],
  shotMerge: ["镜头合并"],
  transcribe: ["字幕识别"],
  summarizer: ["全局聚合"],
  mainAnalysis: ["模型分析画面", "主分析(分段)", "主分析(审计)"],
  audit: ["整理结果"],
};

const TOKEN_STAGE_MAP: Record<string, string> = {
  prefilter: "prefilter",
  shotMerge: "shot-merger",
  transcribe: "",
  summarizer: "summarizer",
  mainAnalysis: "main-analysis",
  audit: "title-gen",
};

function findTimings(timings: TimingEntry[] | undefined, key: string): { durationMs: number; meta: Record<string, unknown> } {
  const names = TIMING_STAGE_MAP[key] || [];
  let durationMs = 0;
  let meta: Record<string, unknown> = {};
  if (!timings) return { durationMs, meta };
  for (const t of timings) {
    if (names.some((n) => t.stage.includes(n))) {
      durationMs += t.durationMs;
      if (t.meta) meta = { ...meta, ...t.meta };
    }
  }
  return { durationMs, meta };
}

function findTokenStat(tokenUsage: TokenUsageSummary | null, key: string): { calls: number; totalTokens: number; promptTokens: number; completionTokens: number; cacheHits: number } {
  const stageKey = TOKEN_STAGE_MAP[key];
  if (!stageKey || !tokenUsage?.stages) return { calls: 0, totalTokens: 0, promptTokens: 0, completionTokens: 0, cacheHits: 0 };
  let calls = 0, totalTokens = 0, promptTokens = 0, completionTokens = 0, cacheHits = 0;
  for (const s of tokenUsage.stages) {
    if (s.stage === stageKey) {
      calls += s.callCount;
      totalTokens += s.totalTokens;
      promptTokens += s.promptTokens;
      completionTokens += s.completionTokens;
      cacheHits += s.cacheHits;
    }
  }
  return { calls, totalTokens, promptTokens, completionTokens, cacheHits };
}

function buildStat(key: string, timings: TimingEntry[] | undefined, tokenUsage: TokenUsageSummary | null): StageStat {
  const t = findTimings(timings, key);
  const tk = findTokenStat(tokenUsage, key);
  return { durationMs: t.durationMs, calls: tk.calls, totalTokens: tk.totalTokens, promptTokens: tk.promptTokens, completionTokens: tk.completionTokens, cacheHits: tk.cacheHits };
}

const StatBox: FunctionComponent<{ label: string; value: string; sub?: string }> = ({ label, value, sub }) => (
  <div className="rounded-md bg-white dark:bg-[#0E0E10] border border-slate-200 dark:border-slate-800 px-3 py-2">
    <div className="text-[10.5px] text-slate-400 dark:text-slate-500">{label}</div>
    <div className="text-sm font-mono font-medium text-slate-800 dark:text-slate-100 mt-0.5">{value}</div>
    {sub && <div className="text-[10px] text-slate-400 dark:text-slate-500 font-mono mt-0.5">{sub}</div>}
  </div>
);

export const PipelineView: FunctionComponent<Props> = ({ projectId, project, onBack }) => {
  const [data, setData] = useState<PipelineData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const api = window.videoAnalyzer;
    if (!api) {
      setError("浏览器预览环境不支持");
      setLoading(false);
      return;
    }
    try {
      const [reportRes, nodesRes, cpRes, trRes, tuRes] = await Promise.all([
        api.getReport(projectId),
        api.getNodes(projectId),
        api.diagnostics?.getFramesCheckpoint(projectId),
        api.diagnostics?.getTranscript(projectId),
        api.diagnostics?.getTokenUsage(projectId),
      ]);
      setData({
        report: reportRes || null,
        nodes: nodesRes || [],
        checkpoint: cpRes?.data || null,
        transcript: trRes?.data || null,
        tokenUsage: tuRes?.data || null,
      });
    } catch (err: unknown) {
      setError(String((err as Error)?.message || err));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  const timings = data?.report?.timings as TimingEntry[] | undefined;
  const tokenUsage = data?.tokenUsage || data?.report?.tokenUsage || null;

  // Summary stats
  const totalDurationMs = data?.report?.totalDurationMs || 0;
  const totalTokens = tokenUsage?.totalTokens || 0;
  const totalCalls = tokenUsage?.stages?.reduce((a, s) => a + s.callCount, 0) || 0;
  const framesCount = data?.checkpoint?.frames?.length || 0;
  const shotsCount = data?.report?.shotContexts?.length || 0;
  const nodesCount = data?.nodes?.length || 0;

  const title = project?.videoName || projectId.slice(0, 12);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Header */}
      <div className="shrink-0 px-6 pt-5 pb-4 border-b border-slate-200 dark:border-slate-800">
        <div className="flex items-center gap-3">
          <button
            onClick={onBack}
            className="p-1.5 -ml-1.5 rounded-md hover:bg-slate-200/60 dark:hover:bg-slate-800/60 transition-colors"
          >
            <ArrowLeft className="w-4 h-4 text-slate-500" />
          </button>
          <div className="min-w-0 flex-1">
            <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100 truncate">{title}</h1>
            <p className="text-[12px] text-slate-400 dark:text-slate-500 mt-0.5">
              分析管线详情
              {project?.source?.type === "url" && (
                <span className="ml-2 opacity-60">{(project.source as { url: string }).url}</span>
              )}
            </p>
          </div>
          <Button size="sm" variant="ghost" onClick={load} className="h-8 text-xs gap-1.5">
            <RefreshCw className="w-3.5 h-3.5" />
            刷新
          </Button>
        </div>

        {/* Summary bar */}
        {!loading && data && (
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 mt-4">
            <StatBox label="总耗时" value={fmtDuration(totalDurationMs)} />
            <StatBox label="总 token" value={fmtTokens(totalTokens)} sub={tokenUsage ? `${fmtTokens(tokenUsage.totalPromptTokens)} in · ${fmtTokens(tokenUsage.totalCompletionTokens)} out` : undefined} />
            <StatBox label="LLM 调用" value={String(totalCalls)} />
            <StatBox label="帧" value={String(framesCount)} />
            <StatBox label="镜头" value={String(shotsCount)} />
            <StatBox label="节点" value={String(nodesCount)} />
          </div>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4">
        {loading && (
          <div className="flex items-center justify-center py-20 text-sm text-slate-400">
            <RefreshCw className="w-4 h-4 animate-spin mr-2" />
            加载中…
          </div>
        )}

        {error && (
          <div className="flex items-center justify-center py-20 text-sm text-red-500">{error}</div>
        )}

        {!loading && !error && data && (
          <div className="space-y-2">
            {/* Stage 1: Extract Frames */}
            <PipelineStagePanel
              index={1} name="抽帧" color="bg-blue-500"
              stat={buildStat("extract", timings, tokenUsage)}
            >
              <StageExtractFrames
                projectId={projectId}
                checkpoint={data.checkpoint}
                meta={findTimings(timings, "extract").meta}
              />
            </PipelineStagePanel>

            {/* Stage 2: Prefilter */}
            <PipelineStagePanel
              index={2} name="预筛选" color="bg-violet-500"
              stat={buildStat("prefilter", timings, tokenUsage)}
            >
              <StagePrefilter
                projectId={projectId}
                nodes={data.nodes}
                meta={findTimings(timings, "prefilter").meta}
              />
            </PipelineStagePanel>

            {/* Stage 3: Shot Merge */}
            <PipelineStagePanel
              index={3} name="镜头合并" color="bg-amber-500"
              stat={buildStat("shotMerge", timings, tokenUsage)}
            >
              <StageShotMerge
                shots={data.report?.shotContexts}
                meta={findTimings(timings, "shotMerge").meta}
              />
            </PipelineStagePanel>

            {/* Stage 4: Transcribe */}
            <PipelineStagePanel
              index={4} name="语音转写" color="bg-cyan-500"
              stat={buildStat("transcribe", timings, tokenUsage)}
            >
              <StageTranscribe
                transcript={data.transcript}
                meta={findTimings(timings, "transcribe").meta}
              />
            </PipelineStagePanel>

            {/* Stage 5: Summarizer */}
            <PipelineStagePanel
              index={5} name="全局摘要" color="bg-emerald-500"
              stat={buildStat("summarizer", timings, tokenUsage)}
            >
              <StageSummarizer report={data.report} />
            </PipelineStagePanel>

            {/* Stage 6: Main Analysis */}
            <PipelineStagePanel
              index={6} name="主分析" color="bg-indigo-500"
              stat={buildStat("mainAnalysis", timings, tokenUsage)}
            >
              <StageMainAnalysis
                nodes={data.nodes}
                meta={findTimings(timings, "mainAnalysis").meta}
              />
            </PipelineStagePanel>

            {/* Stage 7: Methodology Audit */}
            <PipelineStagePanel
              index={7} name="方法论审计" color="bg-rose-500" isLast
              stat={buildStat("audit", timings, tokenUsage)}
            >
              <StageMethodologyAudit audit={data.report?.methodologyAudit} />
            </PipelineStagePanel>
          </div>
        )}
      </div>
    </div>
  );
};
