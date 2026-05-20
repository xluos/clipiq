import { useApp } from "../AppContext";
import { useEffect, useMemo, useRef, useState } from "react";
import { generateMockNodes, generateMockReport } from "../mockData";
import { ArrowRight, CheckCircle2 } from "lucide-react";
import type { AnalysisOptions } from "../types";

const STAGES = [
  "读取视频信息",
  "检测镜头切换",
  "挑选关键画面",
  "识别字幕",
  "整理分析素材",
  "模型分析画面",
  "整理结果",
  "生成最终报告",
];

type LogEntry = {
  ts: number;        // ms since start
  stage: string;
  message: string;
  tone: "info" | "ok" | "warn";
};

function formatElapsed(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const ss = s - m * 60;
  return `${m}:${String(ss).padStart(2, "0")}`;
}

function formatEta(remainingMs: number) {
  const s = Math.max(0, Math.round(remainingMs / 1000));
  if (s >= 60) {
    const m = Math.floor(s / 60);
    const ss = s - m * 60;
    return `≈ ${m}m ${String(ss).padStart(2, "0")}s`;
  }
  return `≈ ${s}s`;
}

function detectTone(stageLabel: string, message: string): "info" | "ok" | "warn" {
  const blob = `${stageLabel} ${message}`.toLowerCase();
  if (/failed|error|skip|warn|超时/.test(blob)) return "warn";
  if (/done|complete|ok|完成/.test(blob)) return "ok";
  return "info";
}

export function ProgressScreen() {
  const {
    setCurrentScreen, activeProjectId, projects, setProjects,
    providers, activeVideoProviderId, activeAudioProviderId,
    setNodesForProject, setReportForProject,
  } = useApp();

  const [progress, setProgress] = useState(0);
  const [stageLabel, setStageLabel] = useState(STAGES[0]);
  const [detail, setDetail] = useState("");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [error, setError] = useState("");
  const [isCancelling, setIsCancelling] = useState(false);
  const [nowTick, setNowTick] = useState(() => Date.now());

  const startedAt = useRef<number>(Date.now());
  const hasStarted = useRef(false);
  const cancelledRef = useRef(false);
  const lastLoggedStage = useRef<string>("");
  // attach 模式 = renderer 不是发起者,而是关窗后重开 / 切回 ProgressScreen,挂到已经在跑的分析上。
  // 完成 / 失败的"兜底处理"只在 attach 模式触发,避免跟 kickoff 路径的 await 结果重复。
  const inAttachMode = useRef(false);
  const completionHandledRef = useRef(false);
  const failureHandledRef = useRef(false);

  const project = projects.find(p => p.id === activeProjectId);

  useEffect(() => {
    if (progress >= 100) return;
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [progress]);

  const elapsedMs = useMemo(() => {
    void progress; void nowTick;
    return Date.now() - startedAt.current;
  }, [progress, nowTick]);

  const etaMs = useMemo(() => {
    if (progress < 5 || elapsedMs < 1500) return null;
    if (progress >= 100) return 0;
    const total = elapsedMs / (progress / 100);
    return Math.max(0, total - elapsedMs);
  }, [elapsedMs, progress]);

  // 下载阶段下方的"分析流水线"还没开始,所以强制 currentStageIndex = -1,所有 stages 灰色。
  const currentStageIndex = project?.status === "downloading"
    ? -1
    : Math.min(STAGES.length - 1, Math.floor((progress / 100) * STAGES.length));

  const recordLog = (stage: string, message: string) => {
    const tone = detectTone(stage, message);
    const key = `${stage}|${message}`;
    if (key === lastLoggedStage.current) return;
    lastLoggedStage.current = key;
    setLogs(prev => {
      const next = [{ ts: Date.now() - startedAt.current, stage, message, tone }, ...prev];
      return next.slice(0, 30);
    });
  };

  const handleCancel = async () => {
    if (!project || cancelledRef.current) {
      setCurrentScreen("home");
      return;
    }
    cancelledRef.current = true;
    if (window.videoAnalyzer) {
      setIsCancelling(true);
      try {
        await window.videoAnalyzer.cancelAnalysis(project.id);
      } catch {
        // ignore
      }
      setIsCancelling(false);
    }
    setProjects(prev => prev.map(p => p.id === project.id ? { ...p, status: "not_analyzed", updatedAt: new Date().toISOString() } : p));
    setCurrentScreen("home");
  };

  const handleBackground = () => {
    setCurrentScreen("home");
  };

  // Subscribe to live progress events on every mount (handles React StrictMode double-mount cleanly).
  useEffect(() => {
    if (!project || !window.videoAnalyzer) return;
    const unsubscribe = window.videoAnalyzer.onAnalysisProgress((event) => {
      if (event.projectId !== project.id) return;
      setProgress(event.progress);
      setStageLabel(event.stage);
      setDetail(event.message || "");
      recordLog(event.stage, event.message || "");

      // attach 模式下,完成 / 失败要走广播兜底——kickoff 路径已通过 await 结果自己处理。
      if (!inAttachMode.current || !window.videoAnalyzer) return;
      if (event.stage === "完成" && event.progress >= 100 && !completionHandledRef.current) {
        completionHandledRef.current = true;
        void (async () => {
          try {
            const [nodes, report] = await Promise.all([
              window.videoAnalyzer!.getNodes(project.id),
              window.videoAnalyzer!.getReport(project.id),
            ]);
            if (nodes && nodes.length) setNodesForProject(project.id, nodes);
            if (report) setReportForProject(project.id, report);
            setProjects(prev => prev.map(p => p.id === project.id
              ? { ...p, status: "completed", updatedAt: new Date().toISOString() }
              : p));
            window.setTimeout(() => setCurrentScreen("workspace"), 800);
          } catch (err) {
            console.warn("attach completion fetch 失败", err);
          }
        })();
      } else if (event.stage === "失败" && !failureHandledRef.current) {
        failureHandledRef.current = true;
        const msg = event.message || "分析失败";
        setError(msg);
        recordLog("失败", msg);
        setProjects(prev => prev.map(p => p.id === project.id
          ? { ...p, status: "failed", updatedAt: new Date().toISOString() }
          : p));
      }
    });
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id]);

  // Kick off the analysis exactly once per project; survives StrictMode double-invoke via the ref guard.
  // downloading 阶段不起分析,等异步下载完成 (AppContext 把 status 切到 analyzing) 后再触发。
  useEffect(() => {
    if (!project || hasStarted.current) return;
    if (project.status === "downloading") {
      // 下载进度通过 onAnalysisProgress (stage="下载视频") 已经在另一个 effect 里订阅。
      // 这里只把 UI 初始 stage label 设好,等 status 切换后 effect 重跑进入分析 kickoff。
      if (!stageLabel || stageLabel === STAGES[0]) setStageLabel("下载视频");
      return;
    }
    if (project.status === "download_failed") {
      setError("视频下载失败,请检查链接或换一个再试。");
      return;
    }
    hasStarted.current = true;
    // 从 downloading 切到 analyzing 时,把进度重置回 0,避免下载条 100% 直接接到分析条 0%。
    setProgress(0);
    setStageLabel(STAGES[0]);
    startedAt.current = Date.now();

    if (!window.videoAnalyzer) {
      // Browser preview: simulate progress
      let currentProgress = 0;
      const totalTime = 3000;
      const intervalTime = 100;
      const progressStep = 100 / (totalTime / intervalTime);

      const timer = setInterval(() => {
        currentProgress += progressStep;
        if (currentProgress >= 100) {
          clearInterval(timer);
          setProgress(100);
          setStageLabel(STAGES[STAGES.length - 1]);
          recordLog(STAGES[STAGES.length - 1], "完成");
          setNodesForProject(project.id, generateMockNodes(project.durationSec));
          setReportForProject(project.id, generateMockReport());
          setProjects(prev => prev.map(p => p.id === project.id ? { ...p, status: "completed", updatedAt: new Date().toISOString() } : p));
          setTimeout(() => setCurrentScreen("workspace"), 500);
        } else {
          setProgress(currentProgress);
          const nextIndex = Math.min(STAGES.length - 1, Math.floor((currentProgress / 100) * STAGES.length));
          const label = STAGES[nextIndex];
          setStageLabel(label);
          recordLog(label, "");
        }
      }, intervalTime);

      return () => clearInterval(timer);
    }

    const provider = providers.find(p => p.id === (project.providerId || activeVideoProviderId)) || providers.find(p => p.kind === "video") || providers[0];
    const audioProvider = activeAudioProviderId
      ? providers.find(p => p.id === activeAudioProviderId && p.kind === "audio")
      : undefined;
    const options: AnalysisOptions = project.analysisOptions || { mode: "standard", density: "standard", focus: "all" };

    const applyProgressSnapshot = (snap: { progress: number; stage: string; message?: string } | null | undefined) => {
      if (!snap) return;
      setProgress(snap.progress);
      setStageLabel(snap.stage);
      setDetail(snap.message || "");
      recordLog(snap.stage, snap.message || "");
    };

    const launchOrAttach = async () => {
      const alreadyRunning = await window.videoAnalyzer!.isAnalysisActive(project.id);
      if (alreadyRunning) {
        inAttachMode.current = true;
        try {
          const last = await window.videoAnalyzer!.getLastAnalysisProgress(project.id);
          if (last) applyProgressSnapshot(last);
          else setStageLabel("后台分析任务运行中");
        } catch {
          setStageLabel("后台分析任务运行中");
        }
        return;
      }
      try {
        const result = await window.videoAnalyzer!.analyzeProject({ project, provider, audioProvider, options });
        if (cancelledRef.current) return;
        setNodesForProject(project.id, result.nodes);
        setReportForProject(project.id, result.report);
        setProjects(prev => prev.map(p => p.id === project.id ? result.project : p));
        setProgress(100);
        setStageLabel("完成");
        recordLog("完成", "全部步骤已结束");
        window.setTimeout(() => setCurrentScreen("workspace"), 1800);
      } catch (err) {
        if (cancelledRef.current) return;
        const message = err instanceof Error ? err.message : String(err);
        if (/cancel|取消/i.test(message)) return;
        setError(message);
        recordLog("失败", message);
        setProjects(prev => prev.map(p => p.id === project.id ? { ...p, status: "failed", updatedAt: new Date().toISOString() } : p));
      }
    };
    launchOrAttach();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id, project?.status]);

  if (!project) return null;

  const presetLabel = (() => {
    const opts = project.analysisOptions;
    if (!opts) return "标准拉片";
    if (opts.mode === "quick" && opts.density === "sparse") return "轻拉片";
    if (opts.mode === "detailed" && opts.density === "dense") return "深度拉片";
    if (opts.mode === "standard" && opts.density === "standard") return "标准拉片";
    return "自定义";
  })();

  return (
    <main className="flex-1 overflow-y-auto bg-slate-50 dark:bg-[#0c0d10]">
      <div className="max-w-3xl mx-auto px-8 pt-10 pb-24 space-y-5">

        {/* Top bar */}
        <div className="flex items-center justify-between">
          <div className="text-[11px] font-mono uppercase tracking-wider text-slate-500">Screen · Progress</div>
          <div className="flex items-center gap-3 text-[11px] font-mono uppercase tracking-wider text-slate-500">
            <span className="inline-flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 animate-pulse" />
              {project.status === "downloading" ? "下载中" : "分析中"} · {presetLabel}
            </span>
            <span>已用 {formatElapsed(elapsedMs)}</span>
          </div>
        </div>

        <h1 className="text-[22px] font-semibold tracking-tight text-slate-900 dark:text-slate-100">
          正在拉片,你可以放着不管。
        </h1>

        {/* Hero */}
        <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#14151a] p-6 md:p-7">
          <div className="flex items-end justify-between gap-4 mb-5">
            <div className="min-w-0">
              <div className="text-[11px] font-mono uppercase tracking-wider text-slate-500 mb-1">当前任务</div>
              <h2 className="text-[18px] font-semibold tracking-tight text-slate-900 dark:text-slate-100 truncate" title={project.videoName}>
                {project.videoName}
              </h2>
              <div className="font-mono text-[11px] uppercase tracking-wider text-slate-500 mt-1">
                {formatElapsed(project.durationSec * 1000)} · {presetLabel}
              </div>
            </div>
            <div className="text-right shrink-0">
              <div className="font-mono text-[22px] font-medium leading-none text-slate-900 dark:text-slate-100 tabular-nums">
                {etaMs == null ? "—" : etaMs === 0 ? "✓ 完成" : formatEta(etaMs)}
              </div>
              <div className="font-mono text-[10.5px] uppercase tracking-wider text-slate-500 mt-1.5">
                {etaMs == null ? "正在估算" : etaMs === 0 ? "已完成" : "预计剩余"}
              </div>
            </div>
          </div>

          <div className="h-2 bg-slate-200 dark:bg-slate-800 rounded-full overflow-hidden mb-2 relative">
            <div
              className="h-full bg-gradient-to-r from-indigo-500 to-indigo-700 rounded-full transition-all duration-300 relative overflow-hidden"
              style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
            >
              <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/30 to-transparent animate-[shimmer_1.8s_linear_infinite]" style={{ animation: "shimmer 1.8s linear infinite" }} />
            </div>
          </div>
          <div className="flex justify-between font-mono text-[11px] uppercase tracking-wider text-slate-500">
            <span>已完成 <strong className="font-medium text-slate-900 dark:text-slate-100">{currentStageIndex + 1} / {STAGES.length}</strong> 步</span>
            <span><strong className="font-medium text-slate-900 dark:text-slate-100 tabular-nums">{Math.round(progress)}%</strong></span>
          </div>
        </section>

        {error && (
          <div className="rounded-lg border border-rose-200 dark:border-rose-900/40 bg-rose-50 dark:bg-rose-950/30 px-3.5 py-2.5 text-[13px] text-rose-700 dark:text-rose-300">
            {error}
          </div>
        )}

        {/* Stage cards */}
        <section className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
          <div className="rounded-xl border border-indigo-200 dark:border-indigo-900 bg-indigo-50 dark:bg-indigo-950/30 p-4 md:p-5">
            <div className="font-mono text-[10.5px] uppercase tracking-wider text-indigo-700 dark:text-indigo-300 mb-1.5 font-medium">当前步骤</div>
            <div className="text-[15px] font-semibold tracking-tight text-slate-900 dark:text-slate-100">
              {stageLabel}
            </div>
            {detail && (
              <div className="font-mono text-[11.5px] text-slate-700 dark:text-slate-300 mt-2 leading-relaxed">
                {detail}
              </div>
            )}
          </div>

          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#14151a] p-4 md:p-5">
            <div className="font-mono text-[10.5px] uppercase tracking-wider text-slate-500 mb-2 font-medium">流水线</div>
            <ul className="space-y-1.5">
              {STAGES.map((s, idx) => {
                const isDownloading = project.status === "downloading";
                const done = !isDownloading && (idx < currentStageIndex || progress >= 100);
                const active = !isDownloading && idx === currentStageIndex && progress < 100;
                return (
                  <li key={s} className="flex items-center gap-2 font-mono text-[11.5px]">
                    {done ? (
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                    ) : active ? (
                      <span className="w-3.5 h-3.5 grid place-items-center shrink-0">
                        <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 animate-pulse" />
                      </span>
                    ) : (
                      <span className="w-3.5 h-3.5 grid place-items-center shrink-0">
                        <span className="w-1.5 h-1.5 rounded-full bg-slate-300 dark:bg-slate-700" />
                      </span>
                    )}
                    <span className={done ? "text-slate-700 dark:text-slate-300" : active ? "text-slate-900 dark:text-slate-100 font-medium" : "text-slate-400 dark:text-slate-600"}>
                      {s}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        </section>

        {/* Live log */}
        <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#0e0e10] p-4 md:px-5 md:py-4">
          <div className="font-mono text-[10.5px] uppercase tracking-wider text-slate-500 mb-2 font-medium">实时日志</div>
          {logs.length === 0 ? (
            <div className="font-mono text-[11.5px] text-slate-400">等待第一条日志…</div>
          ) : (
            <div className="space-y-0.5 max-h-[140px] overflow-y-auto">
              {logs.map((log, idx) => (
                <div key={idx} className="flex gap-3 font-mono text-[11.5px] leading-relaxed">
                  <span className="text-slate-400 shrink-0 tabular-nums w-12">{formatElapsed(log.ts)}</span>
                  <span className={
                    log.tone === "ok" ? "text-emerald-600 dark:text-emerald-400" :
                    log.tone === "warn" ? "text-amber-600 dark:text-amber-400" :
                    "text-slate-700 dark:text-slate-300"
                  }>
                    <span className="text-slate-500 dark:text-slate-500">{log.stage}</span>
                    {log.message && <span className="text-slate-400 mx-1">·</span>}
                    {log.message}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Actions */}
        <div className="flex justify-end gap-2.5">
          <button
            type="button"
            onClick={handleCancel}
            disabled={isCancelling}
            className="inline-flex items-center h-10 px-4 rounded-lg text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 text-[13.5px] transition-colors disabled:opacity-50"
          >
            {isCancelling ? "正在取消…" : "取消"}
          </button>
          <button
            type="button"
            onClick={handleBackground}
            className="inline-flex items-center gap-1.5 h-10 px-5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-[13.5px] font-medium transition-colors"
          >
            后台运行
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>

      </div>

      <style>{`
        @keyframes shimmer {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(100%); }
        }
      `}</style>
    </main>
  );
}
