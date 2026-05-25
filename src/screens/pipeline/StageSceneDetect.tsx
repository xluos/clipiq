import { type FunctionComponent } from "react";
import { fmtDuration } from "./PipelineStagePanel";

type Props = {
  meta?: Record<string, unknown>;
};

export const StageSceneDetect: FunctionComponent<Props> = ({ meta }) => {
  const scenesCount = (meta?.scenesCount as number) || 0;
  const durationSec = (meta?.durationSec as number) || 0;

  if (!scenesCount) return <div className="text-[12px] text-slate-400">该阶段无数据</div>;

  const avgShotSec = durationSec > 0 && scenesCount > 0 ? durationSec / scenesCount : 0;

  return (
    <div className="flex flex-wrap gap-3 text-[12px]">
      <span className="text-slate-600 dark:text-slate-300">
        检出镜头 <span className="font-mono font-medium">{scenesCount}</span>
      </span>
      {durationSec > 0 && (
        <span className="text-slate-400">
          视频时长 <span className="font-mono">{fmtDuration(durationSec * 1000)}</span>
        </span>
      )}
      {avgShotSec > 0 && (
        <span className="text-slate-400">
          平均镜头 <span className="font-mono">{avgShotSec.toFixed(1)}s</span>
        </span>
      )}
    </div>
  );
};
