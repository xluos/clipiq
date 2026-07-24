import { type FunctionComponent, useState } from "react";
import type { ShotContext } from "../../types";
import { fmtDuration } from "./PipelineStagePanel";

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

type Props = {
  shots: ShotContext[] | undefined;
  meta?: Record<string, unknown>;
};

const INITIAL_SHOW = 10;

export const StageShotMerge: FunctionComponent<Props> = ({ shots, meta }) => {
  const [showAll, setShowAll] = useState(false);

  if (!shots || shots.length === 0) {
    return <div className="text-[12px] text-slate-400">该阶段无数据</div>;
  }

  const batchCount = (meta?.batchCount as number) || 0;
  const cacheHits = (meta?.cacheHits as number) || 0;
  const avgMs = (meta?.avgMsPerShot as number) || 0;
  const displayed = showAll ? shots : shots.slice(0, INITIAL_SHOW);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-3 text-[12px]">
        <span className="text-slate-600 dark:text-slate-300">
          镜头 <span className="font-mono font-medium">{shots.length}</span>
        </span>
        {batchCount > 0 && (
          <span className="text-slate-400">
            <span className="font-mono">{batchCount}</span> 批
          </span>
        )}
        {avgMs > 0 && (
          <span className="text-slate-400">
            平均 <span className="font-mono">{fmtDuration(avgMs)}</span>/shot
          </span>
        )}
        {cacheHits > 0 && (
          <span className="text-emerald-500 font-mono">{cacheHits} 缓存命中</span>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-1.5">
        {displayed.map((sc) => {
          const hero = sc.representativeFrames?.[0] || sc.frames?.[0];
          const dur = sc.endSec - sc.startSec;
          return (
            <div key={sc.shotIndex} className="flex gap-3 rounded-lg border border-slate-200 dark:border-slate-800 p-2 bg-white dark:bg-[#0E0E10]">
              <div className="shrink-0 w-[120px] h-[68px] rounded-md border border-slate-200 dark:border-slate-800 overflow-hidden bg-slate-100 dark:bg-slate-900/40 relative">
                {hero?.thumbnailUrl && (
                  <img src={hero.thumbnailUrl} alt="" className="absolute inset-0 w-full h-full object-cover" loading="lazy" />
                )}
                <span className="absolute bottom-0.5 left-0.5 px-1 py-px rounded text-[9px] font-mono bg-black/60 text-white tabular-nums">
                  {hero?.midSec != null ? `${hero.midSec.toFixed(1)}s` : ""}
                </span>
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[10.5px] font-mono px-1.5 py-0.5 rounded-md bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400">
                    S{sc.shotIndex + 1}
                  </span>
                  <span className="text-[10.5px] font-mono text-slate-500">
                    {formatTime(sc.startSec)} → {formatTime(sc.endSec)}
                  </span>
                  <span className="text-[10px] font-mono text-slate-400">{dur.toFixed(1)}s</span>
                  {sc.frames && (
                    <span className="text-[10px] text-slate-400">{sc.frames.length} 帧</span>
                  )}
                </div>
                {sc.shotDescription && (
                  <p className="text-[12px] text-slate-600 dark:text-slate-400 mt-1 line-clamp-2">{sc.shotDescription}</p>
                )}
                {sc.subtitleText && (
                  <p className="text-[11px] text-slate-400 mt-0.5 truncate">{sc.subtitleText}</p>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {shots.length > INITIAL_SHOW && !showAll && (
        <button onClick={() => setShowAll(true)} className="text-[11px] text-indigo-600 dark:text-indigo-400 hover:underline">
          展开剩余 {shots.length - INITIAL_SHOW} 个镜头
        </button>
      )}
    </div>
  );
};
