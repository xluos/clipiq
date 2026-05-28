import { Button } from "@/components/ui/button";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { Fragment, type FunctionComponent, useCallback, useEffect, useState } from "react";
import { useApp } from "../AppContext";
import type { FramesCheckpoint, TranscriptData } from "../electron-api";
import type { AnalysisNode, AnalysisReport, Video, TokenUsageSummary } from "../types";
import { PipelineStagePanel, fmtDuration, fmtTokens, type StageStat } from "./pipeline/PipelineStagePanel";
import { StageSceneDetect } from "./pipeline/StageSceneDetect";
import { StageExtractFrames } from "./pipeline/StageExtractFrames";
import { StagePrefilter } from "./pipeline/StagePrefilter";
import { StageTranscribe } from "./pipeline/StageTranscribe";
import { StageShotMerge } from "./pipeline/StageShotMerge";
import { StageSummarizer } from "./pipeline/StageSummarizer";
import { StageMainAnalysis } from "./pipeline/StageMainAnalysis";
import { StageMethodologyAudit } from "./pipeline/StageMethodologyAudit";

type Props = {
  projectId: string;
  project?: Video;
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
  sceneDetect: ["检测镜头切换"],
  extract: ["抽取关键画面", "挑选关键画面"],
  prefilter: ["本地初筛"],
  transcribe: ["字幕识别"],
  shotMerge: ["镜头合并"],
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
  const { activeAnalysisId: ctxAnalysisId } = useApp();
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
      const analysisId = ctxAnalysisId || project?.currentAnalysisId || projectId;
      const [reportRes, nodesRes, cpRes, trRes, tuRes] = await Promise.all([
        api.getAnalysis(analysisId),
        api.getAnalysis(analysisId),
        api.diagnostics?.getFramesCheckpoint(projectId),
        api.diagnostics?.getTranscript(projectId),
        api.diagnostics?.getTokenUsage(analysisId),
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
            {/* Stage 1: Scene Detection */}
            <PipelineStagePanel
              index={1} name="检测镜头切换" color="bg-slate-500"
              stat={buildStat("sceneDetect", timings, tokenUsage)}
            >
              <StageSceneDetect meta={findTimings(timings, "sceneDetect").meta} />
            </PipelineStagePanel>

            {/* Stage 2: Extract Frames */}
            <PipelineStagePanel
              index={2} name="抽帧" color="bg-blue-500"
              stat={buildStat("extract", timings, tokenUsage)}
            >
              <StageExtractFrames
                projectId={projectId}
                checkpoint={data.checkpoint}
                meta={findTimings(timings, "extract").meta}
              />
            </PipelineStagePanel>

            {/* Stage 3: Prefilter */}
            <PipelineStagePanel
              index={3} name="预筛选" color="bg-violet-500"
              stat={buildStat("prefilter", timings, tokenUsage)}
            >
              <StagePrefilter
                projectId={projectId}
                nodes={data.nodes}
                meta={findTimings(timings, "prefilter").meta}
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

            {/* Stage 5: Shot Merge */}
            <PipelineStagePanel
              index={5} name="镜头合并" color="bg-amber-500"
              stat={buildStat("shotMerge", timings, tokenUsage)}
            >
              <StageShotMerge
                shots={data.report?.shotContexts}
                meta={findTimings(timings, "shotMerge").meta}
              />
            </PipelineStagePanel>

            {/* Stage 6: Summarizer */}
            <PipelineStagePanel
              index={6} name="全局摘要" color="bg-emerald-500"
              stat={buildStat("summarizer", timings, tokenUsage)}
            >
              <StageSummarizer report={data.report} />
            </PipelineStagePanel>

            {/* Stage 7: Main Analysis */}
            <PipelineStagePanel
              index={7} name="主分析" color="bg-indigo-500"
              stat={buildStat("mainAnalysis", timings, tokenUsage)}
            >
              <StageMainAnalysis
                nodes={data.nodes}
                meta={findTimings(timings, "mainAnalysis").meta}
              />
            </PipelineStagePanel>

            {/* Stage 8: Methodology Audit */}
            <PipelineStagePanel
              index={8} name="方法论审计" color="bg-rose-500" isLast
              stat={buildStat("audit", timings, tokenUsage)}
            >
              <StageMethodologyAudit audit={data.report?.methodologyAudit} />
            </PipelineStagePanel>

            {/* Token breakdown */}
            {tokenUsage && tokenUsage.stages.length > 0 && (
              <TokenBreakdown tokenUsage={tokenUsage} />
            )}
          </div>
        )}
      </div>
    </div>
  );
};

const TOKEN_STAGE_LABELS: Record<string, string> = {
  prefilter: "本地初筛",
  "shot-merger": "镜头合并",
  summarizer: "镜头摘要",
  "detect-genre": "类型识别",
  "main-analysis": "主分析",
  "danmaku-emotion": "弹幕情绪",
  "title-gen": "标题生成",
  transcribe: "语音转写",
};

function humanStage(stage: string) {
  if (TOKEN_STAGE_LABELS[stage]) return TOKEN_STAGE_LABELS[stage];
  for (const [k, v] of Object.entries(TOKEN_STAGE_LABELS)) {
    if (stage.includes(k)) return v;
  }
  return stage;
}

function TokenBreakdown({ tokenUsage }: { tokenUsage: TokenUsageSummary }) {
  const { totalPromptTokens, totalCompletionTokens, totalTokens, stages } = tokenUsage;
  if (!stages.length) return null;

  type Group = {
    model: string; providerName: string | null; source: string;
    promptTokens: number; completionTokens: number; totalTokens: number;
    cacheReadTokens: number; cacheCreationTokens: number;
    callCount: number; cacheHits: number;
    stages: { stage: string; promptTokens: number; completionTokens: number; totalTokens: number; cacheReadTokens: number; cacheCreationTokens: number; callCount: number }[];
  };
  const byModel = new Map<string, Group>();
  for (const s of stages) {
    const key = `${s.providerName || ""}::${s.model || "unknown"}::${s.source}`;
    const crt = (s as { cacheReadTokens?: number }).cacheReadTokens || 0;
    const cct = (s as { cacheCreationTokens?: number }).cacheCreationTokens || 0;
    const existing = byModel.get(key);
    const row = { stage: s.stage, promptTokens: s.promptTokens, completionTokens: s.completionTokens, totalTokens: s.totalTokens, cacheReadTokens: crt, cacheCreationTokens: cct, callCount: s.callCount };
    if (existing) {
      existing.promptTokens += s.promptTokens;
      existing.completionTokens += s.completionTokens;
      existing.totalTokens += s.totalTokens;
      existing.cacheReadTokens += crt;
      existing.cacheCreationTokens += cct;
      existing.callCount += s.callCount;
      existing.cacheHits += s.cacheHits;
      existing.stages.push(row);
    } else {
      byModel.set(key, {
        model: s.model || "unknown", providerName: s.providerName, source: s.source,
        promptTokens: s.promptTokens, completionTokens: s.completionTokens, totalTokens: s.totalTokens,
        cacheReadTokens: crt, cacheCreationTokens: cct,
        callCount: s.callCount, cacheHits: s.cacheHits, stages: [row],
      });
    }
  }
  const groups = Array.from(byModel.values()).sort((a, b) => b.totalTokens - a.totalTokens);
  const promptPct = totalTokens > 0 ? (totalPromptTokens / totalTokens) * 100 : 0;

  return (
    <div className="mt-6 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0E0E10] p-4">
      <div className="flex items-baseline justify-between mb-2">
        <span className="text-[11px] uppercase tracking-widest text-slate-500 dark:text-slate-400">Token 消耗明细</span>
        <span className="font-mono text-xs text-slate-700 dark:text-slate-200">
          总计 {fmtTokens(totalTokens)}
          <span className="text-slate-400 dark:text-slate-500 ml-1.5">
            输入 {fmtTokens(totalPromptTokens)} · 输出 {fmtTokens(totalCompletionTokens)}
          </span>
        </span>
      </div>

      <div className="flex h-2 rounded-full overflow-hidden bg-slate-100 dark:bg-slate-800 mb-3">
        <div style={{ width: `${promptPct}%` }} className="bg-sky-500" title={`输入 ${promptPct.toFixed(1)}%`} />
        <div style={{ width: `${100 - promptPct}%` }} className="bg-amber-500" title={`输出 ${(100 - promptPct).toFixed(1)}%`} />
      </div>
      <div className="flex gap-3 mb-3 text-[11px]">
        <div className="flex items-center gap-1.5">
          <span className="inline-block w-2 h-2 rounded-full bg-sky-500" />
          <span className="text-slate-600 dark:text-slate-300">输入</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="inline-block w-2 h-2 rounded-full bg-amber-500" />
          <span className="text-slate-600 dark:text-slate-300">输出</span>
        </div>
      </div>

      <div className="space-y-2">
        {groups.map((g) => {
          const hasCache = g.cacheReadTokens > 0 || g.cacheCreationTokens > 0;
          return (
            <div key={`${g.providerName}::${g.model}::${g.source}`} className="rounded-lg border border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-white/[0.02] p-2.5">
              <div className="flex items-baseline justify-between mb-1.5">
                <span className="font-mono text-xs text-slate-800 dark:text-slate-200 truncate mr-2">
                  {g.providerName ? `${g.providerName} · ` : ""}{g.model}
                </span>
                <span className="font-mono text-[11px] text-slate-500 dark:text-slate-400 shrink-0">
                  {fmtTokens(g.totalTokens)}
                  {g.callCount > 0 && <span className="ml-1.5">{g.callCount} 次调用</span>}
                  {g.cacheHits > 0 && <span className="ml-1.5 text-emerald-600 dark:text-emerald-400">{g.cacheHits} 缓存</span>}
                </span>
              </div>
              <div className={`grid gap-x-3 gap-y-0.5 text-[11px] ${hasCache ? "grid-cols-[1fr_auto_auto_auto_auto]" : "grid-cols-[1fr_auto_auto_auto]"}`}>
                <span className="text-slate-400 dark:text-slate-600">阶段</span>
                <span className="text-slate-400 dark:text-slate-600 text-right">输入</span>
                <span className="text-slate-400 dark:text-slate-600 text-right">输出</span>
                {hasCache && <span className="text-slate-400 dark:text-slate-600 text-right">缓存命中</span>}
                <span className="text-slate-400 dark:text-slate-600 text-right">合计</span>
                {g.stages.map((s) => (
                  <Fragment key={s.stage}>
                    <span className="text-slate-600 dark:text-slate-300 truncate">{humanStage(s.stage)}</span>
                    <span className="font-mono text-slate-500 dark:text-slate-400 text-right">{fmtTokens(s.promptTokens)}</span>
                    <span className="font-mono text-slate-500 dark:text-slate-400 text-right">{fmtTokens(s.completionTokens)}</span>
                    {hasCache && <span className="font-mono text-emerald-600 dark:text-emerald-400 text-right">{s.cacheReadTokens > 0 ? fmtTokens(s.cacheReadTokens) : "—"}</span>}
                    <span className="font-mono text-slate-700 dark:text-slate-200 text-right">{fmtTokens(s.totalTokens)}</span>
                  </Fragment>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
