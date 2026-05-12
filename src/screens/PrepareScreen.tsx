import { useApp } from "../AppContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { AlertTriangle, ArrowLeft, Play, LayoutGrid } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AnalysisOptions } from "../types";
import type { RuntimeStatus } from "../electron-api";

export function PrepareScreen() {
  const { setCurrentScreen, projects, setProjects, activeProjectId, providers, activeVideoProviderId } = useApp();
  
  const project = projects.find(p => p.id === activeProjectId);
  const provider = providers.find(p => p.id === activeVideoProviderId);
  
  const videoRef = useRef<HTMLVideoElement>(null);
  const [mode, setMode] = useState<AnalysisOptions["mode"]>(project?.analysisOptions?.mode || "standard");
  const [density, setDensity] = useState<AnalysisOptions["density"]>(project?.analysisOptions?.density || "standard");
  const [focus, setFocus] = useState<AnalysisOptions["focus"]>(project?.analysisOptions?.focus || "all");
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus | null>(null);
  const [runtimeChecked, setRuntimeChecked] = useState(false);

  useEffect(() => {
    if (!window.videoAnalyzer) {
      setRuntimeChecked(true);
      return;
    }
    window.videoAnalyzer
      .getRuntimeStatus()
      .then((status) => setRuntimeStatus(status))
      .catch(() => setRuntimeStatus(null))
      .finally(() => setRuntimeChecked(true));
  }, []);

  const missingDeps: string[] = [];
  if (window.videoAnalyzer && runtimeChecked) {
    if (!runtimeStatus?.ffmpeg) missingDeps.push("ffmpeg");
    if (!runtimeStatus?.ffprobe) missingDeps.push("ffprobe");
  }
  const hasMissingDeps = missingDeps.length > 0;
  const missingApiKey = !provider?.apiKeyRef;

  if (!project) {
    return null;
  }

  const formatDuration = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  const handleStartAnalysis = () => {
    if (project) {
      setProjects(prev => prev.map(p => p.id === project.id ? {
        ...p,
        status: "analyzing",
        providerId: activeVideoProviderId || undefined,
        model: provider?.model,
        analysisOptions: { mode, density, focus },
        updatedAt: new Date().toISOString()
      } : p));
    }
    setCurrentScreen("progress");
  };

  return (
    <div className="flex-1 flex flex-col md:flex-row bg-slate-50 dark:bg-[#0A0A0B] p-6 md:p-8 gap-8 overflow-hidden h-full">
      <div className="flex-1 flex flex-col min-h-0">
        <Button variant="ghost" onClick={() => setCurrentScreen("home")} className="self-start mb-4 -ml-4 text-slate-500 hover:text-slate-900 dark:hover:text-slate-100">
          <ArrowLeft className="w-4 h-4 mr-2" />
          返回首页
        </Button>
        
        <div className="flex-1 rounded-xl overflow-hidden bg-slate-200/50 dark:bg-slate-900 border border-slate-300 dark:border-slate-800 relative flex items-center justify-center min-h-0">
          <video 
            ref={videoRef}
            src={project.localVideoPath} 
            className="w-full h-full object-contain"
            controls
          />
        </div>
      </div>

      <div className="w-full md:w-[400px] flex flex-col min-h-0 space-y-6 overflow-y-auto pr-2">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight text-slate-800 dark:text-slate-100 truncate" title={project.videoName}>
            {project.videoName}
          </h2>
          <div className="flex items-center space-x-3 text-sm text-slate-500 mt-2">
            <span>{formatDuration(project.durationSec)}</span>
            <span>&bull;</span>
            <span>{project.width}x{project.height}</span>
            <span>&bull;</span>
            <span>{project.orientation === "portrait" ? "竖屏" : project.orientation === "square" ? "方形" : "横屏"}</span>
          </div>
        </div>

        <Card className="bg-white dark:bg-slate-900/50 border-slate-200 dark:border-slate-800 shadow-sm dark:shadow-none">
          <CardContent className="p-6 space-y-6">
            <div className="space-y-2">
              <Label>分析模式</Label>
              <Select value={mode} onValueChange={(value) => setMode(value as AnalysisOptions["mode"])}>
                <SelectTrigger className="bg-slate-50 dark:bg-[#0A0A0B] border-slate-200 dark:border-slate-800">
                  <SelectValue placeholder="选择分析模式" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="quick">快速概览</SelectItem>
                  <SelectItem value="standard">标准分析</SelectItem>
                  <SelectItem value="detailed">深度拆解</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>节点密度</Label>
              <Select value={density} onValueChange={(value) => setDensity(value as AnalysisOptions["density"])}>
                <SelectTrigger className="bg-slate-50 dark:bg-[#0A0A0B] border-slate-200 dark:border-slate-800">
                  <SelectValue placeholder="选择节点密度" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="sparse">稀疏（只保留关键时刻）</SelectItem>
                  <SelectItem value="standard">标准</SelectItem>
                  <SelectItem value="dense">密集（每次切镜都标）</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>关注重点</Label>
              <Select value={focus} onValueChange={(value) => setFocus(value as AnalysisOptions["focus"])}>
                <SelectTrigger className="bg-slate-50 dark:bg-[#0A0A0B] border-slate-200 dark:border-slate-800">
                  <SelectValue placeholder="选择关注重点" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">综合</SelectItem>
                  <SelectItem value="narrative">叙事结构</SelectItem>
                  <SelectItem value="rhythm">剪辑节奏</SelectItem>
                  <SelectItem value="emotion">情绪曲线</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="p-3 rounded-lg bg-slate-50 dark:bg-[#0A0A0B] border border-slate-200 dark:border-slate-800 text-sm space-y-1">
              <div className="text-slate-500 text-xs font-semibold uppercase tracking-widest mb-2">模型配置</div>
              <div className="flex justify-between">
                <span className="text-slate-500 dark:text-slate-400">Provider</span>
                <span className="font-medium text-slate-700 dark:text-slate-200">{provider?.name}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500 dark:text-slate-400">模型</span>
                <span className="font-medium font-mono text-slate-700 dark:text-slate-200">{provider?.model}</span>
              </div>
            </div>
          </CardContent>
        </Card>

        <div className="flex-1" />

        <div className="pt-4 border-t border-slate-200 dark:border-slate-800 space-y-3">
          {hasMissingDeps && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                未检测到 {missingDeps.join("、")}，需要先安装才能进行真实拉片分析。
                <button
                  type="button"
                  onClick={() => setCurrentScreen("settings")}
                  className="ml-1 underline underline-offset-2 hover:text-amber-900 dark:hover:text-amber-200"
                >
                  打开设置
                </button>
              </span>
            </div>
          )}
          {!hasMissingDeps && missingApiKey && (
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600 dark:border-slate-800 dark:bg-slate-900/40 dark:text-slate-400">
              当前未配置模型 API Key，将仅生成基于关键帧的本地启发式节点。
            </div>
          )}
          {project.status === "completed" && (
            <Button variant="secondary" className="w-full bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700" onClick={() => setCurrentScreen("workspace")}>
              <LayoutGrid className="w-4 h-4 mr-2" />
              查看已有分析
            </Button>
          )}
          <Button
            size="lg"
            className="w-full bg-blue-600 hover:bg-blue-700 text-white disabled:bg-slate-400 disabled:hover:bg-slate-400"
            onClick={handleStartAnalysis}
            disabled={hasMissingDeps}
          >
            <Play className="w-4 h-4 mr-2 fill-current" />
            {project.status === "completed" ? "重新分析" : "开始分析"}
          </Button>
        </div>
      </div>
    </div>
  );
}
