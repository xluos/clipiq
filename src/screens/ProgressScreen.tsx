import { useApp } from "../AppContext";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useEffect, useRef, useState } from "react";
import { generateMockNodes, generateMockReport } from "../mockData";
import { CheckCircle2, ChevronRight, Loader2 } from "lucide-react";
import type { AnalysisOptions } from "../types";

const STAGES = [
  "读取视频元数据…",
  "检测镜头切换点…",
  "抽取关键帧…",
  "准备模型上下文…",
  "分析画面语义…",
  "分析音频与叙事…",
  "构建时间线节点…",
  "生成最终报告…"
];

export function ProgressScreen() {
  const { setCurrentScreen, activeProjectId, projects, setProjects, providers, activeVideoProviderId, activeAudioProviderId, setNodesForProject, setReportForProject } = useApp();
  const [progress, setProgress] = useState(0);
  const [stageIndex, setStageIndex] = useState(0);
  const [stageLabel, setStageLabel] = useState(STAGES[0]);
  const [detail, setDetail] = useState("");
  const [error, setError] = useState("");
  const [isCancelling, setIsCancelling] = useState(false);
  const hasStarted = useRef(false);
  const cancelledRef = useRef(false);

  const project = projects.find(p => p.id === activeProjectId);

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

  useEffect(() => {
    if (!project || hasStarted.current) return;
    hasStarted.current = true;

    if (!window.videoAnalyzer) {
    let currentProgress = 0;
      const totalTime = 3000;
    const intervalTime = 100;
    const progressStep = 100 / (totalTime / intervalTime);
    
    const timer = setInterval(() => {
      currentProgress += progressStep;
      if (currentProgress >= 100) {
        clearInterval(timer);
        setProgress(100);
        setStageIndex(STAGES.length - 1);
        
        // Finalize
          setNodesForProject(project.id, generateMockNodes(project.durationSec));
          setReportForProject(project.id, generateMockReport());
          setProjects(prev => prev.map(p => p.id === project.id ? { ...p, status: "completed", updatedAt: new Date().toISOString() } : p));
        
        setTimeout(() => {
          setCurrentScreen("workspace");
        }, 500);
      } else {
        setProgress(currentProgress);
          const nextIndex = Math.min(STAGES.length - 1, Math.floor((currentProgress / 100) * STAGES.length));
          setStageIndex(nextIndex);
          setStageLabel(STAGES[nextIndex]);
      }
    }, intervalTime);

    return () => clearInterval(timer);
    }

    const provider = providers.find(p => p.id === (project.providerId || activeVideoProviderId)) || providers.find(p => p.kind === "video") || providers[0];
    const audioProvider = activeAudioProviderId
      ? providers.find(p => p.id === activeAudioProviderId && p.kind === "audio")
      : undefined;
    const options: AnalysisOptions = project.analysisOptions || { mode: "standard", density: "standard", focus: "all" };
    const unsubscribe = window.videoAnalyzer.onAnalysisProgress((event) => {
      if (event.projectId !== project.id) return;
      setProgress(event.progress);
      setStageLabel(event.stage);
      setDetail(event.message || "");
      setStageIndex(Math.min(STAGES.length - 1, Math.floor((event.progress / 100) * STAGES.length)));
    });

    const launchOrAttach = async () => {
      const alreadyRunning = await window.videoAnalyzer!.isAnalysisActive(project.id);
      if (alreadyRunning) {
        // Another mount/window already kicked off; just listen to progress events until project state
        // updates to completed via the main-process .then handler that ProgressScreen owns.
        setStageLabel("继续监听后台分析任务");
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
        window.setTimeout(() => setCurrentScreen("workspace"), 500);
      } catch (err) {
        if (cancelledRef.current) return;
        const message = err instanceof Error ? err.message : String(err);
        if (/cancel|取消/i.test(message)) return;
        setError(message);
        setProjects(prev => prev.map(p => p.id === project.id ? { ...p, status: "failed", updatedAt: new Date().toISOString() } : p));
      }
    };
    launchOrAttach();

    return unsubscribe;
  }, [project?.id]);

  return (
    <div className="flex-1 flex flex-col items-center justify-center bg-slate-50 dark:bg-[#0A0A0B] p-6">
      <div className="w-full max-w-xl space-y-8">
        <div className="text-center space-y-2">
          <h2 className="text-2xl font-semibold tracking-tight text-slate-800 dark:text-slate-100">正在分析视频</h2>
          <p className="text-slate-500 truncate max-w-sm mx-auto">{project?.videoName}</p>
        </div>

        <div className="space-y-4">
          <Progress value={progress} className="h-2 bg-slate-200 dark:bg-slate-800" />
          <div className="flex justify-between text-sm text-slate-500 font-mono">
            <span>{Math.round(progress)}%</span>
            <span>{stageLabel}</span>
          </div>
        </div>

        {detail && (
          <div className="rounded-lg border border-indigo-200 bg-indigo-50 px-4 py-3 text-sm text-indigo-700 dark:border-indigo-500/20 dark:bg-indigo-500/10 dark:text-indigo-300">
            {detail}
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-300">
            {error}
          </div>
        )}

        <div className="bg-white dark:bg-slate-900/50 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4 shadow-sm dark:shadow-none">
          {STAGES.map((stage, idx) => {
            const isActive = idx === stageIndex;
            const isDone = idx < stageIndex || progress === 100;
            return (
              <div 
                key={idx} 
                className={`flex items-center space-x-3 transition-opacity duration-300 ${isDone || isActive ? 'opacity-100' : 'opacity-30'}`}
              >
                <div className="w-6 h-6 flex items-center justify-center shrink-0">
                  {isDone ? (
                    <CheckCircle2 className="w-5 h-5 text-emerald-500" />
                  ) : isActive ? (
                    <Loader2 className="w-5 h-5 text-indigo-500 animate-spin" />
                  ) : (
                    <div className="w-2 h-2 rounded-full bg-slate-300 dark:bg-slate-700" />
                  )}
                </div>
                <span className={`text-sm ${isActive ? 'text-indigo-600 dark:text-slate-100 font-medium' : 'text-slate-500'}`}>
                  {isActive ? stageLabel : stage}
                </span>
              </div>
            );
          })}
        </div>

        <div className="flex justify-center pt-4">
          <Button variant="ghost" onClick={handleCancel} disabled={isCancelling} className="text-slate-500 hover:text-slate-900 dark:hover:text-slate-100">
            {isCancelling ? "正在取消..." : "取消分析"}
          </Button>
          <Button variant="secondary" onClick={handleBackground} className="ml-4 bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700">
            后台运行
          </Button>
        </div>
      </div>
    </div>
  );
}
