import { type FunctionComponent, useState } from "react";
import type { AnalysisNode } from "../../types";

type Props = {
  projectId: string;
  nodes: AnalysisNode[];
  meta?: Record<string, unknown>;
};

export const StagePrefilter: FunctionComponent<Props> = ({ projectId, nodes, meta }) => {
  const kept = (meta?.kept as number) || 0;
  const dropped = (meta?.dropped as number) || 0;
  const modelKey = (meta?.modelKey as string) || "";
  const [showAll, setShowAll] = useState(false);

  const taggedNodes = nodes.filter((n) => n.prefilterTag);
  const displayed = showAll ? taggedNodes : taggedNodes.slice(0, 12);

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

      {/* Frame grid with prefilterTag overlay */}
      {taggedNodes.length > 0 && (
        <div className="grid grid-cols-4 sm:grid-cols-6 gap-1.5">
          {displayed.map((node, i) => {
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

      {taggedNodes.length > 12 && !showAll && (
        <button onClick={() => setShowAll(true)} className="text-[11px] text-indigo-600 dark:text-indigo-400 hover:underline">
          展开剩余 {taggedNodes.length - 12} 帧
        </button>
      )}
    </div>
  );
};
