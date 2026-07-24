import { ModeToggle } from "./theme-toggle";
import { RuntimeStatusIndicator } from "./RuntimeStatusIndicator";

export function TitleBar() {
  return (
    <div
      className="h-12 border-b border-slate-200 dark:border-slate-800 bg-white/60 dark:bg-[#0F172A]/60 backdrop-blur flex items-center justify-between pr-4 pl-[88px] shrink-0 relative z-20"
      style={{ WebkitAppRegion: 'drag' } as any}
    >
      {/* 单色 wordmark — v2 去掉了 from-indigo via-violet to-cyan 渐变 (违反 DESIGN.md "no purple-pink gradients")。
          品牌入口已挪到 sidebar 的 BrandLogo,这里只留极轻的 title + tagline。 */}
      <div className="flex items-baseline gap-2 select-none">
        <span className="text-[13px] font-medium tracking-tight text-slate-700 dark:text-slate-300">ClipIQ</span>
        <span className="text-[11px] text-slate-400 dark:text-slate-500 hidden sm:inline">看懂每一帧的逻辑</span>
      </div>
      <div className="flex items-center space-x-2" style={{ WebkitAppRegion: 'no-drag' } as any}>
        <RuntimeStatusIndicator />
        <div className="w-px h-4 bg-slate-200 dark:bg-slate-700 mx-1" />
        <ModeToggle />
      </div>
    </div>
  );
}
