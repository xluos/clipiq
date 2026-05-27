import { type ReactNode, useEffect, useRef, useState } from "react";
import { PhotoProvider, PhotoView } from "react-photo-view";
import "react-photo-view/dist/react-photo-view.css";
import { X, Play } from "lucide-react";

// ── 图片查看器 ──
// 单张: <ImageView src={url}><img .../></ImageView>
// 画廊: <ImageGallery> 包裹多个 <ImageView>

export function ImageGallery({ children }: { children: ReactNode }) {
  return <PhotoProvider maskOpacity={0.85} speed={() => 200}>{children}</PhotoProvider>;
}

export function ImageView({ src, children }: { src: string; children: ReactNode }) {
  return <PhotoView src={src}>{children}</PhotoView>;
}

// ── 视频播放器弹窗 ──

export function VideoPlayerModal({ src, poster, open, onClose }: {
  src: string;
  poster?: string;
  open: boolean;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (open && videoRef.current) {
      videoRef.current.play().catch(() => {});
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={onClose}>
      <div
        className="relative rounded-xl overflow-hidden bg-black shadow-2xl"
        style={{ maxWidth: "80vw", maxHeight: "80vh" }}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          className="absolute top-3 right-3 z-10 w-8 h-8 rounded-full bg-black/50 hover:bg-black/70 flex items-center justify-center text-white"
        >
          <X className="w-4 h-4" strokeWidth={2} />
        </button>
        <video
          ref={videoRef}
          src={src}
          poster={poster}
          controls
          autoPlay
          preload="auto"
          className="max-w-[80vw] max-h-[80vh]"
        />
      </div>
    </div>
  );
}

// ── 视频缩略图 + 点击弹窗 ──

function toMediaUrl(p: string | undefined): string | undefined {
  if (!p) return undefined;
  if (p.startsWith("media://")) return p;
  return `media://external/${encodeURIComponent(p)}`;
}

export function VideoThumbnail({ localVideoPath, thumbnailUrl, title, className }: {
  localVideoPath?: string;
  thumbnailUrl?: string;
  title?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const src = toMediaUrl(localVideoPath);

  return (
    <>
      <div
        className={`rounded-lg bg-slate-200 dark:bg-slate-800 shrink-0 overflow-hidden relative ${src ? "cursor-pointer" : ""} ${className || "h-[120px]"}`}
        onClick={() => src && setOpen(true)}
      >
        {thumbnailUrl
          ? <img src={thumbnailUrl} alt={title || ""} referrerPolicy="no-referrer" className="h-full w-auto object-cover" />
          : <span className="flex items-center justify-center h-full w-[120px] text-[11px] font-mono text-slate-400">无封面</span>}
        {src && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/20 hover:bg-black/30 transition-colors">
            <Play className="w-8 h-8 text-white/90" strokeWidth={1.5} fill="currentColor" />
          </div>
        )}
      </div>
      {src && <VideoPlayerModal src={src} poster={thumbnailUrl} open={open} onClose={() => setOpen(false)} />}
    </>
  );
}
