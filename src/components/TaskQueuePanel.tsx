// 全局任务队列面板 — sidebar 任务队列按钮浮出。
// 数据源: AppContext 里的 projects state + analysis:progress 事件聚合的最新进度。
// 单击任务行跳到对应项目的 progress / workspace 屏。

import { type FunctionComponent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../AppContext";
import type { AnalysisProgressEvent, Project } from "../types";
import { Cpu, X, ChevronRight, AlertTriangle, UserSquare2 } from "lucide-react";

type RunningTask = {
  projectId: string;
  videoName: string;
  progress: number;       // 0-100
  stage: string;
  message?: string;
};

type RunningAccountFetch = {
  accountId: string;
  accountName: string;
  progress: number;
  stage: string;
  message?: string;
};

export function useTaskQueueData() {
  const { projects, accounts, accountFetchUi } = useApp();
  const [progressByProject, setProgressByProject] = useState<Record<string, AnalysisProgressEvent>>({});

  useEffect(() => {
    if (!window.videoAnalyzer?.onAnalysisProgress) return;
    const unsub = window.videoAnalyzer.onAnalysisProgress((evt) => {
      setProgressByProject((prev) => ({ ...prev, [evt.projectId]: evt }));
    });
    return unsub;
  }, []);

  const { running, queued, failed, accountFetches } = useMemo(() => {
    const running: RunningTask[] = [];
    const queued: Project[] = [];
    const failed: Project[] = [];
    for (const p of projects) {
      if (p.status === "analyzing" || p.status === "downloading") {
        const evt = progressByProject[p.id];
        const isDownloading = p.status === "downloading";
        running.push({
          projectId: p.id,
          videoName: p.videoName,
          progress: Math.round(evt?.progress ?? (isDownloading ? 5 : 50)),
          stage: evt?.stage || (isDownloading ? "下载视频" : "分析中"),
          message: evt?.message,
        });
      } else if (p.status === "failed" || p.status === "download_failed") {
        failed.push(p);
      } else if (p.status === "not_analyzed") {
        // 不算队列(用户没主动 start),跳过
      }
    }
    const accountFetches: RunningAccountFetch[] = [];
    for (const accountId of Object.keys(accountFetchUi)) {
      const ui = accountFetchUi[accountId];
      const acc = accounts.find((a) => a.id === accountId);
      accountFetches.push({
        accountId,
        accountName: acc?.name || accountId,
        progress: Math.round(ui.progress || 0),
        stage: ui.stage,
        message: ui.message,
      });
    }
    return { running, queued, failed, accountFetches };
  }, [projects, progressByProject, accounts, accountFetchUi]);

  return { running, queued, failed, accountFetches };
}

// Sidebar 上的按钮 — 显示运行中数字徽章,点击切换浮层
export const TaskQueueButton: FunctionComponent<{ collapsed: boolean }> = ({ collapsed }) => {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const { running, failed, accountFetches } = useTaskQueueData();
  const sidebarWidth = collapsed ? 56 : 220;
  const totalRunning = running.length + accountFetches.length;

  // 点击外部关闭 — 用 mouseup + 下一帧 attach,避免和触发的 click 同一帧自杀
  useEffect(() => {
    if (!open) return;
    let attached = false;
    const onUp = (e: MouseEvent) => {
      const wrap = wrapRef.current;
      // 同时检测 wrap (button) 和 drawer (fixed,在 wrap 之外)
      const drawer = document.querySelector('[data-task-queue-drawer="1"]');
      const target = e.target as Node;
      if (wrap?.contains(target)) return;
      if (drawer?.contains(target)) return;
      setOpen(false);
    };
    const timer = window.setTimeout(() => {
      attached = true;
      document.addEventListener("mouseup", onUp);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      if (attached) document.removeEventListener("mouseup", onUp);
    };
  }, [open]);

  return (
    <div ref={wrapRef} className="relative">
      <button
        title={collapsed ? "任务队列" : undefined}
        onClick={() => setOpen((o) => !o)}
        className={[
          "flex items-center rounded-lg text-left text-[14px] transition-colors w-full",
          collapsed ? "gap-0 justify-center py-[9px]" : "gap-2.5 justify-start px-2.5 py-[9px]",
          open
            ? "bg-slate-200/60 dark:bg-slate-800/60 text-slate-900 dark:text-slate-100"
            : "text-slate-700 dark:text-slate-300 hover:bg-slate-200/60 dark:hover:bg-slate-800/60",
        ].join(" ")}
      >
        <span className="relative flex shrink-0">
          <Cpu className="w-4 h-4" strokeWidth={1.5} />
          {totalRunning > 0 && (
            <span
              className="absolute -top-1 -right-1.5 min-w-[14px] h-[14px] px-1 rounded-full bg-indigo-600 text-white font-mono font-semibold flex items-center justify-center leading-none"
              style={{ fontSize: 9 }}
            >
              {totalRunning}
            </span>
          )}
          {totalRunning === 0 && failed.length > 0 && (
            <span
              className="absolute -top-1 -right-1.5 min-w-[14px] h-[14px] px-1 rounded-full bg-rose-500 text-white font-mono font-semibold flex items-center justify-center leading-none"
              style={{ fontSize: 9 }}
            >
              !
            </span>
          )}
        </span>
        {!collapsed && (
          <span className="flex-1 flex items-center gap-2">
            任务队列
            {totalRunning > 0 && (
              <span className="text-[10.5px] font-mono text-slate-500 dark:text-slate-400">
                · {totalRunning} 运行中
              </span>
            )}
          </span>
        )}
      </button>

      {open && <TaskQueueDrawer onClose={() => setOpen(false)} sidebarWidth={sidebarWidth} />}
    </div>
  );
};

const TaskQueueDrawer: FunctionComponent<{ onClose: () => void; sidebarWidth: number }> = ({ onClose, sidebarWidth }) => {
  const { setLocation, setActiveProjectId, startAnalysisForProject } = useApp();
  const { running, failed, accountFetches } = useTaskQueueData();

  const openProject = (projectId: string, kind: "running" | "failed") => {
    if (kind === "running") {
      setActiveProjectId(projectId);
      setLocation({ module: "analysis", screen: "progress" });
    } else {
      // 失败重试: 直接用项目自带或全局默认参数重跑
      startAnalysisForProject(projectId);
    }
    onClose();
  };

  const openAccount = (accountId: string) => {
    try { window.sessionStorage.setItem("clipiq-active-account-id", accountId); } catch { /* noop */ }
    setLocation({ module: "account", screen: "detail" });
    onClose();
  };

  const totalRunning = running.length + accountFetches.length;

  return (
    <div
      data-task-queue-drawer="1"
      className="fixed w-[320px] rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xl z-50 overflow-hidden"
      style={{ left: sidebarWidth + 8, bottom: 16 }}
    >
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-200 dark:border-slate-800">
        <div className="text-[10.5px] font-mono tracking-[0.14em] uppercase text-slate-500 dark:text-slate-400">任务队列</div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200">
          <X className="w-3.5 h-3.5" strokeWidth={1.5} />
        </button>
      </div>

      <div className="max-h-[460px] overflow-y-auto">
        {/* 下载 + 分析 */}
        {running.length > 0 && (
          <Section title="视频任务" count={running.length}>
            {running.map((t) => (
              <button
                key={t.projectId}
                onClick={() => openProject(t.projectId, "running")}
                className="w-full text-left px-4 py-2.5 hover:bg-slate-50 dark:hover:bg-slate-800/40 border-b border-slate-100 dark:border-slate-800/60 last:border-b-0"
              >
                <div className="flex items-center gap-2">
                  <div className="text-[12.5px] font-medium text-slate-900 dark:text-slate-100 truncate flex-1">{t.videoName}</div>
                  <span className="text-[10.5px] font-mono text-indigo-700 dark:text-indigo-400">{t.progress}%</span>
                </div>
                <div className="mt-1.5 h-1 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                  <div className="h-full bg-indigo-600 dark:bg-indigo-500 rounded-full transition-all duration-300" style={{ width: `${t.progress}%` }} />
                </div>
                <div className="mt-1 text-[10.5px] font-mono tracking-wider text-slate-500 dark:text-slate-400 flex items-center gap-2">
                  <span>{t.stage}</span>
                  {t.message && <span className="truncate flex-1">· {t.message}</span>}
                </div>
              </button>
            ))}
          </Section>
        )}

        {/* 账号拉取 */}
        {accountFetches.length > 0 && (
          <Section title="账号拉取" count={accountFetches.length}>
            {accountFetches.map((t) => (
              <button
                key={t.accountId}
                onClick={() => openAccount(t.accountId)}
                className="w-full text-left px-4 py-2.5 hover:bg-slate-50 dark:hover:bg-slate-800/40 border-b border-slate-100 dark:border-slate-800/60 last:border-b-0"
              >
                <div className="flex items-center gap-2">
                  <UserSquare2 className="w-3.5 h-3.5 text-slate-500 shrink-0" strokeWidth={1.5} />
                  <div className="text-[12.5px] font-medium text-slate-900 dark:text-slate-100 truncate flex-1">{t.accountName}</div>
                  <span className="text-[10.5px] font-mono text-indigo-700 dark:text-indigo-400">{t.progress}%</span>
                </div>
                <div className="mt-1.5 h-1 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                  <div className="h-full bg-indigo-600 dark:bg-indigo-500 rounded-full transition-all duration-300" style={{ width: `${t.progress}%` }} />
                </div>
                <div className="mt-1 text-[10.5px] font-mono tracking-wider text-slate-500 dark:text-slate-400 flex items-center gap-2">
                  <span>{t.stage}</span>
                  {t.message && <span className="truncate flex-1">· {t.message}</span>}
                </div>
              </button>
            ))}
          </Section>
        )}

        {/* 失败 */}
        {failed.length > 0 && (
          <Section title="失败 · 可重试" count={failed.length} tone="danger">
            {failed.map((p) => (
              <button
                key={p.id}
                onClick={() => openProject(p.id, "failed")}
                className="w-full text-left px-4 py-2.5 hover:bg-slate-50 dark:hover:bg-slate-800/40 border-b border-slate-100 dark:border-slate-800/60 last:border-b-0 flex items-center gap-2"
              >
                <AlertTriangle className="w-3.5 h-3.5 text-rose-500 shrink-0" strokeWidth={1.5} />
                <div className="text-[12.5px] text-slate-900 dark:text-slate-100 truncate flex-1">{p.videoName}</div>
                <ChevronRight className="w-3 h-3 text-slate-400" strokeWidth={1.5} />
              </button>
            ))}
          </Section>
        )}

        {totalRunning === 0 && failed.length === 0 && (
          <div className="px-4 py-8 text-center">
            <p className="text-[12.5px] text-slate-500 dark:text-slate-400 leading-relaxed">
              当前没有任务在运行
              <br />
              <span className="text-[10.5px] font-mono uppercase tracking-wider mt-2 inline-block">视频下载 · 分析 / 账号拉取 都会出现在这里</span>
            </p>
          </div>
        )}
      </div>

      <div className="px-4 py-2 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/40">
        <span className="text-[10.5px] font-mono uppercase tracking-wider text-slate-500 dark:text-slate-400">
          全局任务面板 · 三个模块共享
        </span>
      </div>
    </div>
  );
};

const Section: FunctionComponent<{
  title: string;
  count: number;
  tone?: "default" | "danger";
  children: ReactNode;
}> = ({ title, count, tone = "default", children }) => {
  if (count === 0) return null;
  return (
    <div>
      <div className={`flex items-center px-4 py-1.5 text-[10.5px] font-mono tracking-wider uppercase ${
        tone === "danger" ? "text-rose-600 dark:text-rose-400" : "text-slate-500 dark:text-slate-400"
      } bg-slate-50 dark:bg-slate-900/40`}>
        <span>{title}</span>
        <span className="ml-2">· {count}</span>
      </div>
      {children}
    </div>
  );
};

