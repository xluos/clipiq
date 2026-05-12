import { useApp } from "../AppContext";
import { Button } from "@/components/ui/button";
import { ArrowLeft, DownloadCloud as InputIcon } from "lucide-react";

export function UrlPullScreen() {
  const { setCurrentScreen, setProjects, setActiveProjectId } = useApp();

  const handleMockSuccess = () => {
    const newProjectId = "proj-url-" + Date.now();
    setProjects(prev => [{
      id: newProjectId,
      source: { type: "url", url: "https://example.com/video", platform: "douyin" },
      localVideoPath: "https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerJoyrides.mp4", // mock external video
      videoName: "Downloaded_Video_Demo",
      durationSec: 15,
      width: 1280,
      height: 720,
      orientation: "landscape",
      status: "not_analyzed"
    }, ...prev]);
    setActiveProjectId(newProjectId);
    setCurrentScreen("prepare");
  };

  return (
    <div className="flex-1 flex flex-col items-center justify-center bg-[#0A0A0B] p-6">
      <div className="w-full max-w-md space-y-6 text-center">
        <div className="w-16 h-16 bg-blue-600/20 rounded-2xl flex items-center justify-center mx-auto mb-6">
           <InputIcon className="w-8 h-8 text-blue-500" />
        </div>
        <h2 className="text-2xl font-semibold tracking-tight">Pulling Video</h2>
        <p className="text-slate-400 text-sm">
          Simulating yt-dlp download process for the typed URL...
        </p>

        <div className="p-4 bg-slate-900 border border-slate-800 rounded font-mono text-xs text-left text-slate-500 overflow-hidden h-32 flex flex-col justify-end">
          <p>[yt-dlp] Extracting URL: https://example.com/video</p>
          <p>[yt-dlp] Downloading webpage</p>
          <p>[yt-dlp] Downloading m3u8 information</p>
          <p>[download] Destination: video.mp4</p>
          <p className="animate-pulse text-blue-400">[download]  50.0% of 15.00MiB at 4.50MiB/s ETA 00:03...</p>
        </div>

        <div className="space-x-4">
          <Button variant="ghost" onClick={() => setCurrentScreen("home")}>Cancel</Button>
          <Button onClick={handleMockSuccess}>Simulate Success</Button>
        </div>
      </div>
    </div>
  );
}
