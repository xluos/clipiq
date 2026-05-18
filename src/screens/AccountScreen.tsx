// 对标账号模块 — v2 Phase 2 占位屏。
// 后续会拆成 list / detail / methodology / batch-progress 等子屏(PRODUCT.md §4.3)。

import { UserSquare2, Sparkles } from "lucide-react";

export function AccountScreen() {
  return (
    <div className="flex-1 flex flex-col bg-slate-50 dark:bg-[#0A0A0B] overflow-hidden">
      <header className="border-b border-slate-200 dark:border-slate-800 bg-white/70 dark:bg-slate-900/40 px-8 py-5 shrink-0">
        <div className="max-w-5xl mx-auto flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 flex items-center justify-center">
            <UserSquare2 className="w-4 h-4 text-slate-700 dark:text-slate-300" strokeWidth={1.5} />
          </div>
          <div>
            <h1 className="text-[17px] font-semibold tracking-tight text-slate-900 dark:text-slate-100">账号分析</h1>
            <p className="text-[12.5px] text-slate-500 dark:text-slate-400 mt-0.5">UP 主方法论 · 批量拉片 · 跨视频汇总</p>
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto">
        <div className="max-w-4xl mx-auto px-8 py-16">
          <ComingSoon
            title="账号分析即将上线"
            description="输入对标 UP 主账号,批量分析热门视频,汇总账号的视频方法论(开场套路 / 节奏画像 / 结构模板 / 视觉风格)。"
            bullets={[
              "粘贴 B 站 / 抖音 / 小红书账号链接,自动识别平台",
              "选择拉取范围(热门 Top 10 / 最近 N 条 / 全部),批量套用分析配置",
              "跨视频 LLM 汇总产出 methodology manifest,可应用到剪辑助手",
            ]}
          />
        </div>
      </main>
    </div>
  );
}

function ComingSoon({ title, description, bullets }: { title: string; description: string; bullets: string[] }) {
  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/40 p-10">
      <div className="flex items-center gap-2 mb-4">
        <Sparkles className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400" strokeWidth={1.5} />
        <span className="text-[10.5px] font-mono tracking-[0.14em] uppercase text-indigo-600 dark:text-indigo-400">即将上线</span>
      </div>
      <h2 className="text-[22px] font-semibold tracking-tight text-slate-900 dark:text-slate-100 leading-tight">{title}</h2>
      <p className="mt-3 text-[14px] leading-relaxed text-slate-600 dark:text-slate-400 max-w-xl">{description}</p>
      <ul className="mt-6 space-y-2.5">
        {bullets.map((b, i) => (
          <li key={i} className="flex gap-2.5 text-[13.5px] text-slate-700 dark:text-slate-300 leading-relaxed">
            <span className="mt-2 w-1 h-1 rounded-full bg-slate-400 dark:bg-slate-600 shrink-0" />
            <span>{b}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
