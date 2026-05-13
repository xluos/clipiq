import { useApp } from "../AppContext";
import { Button } from "@/components/ui/button";
import { FolderOpen, CloudDownload, UploadCloud, CheckCircle2, Clock, XCircle, Film, Trash2 } from "lucide-react";
import { type ChangeEvent, type DragEvent, type MouseEvent, useRef, useState } from "react";
import type { InspectedVideo } from "../electron-api";
import { BrandLogo } from "../components/BrandLogo";

function formatDate(date: Date) {
  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "刚刚";
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour} 小时前`;
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return sameYear ? `${m}-${d} ${hh}:${mm}` : `${date.getFullYear()}-${m}-${d} ${hh}:${mm}`;
}

export function HomeScreen() {
  const { setCurrentScreen, projects, setActiveProjectId, setProjects, removeProject } = useApp();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [dropError, setDropError] = useState<string>("");

  const handleDelete = (event: MouseEvent<HTMLButtonElement>, projectId: string) => {
    event.stopPropagation();
    if (!window.confirm("确定要删除这个项目吗？该项目的分析结果也会从应用记录中移除。")) return;
    removeProject(projectId);
  };

  const handleDragEnter = (event: DragEvent<HTMLElement>) => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    setIsDragging(true);
  };

  const handleDragOver = (event: DragEvent<HTMLElement>) => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };

  const handleDragLeave = (event: DragEvent<HTMLElement>) => {
    // Only clear when leaving the page wrapper, not internal child boundaries
    if (event.currentTarget === event.target) setIsDragging(false);
  };

  const handleDrop = async (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setIsDragging(false);
    setDropError("");
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("video/") && !/\.(mp4|mov|mkv|webm|avi|m4v)$/i.test(file.name)) {
      setDropError(`不是视频文件: ${file.name}`);
      return;
    }
    if (window.videoAnalyzer) {
      const filePath = window.videoAnalyzer.getPathForFile(file) || (file as File & { path?: string }).path;
      if (filePath) {
        try {
          const video = await window.videoAnalyzer.inspectVideoPath(filePath);
          addInspectedProject(video);
        } catch (error) {
          setDropError(error instanceof Error ? error.message : String(error));
        }
        return;
      }
    }
    // Browser fallback
    const objectUrl = URL.createObjectURL(file);
    const videoEl = document.createElement("video");
    videoEl.src = objectUrl;
    videoEl.onloadedmetadata = () => {
      const newProjectId = "proj-" + Date.now();
      const now = new Date().toISOString();
      setProjects(prev => [{
        id: newProjectId,
        source: { type: "local_file", originalPath: file.name },
        localVideoPath: objectUrl,
        videoName: file.name,
        durationSec: videoEl.duration,
        width: videoEl.videoWidth,
        height: videoEl.videoHeight,
        orientation: videoEl.videoWidth > videoEl.videoHeight ? "landscape" : videoEl.videoWidth < videoEl.videoHeight ? "portrait" : "square",
        status: "not_analyzed",
        createdAt: now,
        updatedAt: now,
      }, ...prev]);
      setActiveProjectId(newProjectId);
      setCurrentScreen("prepare");
    };
  };

  const addInspectedProject = (video: InspectedVideo) => {
    const newProjectId = "proj-" + Date.now();
    const now = new Date().toISOString();
    setProjects(prev => [{
      id: newProjectId,
      source: { type: "local_file", originalPath: video.filePath },
      localVideoPath: video.mediaUrl,
      localFilePath: video.filePath,
      videoName: video.filename,
      durationSec: video.durationSec,
      width: video.width,
      height: video.height,
      orientation: video.orientation,
      status: "not_analyzed",
      createdAt: now,
      updatedAt: now
    }, ...prev]);
    setActiveProjectId(newProjectId);
    setCurrentScreen("prepare");
  };

  const handleOpenVideo = async () => {
    if (window.videoAnalyzer) {
      const video = await window.videoAnalyzer.openVideoFile();
      if (video) addInspectedProject(video);
      return;
    }

    fileInputRef.current?.click();
  };

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const objectUrl = URL.createObjectURL(file);
      const newProjectId = "proj-" + Date.now();
      const now = new Date().toISOString();
      const video = document.createElement('video');
      video.src = objectUrl;
      video.onloadedmetadata = () => {
        setProjects(prev => [{
          id: newProjectId,
          source: { type: "local_file", originalPath: file.name },
          localVideoPath: objectUrl,
          videoName: file.name,
          durationSec: video.duration,
          width: video.videoWidth,
          height: video.videoHeight,
          orientation: video.videoWidth > video.videoHeight ? "landscape" : video.videoWidth < video.videoHeight ? "portrait" : "square",
          status: "not_analyzed",
          createdAt: now,
          updatedAt: now
        }, ...prev]);
        setActiveProjectId(newProjectId);
        setCurrentScreen("prepare");
      };
    }
  };

  return (
    <div className="flex-1 flex h-full">
      <main
        className="flex-1 overflow-y-auto bg-slate-50 dark:bg-[#0A0A0B] p-8 md:p-12 relative"
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <div className="max-w-4xl mx-auto space-y-10 mt-4">
          <header className="flex items-center gap-5 select-none">
            <BrandLogo size={72} className="shrink-0 drop-shadow-md" />
            <div>
              <h1 className="text-4xl font-bold tracking-tight bg-gradient-to-r from-indigo-500 via-violet-500 to-cyan-500 bg-clip-text text-transparent">
                ClipIQ
              </h1>
              <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">看见视频，洞察价值 · 让每一帧，都有意义</p>
            </div>
          </header>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <button
              onClick={handleOpenVideo}
              className="group flex flex-col p-6 bg-white dark:bg-[#181B2E] hover:bg-slate-50 dark:hover:bg-[#1F2440] border border-slate-200 dark:border-indigo-500/20 rounded-2xl transition-all text-left shadow-sm hover:shadow relative overflow-hidden"
            >
              <div className="absolute top-0 right-0 w-40 h-40 bg-indigo-500/10 rounded-full blur-3xl group-hover:bg-indigo-500/20 transition-colors" />
              <div className="flex items-center gap-4 relative z-10">
                <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-500 flex items-center justify-center group-hover:scale-105 transition-transform shrink-0 shadow-md shadow-indigo-500/20">
                  <FolderOpen className="w-6 h-6 text-white" />
                </div>
                <div>
                  <h3 className="font-semibold text-slate-800 dark:text-slate-100 text-lg">打开视频</h3>
                  <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">选择本地视频文件</p>
                </div>
              </div>
            </button>
            <input type="file" ref={fileInputRef} className="hidden" accept="video/*" onChange={handleFileChange} />

            <button
              onClick={() => setCurrentScreen("url_pull")}
              className="group flex flex-col p-6 bg-white dark:bg-[#1A1E36] hover:bg-slate-50 dark:hover:bg-[#222848] border border-slate-200 dark:border-cyan-500/20 rounded-2xl transition-all text-left shadow-sm hover:shadow relative overflow-hidden"
            >
              <div className="absolute top-0 right-0 w-40 h-40 bg-cyan-500/10 rounded-full blur-3xl group-hover:bg-cyan-500/20 transition-colors" />
              <div className="flex items-center gap-4 relative z-10">
                <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-cyan-500 to-sky-500 flex items-center justify-center group-hover:scale-105 transition-transform shrink-0 shadow-md shadow-cyan-500/20">
                  <CloudDownload className="w-6 h-6 text-white" />
                </div>
                <div>
                  <h3 className="font-semibold text-slate-800 dark:text-slate-100 text-lg">拉取视频</h3>
                  <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">从链接拉取短视频</p>
                </div>
              </div>
            </button>
          </div>

          <div
            onClick={handleOpenVideo}
            className={`border-2 border-dashed rounded-2xl p-16 flex flex-col items-center justify-center text-center cursor-pointer transition-all shadow-sm group ${
              isDragging
                ? "border-indigo-500 bg-indigo-50 dark:bg-indigo-500/10 dark:border-indigo-400"
                : "border-slate-300 dark:border-slate-800 bg-white/50 dark:bg-slate-900/20 hover:bg-white dark:hover:bg-slate-900/40 hover:border-indigo-400 dark:hover:border-indigo-500/50"
            }`}
          >
            <div className={`p-4 rounded-full mb-4 group-hover:scale-105 transition-transform ${
              isDragging ? "bg-indigo-100 dark:bg-indigo-500/20" : "bg-slate-100 dark:bg-slate-800"
            }`}>
              <UploadCloud className={`w-8 h-8 ${isDragging ? "text-indigo-600 dark:text-indigo-400" : "text-slate-500 dark:text-slate-400"}`} />
            </div>
            <h3 className="font-semibold text-slate-800 dark:text-slate-200 text-lg">
              {isDragging ? "松手即可导入视频" : "拖拽视频到这里"}
            </h3>
            <p className="text-sm text-slate-500 mt-2">支持 MP4、MOV、MKV、WebM 等格式</p>
            {dropError && (
              <p className="mt-3 text-xs text-red-600 dark:text-red-400">{dropError}</p>
            )}
          </div>

          <div className="space-y-4 pt-6">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-slate-800 dark:text-slate-200">最近项目</h3>
              {projects.length > 0 && (
                <span className="text-xs text-slate-500 dark:text-slate-400 font-mono">共 {projects.length} 项</span>
              )}
            </div>
            
            {projects.length === 0 ? (
               <div className="text-center py-12 border border-slate-200 dark:border-slate-800/50 rounded-xl bg-white/50 dark:bg-[#0E0E10] text-slate-500 text-sm">
                 暂无最近项目，请导入视频开始分析。
               </div>
            ) : (
              <div className="space-y-3">
                {projects.map(proj => (
                  <div
                    key={proj.id}
                    onClick={() => {
                      setActiveProjectId(proj.id);
                      if (proj.status === "completed") setCurrentScreen("workspace");
                      else if (proj.status === "analyzing") setCurrentScreen("progress");
                      else if (proj.status === "download_failed") setCurrentScreen("url_pull");
                      else setCurrentScreen("prepare");
                    }}
                    className="flex items-center p-3 rounded-xl bg-white dark:bg-[#0E0E10] border border-slate-200 dark:border-slate-800 hover:border-indigo-300 dark:hover:border-indigo-500/50 shadow-sm cursor-pointer transition-all group"
                  >
                    <div className="w-[120px] h-[68px] rounded mr-4 shrink-0 relative overflow-hidden border border-slate-200 dark:border-slate-800 bg-gradient-to-br from-slate-200 to-slate-300 dark:from-slate-800 dark:to-slate-900">
                      {proj.thumbnailUrl ? (
                        <img
                          src={proj.thumbnailUrl}
                          alt={proj.videoName}
                          className="absolute inset-0 h-full w-full object-cover"
                        />
                      ) : (
                        <div className="absolute inset-0 flex items-center justify-center text-slate-400 dark:text-slate-600">
                          <Film className="h-6 w-6" />
                        </div>
                      )}
                      <div className="absolute inset-0 bg-black/10 group-hover:bg-transparent transition-colors" />
                    </div>

                    <div className="flex-1 min-w-0 pr-4">
                      <h4 className="font-medium text-slate-800 dark:text-slate-200 text-sm truncate mb-1.5">{proj.videoName}</h4>
                      <div className="flex items-center gap-2 text-[11px]">
                        {proj.status === "completed" && <span className="flex items-center text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-500/10 px-1.5 py-0.5 rounded border border-emerald-200 dark:border-emerald-500/20"><CheckCircle2 className="w-3 h-3 mr-1" /> 已完成分析</span>}
                        {proj.status === "analyzing" && <span className="flex items-center text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-500/10 px-1.5 py-0.5 rounded border border-indigo-200 dark:border-indigo-500/20"><Clock className="w-3 h-3 mr-1" /> 分析中</span>}
                        {proj.status === "failed" && <span className="flex items-center text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-500/10 px-1.5 py-0.5 rounded border border-red-200 dark:border-red-500/20"><XCircle className="w-3 h-3 mr-1" /> 分析失败</span>}
                        {proj.status === "download_failed" && <span className="flex items-center text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-500/10 px-1.5 py-0.5 rounded border border-red-200 dark:border-red-500/20"><XCircle className="w-3 h-3 mr-1" /> 下载失败</span>}
                        {proj.status === "not_analyzed" && <span className="flex items-center text-slate-600 dark:text-slate-400 bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 rounded border border-slate-200 dark:border-slate-700"><Clock className="w-3 h-3 mr-1" /> 未分析</span>}
                      </div>
                    </div>

                    <div className="text-xs text-slate-400 font-mono hidden md:block w-32 text-right">
                      {formatDate(new Date(proj.updatedAt || proj.createdAt || Date.now()))}
                    </div>
                    <button
                      type="button"
                      onClick={(event) => handleDelete(event, proj.id)}
                      title="删除项目"
                      className="ml-3 hidden md:flex h-8 w-8 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-500/10 dark:hover:text-red-400"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
