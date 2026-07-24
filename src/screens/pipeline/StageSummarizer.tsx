import { Badge } from "@/components/ui/badge";
import { type FunctionComponent } from "react";
import type { AnalysisReport } from "../../types";

type Props = {
  report: AnalysisReport | null;
};

export const StageSummarizer: FunctionComponent<Props> = ({ report }) => {
  const summary = report?.globalSummary;
  const audit = report?.methodologyAudit;
  const genre = audit?.detectedGenre;
  const confidence = audit?.genreConfidence;

  if (!summary && !genre) return <div className="text-[12px] text-slate-400">该阶段无数据</div>;

  return (
    <div className="space-y-3">
      {/* Genre + confidence */}
      {genre && (
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-[10.5px] font-mono">{genre}</Badge>
          {confidence != null && (
            <span className="text-[11px] font-mono text-slate-400">
              {(confidence * 100).toFixed(0)}%
            </span>
          )}
        </div>
      )}

      {/* Global summary */}
      {summary && (
        <div className="text-[13px] text-slate-700 dark:text-slate-300 leading-relaxed bg-white dark:bg-[#0E0E10] rounded-md border border-slate-200 dark:border-slate-800 px-3 py-2">
          {summary}
        </div>
      )}

      {/* Structure hint */}
      {report?.structure && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-[12px]">
          {report.structure.hook && (
            <div>
              <span className="text-[10.5px] text-slate-400 uppercase tracking-wider">Hook</span>
              <p className="text-slate-600 dark:text-slate-400 mt-0.5">{report.structure.hook}</p>
            </div>
          )}
          {report.structure.climax && (
            <div>
              <span className="text-[10.5px] text-slate-400 uppercase tracking-wider">Climax</span>
              <p className="text-slate-600 dark:text-slate-400 mt-0.5">{report.structure.climax}</p>
            </div>
          )}
          {report.structure.ending && (
            <div>
              <span className="text-[10.5px] text-slate-400 uppercase tracking-wider">Ending</span>
              <p className="text-slate-600 dark:text-slate-400 mt-0.5">{report.structure.ending}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
