import { type FunctionComponent, useState } from "react";
import type { TranscriptData } from "../../electron-api";

type Props = {
  transcript: TranscriptData | null;
  meta?: Record<string, unknown>;
};

const INITIAL_SHOW = 10;

function fmtTimestamp(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export const StageTranscribe: FunctionComponent<Props> = ({ transcript, meta }) => {
  const [showAll, setShowAll] = useState(false);

  if (!transcript) return <div className="text-[12px] text-slate-400">该阶段无数据</div>;

  const segments = transcript.segments || [];
  const displayed = showAll ? segments : segments.slice(0, INITIAL_SHOW);
  const totalChars = (meta?.transcriptChars as number) || transcript.text?.length || 0;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-3 text-[12px]">
        {transcript.language && (
          <span className="text-slate-600 dark:text-slate-300">
            语言 <span className="font-mono font-medium">{transcript.language}</span>
          </span>
        )}
        <span className="text-slate-600 dark:text-slate-300">
          <span className="font-mono font-medium">{segments.length}</span> 段
        </span>
        <span className="text-slate-400">
          <span className="font-mono">{totalChars.toLocaleString()}</span> 字
        </span>
      </div>

      <div className="space-y-0.5">
        {displayed.map((seg, i) => (
          <div key={i} className="flex gap-2 text-[12px] py-0.5">
            <span className="shrink-0 font-mono text-slate-400 w-[48px] text-right tabular-nums">
              {fmtTimestamp(seg.start)}
            </span>
            <span className="text-slate-700 dark:text-slate-300">{seg.text}</span>
          </div>
        ))}
      </div>

      {segments.length > INITIAL_SHOW && !showAll && (
        <button onClick={() => setShowAll(true)} className="text-[11px] text-indigo-600 dark:text-indigo-400 hover:underline">
          展开剩余 {segments.length - INITIAL_SHOW} 段
        </button>
      )}
    </div>
  );
};
