// 剪辑助手模块 — v2 Phase 3 占位屏。
// 后续拆 list / editor 两屏(PRODUCT.md §4.4)。Editor 是左中右三栏: 输入设置 / 推荐输出 / 引用面板。

import { Wand2, Sparkles } from "lucide-react";

export function StudioScreen() {
  return (
    <div className="flex-1 flex flex-col bg-slate-50 dark:bg-[#0A0A0B] overflow-hidden">
      <header className="border-b border-slate-200 dark:border-slate-800 bg-white/70 dark:bg-slate-900/40 px-8 py-5 shrink-0">
        <div className="max-w-5xl mx-auto flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 flex items-center justify-center">
            <Wand2 className="w-4 h-4 text-slate-700 dark:text-slate-300" strokeWidth={1.5} />
          </div>
          <div>
            <h1 className="text-[17px] font-semibold tracking-tight text-slate-900 dark:text-slate-100">剪辑助手</h1>
            <p className="text-[12.5px] text-slate-500 dark:text-slate-400 mt-0.5">素材 × 方法论 → 剪辑思路 · 脚本草稿</p>
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto">
        <div className="max-w-4xl mx-auto px-8 py-16">
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/40 p-10">
            <div className="flex items-center gap-2 mb-4">
              <Sparkles className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400" strokeWidth={1.5} />
              <span className="text-[10.5px] font-mono tracking-[0.14em] uppercase text-indigo-600 dark:text-indigo-400">即将上线</span>
            </div>
            <h2 className="text-[22px] font-semibold tracking-tight text-slate-900 dark:text-slate-100 leading-tight">剪辑助手即将上线</h2>
            <p className="mt-3 text-[14px] leading-relaxed text-slate-600 dark:text-slate-400 max-w-xl">
              输入剪辑目标,结合素材库和对标账号方法论,自动推荐剪辑思路 / 镜头时间线 / 缺失镜头清单 / 脚本草稿。
            </p>
            <ul className="mt-6 space-y-2.5">
              <li className="flex gap-2.5 text-[13.5px] text-slate-700 dark:text-slate-300 leading-relaxed">
                <span className="mt-2 w-1 h-1 rounded-full bg-slate-400 dark:bg-slate-600 shrink-0" />
                <span>左栏 输入设置 · 剪辑目标 / 时长 / 应用的账号方法论 / 引用的素材池</span>
              </li>
              <li className="flex gap-2.5 text-[13.5px] text-slate-700 dark:text-slate-300 leading-relaxed">
                <span className="mt-2 w-1 h-1 rounded-full bg-slate-400 dark:bg-slate-600 shrink-0" />
                <span>中栏 推荐输出 · 叙事结构骨架 + 镜头时间线 + 缺失镜头清单 + 脚本草稿</span>
              </li>
              <li className="flex gap-2.5 text-[13.5px] text-slate-700 dark:text-slate-300 leading-relaxed">
                <span className="mt-2 w-1 h-1 rounded-full bg-slate-400 dark:bg-slate-600 shrink-0" />
                <span>右栏 引用面板 · 选中推荐项时显示引用的素材 Shot 与方法论条目</span>
              </li>
            </ul>
          </div>
        </div>
      </main>
    </div>
  );
}
