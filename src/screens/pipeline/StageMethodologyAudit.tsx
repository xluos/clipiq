import { Badge } from "@/components/ui/badge";
import { type FunctionComponent, useState } from "react";
import type { MethodologyAudit } from "../../types";

type Props = {
  audit: MethodologyAudit | undefined | null;
};

type ItemListProps = {
  items: Array<Record<string, unknown>>;
  color: string;
  labelKey: string;
  detailKeys: string[];
};

const ItemList: FunctionComponent<ItemListProps> = ({ items, color, labelKey, detailKeys }) => {
  const [showAll, setShowAll] = useState(false);
  const displayed = showAll ? items : items.slice(0, 5);
  return (
    <div className="space-y-1">
      {displayed.map((item, i) => (
        <div key={i} className="flex gap-2 text-[12px]">
          <span className={`shrink-0 w-1.5 h-1.5 rounded-full mt-1.5 ${color}`} />
          <div className="min-w-0 flex-1">
            <span className="font-medium text-slate-700 dark:text-slate-300">
              {String(item[labelKey] || item.ruleId || "")}
            </span>
            {item.category && (
              <Badge variant="outline" className="text-[9px] py-0 ml-1.5">{String(item.category)}</Badge>
            )}
            {detailKeys.map((dk) => item[dk] ? (
              <p key={dk} className="text-[11px] text-slate-400 mt-0.5">{String(item[dk])}</p>
            ) : null)}
          </div>
        </div>
      ))}
      {items.length > 5 && !showAll && (
        <button onClick={() => setShowAll(true)} className="text-[11px] text-indigo-600 dark:text-indigo-400 hover:underline ml-3.5">
          展开剩余 {items.length - 5} 条
        </button>
      )}
    </div>
  );
};

export const StageMethodologyAudit: FunctionComponent<Props> = ({ audit }) => {
  if (!audit) return <div className="text-[12px] text-slate-400">该阶段无数据</div>;

  return (
    <div className="space-y-4">
      {/* Score + genre */}
      <div className="flex items-center gap-4">
        <div className="text-center">
          <div className="text-2xl font-mono font-bold text-slate-800 dark:text-slate-100">{audit.overallScore}</div>
          <div className="text-[10px] text-slate-400 uppercase tracking-wider">总分</div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {audit.detectedGenre && <Badge variant="outline" className="text-[10.5px] font-mono">{audit.detectedGenre}</Badge>}
          {audit.lengthBucket && <Badge variant="outline" className="text-[10.5px] font-mono">{audit.lengthBucket}</Badge>}
          {audit.appliedRuleSets?.map((rs, i) => (
            <Badge key={i} variant="outline" className="text-[10.5px]">{typeof rs === "string" ? rs : (rs as Record<string, unknown>).name as string}</Badge>
          ))}
        </div>
      </div>

      {/* Hits */}
      {audit.hits && audit.hits.length > 0 && (
        <div>
          <div className="text-[11px] font-medium text-emerald-600 dark:text-emerald-400 mb-1.5">
            命中 ({audit.hits.length})
          </div>
          <ItemList items={audit.hits as Record<string, unknown>[]} color="bg-emerald-500" labelKey="ruleName" detailKeys={["evidence"]} />
        </div>
      )}

      {/* Violations */}
      {audit.violations && audit.violations.length > 0 && (
        <div>
          <div className="text-[11px] font-medium text-red-500 dark:text-red-400 mb-1.5">
            违反 ({audit.violations.length})
          </div>
          <ItemList items={audit.violations as Record<string, unknown>[]} color="bg-red-500" labelKey="ruleName" detailKeys={["evidence", "fixSuggestion"]} />
        </div>
      )}

      {/* Misses */}
      {audit.misses && audit.misses.length > 0 && (
        <div>
          <div className="text-[11px] font-medium text-amber-500 dark:text-amber-400 mb-1.5">
            缺失 ({audit.misses.length})
          </div>
          <ItemList items={audit.misses as Record<string, unknown>[]} color="bg-amber-500" labelKey="ruleName" detailKeys={["reason", "fixSuggestion"]} />
        </div>
      )}
    </div>
  );
};
