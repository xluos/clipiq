import { type FunctionComponent } from "react";
import type { FramesCheckpoint } from "../../electron-api";
import { fmtDuration } from "./PipelineStagePanel";
import { ImageGallery, ImageView } from "../../components/MediaViewer";

type Props = {
  projectId: string;
  checkpoint: FramesCheckpoint | null;
  meta?: Record<string, unknown>;
};

export const StageExtractFrames: FunctionComponent<Props> = ({ projectId, checkpoint, meta }) => {
  if (!checkpoint) return <div className="text-[12px] text-slate-400">该阶段无数据</div>;

  const frames = checkpoint.frames;
  const durationSec = (meta?.durationSec as number) || 0;

  return (
    <div className="space-y-3">
      {/* Stats row */}
      <div className="flex flex-wrap gap-3 text-[12px]">
        <span className="text-slate-600 dark:text-slate-300">
          候选帧 <span className="font-mono font-medium">{frames.length}</span>
        </span>
        {checkpoint.skipped > 0 && (
          <span className="text-slate-400">
            相似过滤 <span className="font-mono">{checkpoint.skipped}</span>
          </span>
        )}
        {durationSec > 0 && (
          <span className="text-slate-400">
            视频时长 <span className="font-mono">{fmtDuration(durationSec * 1000)}</span>
          </span>
        )}
      </div>

      {/* Thumbnail grid */}
      <ImageGallery>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(100px,1fr))] gap-1.5">
          {frames.map((f, i) => {
            const filename = f.framePath.split("/").pop() || `keyframe-${String(i + 1).padStart(2, "0")}.jpg`;
            const src = `media://project/${projectId}/artifacts/${filename}`;
            return (
              <div key={i}>
                <ImageView src={src}>
                  <div className="rounded-md border border-slate-200 dark:border-slate-800 overflow-hidden bg-slate-100 dark:bg-slate-900/40 relative aspect-video cursor-pointer hover:ring-2 hover:ring-indigo-400 transition-shadow">
                    <img src={src} alt={`frame-${i}`} className="absolute inset-0 w-full h-full object-cover" loading="lazy" />
                    <span className="absolute bottom-0.5 left-0.5 px-1 py-px rounded text-[9px] font-mono bg-black/60 text-white tabular-nums">
                      {f.midSec.toFixed(1)}s
                    </span>
                  </div>
                </ImageView>
              </div>
            );
          })}
        </div>
      </ImageGallery>
    </div>
  );
};
