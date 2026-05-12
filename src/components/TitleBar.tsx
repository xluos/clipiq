import { useApp } from "../AppContext";
import { ModeToggle } from "./theme-toggle";
import { Settings, Home } from "lucide-react";

export function TitleBar() {
  const { currentScreen, setCurrentScreen } = useApp();

  return (
    <div className="h-12 border-b border-slate-200 dark:border-slate-800 bg-white/50 dark:bg-[#0A0A0B]/50 backdrop-blur flex items-center justify-between px-4 shrink-0 shadow-sm" style={{ WebkitAppRegion: 'drag' } as any}>
      <div className="flex items-center space-x-4">
        {/* Fake macOS buttons */}
        <div className="flex space-x-2 ml-2">
          <div className="w-3 h-3 rounded-full bg-red-400 dark:bg-red-500 shadow-inner" />
          <div className="w-3 h-3 rounded-full bg-amber-400 dark:bg-amber-500 shadow-inner" />
          <div className="w-3 h-3 rounded-full bg-green-400 dark:bg-green-500 shadow-inner" />
        </div>
        <div className="text-sm font-semibold text-slate-700 dark:text-slate-300 tracking-wide select-none">
          自动拉片分析工具
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
