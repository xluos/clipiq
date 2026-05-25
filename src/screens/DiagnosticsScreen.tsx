import { useApp } from "../AppContext";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ArrowLeft, RefreshCw, ChevronDown, ChevronRight, Clock, Cpu, Zap, Hash, Database } from "lucide-react";
import { type FunctionComponent, useCallback, useEffect, useMemo, useState } from "react";
import type { AnalysisSample, AnalysisSampleStage } from "../electron-api";
import type { Project } from "../types";

const STAGE_LABELS: Record<string, string> = {
  "prepare": "准备",
  "extract-frames": "抽帧",
  "prefilter": "预筛选",
  "scene-detect": "场景检测",
  "plan-frames": "帧规划",
  "shot-merge": "镜头合并",
  "shot-merger": "镜头合并",
  "transcribe": "语音转写",
  "summarizer": "生成摘要",
  "summarize": "生成摘要",
  "detect-genre": "类型识别",
  "main-analysis": "主分析",
  "danmaku-emotion": "弹幕情绪",
  "title-gen": "标题生成",
  "audit": "方法论审计",
};

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.floor(s % 60);
  return `${m}m${rem}s`;
}

function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function fmtDate(iso: string): string {
  try {
    const d = new Date(iso);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  } catch {
    return iso;
  }
}

function outcomeColor(outcome: string): string {
  if (outcome === "ok") return "text-emerald-600 dark:text-emerald-400";
  if (outcome === "failed") return "text-red-500 dark:text-red-400";
  return "text-amber-500 dark:text-amber-400";
}

function outcomeLabel(outcome: string): string {
  if (outcome === "ok") return "成功";
  if (outcome === "failed") return "失败";
  return "已取消";
}

type StageAgg = {
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  callCount: number;
  cacheHits: number;
  models: Set<string>;
};

function aggregateStageTokens(stages: AnalysisSampleStage[]): {
  byStage: Map<string, StageAgg>;
  totalTokens: number;
  totalPrompt: number;
  totalCompletion: number;
  totalCalls: number;
} {
  const byStage = new Map<string, StageAgg>();
  let totalTokens = 0, totalPrompt = 0, totalCompletion = 0, totalCalls = 0;

  for (const s of stages) {
    if (!s.tokenDelta) continue;
    for (const d of s.tokenDelta) {
      const key = d.stage || s.stage;
      let agg = byStage.get(key);
      if (!agg) {
        agg = { totalTokens: 0, promptTokens: 0, completionTokens: 0, callCount: 0, cacheHits: 0, models: new Set() };
        byStage.set(key, agg);
      }
      agg.totalTokens += d.totalTokens;
      agg.promptTokens += d.promptTokens;
      agg.completionTokens += d.completionTokens;
      agg.callCount += d.callCount;
      if (d.model) agg.models.add(d.model);
      totalTokens += d.totalTokens;
      totalPrompt += d.promptTokens;
      totalCompletion += d.completionTokens;
      totalCalls += d.callCount;
    }
  }
  return { byStage, totalTokens, totalPrompt, totalCompletion, totalCalls };
}

function extractStageMeta(stages: AnalysisSampleStage[]) {
  let candidateFrames = 0, keptFrames = 0, droppedFrames = 0;
  let shotsCount = 0, shotBatches = 0, shotsPerBatch: number[] = [];
  let transcriptSegments = 0, transcriptChars = 0;
  let durationSec = 0;

  for (const s of stages) {
    const m = s.meta as Record<string, unknown> | undefined;
    if (!m) continue;
    if (typeof m.candidateFrames === "number") candidateFrames = m.candidateFrames;
    if (typeof m.kept === "number") keptFrames = m.kept;
    if (typeof m.dropped === "number") droppedFrames = m.dropped;
    if (typeof m.rawShots === "number" || typeof m.shotsCount === "number")
      shotsCount = (m.rawShots as number) || (m.shotsCount as number) || shotsCount;
    if (typeof m.mergedShots === "number") shotsCount = m.mergedShots as number;
    if (typeof m.batchCount === "number") shotBatches = m.batchCount as number;
    if (Array.isArray(m.batchSizes)) shotsPerBatch = m.batchSizes as number[];
    if (typeof m.transcriptSegments === "number") transcriptSegments = m.transcriptSegments as number;
    if (typeof m.transcriptChars === "number") transcriptChars = m.transcriptChars as number;
    if (typeof m.durationSec === "number") durationSec = m.durationSec as number;
  }
  return { candidateFrames, keptFrames, droppedFrames, shotsCount, shotBatches, shotsPerBatch, transcriptSegments, transcriptChars, durationSec };
}

const SampleCard: FunctionComponent<{
  sample: AnalysisSample;
  projectTitle?: string;
}> = ({ sample, projectTitle }) => {
  const [expanded, setExpanded] = useState(false);
  const tokens = useMemo(() => aggregateStageTokens(sample.stages), [sample.stages]);
  const meta = useMemo(() => extractStageMeta(sample.stages), [sample.stages]);

  const title = projectTitle || sample.projectId.slice(0, 8);

  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0E0E10] overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors"
      >
        {expanded
          ? <ChevronDown className="w-3.5 h-3.5 shrink-0 text-slate-400" />
          : <ChevronRight className="w-3.5 h-3.5 shrink-0 text-slate-400" />
        }
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium truncate">{title}</span>
            <span className={`text-[11px] font-medium ${outcomeColor(sample.outcome)}`}>
              {outcomeLabel(sample.outcome)}
            </span>
          </div>
          <div className="text-[11px] text-slate-400 dark:text-slate-500 mt-0.5 font-mono">
            {fmtDate(sample.startedAt)}
          </div>
        </div>
        {/* Quick stats on the right */}
        <div className="shrink-0 flex items-center gap-4 text-[11px] text-slate-500 dark:text-slate-400">
          <span className="flex items-center gap-1" title="总耗时">
            <Clock className="w-3 h-3" />
            {fmtDuration(sample.totalDurationMs)}
          </span>
          <span className="flex items-center gap-1" title="LLM 调用次数">
            <Zap className="w-3 h-3" />
            {tokens.totalCalls}
          </span>
          <span className="flex items-center gap-1 font-mono" title="总 token">
            <Hash className="w-3 h-3" />
            {fmtTokens(tokens.totalTokens)}
          </span>
        </div>
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div className="border-t border-slate-100 dark:border-slate-800 px-4 py-3 space-y-4">
          {/* Summary row */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatBox label="总耗时" value={fmtDuration(sample.totalDurationMs)} />
            <StatBox label="总 token" value={fmtTokens(tokens.totalTokens)} sub={`${fmtTokens(tokens.totalPrompt)} in · ${fmtTokens(tokens.totalCompletion)} out`} />
            <StatBox label="LLM 调用" value={String(tokens.totalCalls)} />
            <StatBox label="视频时长" value={meta.durationSec > 0 ? fmtDuration(meta.durationSec * 1000) : "—"} />
          </div>

          {/* Pipeline meta */}
          {(meta.candidateFrames > 0 || meta.shotsCount > 0 || meta.transcriptSegments > 0) && (
            <div className="space-y-1.5">
              <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wider">管线数据</div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-[12px]">
                {meta.candidateFrames > 0 && (
                  <div className="text-slate-600 dark:text-slate-300">
                    抽帧 <span className="font-mono">{meta.candidateFrames}</span>
                    {meta.keptFrames > 0 && <> → 保留 <span className="font-mono">{meta.keptFrames}</span></>}
                    {meta.droppedFrames > 0 && <span className="text-slate-400"> (丢弃 {meta.droppedFrames})</span>}
                  </div>
                )}
                {meta.shotsCount > 0 && (
                  <div className="text-slate-600 dark:text-slate-300">
                    镜头 <span className="font-mono">{meta.shotsCount}</span>
                    {meta.shotBatches > 0 && <> · <span className="font-mono">{meta.shotBatches}</span> 批</>}
                    {meta.shotsPerBatch.length > 0 && (
                      <span className="text-slate-400"> ({meta.shotsPerBatch.join("/")})</span>
                    )}
                  </div>
                )}
                {meta.transcriptSegments > 0 && (
                  <div className="text-slate-600 dark:text-slate-300">
                    字幕 <span className="font-mono">{meta.transcriptSegments}</span> 段
                    {meta.transcriptChars > 0 && <> · <span className="font-mono">{meta.transcriptChars}</span> 字</>}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Provider info */}
          <div className="space-y-1.5">
            <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wider">模型</div>
            <div className="flex flex-wrap gap-1.5">
              {sample.providers.complexVision && (
                <Badge variant="outline" className="text-[10.5px] font-mono">
                  视觉: {sample.providers.complexVision.model}
                </Badge>
              )}
              {sample.providers.mediumText && (
                <Badge variant="outline" className="text-[10.5px] font-mono">
                  文本: {sample.providers.mediumText.model}
                </Badge>
              )}
              {sample.providers.audio && (
                <Badge variant="outline" className="text-[10.5px] font-mono">
                  音频: {sample.providers.audio.model}
                </Badge>
              )}
            </div>
          </div>

          {/* Per-stage breakdown */}
          <div className="space-y-1.5">
            <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wider">各阶段</div>
            <div className="rounded-md border border-slate-100 dark:border-slate-800 overflow-hidden">
              <table className="w-full text-[11.5px]">
                <thead>
                  <tr className="bg-slate-50 dark:bg-slate-900/50 text-slate-500 dark:text-slate-400">
                    <th className="text-left px-3 py-1.5 font-medium">阶段</th>
                    <th className="text-right px-3 py-1.5 font-medium">耗时</th>
                    <th className="text-right px-3 py-1.5 font-medium">调用</th>
                    <th className="text-right px-3 py-1.5 font-medium">Prompt</th>
                    <th className="text-right px-3 py-1.5 font-medium">Completion</th>
                    <th className="text-right px-3 py-1.5 font-medium">总 token</th>
                  </tr>
                </thead>
                <tbody>
                  {sample.stages.map((s, i) => {
                    const stageTokens = tokens.byStage.get(s.stage);
                    return (
                      <tr key={i} className="border-t border-slate-100 dark:border-slate-800">
                        <td className="px-3 py-1.5 text-slate-700 dark:text-slate-300">
                          {STAGE_LABELS[s.stage] || s.stage}
                          {s.note && <span className="text-slate-400 ml-1">({s.note})</span>}
                        </td>
                        <td className="px-3 py-1.5 text-right font-mono text-slate-600 dark:text-slate-400">
                          {fmtDuration(s.durationMs)}
                        </td>
                        <td className="px-3 py-1.5 text-right font-mono text-slate-600 dark:text-slate-400">
                          {stageTokens?.callCount || "—"}
                        </td>
                        <td className="px-3 py-1.5 text-right font-mono text-slate-600 dark:text-slate-400">
                          {stageTokens ? fmtTokens(stageTokens.promptTokens) : "—"}
                        </td>
                        <td className="px-3 py-1.5 text-right font-mono text-slate-600 dark:text-slate-400">
                          {stageTokens ? fmtTokens(stageTokens.completionTokens) : "—"}
                        </td>
                        <td className="px-3 py-1.5 text-right font-mono text-slate-600 dark:text-slate-400">
                          {stageTokens ? fmtTokens(stageTokens.totalTokens) : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Failure message */}
          {sample.failureMsg && (
            <div className="text-[12px] text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-500/10 rounded-md px-3 py-2 font-mono whitespace-pre-wrap break-all">
              {sample.failureMsg}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

const StatBox: FunctionComponent<{ label: string; value: string; sub?: string }> = ({ label, value, sub }) => (
  <div className="rounded-md bg-slate-50 dark:bg-slate-900/50 px-3 py-2">
    <div className="text-[10.5px] text-slate-400 dark:text-slate-500">{label}</div>
    <div className="text-sm font-mono font-medium text-slate-800 dark:text-slate-100 mt-0.5">{value}</div>
    {sub && <div className="text-[10px] text-slate-400 dark:text-slate-500 font-mono mt-0.5">{sub}</div>}
  </div>
);

type FilterOutcome = "all" | "ok" | "failed" | "cancelled";

export function DiagnosticsScreen() {
  const { projects, setLocation } = useApp();
  const [samples, setSamples] = useState<AnalysisSample[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterOutcome>("all");

  const projectMap = useMemo(() => {
    const m = new Map<string, Project>();
    for (const p of projects) m.set(p.id, p);
    return m;
  }, [projects]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const api = window.videoAnalyzer;
      if (!api?.diagnostics) {
        setError("浏览器预览环境不支持诊断数据");
        return;
      }
      const res = await api.diagnostics.getAnalysisSamples();
      if (!res.ok) {
        setError(res.error || "读取失败");
        return;
      }
      setSamples(res.samples.reverse());
    } catch (err: unknown) {
      setError(String((err as Error)?.message || err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    if (filter === "all") return samples;
    return samples.filter((s) => s.outcome === filter);
  }, [samples, filter]);

  const totalStats = useMemo(() => {
    let totalTokens = 0, totalCalls = 0, totalDuration = 0;
    const okSamples = samples.filter((s) => s.outcome === "ok");
    for (const s of okSamples) {
      totalDuration += s.totalDurationMs;
      const t = aggregateStageTokens(s.stages);
      totalTokens += t.totalTokens;
      totalCalls += t.totalCalls;
    }
    return {
      total: samples.length,
      ok: okSamples.length,
      failed: samples.filter((s) => s.outcome === "failed").length,
      cancelled: samples.filter((s) => s.outcome === "cancelled").length,
      totalTokens,
      totalCalls,
      totalDuration,
    };
  }, [samples]);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Header */}
      <div className="shrink-0 px-6 pt-5 pb-4 border-b border-slate-200 dark:border-slate-800">
        <div className="flex items-center gap-3">
          <button
            onClick={() => setLocation({ module: "settings" })}
            className="p-1.5 -ml-1.5 rounded-md hover:bg-slate-200/60 dark:hover:bg-slate-800/60 transition-colors"
          >
            <ArrowLeft className="w-4 h-4 text-slate-500" />
          </button>
          <div>
            <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100">分析诊断</h1>
            <p className="text-[12px] text-slate-400 dark:text-slate-500 mt-0.5">
              历史分析执行记录 · 每个阶段的耗时与 token 消耗
            </p>
          </div>
          <div className="flex-1" />
          <Button size="sm" variant="ghost" onClick={load} className="h-8 text-xs gap-1.5">
            <RefreshCw className="w-3.5 h-3.5" />
            刷新
          </Button>
        </div>

        {/* Overview stats */}
        {!loading && samples.length > 0 && (
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-3 mt-4">
            <StatBox label="总执行次数" value={String(totalStats.total)} />
            <StatBox label="成功" value={String(totalStats.ok)} />
            <StatBox label="失败" value={String(totalStats.failed)} />
            <StatBox label="总耗时(成功)" value={fmtDuration(totalStats.totalDuration)} />
            <StatBox label="总 LLM 调用" value={String(totalStats.totalCalls)} />
            <StatBox label="总 token" value={fmtTokens(totalStats.totalTokens)} />
          </div>
        )}

        {/* Filter bar */}
        {!loading && samples.length > 0 && (
          <div className="flex items-center gap-1.5 mt-3">
            {(["all", "ok", "failed", "cancelled"] as FilterOutcome[]).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={[
                  "px-2.5 py-1 rounded-md text-[11.5px] transition-colors",
                  filter === f
                    ? "bg-indigo-50 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300 font-medium"
                    : "text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800",
                ].join(" ")}
              >
                {{ all: "全部", ok: "成功", failed: "失败", cancelled: "已取消" }[f]}
                <span className="ml-1 font-mono text-[10px]">
                  {f === "all" ? totalStats.total : f === "ok" ? totalStats.ok : f === "failed" ? totalStats.failed : totalStats.cancelled}
                </span>
              </button>
            ))}
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
          <div className="flex items-center justify-center py-20">
            <div className="text-sm text-red-500">{error}</div>
          </div>
        )}

        {!loading && !error && samples.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-slate-400">
            <Database className="w-8 h-8 mb-3 opacity-40" />
            <div className="text-sm">还没有分析执行记录</div>
            <div className="text-[12px] mt-1">完成一次视频分析后会在此显示</div>
          </div>
        )}

        {!loading && !error && filtered.length > 0 && (
          <div className="space-y-2">
            {filtered.map((s, i) => (
              <SampleCard
                key={`${s.projectId}-${s.startedAt}-${i}`}
                sample={s}
                projectTitle={projectMap.get(s.projectId)?.title || projectMap.get(s.projectId)?.source?.url}
              />
            ))}
          </div>
        )}

        {!loading && !error && samples.length > 0 && filtered.length === 0 && (
          <div className="flex items-center justify-center py-20 text-sm text-slate-400">
            没有匹配"{filter === "ok" ? "成功" : filter === "failed" ? "失败" : "已取消"}"的记录
          </div>
        )}
      </div>
    </div>
  );
}
