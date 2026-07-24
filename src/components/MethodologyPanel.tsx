// 创作手册(方法论)展示面板 —— 账号详情页和收藏夹详情页共用。
// 新结构:共性洞察(commonalities)+ 创作方法(playbook),每条挂可点的样本视频 chip。
// 兼容老记录:有 hooks/pacing/structure/visual 就回退渲染旧 4 卡。
// 自带:生成按钮 + 版本历史切换。数据由调用方传入,生成动作由调用方实现。

import { type FunctionComponent, useMemo, useState } from "react";
import { Sparkles, Loader2 } from "lucide-react";
import type { AnyMethodology, MethodologyItem, Video } from "../types";

type Props = {
  methodology?: AnyMethodology;
  history?: AnyMethodology[];
  sourceCount: number;
  generating: boolean;
  error?: string;
  onGenerate: () => void;
  /** 解析 sampleVideoIds → 标题 + 点击跳转 */
  videos?: Video[];
  onClickSample?: (videoId: string) => void;
  /** 生成按钮文案里的名词,如「创作手册」/「方法论」 */
  noun?: string;
  emptyHint?: string;
};

function hasNew(m?: AnyMethodology): boolean {
  return !!m && ((m.commonalities?.length ?? 0) > 0 || (m.playbook?.length ?? 0) > 0);
}
function hasLegacy(m?: AnyMethodology): boolean {
  return !!m && !!(m.hooks || m.pacing || m.structure || m.visual);
}

export function MethodologyPanel({
  methodology, history, sourceCount, generating, error, onGenerate,
  videos, onClickSample, noun = "创作手册", emptyHint,
}: Props) {
  const [viewIdx, setViewIdx] = useState<number | null>(null);
  const allVersions = useMemo(() => {
    const list: AnyMethodology[] = [];
    if (methodology?.generatedAt) list.push(methodology);
    if (history?.length) list.push(...[...history].reverse());
    return list;
  }, [methodology, history]);
  const viewing = viewIdx !== null ? allVersions[viewIdx] : methodology;
  const showContent = hasNew(viewing) || hasLegacy(viewing);

  const titleOf = (id: string) => videos?.find((v) => v.id === id)?.title || id.slice(0, 12);

  return (
    <div className="space-y-4">
      {/* 操作栏 */}
      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={onGenerate}
          disabled={generating || sourceCount === 0}
          className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-[12.5px] font-medium bg-indigo-600 hover:bg-indigo-700 text-white disabled:opacity-50"
        >
          {generating ? <Loader2 className="w-3 h-3 animate-spin" strokeWidth={2} /> : <Sparkles className="w-3 h-3" strokeWidth={2} />}
          {generating ? "生成中…" : methodology ? `重新生成 (${sourceCount} 条视频)` : `生成${noun} (${sourceCount} 条视频)`}
        </button>
        {sourceCount === 0 && <span className="text-[11.5px] text-slate-500">需要先做内容分析的视频</span>}
        <div className="flex-1" />
        {allVersions.length > 1 && (
          <div className="flex items-center gap-1">
            <span className="text-[10.5px] font-mono text-slate-500 mr-1">历史</span>
            {allVersions.map((v, i) => (
              <button
                key={v.generatedAt || i}
                onClick={() => setViewIdx(i === 0 ? null : i)}
                className={`h-6 px-2 rounded text-[10.5px] font-mono ${
                  (viewIdx === null && i === 0) || viewIdx === i
                    ? "bg-indigo-50 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800"
                    : "text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-700"
                }`}
              >
                {i === 0 ? "最新" : new Date(v.generatedAt || "").toLocaleDateString("zh-CN", { month: "short", day: "numeric" })}
              </button>
            ))}
          </div>
        )}
      </div>

      {error && (
        <div className="text-[12px] text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-900/20 border border-rose-200 dark:border-rose-800/50 rounded-lg px-3 py-2">
          {error}
        </div>
      )}

      {!showContent ? (
        <div className="border border-dashed border-slate-300 dark:border-slate-700 rounded-xl bg-white/50 dark:bg-slate-900/30 px-8 py-12 text-center">
          <Sparkles className="w-5 h-5 mx-auto text-slate-400 dark:text-slate-500 mb-2" strokeWidth={1.5} />
          <p className="text-[13.5px] text-slate-600 dark:text-slate-400 leading-relaxed">
            {emptyHint || `${noun}还未生成。先对这组视频做内容分析,再点上方按钮生成。`}
          </p>
        </div>
      ) : (
        <div className="space-y-5">
          {viewing?.generatedAt && (
            <div className="text-[10.5px] font-mono text-slate-400">
              生成于 {new Date(viewing.generatedAt).toLocaleString("zh-CN")}
              {viewing.sourceVideoCount ? ` · 基于 ${viewing.sourceVideoCount} 条视频` : ""}
            </div>
          )}
          {hasNew(viewing) ? (
            <>
              <Section title="共性洞察" items={viewing!.commonalities} titleOf={titleOf} onClickSample={onClickSample} />
              <Section title="创作方法" items={viewing!.playbook} titleOf={titleOf} onClickSample={onClickSample} />
            </>
          ) : (
            <LegacyCards methodology={viewing!} />
          )}
        </div>
      )}
    </div>
  );
}

const Section: FunctionComponent<{
  title: string;
  items?: MethodologyItem[];
  titleOf: (id: string) => string;
  onClickSample?: (videoId: string) => void;
}> = ({ title, items, titleOf, onClickSample }) => {
  if (!items || items.length === 0) return null;
  return (
    <div>
      <div className="text-[10.5px] font-mono tracking-[0.14em] uppercase text-slate-500 dark:text-slate-400 mb-2">{title}</div>
      <div className="space-y-2.5">
        {items.map((it, i) => (
          <div key={i} className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/40 p-4">
            {it.title && <h3 className="text-[14px] font-semibold tracking-tight text-slate-900 dark:text-slate-100 mb-1.5">{it.title}</h3>}
            {it.detail && <p className="text-[13px] leading-relaxed text-slate-700 dark:text-slate-300">{it.detail}</p>}
            {it.sampleVideoIds && it.sampleVideoIds.length > 0 && (
              <div className="mt-2.5 flex items-center gap-1.5 flex-wrap">
                <span className="text-[10.5px] font-mono text-slate-400">样本</span>
                {it.sampleVideoIds.map((id) => (
                  <button
                    key={id}
                    onClick={() => onClickSample?.(id)}
                    className="max-w-[180px] truncate inline-flex items-center h-6 px-2 rounded-md text-[11px] bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-indigo-50 dark:hover:bg-indigo-950/40 hover:text-indigo-700 dark:hover:text-indigo-300"
                    title={titleOf(id)}
                  >
                    {titleOf(id)}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

// 老记录(偏结构拆解的 4 维)兜底渲染
const LegacyCards: FunctionComponent<{ methodology: AnyMethodology }> = ({ methodology }) => {
  const cards: Array<{ k: string; m?: { summary: string } }> = [
    { k: "开场风格 / Hooks", m: methodology.hooks },
    { k: "节奏画像", m: methodology.pacing },
    { k: "结构模板", m: methodology.structure },
    { k: "视觉风格", m: methodology.visual },
  ];
  return (
    <div className="grid gap-3 grid-cols-1 md:grid-cols-2">
      {cards.map(({ k, m }) =>
        m ? (
          <div key={k} className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/40 p-4">
            <h3 className="text-[14px] font-semibold tracking-tight text-slate-900 dark:text-slate-100 mb-2">{k}</h3>
            <p className="text-[13px] leading-relaxed text-slate-700 dark:text-slate-300">{m.summary}</p>
          </div>
        ) : null,
      )}
    </div>
  );
};
