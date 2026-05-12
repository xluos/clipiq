import { useVideoPlayer } from "../lib/hooks";
import { useApp } from "../AppContext";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Home, FileText, Download, Play, Pause, Settings, Maximize2, ArrowLeft, Folder } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { AnalysisNode } from "../types";

export function WorkspaceScreen() {
  const { setCurrentScreen, projects, activeProjectId, nodesByProject } = useApp();
  
  const project = projects.find(p => p.id === activeProjectId);
  const nodes = nodesByProject[activeProjectId || ""] || [];
  
  const videoRef = useRef<HTMLVideoElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const onTimeUpdate = () => {
      setCurrentTime(video.currentTime);
      // Find active node
      const current = nodes.find(n => video.currentTime >= n.startSec && video.currentTime < n.endSec);
      if (current && current.id !== activeNodeId) {
        setActiveNodeId(current.id);
        // Ensure visible in list
        const el = document.getElementById(`node-${current.id}`);
        if (el && scrollRef.current) {
          el.scrollIntoView({ behavior: "smooth", block: "nearest" });
        }
      }
    };

    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('play', () => setIsPlaying(true));
    video.addEventListener('pause', () => setIsPlaying(false));

    return () => {
      video.removeEventListener('timeupdate', onTimeUpdate);
      video.removeEventListener('play', () => setIsPlaying(true));
      video.removeEventListener('pause', () => setIsPlaying(false));
    };
  }, [nodes, activeNodeId]);

  if (!project) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center bg-slate-50 dark:bg-[#0A0A0B]">
        <Folder className="w-16 h-16 text-slate-300 dark:text-slate-700 mb-4" />
        <h2 className="text-xl font-semibold text-slate-700 dark:text-slate-300">暂无选中的项目</h2>
        <p className="text-sm text-slate-500 mt-2">请先从首页选择或创建一个项目</p>
        <Button className="mt-6" onClick={() => setCurrentScreen("home")}>
          返回首页
        </Button>
      </div>
    );
  }

  const handleNodeClick = (node: AnalysisNode) => {
    if (videoRef.current) {
      videoRef.current.currentTime = node.startSec;
    }
  };

  const handleNodeDoubleClick = (node: AnalysisNode) => {
    if (videoRef.current) {
      videoRef.current.currentTime = node.startSec;
      videoRef.current.play();
    }
  };

  const togglePlay = () => {
    if (videoRef.current) {
      if (isPlaying) videoRef.current.pause();
      else videoRef.current.play();
    }
  };

  const isPortrait = project.orientation === "portrait";

  return (
    <div className="flex-1 flex flex-col h-full bg-slate-50 dark:bg-[#0A0A0B] overflow-hidden">
      {/* Top Toolbar */}
      <header className="h-14 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0A0A0B]/80 backdrop-blur flex flex-none items-center justify-between px-4 z-10 shrink-0">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => setCurrentScreen("home")} className="text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100">
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <div className="h-4 w-px bg-slate-200 dark:bg-slate-800" />
          <div className="flex items-center gap-3">
            <span className="text-sm font-medium text-slate-800 dark:text-slate-200 truncate max-w-[200px] md:max-w-md">{project.videoName}</span>
            <span className="px-2 py-0.5 rounded bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400 text-[10px] font-mono border border-blue-100 dark:border-blue-500/20 capitalize">{project.orientation}</span>
          </div>
        </div>
        <div className="flex items-center gap-2 md:gap-4">
          <div className="hidden md:flex items-center gap-2 px-3 py-1.5 bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
            <span className="text-xs font-medium text-slate-600 dark:text-slate-400 uppercase tracking-widest font-mono">Analysis Active</span>
          </div>
          <Button variant="secondary" size="sm" onClick={() => setCurrentScreen("report")} className="bg-blue-600 hover:bg-blue-700 text-white border-0 hidden md:flex h-9 shadow-sm hover:shadow">
            <FileText className="w-4 h-4 mr-2" />
            Summary Report
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setCurrentScreen("report")} className="flex md:hidden text-blue-600 dark:text-blue-400">
             <FileText className="w-4 h-4" />
          </Button>
        </div>
      </header>

      {/* Main Workspace */}
      <div className={`flex-1 flex overflow-hidden ${isPortrait ? 'flex-row' : 'flex-col md:flex-row'}`}>
        
        {/* Left: Video Player Area */}
        <div className={`flex flex-col relative ${isPortrait ? 'w-auto max-w-[45%]' : 'flex-1'} min-h-0 bg-slate-100/50 dark:bg-black/20`}>
          <div className="flex-1 relative flex items-center justify-center p-4 min-h-0">
            <div className="relative w-full h-full max-w-full max-h-full flex items-center justify-center rounded-xl overflow-hidden bg-black shadow-xl border border-slate-200/50 dark:border-slate-800/50">
              <video 
                ref={videoRef}
                src={project.localVideoPath} 
                className={`w-full h-full object-contain`}
                onClick={togglePlay}
              />
            </div>
          </div>
          
          {/* Enhanced Progress Bar */}
          <div className="h-28 bg-white dark:bg-slate-900/40 rounded-xl border border-slate-200 dark:border-slate-800 mx-4 mb-4 p-4 flex flex-col justify-center gap-2 shrink-0 shadow-sm backdrop-blur-sm">
            <div className="flex justify-between items-center text-xs text-slate-500 font-mono mb-1">
              <span>{formatTime(currentTime)}</span>
              <span>{formatTime(project.durationSec)}</span>
            </div>
            <div className="relative h-10 bg-slate-100 dark:bg-[#0A0A0B] rounded-lg border border-slate-200 dark:border-slate-800 cursor-pointer overflow-hidden group" onClick={(e) => {
              if (videoRef.current) {
                const rect = e.currentTarget.getBoundingClientRect();
                const pos = (e.clientX - rect.left) / rect.width;
                videoRef.current.currentTime = pos * project.durationSec;
              }
            }}>
              {/* Playhead Area */}
              <div 
                className="absolute top-0 bottom-0 bg-blue-100 dark:bg-blue-500/20 border-r border-blue-400 dark:border-blue-500/50 transition-all duration-75" 
                style={{ width: `${(currentTime / project.durationSec) * 100}%` }}
              />
              <div 
                className="absolute top-0 bottom-0 w-0.5 bg-blue-600 dark:bg-white z-10 shadow-[0_0_10px_rgba(37,99,235,0.5)] dark:shadow-[0_0_10px_rgba(255,255,255,0.5)] transition-all duration-75" 
                style={{ left: `${(currentTime / project.durationSec) * 100}%` }}
              />
              {/* Markers */}
              {nodes.map(node => (
                <div 
                  key={node.id}
                  className={`absolute top-0 bottom-0 w-[3px] ${node.id === activeNodeId ? 'bg-blue-600 dark:bg-white z-20' : 'bg-amber-400 dark:bg-amber-500/80'} hover:bg-slate-900 dark:hover:bg-white transition-colors`}
                  style={{ left: `${(node.startSec / project.durationSec) * 100}%` }}
                  title={node.title}
                />
              ))}
            </div>
            <div className="flex items-center justify-center mt-1">
              <Button variant="ghost" size="icon" className="w-8 h-8 rounded-full text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors" onClick={togglePlay}>
                {isPlaying ? <Pause className="w-4 h-4 fill-current" /> : <Play className="w-4 h-4 fill-current ml-0.5" />}
              </Button>
            </div>
          </div>
        </div>

        {/* Right: Nodes List Sidebar */}
        <div className={`${isPortrait ? 'flex-1' : 'w-full md:w-[450px]'} border-l border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0E0E10] flex flex-col min-h-0 shadow-sm z-10`}>
          <div className="p-3 border-b border-slate-200 dark:border-slate-800 flex-none bg-slate-50/80 dark:bg-[#0E0E10]">
            <Tabs defaultValue="timeline">
              <TabsList className="grid w-full grid-cols-2 bg-slate-100 dark:bg-slate-900 p-1 rounded-lg">
                <TabsTrigger value="timeline" className="data-[state=active]:bg-white dark:data-[state=active]:bg-[#0E0E10] rounded-md shadow-sm dark:shadow-none font-medium">Timeline</TabsTrigger>
                <TabsTrigger value="insights" className="data-[state=active]:bg-white dark:data-[state=active]:bg-[#0E0E10] rounded-md shadow-sm dark:shadow-none font-medium text-slate-500">Insights</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
          
          <ScrollArea className="flex-1 px-4 py-4" ref={scrollRef}>
            <div className="space-y-4 pb-20">
              {nodes.map((node) => {
                const isActive = activeNodeId === node.id;
                return (
                  <div
                    key={node.id}
                    id={`node-${node.id}`}
                    onClick={() => handleNodeClick(node)}
                    onDoubleClick={() => handleNodeDoubleClick(node)}
                    className={`p-4 rounded-xl cursor-pointer border transition-all duration-200 shadow-sm
                      ${isActive 
                        ? 'bg-blue-50/50 dark:bg-blue-600/10 border-blue-300 dark:border-blue-500/40 ring-1 ring-blue-400/30 dark:ring-blue-500/20' 
                        : 'bg-white dark:bg-slate-900/40 border-slate-200 dark:border-slate-800/60 hover:border-slate-300 dark:hover:bg-slate-900/60'
                      }
                    `}
                  >
                    <div className="flex items-start justify-between mb-3">
                      <div className="flex items-center space-x-3">
                        <span className={`text-xs font-mono px-2 py-0.5 rounded-md border ${isActive ? 'bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-500/20 dark:text-blue-400 dark:border-blue-500/30' : 'bg-slate-100/50 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700'}`}>
                          {formatTime(node.startSec)}
                        </span>
                        <h3 className={`font-semibold text-sm ${isActive ? 'text-blue-900 dark:text-slate-50' : 'text-slate-800 dark:text-slate-300'}`}>{node.title}</h3>
                      </div>
                      {node.isHighlight && (
                        <div className="w-2 h-2 rounded-full bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.6)]" title="Highlight" />
                      )}
                    </div>
                    
                    <div className="flex flex-wrap gap-2 mb-3">
                      <Badge variant="secondary" className="bg-slate-100 text-slate-600 border-slate-200 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700 dark:hover:bg-slate-700 text-[11px] px-2 py-0.5 font-medium shadow-none">{node.narrativeFunction}</Badge>
                      <Badge variant="secondary" className="bg-emerald-50 text-emerald-600 border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-400 text-[11px] px-2 py-0.5 font-medium dark:border-emerald-500/20 shadow-none">{node.emotionLabel}</Badge>
                    </div>

                    <p className={`text-sm line-clamp-2 leading-relaxed ${isActive ? 'text-slate-700 dark:text-slate-300' : 'text-slate-500 dark:text-slate-400'}`}>
                      {node.shotDescription}
                    </p>

                    {isActive && (
                      <div className="mt-4 pt-4 border-t border-slate-200 dark:border-slate-800/50 space-y-4 animate-in fade-in slide-in-from-top-2">
                        <div>
                          <p className="text-[11px] text-slate-500 uppercase tracking-widest mb-1.5 font-bold flex items-center">
                            <span className="w-1.5 h-1.5 rounded-full bg-blue-500 mr-2" /> Edit Intent
                          </p>
                          <p className="text-sm text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-900/40 p-3 rounded-lg border border-slate-100 dark:border-slate-800/50 shadow-sm inner-shadow">{node.editIntent}</p>
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                          <div>
                            <p className="text-[11px] text-slate-500 uppercase tracking-widest mb-1.5 font-bold flex items-center">
                              <span className="w-1.5 h-1.5 rounded-full bg-purple-500 mr-2" /> Visuals
                            </p>
                            <ul className="text-sm text-slate-600 dark:text-slate-400 list-disc list-inside space-y-1">
                              {node.visualElements.map((el, i) => <li key={i} className="truncate">{el}</li>)}
                            </ul>
                          </div>
                          <div>
                            <p className="text-[11px] text-slate-500 uppercase tracking-widest mb-1.5 font-bold flex items-center">
                              <span className="w-1.5 h-1.5 rounded-full bg-amber-500 mr-2" /> Audio
                            </p>
                            <ul className="text-sm text-slate-600 dark:text-slate-400 list-disc list-inside space-y-1">
                              {node.audioElements.map((el, i) => <li key={i} className="truncate">{el}</li>)}
                            </ul>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </ScrollArea>
        </div>
      </div>
    </div>
  );
}
