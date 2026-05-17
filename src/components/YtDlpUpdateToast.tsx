import { useEffect, useState } from "react";
import type { YtDlpProgress, YtDlpUpdateInfo } from "../electron-api";
import { Button } from "@/components/ui/button";
import { CheckCircle2, DownloadCloud, Loader2, X } from "lucide-react";

type Status = "idle" | "installing" | "installed";

export function YtDlpUpdateToast() {
  const [info, setInfo] = useState<YtDlpUpdateInfo | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  const [progress, setProgress] = useState<string>("");
  const [errorMessage, setErrorMessage] = useState<string>("");

  useEffect(() => {
    if (!window.videoAnalyzer) return;
    const unsubStatus = window.videoAnalyzer.onYtDlpUpdateStatus((next) => {
      setInfo(next);
      setDismissed(false);
    });
    const unsubProgress = window.videoAnalyzer.onYtDlpProgress((p: YtDlpProgress) => {
      setProgress(`${p.stage === "download" ? "下载中" : p.stage === "resolve" ? "查询版本" : "完成"}：${p.message}`);
    });
    return () => {
      unsubStatus();
      unsubProgress();
    };
  }, []);

  const handleInstall = async () => {
    if (!window.videoAnalyzer) return;
    setStatus("installing");
    setErrorMessage("");
    setProgress("准备开始下载…");
    try {
      const result = await window.videoAnalyzer.installYtDlp();
      setStatus("installed");
      setInfo({
        installed: true,
        installedVersion: result.installedVersion,
        isBundled: true,
        latestVersion: result.latestVersion,
        updateAvailable: false,
      });
      window.setTimeout(() => setDismissed(true), 3000);
    } catch (error) {
      setStatus("idle");
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  };

  if (!info || dismissed) return null;

  const needsInstall = !info.installed;
  const needsUpdate = info.installed && info.updateAvailable;
  if (!needsInstall && !needsUpdate && status !== "installed") return null;

  const title = needsInstall ? "未安装 yt-dlp" : "yt-dlp 有新版本";
  const subtitle = needsInstall
    ? `检测到本机没有 yt-dlp，无法通过链接拉取视频。点下方按钮下载到应用内 (${info.latestVersion ?? "最新版"})。`
    : `当前 ${info.installedVersion ?? "未知"} → 最新 ${info.latestVersion ?? "?"}。${info.isBundled ? "下载会替换应用内的版本。" : "下载到应用目录后会优先使用应用内版本。"}`;

  return (
    <div className="fixed bottom-6 right-6 z-50 w-[340px] rounded-xl border border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-900">
      <div className="flex items-start gap-3 p-4">
        <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-400">
          {status === "installing" ? (
            <Loader2 className="h-5 w-5 animate-spin" />
          ) : status === "installed" ? (
            <CheckCircle2 className="h-5 w-5" />
          ) : (
            <DownloadCloud className="h-5 w-5" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">
              {status === "installed" ? "yt-dlp 已更新" : title}
            </p>
            <button
              type="button"
              onClick={() => setDismissed(true)}
              className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
              title="关闭"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
            {status === "installing"
              ? progress || "正在安装…"
              : status === "installed"
                ? `安装完成 ${info.installedVersion ?? info.latestVersion ?? ""}`
                : subtitle}
          </p>
          {errorMessage && (
            <p className="mt-2 break-words text-xs text-red-600 dark:text-red-400">{errorMessage}</p>
          )}
          {status !== "installed" && (
            <div className="mt-3 flex justify-end gap-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setDismissed(true)}
                disabled={status === "installing"}
                className="text-slate-500 hover:text-slate-800 dark:hover:text-slate-100"
              >
                稍后
              </Button>
              <Button
                size="sm"
                onClick={handleInstall}
                disabled={status === "installing"}
                className="bg-indigo-600 text-white hover:bg-indigo-700"
              >
                {status === "installing" ? "下载中" : needsInstall ? "立即安装" : "立即更新"}
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
