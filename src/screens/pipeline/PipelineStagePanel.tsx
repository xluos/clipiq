import { ChevronDown, ChevronRight } from "lucide-react";
import { type FunctionComponent, type ReactNode, useState } from "react";

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.floor(s % 60);
  return `${m}m${rem}s`;
}

function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export type StageStat = {
  durationMs?: number;
  calls?: number;
  totalTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
  cacheHits?: number;
};

type Props = {
  index: number;
  name: string;
  color: string;
  stat?: StageStat;
  isLast?: boolean;
  defaultOpen?: boolean;
  children: ReactNode;
};

export const PipelineStagePanel: FunctionComponent<Props> = ({
  index, name, color, stat, isLast, defaultOpen, children,
}) => {
  const [open, setOpen] = useState(defaultOpen ?? false);

  return (
    <div className="relative">
      {/* Connector line */}
      {!isLast && (
        <div className="absolute left-[15px] top-[40px] bottom-[-8px] w-px bg-slate-200 dark:bg-slate-800" />
      )}

      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-3 px-3 py-2.5 text-left rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0E0E10] hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors"
      >
        {/* Accent bullet */}
        <div className="shrink-0 flex items-center justify-center w-[30px]">
          <div className={`w-2.5 h-2.5 rounded-full ${color}`} />
        </div>

        {/* Expand icon + name */}
        {open
          ? <ChevronDown className="w-3.5 h-3.5 shrink-0 text-slate-400" />
          : <ChevronRight className="w-3.5 h-3.5 shrink-0 text-slate-400" />
        }
        <span className="text-[13px] font-medium text-slate-800 dark:text-slate-200 flex-1">
          <span className="text-slate-400 dark:text-slate-500 font-mono mr-1.5">{index}.</span>
          {name}
        </span>

        {/* Stat badges */}
        <div className="shrink-0 flex items-center gap-2.5 text-[10.5px] font-mono text-slate-400 dark:text-slate-500">
          {stat?.durationMs != null && stat.durationMs > 0 && (
            <span>{fmtDuration(stat.durationMs)}</span>
          )}
          {stat?.calls != null && stat.calls > 0 && (
            <span>{stat.calls} 调用</span>
          )}
          {stat?.cacheHits != null && stat.cacheHits > 0 && (
            <span className="text-emerald-500">{stat.cacheHits} 缓存</span>
          )}
          {stat?.totalTokens != null && stat.totalTokens > 0 && (
            <span>{fmtTokens(stat.totalTokens)} tok</span>
          )}
        </div>
      </button>

      {/* Detail content */}
      {open && (
        <div className="ml-[30px] mt-1 mb-2 pl-6 border-l-2 border-slate-100 dark:border-slate-800/60">
          <div className="rounded-lg border border-slate-100 dark:border-slate-800/60 bg-slate-50/50 dark:bg-slate-900/30 p-4">
            {children}
          </div>
        </div>
      )}
    </div>
  );
};

export { fmtDuration, fmtTokens };
