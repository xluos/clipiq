// 全局任务队列面板 — 通用任务状态展示框架。
// 每种任务类型是一个独立 section,各自维护状态互不影响。
// 新增任务类型只需在 useTaskQueueData 里加一个数组 + drawer 里加一个 Section。

import { type FunctionComponent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useApp, type ModelDownloadProgress } from "../AppContext";
import { useTaskQueueStore } from "../stores/tasks";
import type { QueueTask } from "../electron-api";
import type { Video } from "../types";
import { Cpu, X, ChevronRight, AlertTriangle, UserSquare2, Download, Sparkles, Clock } from "lucide-react";

// ─── 通用任务条目类型 ─────────────────────────────────

type TaskEntry = {
  id: string;
  title: string;
  progress: number;
  stage: string;
  message?: string;
  icon?: ReactNode;
  onClick?: () => void;
};

const ACCOUNT_PLATFORM_LABEL: Record<string, string> = {
  douyin: "抖音",
  bilibili: "B 站",
  xiaohongshu: "小红书",
  youtube: "YouTube",
  tiktok: "TikTok",
};

// ─── 数据汇聚 hook ────────────────────────────────────

export function useTaskQueueData() {
  const { videos, accounts, accountFetchUi, progressByAnalysis, activeAnalysisForProject, analysesByVideo, modelDownloads } = useApp();
  const tasksById = useTaskQueueStore((s) => s.tasksById);

  // 后台任务队列里"排队中"的任务(运行中的仍由下面各 section 按 analysesByVideo 展示详细进度)。
  const queued = useMemo(
    () => Object.values(tasksById).filter((t) => t.status === "queued").sort((a, b) => a.createdAt - b.createdAt),
    [tasksById],
  );

  const base = useMemo(() => {
    // v3: 从 analysesByVideo 读正在跑的分析（不依赖 video.status）
    const analysisTasks: TaskEntry[] = [];
    const contentTasks: TaskEntry[] = [];
    const failedAnalyses: Array<{ videoTitle: string; analysisId: string; pipelineId: string; error?: string }> = [];

    for (const v of videos) {
      const analyses = analysesByVideo[v.id] || [];
      for (const a of analyses) {
        if (a.status === "analyzing") {
          const evt = progressByAnalysis[a.id] || (activeAnalysisForProject[v.id] === a.id ? progressByAnalysis[a.id] : undefined);
          const isContent = a.pipelineId === "builtin-content";
          const entry: TaskEntry = {
            id: a.id,
            title: v.title || v.videoName || v.id.slice(0, 12),
            progress: Math.round(evt?.progress ?? 50),
            stage: evt?.stage || "分析中",
            message: evt?.message,
            icon: isContent ? <Sparkles className="w-3.5 h-3.5 text-indigo-500 shrink-0" strokeWidth={1.5} /> : undefined,
          };
          if (isContent) contentTasks.push(entry);
          else analysisTasks.push(entry);
        } else if (a.status === "failed") {
          failedAnalyses.push({
            videoTitle: v.title || v.videoName || v.id.slice(0, 12),
            analysisId: a.id,
            pipelineId: a.pipelineId,
            error: a.errorMessage,
          });
        }
      }
    }

    // 账号拉取任务
    const accountTasks: TaskEntry[] = [];
    for (const accountId of Object.keys(accountFetchUi)) {
      const ui = accountFetchUi[accountId];
      const acc = accounts.find((a) => a.id === accountId);
      accountTasks.push({
        id: accountId,
        // 新账号首次拉取时 name 还没回填(拉到资料才有昵称),别露出裸 acc-<时间戳> id。
        title: acc?.name?.trim() || `${ACCOUNT_PLATFORM_LABEL[acc?.platform ?? ""] || "新"}账号`,
        progress: Math.round(ui.progress || 0),
        stage: ui.stage,
        message: ui.message,
        icon: <UserSquare2 className="w-3.5 h-3.5 text-slate-500 shrink-0" strokeWidth={1.5} />,
      });
    }

    // 模型下载任务
    const downloadTasks: TaskEntry[] = Object.values(modelDownloads).map((d: ModelDownloadProgress) => ({
      id: d.modelKey,
      title: d.label || d.modelKey,
      progress: d.percent,
      stage: d.stage === "progress" ? "下载中" : d.stage,
      message: fmtSize(d.receivedBytes) && fmtSize(d.totalBytes)
        ? `${fmtSize(d.receivedBytes)} / ${fmtSize(d.totalBytes)} · ${fmtSpeed(d.speed)}`
        : undefined,
      icon: <Download className="w-3.5 h-3.5 text-slate-500 shrink-0" strokeWidth={1.5} />,
    }));

    const totalRunning = analysisTasks.length + contentTasks.length + accountTasks.length + downloadTasks.length;
    return { analysisTasks, contentTasks, accountTasks, downloadTasks, failedAnalyses, totalRunning };
  }, [videos, analysesByVideo, progressByAnalysis, activeAnalysisForProject, accounts, accountFetchUi, modelDownloads]);

  return { ...base, queued, totalQueued: queued.length };
}

function fmtSize(n: number): string | null {
  if (!n) return null;
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
  return `${(n / 1024 / 1024).toFixed(0)} MB`;
}

function fmtSpeed(bps: number): string {
  if (!bps || bps <= 0) return "—";
  if (bps >= 1024 * 1024) return `${(bps / 1024 / 1024).toFixed(1)} MB/s`;
  if (bps >= 1024) return `${Math.round(bps / 1024)} KB/s`;
  return `${Math.round(bps)} B/s`;
}

// ─── Sidebar 按钮 ──────────────────────────────────────

export const TaskQueueButton: FunctionComponent<{ collapsed: boolean }> = ({ collapsed }) => {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const { totalRunning, totalQueued, failedAnalyses } = useTaskQueueData();
  const totalActive = totalRunning + totalQueued;
  const sidebarWidth = collapsed ? 56 : 220;

  useEffect(() => {
    if (!open) return;
    let attached = false;
    const onUp = (e: MouseEvent) => {
      const wrap = wrapRef.current;
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
          {totalActive > 0 && (
            <span
              className="absolute -top-1 -right-1.5 min-w-[14px] h-[14px] px-1 rounded-full bg-indigo-600 text-white font-mono font-semibold flex items-center justify-center leading-none"
              style={{ fontSize: 9 }}
            >
              {totalActive}
            </span>
          )}
          {totalActive === 0 && failedAnalyses.length > 0 && (
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
            {totalActive > 0 && (
              <span className="text-[10.5px] font-mono text-slate-500 dark:text-slate-400">
                · {totalRunning} 运行{totalQueued > 0 ? ` · ${totalQueued} 排队` : ""}
              </span>
            )}
          </span>
        )}
      </button>

      {open && <TaskQueueDrawer onClose={() => setOpen(false)} sidebarWidth={sidebarWidth} />}
    </div>
  );
};

// ─── Drawer ────────────────────────────────────────────

const TaskQueueDrawer: FunctionComponent<{ onClose: () => void; sidebarWidth: number }> = ({ onClose, sidebarWidth }) => {
  const { setLocation, setActiveProjectId, setCurrentScreen, refreshAnalyses, videos } = useApp();
  const { analysisTasks, contentTasks, accountTasks, downloadTasks, failedAnalyses, totalRunning, queued } = useTaskQueueData();

  const openProject = (videoId: string) => {
    setActiveProjectId(videoId);
    setLocation({ module: "analysis", screen: "progress" });
    onClose();
  };

  const openAccount = (accountId: string) => {
    try { window.sessionStorage.setItem("clipiq-active-account-id", accountId); } catch { /* noop */ }
    setLocation({ module: "account", screen: "detail" });
    onClose();
  };

  const openSettings = () => {
    setCurrentScreen("settings");
    onClose();
  };

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
        {/* 排队中(后台任务调度器:等待空闲槽位)*/}
        <QueuedSection tasks={queued} />

        {/* 结构拆解 */}
        <TaskSection title="结构拆解" entries={analysisTasks} onClickEntry={(t) => openProject(t.id)} />

        {/* 内容分析 */}
        <TaskSection title="内容分析" entries={contentTasks} onClickEntry={(t) => openProject(t.id)} />

        {/* 模型下载 */}
        <TaskSection title="模型下载" entries={downloadTasks} onClickEntry={() => openSettings()} />

        {/* 账号拉取 */}
        <TaskSection title="账号拉取" entries={accountTasks} onClickEntry={(t) => openAccount(t.id)} />

        {/* 失败记录 */}
        {failedAnalyses.length > 0 && (
          <Section title="失败记录" count={failedAnalyses.length} tone="danger">
            {failedAnalyses.map((a) => (
              <div
                key={a.analysisId}
                className="px-4 py-2.5 border-b border-slate-100 dark:border-slate-800/60 last:border-b-0 flex items-center gap-2"
              >
                <AlertTriangle className="w-3.5 h-3.5 text-rose-500 shrink-0" strokeWidth={1.5} />
                <div className="flex-1 min-w-0">
                  <div className="text-[12.5px] text-slate-900 dark:text-slate-100 truncate">{a.videoTitle}</div>
                  <div className="text-[10.5px] text-slate-500">{a.pipelineId === "builtin-content" ? "内容分析" : "结构拆解"}{a.error ? ` · ${a.error.slice(0, 40)}` : ""}</div>
                </div>
                <button
                  onClick={async () => {
                    await window.videoAnalyzer?.deleteAnalysis(a.analysisId).catch(() => {});
                    for (const v of videos) refreshAnalyses(v.id);
                  }}
                  title="删除失败记录"
                  className="w-6 h-6 rounded flex items-center justify-center text-slate-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-900/30 shrink-0"
                >
                  <X className="w-3 h-3" strokeWidth={1.5} />
                </button>
              </div>
            ))}
          </Section>
        )}

        {totalRunning === 0 && queued.length === 0 && failedAnalyses.length === 0 && (
          <div className="px-4 py-8 text-center">
            <p className="text-[12.5px] text-slate-500 dark:text-slate-400 leading-relaxed">
              当前没有任务在运行
            </p>
          </div>
        )}
      </div>
    </div>
  );
};

// ─── 通用任务 Section ──────────────────────────────────

// 排队中的任务:还没拿到运行槽位,可直接取消(从队列里拿掉,不会启动)。
const KIND_LABEL: Record<string, string> = { analysis: "结构拆解", summary: "内容分析" };

const QueuedSection: FunctionComponent<{ tasks: QueueTask[] }> = ({ tasks }) => {
  if (tasks.length === 0) return null;
  return (
    <Section title="排队中" count={tasks.length}>
      {tasks.map((t) => (
        <div
          key={t.id}
          className="px-4 py-2.5 border-b border-slate-100 dark:border-slate-800/60 last:border-b-0 flex items-center gap-2"
        >
          <Clock className="w-3.5 h-3.5 text-amber-500 shrink-0" strokeWidth={1.5} />
          <div className="flex-1 min-w-0">
            <div className="text-[12.5px] text-slate-900 dark:text-slate-100 truncate">{t.title}</div>
            <div className="text-[10.5px] font-mono tracking-wider text-slate-500 dark:text-slate-400">
              {KIND_LABEL[t.kind] || t.kind} · 等待运行
            </div>
          </div>
          <button
            onClick={() => window.videoAnalyzer?.cancelQueueTask(t.id).catch(() => {})}
            title="取消排队"
            className="w-6 h-6 rounded flex items-center justify-center text-slate-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-900/30 shrink-0"
          >
            <X className="w-3 h-3" strokeWidth={1.5} />
          </button>
        </div>
      ))}
    </Section>
  );
};

const TaskSection: FunctionComponent<{
  title: string;
  entries: TaskEntry[];
  onClickEntry: (entry: TaskEntry) => void;
}> = ({ title, entries, onClickEntry }) => {
  if (entries.length === 0) return null;
  return (
    <Section title={title} count={entries.length}>
      {entries.map((t) => (
        <button
          key={t.id}
          onClick={() => onClickEntry(t)}
          className="w-full text-left px-4 py-2.5 hover:bg-slate-50 dark:hover:bg-slate-800/40 border-b border-slate-100 dark:border-slate-800/60 last:border-b-0"
        >
          <div className="flex items-center gap-2">
            {t.icon}
            <div className="text-[12.5px] font-medium text-slate-900 dark:text-slate-100 truncate flex-1">{t.title}</div>
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
  );
};

// ─── Section 容器 ──────────────────────────────────────

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
