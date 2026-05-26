import { useApp } from "../AppContext";
import { useEffect, useMemo, useRef, useState } from "react";
import { generateMockNodes, generateMockReport } from "../mockData";
import { ArrowRight, CheckCircle2, Settings } from "lucide-react";
import { PIPELINE_STAGE_DEFS, type AnalysisOptions } from "../types";

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

export function ProgressScreen() {
  const {
    setCurrentScreen, activeProjectId, projects, setProjects,
    providers, activeVideoProviderId, activeAudioProviderId,
    setNodesForAnalysis, setReportForAnalysis, progressByAnalysis, pipelineByAnalysis,
    budgetByAnalysis, activeAnalysisForProject, setBudgetForAnalysis, startAnalysisForProject,
    analysisRecordsByProject, refreshAnalysisRecords,
  } = useApp();

  const project = projects.find(p => p.id === activeProjectId);

  const isUrlSource = project?.source?.type === "url";
  const visibleStageDefs = PIPELINE_STAGE_DEFS.filter((s) => s.key !== "download" || isUrlSource);

  const analysisActive = project?.status === "analyzing" || project?.status === "downloading";

  const activeAnalysisId = project
    ? (activeAnalysisForProject[project.id] || project.currentAnalysisId)
    : undefined;
  const liveSnapshot = (activeAnalysisId && analysisActive) ? progressByAnalysis[activeAnalysisId] : undefined;
  const pipeline = (activeAnalysisId && analysisActive) ? pipelineByAnalysis[activeAnalysisId] : undefined;
  const budget = (activeAnalysisId && analysisActive) ? budgetByAnalysis[activeAnalysisId] : undefined;

  const [progress, setProgress] = useState(liveSnapshot?.progress ?? 0);
  const [stageLabel, setStageLabel] = useState(liveSnapshot?.stage ?? PIPELINE_STAGE_DEFS[0].label);
  const [detail, setDetail] = useState(liveSnapshot?.message ?? "");
  const [error, setError] = useState("");
  const [isCancelling, setIsCancelling] = useState(false);
  const [nowTick, setNowTick] = useState(() => Date.now());

  const currentAnalysisRecord = useMemo(() => {
    if (!project?.currentAnalysisId) return undefined;
    const records = analysisRecordsByProject[project.id] || [];
    return records.find((r) => r.id === project.currentAnalysisId);
  }, [project?.id, project?.currentAnalysisId, analysisRecordsByProject]);

  const startedAt = useMemo(() => {
    if (currentAnalysisRecord?.startedAt) return new Date(currentAnalysisRecord.startedAt).getTime();
    return Date.now();
  }, [currentAnalysisRecord?.startedAt]);

  // launchedForKey 替代 hasStarted ref: 记录已经发起分析的 project+status 组合键。
  // StrictMode 第二轮 key 相同直接跳过,避免发出两个 analyzeProject IPC。
  // status 真正变化 (downloading→analyzing / failed→analyzing) 时 key 不同,允许重新启动。
  const launchedForKey = useRef<string | null>(null);
  const cancelledRef = useRef(false);
  // attach 模式 = renderer 不是发起者,而是关窗后重开 / 切回 ProgressScreen,挂到已经在跑的分析上。
  // 完成 / 失败的"兜底处理"只在 attach 模式触发,避免跟 kickoff 路径的 await 结果重复。
  const inAttachMode = useRef(false);
  const completionHandledRef = useRef(false);
  const failureHandledRef = useRef(false);

  // project 切换时重置 UI 状态和流程 ref。
  useEffect(() => {
    if (!project) return;
    const snap = (activeAnalysisId && analysisActive) ? progressByAnalysis[activeAnalysisId] : undefined;
    setProgress(snap?.progress ?? 0);
    setStageLabel(snap?.stage ?? visibleStageDefs[0].label);
    setDetail(snap?.message ?? "");
    setError("");
    setIsCancelling(false);
    completionHandledRef.current = false;
    failureHandledRef.current = false;
    launchedForKey.current = null;
    cancelledRef.current = false;
    inAttachMode.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id]);

  useEffect(() => {
    if (progress >= 100 || !analysisActive) return;
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [progress, analysisActive]);

  const elapsedMs = useMemo(() => {
    if (!analysisActive) return 0;
    void progress; void nowTick;
    return Date.now() - startedAt;
  }, [analysisActive, progress, nowTick, startedAt]);

  // 追踪当前 stage 进入时刻, 用于 budget-based ETA 算"当前 stage 剩余预算"。
  const stageStartedAtRef = useRef<{ stage: string; ts: number }>({ stage: stageLabel, ts: Date.now() });
  useEffect(() => {
    if (stageStartedAtRef.current.stage !== stageLabel) {
      stageStartedAtRef.current = { stage: stageLabel, ts: Date.now() };
    }
  }, [stageLabel]);

  const etaMs = useMemo(() => {
    void nowTick;
    if (!analysisActive) return null;
    if (progress >= 100) return 0;
    // 优先用 main 推过来的 budget: 剩余 = sum(后续 stages estMs) + max(0, currentStage estMs - elapsedInCurrent)
    // stage prefix 匹配从后往前找最长 (例: "主分析(审计)" 优先于 "主分析")
    if (budget && budget.stages.length > 0) {
      let idx = -1;
      for (let i = budget.stages.length - 1; i >= 0; i--) {
        if (stageLabel.startsWith(budget.stages[i].stage)) { idx = i; break; }
      }
      if (idx >= 0) {
        const currentStage = budget.stages[idx];
        const elapsedInCurrent = Date.now() - stageStartedAtRef.current.ts;
        const remainingInCurrent = Math.max(0, currentStage.estMs - elapsedInCurrent);
        const remainingAfter = budget.stages.slice(idx + 1).reduce((sum, s) => sum + s.estMs, 0);
        return remainingInCurrent + remainingAfter;
      }
      // stage label 还没在 budget 里出现 (例: 刚启动, label 是占位的 PIPELINE_STAGE_DEFS[0].label) → 给总预算
      if (progress < 1) return budget.totalMs;
    }
    // fallback: 老的线性外推 (没 budget 或者 stage label 完全对不上)
    if (progress < 5 || elapsedMs < 1500) return null;
    const total = elapsedMs / (progress / 100);
    return Math.max(0, total - elapsedMs);
  }, [budget, stageLabel, progress, elapsedMs, nowTick]);


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
    setProjects(prev => prev.map(p => p.id === project.id ? { ...p, status: "failed", updatedAt: new Date().toISOString() } : p));
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
      if (!launchedForKey.current) return;
      if (activeAnalysisId && event.analysisId && event.analysisId !== activeAnalysisId) {
        console.debug("[ProgressScreen] 忽略非当前分析的事件", event.analysisId, "期望", activeAnalysisId, event.stage);
        return;
      }
      setProgress(event.progress);
      setStageLabel(event.stage);
      setDetail(event.message || "");
      // 阶段进度由 AppContext 全局订阅统一写到 pipelineByAnalysis。

      // attach 模式下,完成 / 失败要走广播兜底——kickoff 路径已通过 await 结果自己处理。
      if (!inAttachMode.current || !window.videoAnalyzer) return;
      if (event.stage === "完成" && event.progress >= 100 && !completionHandledRef.current) {
        completionHandledRef.current = true;
        const aid = event.analysisId || project.currentAnalysisId;
        if (!aid) return;
        void (async () => {
          try {
            const [nodes, report] = await Promise.all([
              window.videoAnalyzer!.getNodes(aid),
              window.videoAnalyzer!.getReport(aid),
            ]);
            if (nodes && nodes.length) setNodesForAnalysis(aid, nodes);
            if (report) setReportForAnalysis(aid, report);
            setProjects(prev => prev.map(p => p.id === project.id
              ? { ...p, status: "completed", currentAnalysisId: aid, updatedAt: new Date().toISOString() }
              : p));
            refreshAnalysisRecords(project.id);
            window.setTimeout(() => setCurrentScreen("workspace"), 800);
          } catch (err) {
            console.warn("attach completion fetch 失败", err);
          }
        })();
      } else if (event.stage === "失败" && !failureHandledRef.current) {
        failureHandledRef.current = true;
        const msg = event.message || "分析失败";
        setError(msg);
        const now = new Date().toISOString();
        setProjects(prev => prev.map(p => p.id === project.id
          ? { ...p, status: "failed", updatedAt: now }
          : p));
        refreshAnalysisRecords(project.id);
      }
    });
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id]);

  // Kick off the analysis exactly once per project+status 组合。
  // 用 launchedForKey 代替 hasStarted ref: StrictMode 第二轮 key 相同跳过,
  // status 真正变化 (downloading→analyzing, failed→analyzing) 时 key 不同,允许重新启动。
  useEffect(() => {
    if (!project) return;
    const key = `${project.id}:${project.status}`;
    if (launchedForKey.current === key) return;
    setError("");
    if (project.status === "downloading") {
      if (!stageLabel || stageLabel === PIPELINE_STAGE_DEFS[0].label) setStageLabel("下载视频");
      return;
    }
    if (project.status === "download_failed") {
      setProgress(0);
      setError("视频下载失败,请检查链接或换一个再试。");
      return;
    }
    if (project.status === "failed") {
      setProgress(0);
      setError(currentAnalysisRecord?.lastErrorMessage || "上次分析失败。点击下方'重试'重新运行。");
      setStageLabel("已结束 · 失败");
      return;
    }
    if (project.status === "completed") {
      window.setTimeout(() => setCurrentScreen("workspace"), 0);
      return;
    }
    launchedForKey.current = key;
    // 从 downloading 切到 analyzing 时,把进度重置回 0,避免下载条 100% 直接接到分析条 0%。
    setProgress(0);
    setStageLabel(visibleStageDefs[0].label);
    // startedAt 从当前 AnalysisRecord.startedAt 派生, main 进程创建分析记录时写入。

    if (!window.videoAnalyzer) {
      // Browser preview: simulate progress
      let currentProgress = 0;
      const totalTime = 3000;
      const intervalTime = 100;
      const progressStep = 100 / (totalTime / intervalTime);

      // 浏览器预览模式 (没有 window.videoAnalyzer) 不经 main 进程 broadcast,
      // 浏览器预览模式不经 main 进程 broadcast, pipelineByAnalysis 不更新。
      const timer = setInterval(() => {
        currentProgress += progressStep;
        if (currentProgress >= 100) {
          clearInterval(timer);
          setProgress(100);
          setStageLabel(PIPELINE_STAGE_DEFS[PIPELINE_STAGE_DEFS.length - 1].label);
          const mockAnalysisId = `mock-${project.id}`;
          setNodesForAnalysis(mockAnalysisId, generateMockNodes(project.durationSec));
          setReportForAnalysis(mockAnalysisId, generateMockReport());
          setProjects(prev => prev.map(p => p.id === project.id ? { ...p, status: "completed", updatedAt: new Date().toISOString() } : p));
          setTimeout(() => setCurrentScreen("workspace"), 500);
        } else {
          setProgress(currentProgress);
          const nextIndex = Math.min(PIPELINE_STAGE_DEFS.length - 1, Math.floor((currentProgress / 100) * PIPELINE_STAGE_DEFS.length));
          setStageLabel(PIPELINE_STAGE_DEFS[nextIndex].label);
        }
      }, intervalTime);

      return () => clearInterval(timer);
    }

    const provider = providers.find(p => p.id === activeVideoProviderId) || providers.find(p => p.kind === "video") || providers[0];
    const audioProvider = activeAudioProviderId
      ? providers.find(p => p.id === activeAudioProviderId && p.kind === "audio")
      : undefined;
    const options: AnalysisOptions = currentAnalysisRecord?.analysisOptions || { mode: "standard", density: "standard", focus: "all" };

    const applyProgressSnapshot = (snap: { progress: number; stage: string; message?: string } | null | undefined) => {
      if (!snap) return;
      setProgress(snap.progress);
      setStageLabel(snap.stage);
      setDetail(snap.message || "");
      // 这是 main 端的 lastProgress 一次性回灌, 真实事件流走 AppContext 全局订阅 → pipelineByAnalysis。
    };

    const launchOrAttach = async () => {
      const alreadyRunning = await window.videoAnalyzer!.isAnalysisActive(project.id);
      if (alreadyRunning) {
        inAttachMode.current = true;
        // 进入 attach 模式前清掉上轮的 handled 标记。reset effect 只在 project.id 变化时跑,
        // 重试时 (同 project, status failed → analyzing) 不重置,残留的 true 会让本轮
        // onAnalysisProgress 的 "完成"/"失败" event 静默 (走 !ref.current 防重入)。
        completionHandledRef.current = false;
        failureHandledRef.current = false;
        try {
          const last = await window.videoAnalyzer!.getLastAnalysisProgress(project.id);
          if (last) applyProgressSnapshot(last);
          else setStageLabel("后台分析任务运行中");
        } catch {
          setStageLabel("后台分析任务运行中");
        }
        // attach 模式: budget broadcast 已经在我们订阅前发完了, 拉一次补回 cache
        try {
          const budgetEvt = await window.videoAnalyzer!.getLastAnalysisBudget(project.id);
          if (budgetEvt?.budget && budgetEvt.analysisId) setBudgetForAnalysis(budgetEvt.analysisId, budgetEvt.budget);
        } catch { /* 老 main / 没装 handler → 静默 fallback 到线性外推 */ }
        return;
      }
      try {
        const result = await window.videoAnalyzer!.analyzeProject({ project, provider, audioProvider, options });
        if (cancelledRef.current) return;
        setNodesForAnalysis(result.analysisId, result.nodes);
        setReportForAnalysis(result.analysisId, result.report);
        setProjects(prev => prev.map(p => p.id === project.id ? result.project : p));
        refreshAnalysisRecords(project.id);
        setProgress(100);
        setStageLabel("完成");
        // 完成 / 失败 log 由 main 进程的 "完成" event 走 AppContext 统一记录, 不在这里重复。
        window.setTimeout(() => setCurrentScreen("workspace"), 1800);
      } catch (err) {
        if (cancelledRef.current) return;
        const raw = err instanceof Error ? err.message : String(err);
        const message = raw.replace(/^Error invoking remote method '[^']+': Error: /, "");
        if (/cancel|取消/i.test(message)) return;
        setError(message);
        const now = new Date().toISOString();
        setProjects(prev => prev.map(p => p.id === project.id
          ? { ...p, status: "failed", updatedAt: now }
          : p));
        refreshAnalysisRecords(project.id);
      }
    };
    launchOrAttach();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id, project?.status]);

  if (!project) return null;

  const presetLabel = (() => {
    const opts = currentAnalysisRecord?.analysisOptions;
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
            {analysisActive ? (
              <span className="inline-flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 animate-pulse" />
                {project.status === "downloading" ? "下载中" : "分析中"} · {presetLabel}
              </span>
            ) : (
              <span>{presetLabel}</span>
            )}
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
            <span>已完成 <strong className="font-medium text-slate-900 dark:text-slate-100">{pipeline ? pipeline.stages.filter((s) => (s.key !== "download" || isUrlSource) && s.status === "done").length : 0} / {visibleStageDefs.length}</strong> 步</span>
            <span><strong className="font-medium text-slate-900 dark:text-slate-100 tabular-nums">{Math.round(progress)}%</strong></span>
          </div>
        </section>

        {error && (
          error.includes("设置页") ? (
            <div className="rounded-lg border border-amber-200 dark:border-amber-800/40 bg-amber-50 dark:bg-amber-950/20 px-4 py-3 flex items-center gap-3">
              <span className="text-[13px] text-amber-800 dark:text-amber-200 flex-1">{error}</span>
              <button
                type="button"
                onClick={() => setCurrentScreen("settings")}
                className="inline-flex items-center gap-1.5 shrink-0 px-3 py-1.5 rounded-md bg-amber-600 hover:bg-amber-700 text-white text-[12px] font-medium transition-colors"
              >
                <Settings className="w-3.5 h-3.5" />
                去设置
              </button>
            </div>
          ) : (
            <div className="rounded-lg border border-rose-200 dark:border-rose-900/40 bg-rose-50 dark:bg-rose-950/30 px-3.5 py-2.5 text-[13px] text-rose-700 dark:text-rose-300">
              {error}
            </div>
          )
        )}

        {/* Pipeline stages */}
        <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#14151a] p-4 md:p-5">
          <div className="font-mono text-[10.5px] uppercase tracking-wider text-slate-500 mb-3 font-medium">流水线</div>
          <ul className="space-y-1">
            {(pipeline?.stages ?? PIPELINE_STAGE_DEFS).filter((s) => s.key !== "download" || isUrlSource).map((s) => {
              const idx = (pipeline?.stages ?? PIPELINE_STAGE_DEFS).indexOf(s);
              const stage = pipeline?.stages[idx];
              const done = stage?.status === "done" || progress >= 100;
              const active = stage?.status === "active" && progress < 100;
              const failed = stage?.status === "failed";
              const elapsed = stage?.startedAt
                ? formatElapsed((stage.completedAt || Date.now()) - stage.startedAt)
                : undefined;
              return (
                <li key={s.key ?? idx}>
                  <div className="flex items-center gap-2 font-mono text-[11.5px] py-0.5">
                    {done ? (
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                    ) : failed ? (
                      <span className="w-3.5 h-3.5 grid place-items-center shrink-0">
                        <span className="w-1.5 h-1.5 rounded-full bg-rose-500" />
                      </span>
                    ) : active ? (
                      <span className="w-3.5 h-3.5 grid place-items-center shrink-0">
                        <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 animate-pulse" />
                      </span>
                    ) : (
                      <span className="w-3.5 h-3.5 grid place-items-center shrink-0">
                        <span className="w-1.5 h-1.5 rounded-full bg-slate-300 dark:bg-slate-700" />
                      </span>
                    )}
                    <span className={
                      done ? "text-slate-700 dark:text-slate-300" :
                      failed ? "text-rose-600 dark:text-rose-400" :
                      active ? "text-slate-900 dark:text-slate-100 font-medium" :
                      "text-slate-400 dark:text-slate-600"
                    }>
                      {s.label}
                    </span>
                    {(done || failed) && elapsed && (
                      <span className="text-slate-400 dark:text-slate-600 text-[10px] tabular-nums">{elapsed}</span>
                    )}
                    {stage?.fromCache && (
                      <span className="text-emerald-600 dark:text-emerald-400 text-[10px]">(缓存)</span>
                    )}
                  </div>
                  {stage?.detail && (stage.status === "active" || stage.status === "done" || stage.status === "failed") && (
                    <div className="ml-[22px] pl-3 pb-0.5">
                      <span className="font-mono text-[11px] text-slate-500 dark:text-slate-500">{stage.detail}</span>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>

        {/* Actions */}
        <div className="flex justify-end gap-2.5">
          {project.status === "failed" || project.status === "download_failed" ? (
            <>
              <button
                type="button"
                onClick={() => setCurrentScreen("home")}
                className="inline-flex items-center h-10 px-4 rounded-lg text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 text-[13.5px] transition-colors"
              >
                返回
              </button>
              <button
                type="button"
                onClick={() => startAnalysisForProject(project.id)}
                className="inline-flex items-center gap-1.5 h-10 px-5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-[13.5px] font-medium transition-colors"
              >
                重试分析
                <ArrowRight className="w-4 h-4" />
              </button>
            </>
          ) : (
            <>
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
            </>
          )}
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
