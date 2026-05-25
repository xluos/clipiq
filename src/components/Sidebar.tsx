// ClipIQ v2 — 左侧 sidebar。4 个模块 + 任务队列 + 设置。
// 支持 220px 展开 / 56px 收起两态(localStorage 持久化)。
// 设计参考 design bundle 的 sidebar.jsx,token 用 DESIGN.md 的 accent-soft / paper-muted 取向。

import { type ReactNode } from "react";
import { useApp } from "../AppContext";
import { BrandLogo } from "./BrandLogo";
import { TaskQueueButton } from "./TaskQueuePanel";
import type { AppModule } from "../types";
import {
  BarChart3,
  Folder,
  UserSquare,
  Wand2,
  Settings,
  ChevronLeft,
  ChevronRight,
  Activity,
} from "lucide-react";

type Item = {
  id: AppModule;
  label: string;
  icon: ReactNode;
  /** disabled 状态下挂"即将上线"tooltip,但仍能点 (新模块占位也能进去) */
  hint?: string;
};

export function Sidebar() {
  const { currentLocation, goModule, sidebarCollapsed, setSidebarCollapsed } = useApp();
  const activeModule = currentLocation.module;
  const collapsed = sidebarCollapsed;

  const items: Item[] = [
    { id: "analysis", label: "分析",     icon: <BarChart3 className="w-4 h-4 shrink-0" strokeWidth={1.5} /> },
    { id: "library",  label: "素材库",    icon: <Folder className="w-4 h-4 shrink-0" strokeWidth={1.5} /> },
    { id: "account",  label: "账号分析",  icon: <UserSquare className="w-4 h-4 shrink-0" strokeWidth={1.5} /> },
    { id: "studio",   label: "剪辑助手",  icon: <Wand2 className="w-4 h-4 shrink-0" strokeWidth={1.5} /> },
  ];

  const width = collapsed ? 56 : 220;

  return (
    <aside
      className="shrink-0 flex flex-col bg-slate-50 dark:bg-slate-900/50 border-r border-slate-200 dark:border-slate-800 overflow-hidden relative"
      style={{
        width,
        padding: collapsed ? "16px 8px 12px" : "16px 12px 12px",
        transition: "width 0.18s cubic-bezier(0.4, 0, 0.2, 1), padding 0.18s ease",
      }}
    >
      {/* Brand */}
      <div
        className="flex items-center select-none"
        style={{
          gap: 10,
          padding: collapsed ? "4px 4px 18px" : "4px 8px 18px",
          justifyContent: collapsed ? "center" : "flex-start",
        }}
      >
        <BrandLogo size={collapsed ? 24 : 22} />
        {!collapsed && (
          <>
            <span className="text-[15px] font-semibold tracking-tight text-slate-900 dark:text-slate-100 leading-none">ClipIQ</span>
            <span className="ml-auto text-[10.5px] font-mono tracking-wider text-slate-400 dark:text-slate-500 uppercase">v0.4</span>
          </>
        )}
      </div>

      {/* Nav */}
      <nav className="flex flex-col gap-0.5">
        {items.map((it) => {
          const active = activeModule === it.id;
          return (
            <button
              key={it.id}
              onClick={() => goModule(it.id)}
              title={collapsed ? it.label : undefined}
              className={[
                "flex items-center rounded-lg text-left transition-colors",
                "text-[14px] leading-tight",
                collapsed ? "gap-0 justify-center py-[9px]" : "gap-2.5 justify-start px-2.5 py-[9px]",
                active
                  ? "bg-indigo-50 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300 border border-indigo-200/70 dark:border-indigo-800/50 font-medium"
                  : "border border-transparent text-slate-700 dark:text-slate-300 hover:bg-slate-200/60 dark:hover:bg-slate-800/60",
              ].join(" ")}
              style={{ transition: "padding 0.18s ease, gap 0.18s ease, background-color 0.12s ease, color 0.12s ease, border-color 0.12s ease" }}
            >
              {it.icon}
              {!collapsed && <span className="flex-1">{it.label}</span>}
            </button>
          );
        })}
      </nav>

      <div className="flex-1" />

      {/* Task queue — 全局任务面板 (sidebar 徽章 + 浮层) */}
      <TaskQueueButton collapsed={collapsed} />

      {/* Diagnostics + Settings */}
      <button
        onClick={() => goModule("diagnostics")}
        title={collapsed ? "诊断" : undefined}
        className={[
          "flex items-center rounded-lg text-left text-[14px] transition-colors",
          collapsed ? "gap-0 justify-center py-[9px]" : "gap-2.5 justify-start px-2.5 py-[9px]",
          activeModule === "diagnostics"
            ? "bg-indigo-50 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300 border border-indigo-200/70 dark:border-indigo-800/50 font-medium"
            : "border border-transparent text-slate-700 dark:text-slate-300 hover:bg-slate-200/60 dark:hover:bg-slate-800/60",
        ].join(" ")}
      >
        <Activity className="w-4 h-4 shrink-0" strokeWidth={1.5} />
        {!collapsed && <span className="flex-1">诊断</span>}
      </button>
      <button
        onClick={() => goModule("settings")}
        title={collapsed ? "设置" : undefined}
        className={[
          "flex items-center rounded-lg text-left text-[14px] transition-colors",
          collapsed ? "gap-0 justify-center py-[9px]" : "gap-2.5 justify-start px-2.5 py-[9px]",
          activeModule === "settings"
            ? "bg-indigo-50 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300 border border-indigo-200/70 dark:border-indigo-800/50 font-medium"
            : "border border-transparent text-slate-700 dark:text-slate-300 hover:bg-slate-200/60 dark:hover:bg-slate-800/60",
        ].join(" ")}
      >
        <Settings className="w-4 h-4 shrink-0" strokeWidth={1.5} />
        {!collapsed && <span className="flex-1">设置</span>}
      </button>

      {/* Collapse toggle */}
      <button
        onClick={() => setSidebarCollapsed(!collapsed)}
        title={collapsed ? "展开侧栏" : "收起侧栏"}
        className={[
          "mt-2 pt-3 border-t border-slate-200 dark:border-slate-800 flex items-center text-[12.5px] text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 transition-colors",
          collapsed ? "gap-0 justify-center py-2" : "gap-2.5 justify-start px-2.5 py-2",
        ].join(" ")}
      >
        {collapsed ? (
          <ChevronRight className="w-3.5 h-3.5 shrink-0" strokeWidth={1.5} />
        ) : (
          <ChevronLeft className="w-3.5 h-3.5 shrink-0" strokeWidth={1.5} />
        )}
        {!collapsed && <span className="flex-1">收起侧栏</span>}
      </button>
    </aside>
  );
}
