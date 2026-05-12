import { useApp } from "../AppContext";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useEffect, useState } from "react";
import { generateMockNodes, generateMockReport } from "../mockData";
import { CheckCircle2, ChevronRight, Loader2 } from "lucide-react";

const STAGES = [
  "Reading video metadata...",
  "Detecting shot boundaries...",
  "Extracting keyframes...",
  "Preparing model context...",
  "Analyzing visual semantic language...",
  "Analyzing audio and narrative...",
  "Structuring timeline data...",
  "Finalizing report..."
];

export function ProgressScreen() {
  const { setCurrentScreen, activeProjectId, projects, setProjects, setNodesForProject, setReportForProject } = useApp();
  const [progress, setProgress] = useState(0);
  const [stageIndex, setStageIndex] = useState(0);
  
  const project = projects.find(p => p.id === activeProjectId);

  useEffect(() => {
    if (!project) return;
    
    // Simulate complex analysis process
    let currentProgress = 0;
    const totalTime = 8000; // 8 seconds mock waiting
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
        setProjects(prev => prev.map(p => p.id === project.id ? { ...p, status: "completed" } : p));
        
        setTimeout(() => {
          setCurrentScreen("workspace");
        }, 500);
      } else {
        setProgress(currentProgress);
        setStageIndex(Math.floor((currentProgress / 100) * STAGES.length));
      }
    }, intervalTime);

    return () => clearInterval(timer);
  }, [project, setNodesForProject, setReportForProject, setProjects, setCurrentScreen]);

  return (
    <div className="flex-1 flex flex-col items-center justify-center bg-slate-50 dark:bg-[#0A0A0B] p-6">
      <div className="w-full max-w-xl space-y-8">
        <div className="text-center space-y-2">
          <h2 className="text-2xl font-semibold tracking-tight text-slate-800 dark:text-slate-100">Analyzing Video</h2>
          <p className="text-slate-500 truncate max-w-sm mx-auto">{project?.videoName}</p>
        </div>

        <div className="space-y-4">
          <Progress value={progress} className="h-2 bg-slate-200 dark:bg-slate-800" />
          <div className="flex justify-between text-sm text-slate-500 font-mono">
            <span>{Math.round(progress)}%</span>
            <span>Elapsed: {Math.round(progress * 0.08)}s</span>
          </div>
        </div>

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
                    <Loader2 className="w-5 h-5 text-blue-500 animate-spin" />
                  ) : (
                    <div className="w-2 h-2 rounded-full bg-slate-300 dark:bg-slate-700" />
                  )}
                </div>
                <span className={`text-sm ${isActive ? 'text-blue-600 dark:text-slate-100 font-medium' : 'text-slate-500'}`}>
                  {stage}
                </span>
              </div>
            );
          })}
        </div>

        <div className="flex justify-center pt-4">
          <Button variant="ghost" onClick={() => setCurrentScreen("home")} className="text-slate-500 hover:text-slate-900 dark:hover:text-slate-100">
            取消分析
          </Button>
          <Button variant="secondary" onClick={() => setCurrentScreen("home")} className="ml-4 bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700">
            后台运行
          </Button>
        </div>
      </div>
    </div>
  );
}
