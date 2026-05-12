import { useApp } from "../AppContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { ArrowLeft, Play, LayoutGrid } from "lucide-react";
import { useEffect, useRef } from "react";

export function PrepareScreen() {
  const { setCurrentScreen, projects, activeProjectId, providers, activeProviderId } = useApp();
  
  const project = projects.find(p => p.id === activeProjectId);
  const provider = providers.find(p => p.id === activeProviderId);
  
  const videoRef = useRef<HTMLVideoElement>(null);

  if (!project) {
    return null;
  }

  const formatDuration = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  const handleStartAnalysis = () => {
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
            <span className="capitalize">{project.orientation}</span>
          </div>
        </div>

        <Card className="bg-white dark:bg-slate-900/50 border-slate-200 dark:border-slate-800 shadow-sm dark:shadow-none">
          <CardContent className="p-6 space-y-6">
            <div className="space-y-2">
              <Label>Analysis Mode</Label>
              <Select defaultValue="standard">
                <SelectTrigger className="bg-slate-50 dark:bg-[#0A0A0B] border-slate-200 dark:border-slate-800">
                  <SelectValue placeholder="Select mode" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="quick">Quick Overview</SelectItem>
                  <SelectItem value="standard">Standard Analysis</SelectItem>
                  <SelectItem value="detailed">In-depth Breakdown</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Node Density</Label>
              <Select defaultValue="standard">
                <SelectTrigger className="bg-slate-50 dark:bg-[#0A0A0B] border-slate-200 dark:border-slate-800">
                  <SelectValue placeholder="Select density" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="sparse">Sparse (Key events only)</SelectItem>
                  <SelectItem value="standard">Standard</SelectItem>
                  <SelectItem value="dense">Dense (Every cut)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Focus Areas</Label>
              <Select defaultValue="all">
                <SelectTrigger className="bg-slate-50 dark:bg-[#0A0A0B] border-slate-200 dark:border-slate-800">
                  <SelectValue placeholder="Select focus" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Comprehensive</SelectItem>
                  <SelectItem value="narrative">Narrative Structure</SelectItem>
                  <SelectItem value="rhythm">Editing Rhythm</SelectItem>
                  <SelectItem value="emotion">Emotional Arc</SelectItem>
                </SelectContent>
              </Select>
            </div>
            
            <div className="p-3 rounded-lg bg-slate-50 dark:bg-[#0A0A0B] border border-slate-200 dark:border-slate-800 text-sm space-y-1">
              <div className="text-slate-500 text-xs font-semibold uppercase tracking-widest mb-2">Model Configuration</div>
              <div className="flex justify-between">
                <span className="text-slate-500 dark:text-slate-400">Provider</span>
                <span className="font-medium text-slate-700 dark:text-slate-200">{provider?.name}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500 dark:text-slate-400">Model</span>
                <span className="font-medium font-mono text-slate-700 dark:text-slate-200">{provider?.model}</span>
              </div>
            </div>
          </CardContent>
        </Card>

        <div className="flex-1" />

        <div className="pt-4 border-t border-slate-200 dark:border-slate-800 space-y-3">
          {project.status === "completed" && (
            <Button variant="secondary" className="w-full bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700" onClick={() => setCurrentScreen("workspace")}>
              <LayoutGrid className="w-4 h-4 mr-2" />
              查看已有分析
            </Button>
          )}
          <Button size="lg" className="w-full bg-blue-600 hover:bg-blue-700 text-white" onClick={handleStartAnalysis}>
            <Play className="w-4 h-4 mr-2 fill-current" />
            {project.status === "completed" ? "重新分析" : "开始分析"}
          </Button>
        </div>
      </div>
    </div>
  );
}
