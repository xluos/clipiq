import { type FunctionComponent, useState } from "react";
import type { AnalysisNode } from "../../types";

type DroppedDetail = {
  index: number;
  midSec: number;
  reason: string;
  salience: number | null;
  sceneType: string | null;
  caption: string | null;
  thumbnailUrl: string | null;
};

type Props = {
  projectId: string;
  nodes: AnalysisNode[];
  meta?: Record<string, unknown>;
};

const INITIAL_KEPT = 12;
const INITIAL_DROPPED = 8;

function fmtTimestamp(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export const StagePrefilter: FunctionComponent<Props> = ({ projectId, nodes, meta }) => {
  const kept = (meta?.kept as number) || 0;
  const dropped = (meta?.dropped as number) || 0;
  const modelKey = (meta?.modelKey as string) || "";
  const droppedDetails = (meta?.droppedDetails as DroppedDetail[] | undefined) || [];
  const [showAllKept, setShowAllKept] = useState(false);
  const [showDropped, setShowDropped] = useState(false);
  const [showAllDropped, setShowAllDropped] = useState(false);

  const taggedNodes = nodes.filter((n) => n.prefilterTag);
  const displayedKept = showAllKept ? taggedNodes : taggedNodes.slice(0, INITIAL_KEPT);
  const displayedDropped = showAllDropped ? droppedDetails : droppedDetails.slice(0, INITIAL_DROPPED);

  if (kept === 0 && dropped === 0 && taggedNodes.length === 0) {
    return <div className="text-[12px] text-slate-400">该阶段无数据</div>;
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-3 text-[12px]">
        <span className="text-slate-600 dark:text-slate-300">
          保留 <span className="font-mono font-medium text-emerald-600 dark:text-emerald-400">{kept}</span>
        </span>
        <span className="text-slate-600 dark:text-slate-300">
          丢弃 <span className="font-mono font-medium text-red-500 dark:text-red-400">{dropped}</span>
        </span>
        {modelKey && (
          <span className="text-slate-400 font-mono">{modelKey}</span>
        )}
      </div>

      {/* Kept frames grid */}
      {taggedNodes.length > 0 && (
        <div className="grid grid-cols-4 sm:grid-cols-6 gap-1.5">
          {displayedKept.map((node, i) => {
            const tag = node.prefilterTag!;
            const frame = node.framesInShot?.[0] || node.representativeFrames?.[0];
            const src = frame?.thumbnailUrl;
            return (
              <div key={node.id || i} className="relative rounded-md border border-slate-200 dark:border-slate-800 overflow-hidden bg-slate-100 dark:bg-slate-900/40 aspect-video">
                {src && <img src={src} alt="" className="absolute inset-0 w-full h-full object-cover" loading="lazy" />}
                <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-1 pb-0.5 pt-3">
                  <div className="flex items-center gap-1">
                    <span className="px-1 py-px rounded text-[8px] font-mono bg-white/20 text-white">{tag.sceneType}</span>
                    <span className="text-[8px] font-mono text-white/80">{tag.salience}</span>
                  </div>
                  {tag.caption && (
                    <div className="text-[8px] text-white/70 truncate mt-0.5">{tag.caption}</div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {taggedNodes.length > INITIAL_KEPT && !showAllKept && (
        <button onClick={() => setShowAllKept(true)} className="text-[11px] text-indigo-600 dark:text-indigo-400 hover:underline">
          展开剩余 {taggedNodes.length - INITIAL_KEPT} 张保留帧
        </button>
      )}

      {/* Dropped frames with reasons */}
      {droppedDetails.length > 0 && (
        <div className="space-y-1.5">
          <button
            onClick={() => setShowDropped(!showDropped)}
            className="flex items-center gap-1 text-[11px] text-slate-500 dark:text-slate-400 font-medium hover:text-slate-700 dark:hover:text-slate-200 transition-colors"
          >
            <span className="text-[9px]">{showDropped ? "▼" : "▶"}</span>
            丢弃帧详情 ({droppedDetails.length})
          </button>
          {showDropped && (
            <div className="space-y-0.5">
              {displayedDropped.map((d) => (
                <div key={d.index} className="flex items-center gap-2 text-[11px] py-1 px-2 rounded-md bg-red-50/50 dark:bg-red-950/20 border border-red-200/40 dark:border-red-900/20">
                  <span className="font-mono text-slate-400 shrink-0 w-[28px] text-right">#{d.index + 1}</span>
                  <span className="font-mono text-slate-400 shrink-0 w-[36px]">{fmtTimestamp(d.midSec)}</span>
                  {d.sceneType && (
                    <span className="px-1 py-px rounded text-[9px] font-mono bg-slate-200/60 dark:bg-slate-700/40 text-slate-500 dark:text-slate-400 shrink-0">{d.sceneType}</span>
                  )}
                  {d.salience != null && (
                    <span className="font-mono text-[9px] text-slate-400 shrink-0">sal {d.salience}</span>
                  )}
                  <span className="text-red-600 dark:text-red-400 truncate flex-1" title={d.reason}>{d.reason}</span>
                </div>
              ))}
              {droppedDetails.length > INITIAL_DROPPED && !showAllDropped && (
                <button onClick={() => setShowAllDropped(true)} className="text-[11px] text-indigo-600 dark:text-indigo-400 hover:underline">
                  展开剩余 {droppedDetails.length - INITIAL_DROPPED} 条
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
