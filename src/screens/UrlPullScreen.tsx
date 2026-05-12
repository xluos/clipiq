import { useApp } from "../AppContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ArrowLeft, DownloadCloud as InputIcon, Loader2, XCircle } from "lucide-react";
import { useMemo, useState } from "react";
import type { ProjectSource } from "../types";

function inferPlatform(url: string): Extract<ProjectSource, { type: "url" }>["platform"] {
  const value = url.toLowerCase();
  if (value.includes("douyin")) return "douyin";
  if (value.includes("xiaohongshu") || value.includes("xhslink") || value.includes("xhs")) return "xiaohongshu";
  if (value.includes("bilibili") || value.includes("b23.tv")) return "bilibili";
  if (value.includes("tiktok")) return "tiktok";
  return "unknown";
}

export function UrlPullScreen() {
  const { setCurrentScreen, setProjects, setActiveProjectId } = useApp();
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState<"idle" | "downloading" | "failed">("idle");
  const [logs, setLogs] = useState<string[]>([
    "等待输入视频链接。支持 yt-dlp 能识别的公开视频链接，合集会按单条视频处理。"
  ]);
  const [error, setError] = useState("");
  const platform = useMemo(() => inferPlatform(url), [url]);

  const createMockProject = () => {
    const newProjectId = "proj-url-" + Date.now();
    const now = new Date().toISOString();
    setProjects(prev => [{
      id: newProjectId,
      source: { type: "url", url: url || "https://example.com/video", platform },
      localVideoPath: "https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerJoyrides.mp4", // mock external video
      videoName: "Downloaded_Video_Demo",
      durationSec: 15,
      width: 1280,
      height: 720,
      orientation: "landscape",
      status: "not_analyzed",
      createdAt: now,
      updatedAt: now
    }, ...prev]);
    setActiveProjectId(newProjectId);
    setCurrentScreen("prepare");
  };

  const handleStartPull = async () => {
    if (!url.trim()) {
      setError("请先输入视频链接。");
      setStatus("failed");
      return;
    }

    setStatus("downloading");
    setError("");
    setLogs([
      `[source] ${url}`,
      `[platform] ${platform}`,
      "[yt-dlp] 准备拉取单条视频..."
    ]);

    try {
      if (!window.videoAnalyzer) {
        setLogs(prev => [...prev, "[demo] 当前是浏览器预览环境，使用示例视频模拟下载成功。"]);
        window.setTimeout(createMockProject, 800);
        return;
      }

      const video = await window.videoAnalyzer.downloadVideo(url.trim());
      setLogs(prev => [
        ...prev,
        `[yt-dlp] 下载完成: ${video.filename}`,
        `[ffprobe] ${Math.round(video.durationSec)}s · ${video.width}x${video.height} · ${video.orientation}`
      ]);

      setProjects(prev => [{
        id: video.projectId,
        source: { type: "url", url: url.trim(), platform: video.platform },
        localVideoPath: video.mediaUrl,
        localFilePath: video.filePath,
        videoName: video.filename,
        durationSec: video.durationSec,
        width: video.width,
        height: video.height,
        orientation: video.orientation,
        status: "not_analyzed",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }, ...prev]);
      setActiveProjectId(video.projectId);
      window.setTimeout(() => setCurrentScreen("prepare"), 500);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStatus("failed");
      setError(message);
      setLogs(prev => [...prev, `[error] ${message}`]);
    }
  };

  return (
    <div className="flex-1 flex flex-col items-center justify-center bg-slate-50 dark:bg-[#0A0A0B] p-6">
      <div className="w-full max-w-md space-y-6 text-center">
        <div className="w-16 h-16 bg-indigo-600/20 rounded-2xl flex items-center justify-center mx-auto mb-6">
           <InputIcon className="w-8 h-8 text-indigo-500" />
        </div>
        <h2 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">通过链接拉取视频</h2>
        <p className="text-slate-500 dark:text-slate-400 text-sm">
          链接拉取由 Electron main process 调用 yt-dlp 完成；失败时可以改用本地文件继续拉片。
        </p>

        <div className="space-y-3 text-left">
          <Input
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="粘贴抖音 / 小红书 / Bilibili / TikTok 视频链接"
            className="bg-white dark:bg-[#0E0E10] border-slate-200 dark:border-slate-800"
          />
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span>平台识别：<span className="font-mono text-slate-700 dark:text-slate-300">{platform}</span></span>
            {!window.videoAnalyzer && <span>浏览器预览模式会使用示例视频</span>}
          </div>
        </div>

        <div className="p-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg font-mono text-xs text-left text-slate-500 overflow-hidden h-40 flex flex-col justify-end shadow-sm">
          {logs.map((line, index) => (
            <p key={index} className={line.startsWith("[error]") ? "text-red-500" : index === logs.length - 1 && status === "downloading" ? "animate-pulse text-indigo-500" : ""}>
              {line}
            </p>
          ))}
        </div>

        {status === "failed" && (
          <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-left text-sm text-red-700 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-300">
            <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="flex justify-center gap-3">
          <Button variant="ghost" onClick={() => setCurrentScreen("home")}>
            <ArrowLeft className="w-4 h-4 mr-2" />
            返回首页
          </Button>
          <Button variant="secondary" onClick={() => setCurrentScreen("home")}>改用本地视频</Button>
          <Button onClick={handleStartPull} disabled={status === "downloading"} className="bg-indigo-600 hover:bg-indigo-700 text-white">
            {status === "downloading" ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <InputIcon className="w-4 h-4 mr-2" />}
            开始拉取
          </Button>
        </div>
      </div>
    </div>
  );
}
