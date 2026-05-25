import { Badge } from "@/components/ui/badge";
import { Star } from "lucide-react";
import { type FunctionComponent, useState } from "react";
import type { AnalysisNode } from "../../types";

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

type Props = {
  nodes: AnalysisNode[];
  meta?: Record<string, unknown>;
};

const INITIAL_SHOW = 8;

export const StageMainAnalysis: FunctionComponent<Props> = ({ nodes, meta }) => {
  const [showAll, setShowAll] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (nodes.length === 0) return <div className="text-[12px] text-slate-400">该阶段无数据</div>;

  const highlights = nodes.filter((n) => n.isHighlight).length;
  const displayed = showAll ? nodes : nodes.slice(0, INITIAL_SHOW);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-3 text-[12px]">
        <span className="text-slate-600 dark:text-slate-300">
          节点 <span className="font-mono font-medium">{nodes.length}</span>
        </span>
        {highlights > 0 && (
          <span className="text-amber-500">
            <span className="font-mono">{highlights}</span> 高光
          </span>
        )}
        {meta?.model && (
          <span className="text-slate-400 font-mono">{meta.model as string}</span>
        )}
        {meta?.contextSize && (
          <span className="text-slate-400 font-mono">ctx={meta.contextSize as number}</span>
        )}
      </div>

      <div className="space-y-1">
        {displayed.map((node) => {
          const isExpanded = expandedId === node.id;
          return (
            <div key={node.id} className="rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0E0E10] overflow-hidden">
              <button
                onClick={() => setExpandedId(isExpanded ? null : node.id)}
                className="w-full flex items-center gap-2 px-3 py-2 text-left text-[12px] hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors"
              >
                {node.isHighlight && <Star className="w-3 h-3 text-amber-500 fill-amber-500 shrink-0" />}
                <span className="font-mono text-[10.5px] text-slate-400 shrink-0">
                  {formatTime(node.startSec)}
                </span>
                <span className="font-medium text-slate-700 dark:text-slate-300 truncate flex-1">
                  {node.title}
                </span>
                <div className="shrink-0 flex items-center gap-1">
                  {node.nodeTypes?.slice(0, 2).map((t) => (
                    <Badge key={t} variant="outline" className="text-[9px] py-0">{t}</Badge>
                  ))}
                  <span className="font-mono text-[10px] text-slate-400 ml-1">
                    {node.emotionLabel} {node.emotionIntensity}/10
                  </span>
                  <span className="font-mono text-[10px] text-slate-400">
                    {(node.confidence * 100).toFixed(0)}%
                  </span>
                </div>
              </button>
              {isExpanded && (
                <div className="px-3 pb-3 pt-1 border-t border-slate-100 dark:border-slate-800 space-y-2 text-[12px]">
                  <p className="text-slate-600 dark:text-slate-400">{node.shotDescription}</p>
                  <p className="text-slate-600 dark:text-slate-400 bg-slate-50 dark:bg-slate-900/40 rounded-md px-2 py-1.5">{node.editIntent}</p>
                  <div className="flex gap-4">
                    {node.visualElements?.length > 0 && (
                      <div className="flex-1">
                        <span className="text-[10.5px] text-slate-400 uppercase tracking-wider">画面</span>
                        <ul className="text-slate-500 mt-0.5 space-y-0.5">
                          {node.visualElements.map((el, i) => <li key={i}>· {el}</li>)}
                        </ul>
                      </div>
                    )}
                    {node.audioElements?.length > 0 && (
                      <div className="flex-1">
                        <span className="text-[10.5px] text-slate-400 uppercase tracking-wider">音频</span>
                        <ul className="text-slate-500 mt-0.5 space-y-0.5">
                          {node.audioElements.map((el, i) => <li key={i}>· {el}</li>)}
                        </ul>
                      </div>
                    )}
                  </div>
                  {node.subtitleText && (
                    <p className="text-[11px] text-slate-400 italic">"{node.subtitleText}"</p>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {nodes.length > INITIAL_SHOW && !showAll && (
        <button onClick={() => setShowAll(true)} className="text-[11px] text-indigo-600 dark:text-indigo-400 hover:underline">
          展开剩余 {nodes.length - INITIAL_SHOW} 个节点
        </button>
      )}
    </div>
  );
};
