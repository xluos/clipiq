import { useApp } from "../AppContext";
import { ModeToggle } from "./theme-toggle";
import { Settings, Home } from "lucide-react";
import { BrandLogo } from "./BrandLogo";

export function TitleBar() {
  const { currentScreen, setCurrentScreen } = useApp();

  return (
    <div className="h-12 border-b border-slate-200 dark:border-slate-800 bg-white/50 dark:bg-[#0F172A]/60 backdrop-blur flex items-center justify-between pr-4 pl-[88px] shrink-0 shadow-sm" style={{ WebkitAppRegion: 'drag' } as any}>
      <div className="flex items-center gap-2 select-none">
        <BrandLogo size={22} />
        <div className="flex items-baseline gap-2">
          <span className="bg-gradient-to-r from-indigo-500 via-violet-500 to-cyan-500 bg-clip-text text-transparent text-sm font-bold tracking-tight">
            ClipIQ
          </span>
          <span className="text-[11px] text-slate-400 dark:text-slate-500 hidden sm:inline">自动拉片分析工具</span>
        </div>
      </div>
      <div className="flex items-center space-x-2" style={{ WebkitAppRegion: 'no-drag' } as any}>
        {currentScreen !== 'home' && (
          <button 
            onClick={() => setCurrentScreen('home')} 
            className="p-1.5 text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            title="回到首页"
          >
            <Home className="w-4 h-4" />
          </button>
        )}
        <button 
          onClick={() => setCurrentScreen('settings')} 
          className="p-1.5 text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
          title="系统设置"
        >
          <Settings className="w-4 h-4" />
        </button>
        <div className="w-px h-4 bg-slate-200 dark:bg-slate-700 mx-1" />
        <ModeToggle />
      </div>
    </div>
  );
}
