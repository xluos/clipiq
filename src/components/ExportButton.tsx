// 批量导出按钮 —— 账号详情页 / 收藏夹详情页共用。
// 点开下拉选 JSON(单文件)或压缩包(ZIP,每视频一目录、每份分析一文件),
// 走 window.videoAnalyzer.exportBundle,弹系统保存框,完成后就地反馈条数。
// 下拉是 floating overlay,按 DESIGN.md 允许 shadow;其余按钮风格对齐两页 header。

import { type FunctionComponent, type ReactNode, useEffect, useRef, useState } from "react";
import { Download, Loader2, FileJson, FileArchive, Film } from "lucide-react";

type Props = {
  scope: "account" | "collection";
  id: string;
  /** 无视频时禁用(没东西可导) */
  disabled?: boolean;
};

type Mode = "json" | "zip" | "zip-media";

export const ExportButton: FunctionComponent<Props> = ({ scope, id, disabled }) => {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<null | Mode>(null);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const run = async (mode: Mode) => {
    setOpen(false);
    if (busy) return;
    setBusy(mode);
    setToast(null);
    try {
      const format = mode === "json" ? "json" : "zip";
      const includeMedia = mode === "zip-media";
      const r = await window.videoAnalyzer?.exportBundle?.({ scope, id, format, includeMedia });
      if (r && !r.canceled) {
        let text = `已导出 ${r.videoCount ?? 0} 条视频 · ${r.analysisCount ?? 0} 份分析`;
        if (format === "zip") {
          if (r.frameFileCount) text += ` · ${r.frameFileCount} 张帧截图`;
          if (includeMedia) {
            text += ` · ${r.mediaFileCount ?? 0} 个原视频`;
            if (r.mediaMissingCount) text += `(${r.mediaMissingCount} 个无本地文件)`;
          }
        }
        setToast({ kind: "ok", text });
        setTimeout(() => setToast(null), 5000);
      }
    } catch (e) {
      setToast({ kind: "err", text: `导出失败:${e instanceof Error ? e.message : String(e)}` });
      setTimeout(() => setToast(null), 5000);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={disabled || busy !== null}
        title={disabled ? "没有可导出的分析" : "导出全部分析"}
        className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-[12.5px] text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-700 disabled:opacity-50"
      >
        {busy ? <Loader2 className="w-3 h-3 animate-spin" strokeWidth={1.5} /> : <Download className="w-3 h-3" strokeWidth={1.5} />}
        {busy ? "导出中…" : "导出"}
      </button>

      {open && (
        <div className="absolute right-0 top-9 z-30 w-52 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-lg py-1">
          <MenuItem
            icon={<FileJson className="w-3.5 h-3.5" strokeWidth={1.5} />}
            title="JSON 文件"
            subtitle="单个 .json"
            onClick={() => run("json")}
          />
          <MenuItem
            icon={<FileArchive className="w-3.5 h-3.5" strokeWidth={1.5} />}
            title="压缩包"
            subtitle="ZIP · 每份分析一文件"
            onClick={() => run("zip")}
          />
          <MenuItem
            icon={<Film className="w-3.5 h-3.5" strokeWidth={1.5} />}
            title="压缩包 · 含原视频"
            subtitle="ZIP · 额外打包本地视频"
            onClick={() => run("zip-media")}
          />
        </div>
      )}

      {toast && (
        <div
          className={`absolute right-0 top-9 z-30 whitespace-nowrap rounded-md border px-3 py-1.5 text-[11.5px] shadow-lg ${
            toast.kind === "ok"
              ? "border-emerald-200 dark:border-emerald-900/50 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300"
              : "border-rose-200 dark:border-rose-900/50 bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300"
          }`}
        >
          {toast.text}
        </div>
      )}
    </div>
  );
};

const MenuItem: FunctionComponent<{ icon: ReactNode; title: string; subtitle: string; onClick: () => void }> = ({
  icon,
  title,
  subtitle,
  onClick,
}) => (
  <button
    onClick={onClick}
    className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-slate-50 dark:hover:bg-slate-800/60"
  >
    <span className="text-slate-500 dark:text-slate-400">{icon}</span>
    <span className="flex-1 min-w-0">
      <span className="block text-[12.5px] text-slate-800 dark:text-slate-200">{title}</span>
      <span className="block text-[10.5px] font-mono text-slate-400">{subtitle}</span>
    </span>
  </button>
);
