// 账号分析模块 — v2.1
// list: UP 主卡片网格 (头像 / 平台 / 粉丝 / 已分析 / 方法论摘要 / 标签)
// detail: hero + 3 tabs (方法论 / 视频 / 开场样本)
// add-account: 添加账号 dialog (粘贴链接 → 立即关闭, 后台拉取)
//
// v2.1 变化:
// - 账号下的视频不再做 Project; 单独存到 AccountVideo 表
// - 添加账号点确认后立即关闭 dialog, 后台拉视频列表; 进度走 TaskQueuePanel
// - 详情页 hero 加 fetchRange dropdown, 切换后自动重拉
// - 视频列表行: 已分析 → 跳 workspace; 未分析 → 行内"开始分析"按钮 (先下载再 analyzeProject)

import { type FunctionComponent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../AppContext";
import type {
  AppLocation,
  Account,
  AccountPlatform,
  AccountMethodology,
  AccountFetchRange,
  AccountVideo,
  VideoContentAnalysis,
  Project,
} from "../types";
import { defaultPresetToAnalysisOptions } from "../types";
import {
  UserSquare2,
  ArrowLeft,
  Plus,
  RefreshCw,
  Sparkles,
  ChevronRight,
  ChevronDown,
  X,
  Play,
  Loader2,
  AlertTriangle,
} from "lucide-react";

export function AccountScreen() {
  const { currentLocation } = useApp();
  if (currentLocation.module !== "account") return null;
  const screen = currentLocation.screen;
  if (screen === "detail") return <AccountDetailScreen />;
  if (screen === "methodology") return <AccountDetailScreen tab="methodology" />;
  return <AccountListScreen />;
}

// ─────────────────────────────────────────────────────────────
// 账号列表

const PLATFORM_LABEL: Record<AccountPlatform, string> = {
  bilibili: "BILIBILI",
  douyin: "DOUYIN",
  xiaohongshu: "XHS",
  youtube: "YOUTUBE",
  tiktok: "TIKTOK",
  unknown: "其他",
};

const RANGE_LABEL: Record<AccountFetchRange, string> = {
  top10: "热门 Top 10",
  recent20: "最近 20 条",
  all: "全部",
};

function avatarText(a: Account): string {
  if (a.avatarHint) return a.avatarHint;
  return a.name.slice(0, 2);
}

function gradientFromId(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 47 + id.charCodeAt(i)) | 0;
  const hue = Math.abs(hash) % 360;
  return `linear-gradient(135deg, hsl(${hue} 25% 32%), hsl(${(hue + 28) % 360} 25% 20%))`;
}

const AccountAvatar: FunctionComponent<{
  account: Account;
  size: number;
  fontSize: number;
}> = ({ account, size, fontSize }) => {
  const [imgError, setImgError] = useState(false);
  const showImg = !!account.avatarUrl && !imgError;
  return (
    <div
      className="rounded-full overflow-hidden text-white flex items-center justify-center font-medium shrink-0"
      style={{
        width: size,
        height: size,
        fontSize,
        background: gradientFromId(account.id),
      }}
    >
      {showImg ? (
        <img
          src={account.avatarUrl}
          alt={account.name}
          referrerPolicy="no-referrer"
          className="w-full h-full object-cover"
          onError={() => setImgError(true)}
        />
      ) : (
        avatarText(account)
      )}
    </div>
  );
};

function AccountListScreen() {
  const ctx = useApp();
  const { accounts, accountVideosByAccountId, accountFetchUi, setLocation, setActiveAccountId } = useAccountNav();
  const [addOpen, setAddOpen] = useState(false);

  const detailLoc: AppLocation = { module: "account", screen: "detail" };
  const totalVideos = useMemo(
    () => accounts.reduce((sum, a) => sum + (accountVideosByAccountId[a.id]?.length ?? 0), 0),
    [accounts, accountVideosByAccountId],
  );

  return (
    <div className="flex-1 flex flex-col bg-slate-50 dark:bg-[#0A0A0B] overflow-hidden">
      <header className="border-b border-slate-200 dark:border-slate-800 bg-white/70 dark:bg-slate-900/40 px-8 py-5 shrink-0">
        <div className="max-w-6xl mx-auto">
          <div className="text-[10.5px] font-mono tracking-[0.14em] uppercase text-slate-500 dark:text-slate-400">
            账号分析 · BENCHMARK
          </div>
          <div className="flex items-baseline gap-3 mt-1.5">
            <h1 className="text-[22px] font-semibold tracking-tight text-slate-900 dark:text-slate-100">账号分析</h1>
            <span className="text-[11.5px] font-mono text-slate-500 dark:text-slate-400">
              {accounts.length} 位 · {totalVideos} 条视频
            </span>
            <div className="flex-1" />
            <button
              onClick={() => setAddOpen(true)}
              className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md bg-indigo-600 hover:bg-indigo-700 text-white text-[13px] font-medium"
            >
              <Plus className="w-3.5 h-3.5" strokeWidth={2} />
              添加账号
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto">
        <div className="max-w-6xl mx-auto px-8 py-8">
          {accounts.length === 0 ? (
            <EmptyAccounts onAdd={() => setAddOpen(true)} />
          ) : (
            <div className="grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
              {accounts.map((a) => (
                <AccountCard
                  key={a.id}
                  account={a}
                  videos={accountVideosByAccountId[a.id] || []}
                  fetchUi={accountFetchUi[a.id]}
                  onClick={() => {
                    setActiveAccountId(a.id);
                    setLocation(detailLoc);
                  }}
                  onDelete={() => ctx.removeAccount(a.id)}
                />
              ))}
            </div>
          )}
        </div>
      </main>

      {addOpen && <AddAccountDialog onClose={() => setAddOpen(false)} ctx={ctx} />}
    </div>
  );
}

function useAccountNav() {
  const ctx = useApp();
  const setActiveAccountId = (id: string | null) => {
    if (id) window.sessionStorage.setItem("clipiq-active-account-id", id);
    else window.sessionStorage.removeItem("clipiq-active-account-id");
  };
  return { ...ctx, setActiveAccountId };
}

function activeAccountId(): string | null {
  try { return window.sessionStorage.getItem("clipiq-active-account-id"); } catch { return null; }
}

function EmptyAccounts({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="border border-dashed border-slate-300 dark:border-slate-700 rounded-xl bg-white/50 dark:bg-slate-900/30 px-8 py-16 text-center">
      <div className="w-12 h-12 mx-auto rounded-xl bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 flex items-center justify-center mb-4">
        <UserSquare2 className="w-5 h-5 text-slate-500 dark:text-slate-400" strokeWidth={1.5} />
      </div>
      <h2 className="text-[16px] font-semibold tracking-tight text-slate-900 dark:text-slate-100">还没有对标账号</h2>
      <p className="mt-2 text-[13.5px] text-slate-600 dark:text-slate-400 max-w-md mx-auto leading-relaxed">
        添加 UP 主账号,批量分析热门视频,自动汇总他们的视频方法论。
      </p>
      <button
        onClick={onAdd}
        className="mt-6 inline-flex items-center gap-1.5 h-9 px-4 rounded-md bg-indigo-600 hover:bg-indigo-700 text-white text-[13px] font-medium"
      >
        <Plus className="w-3.5 h-3.5" strokeWidth={2} />
        添加第一个账号
      </button>
    </div>
  );
}

const AccountCard: FunctionComponent<{
  account: Account;
  videos: AccountVideo[];
  fetchUi?: { stage: string; progress: number; message?: string };
  onClick: () => void;
  onDelete: () => void;
}> = ({ account, videos, fetchUi, onClick, onDelete }) => {
  const fetching = !!fetchUi || account.fetchPhase === "fetching";
  const analyzed = videos.filter((v) => !!v.analysisProjectId).length;
  const total = videos.length || account.totalVideoCount || 0;
  const ratioComplete = total > 0 && analyzed === total;
  const methodologySummary = (() => {
    const m = account.methodology;
    if (!m) return null;
    return [m.hooks?.summary, m.pacing?.summary, m.structure?.summary, m.visual?.summary].filter(Boolean).join(" ");
  })();
  const failed = account.fetchPhase === "failed";

  return (
    <button
      onClick={onClick}
      className="text-left p-4 rounded-xl bg-white dark:bg-slate-900/40 border border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700 transition-colors"
    >
      <div className="flex items-start gap-3">
        <AccountAvatar account={account} size={44} fontSize={12} />
        <div className="flex-1 min-w-0">
          <div className="text-[14.5px] font-semibold tracking-tight text-slate-900 dark:text-slate-100 truncate">{account.name || (account.fetchPhase === "fetching" ? "拉取中…" : "未知账号")}</div>
          <div className="text-[10.5px] font-mono tracking-wider uppercase text-slate-500 dark:text-slate-400 mt-1">
            {PLATFORM_LABEL[account.platform]}
            {account.followers && <span> · {account.followers} 粉丝</span>}
          </div>
        </div>
        <span
          className={`text-[10.5px] font-mono px-1.5 py-0.5 rounded ${
            fetching
              ? "bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300"
              : ratioComplete
              ? "bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300"
              : "bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400"
          }`}
        >
          {fetching ? "拉取中…" : `${analyzed}/${total || "?"}`}
        </span>
      </div>

      <div className="flex gap-1 mt-3">
        {(account.tags?.length ?? 0) > 0 ? (
          account.tags!.map((t) => (
            <span key={t} className="text-[10.5px] font-mono px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400">
              {t}
            </span>
          ))
        ) : (
          <span aria-hidden className="text-[10.5px] font-mono px-1.5 py-0.5 rounded invisible">·</span>
        )}
      </div>

      {fetching ? (
        <div className="mt-3.5 px-3 py-2.5 bg-indigo-50/50 dark:bg-indigo-950/30 rounded-md">
          <div className="text-[10.5px] font-mono tracking-wider uppercase text-indigo-700 dark:text-indigo-400">
            {fetchUi?.stage || "拉取中"} · {fetchUi?.progress ?? 0}%
          </div>
          <div className="mt-1.5 h-1 rounded-full bg-indigo-100 dark:bg-indigo-900/40 overflow-hidden">
            <div className="h-full bg-indigo-600 dark:bg-indigo-500 rounded-full transition-all" style={{ width: `${fetchUi?.progress ?? 0}%` }} />
          </div>
        </div>
      ) : failed ? (
        <div className="mt-3.5 px-3 py-2.5 bg-rose-50 dark:bg-rose-950/30 rounded-md">
          <div className="flex items-start gap-1.5">
            <AlertTriangle className="w-3 h-3 mt-0.5 text-rose-500 shrink-0" strokeWidth={1.5} />
            <p className="text-[12px] text-rose-700 dark:text-rose-300 leading-relaxed line-clamp-2 flex-1">
              {account.fetchError || "拉取失败"}
            </p>
          </div>
          <span
            role="button"
            onClick={(e) => {
              e.stopPropagation();
              const label = account.name || "该账号";
              if (!window.confirm(`确认删除「${label}」？`)) return;
              onDelete();
            }}
            className="mt-2 inline-flex items-center gap-1 h-6 px-2 rounded text-[11px] text-rose-600 dark:text-rose-400 hover:bg-rose-100 dark:hover:bg-rose-900/40"
          >
            <X className="w-3 h-3" strokeWidth={2} />
            删除
          </span>
        </div>
      ) : (
        <div className="mt-3.5 px-3 py-2.5 bg-slate-50 dark:bg-slate-800/40 rounded-md">
          <div className="text-[10.5px] font-mono tracking-wider uppercase text-slate-500 dark:text-slate-400">方法论摘要</div>
          <p className="text-[12.5px] text-slate-700 dark:text-slate-300 leading-relaxed mt-1 line-clamp-2">
            {methodologySummary || "还未生成 — 拉取视频并分析后会自动汇总"}
          </p>
        </div>
      )}

      <div className="mt-3 flex items-center gap-2 text-[10.5px] font-mono tracking-wider uppercase text-slate-500 dark:text-slate-400">
        {account.updatedAt ? `更新于 ${formatRelative(account.updatedAt)}` : "刚创建"}
        <div className="flex-1" />
        {account.fetchRange && <span>{RANGE_LABEL[account.fetchRange]}</span>}
      </div>
    </button>
  );
};

function formatRelative(iso: string): string {
  const dt = new Date(iso);
  const diffH = (Date.now() - dt.getTime()) / 3600_000;
  if (diffH < 1) return "刚刚";
  if (diffH < 24) return `${Math.floor(diffH)}小时前`;
  if (diffH < 48) return "昨天";
  return dt.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

// ─────────────────────────────────────────────────────────────
// 添加账号 dialog (后台拉取版)

function detectPlatform(url: string): AccountPlatform {
  const u = url.toLowerCase();
  if (u.includes("bilibili.com") || u.includes("b23.tv")) return "bilibili";
  if (u.includes("douyin.com")) return "douyin";
  if (u.includes("xiaohongshu.com") || u.includes("xhslink.com")) return "xiaohongshu";
  if (u.includes("youtube.com") || u.includes("youtu.be")) return "youtube";
  if (u.includes("tiktok.com")) return "tiktok";
  return "unknown";
}

function AddAccountDialog({ onClose, ctx }: { onClose: () => void; ctx: ReturnType<typeof useApp> }) {
  const { upsertAccount, setLocation } = ctx;
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [range, setRange] = useState<AccountFetchRange>("top10");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [bridgeConnected, setBridgeConnected] = useState<boolean | null>(null);

  useEffect(() => {
    if (!window.videoAnalyzer?.extensionBridge) {
      setBridgeConnected(null);
      return;
    }
    window.videoAnalyzer.extensionBridge.getStatus()
      .then((s) => setBridgeConnected(s.connected))
      .catch(() => setBridgeConnected(null));
    const off = window.videoAnalyzer.extensionBridge.onStatus((s) => setBridgeConnected(s.connected));
    return off;
  }, []);

  const platform = useMemo(() => detectPlatform(url), [url]);
  const showBridgeHint =
    (platform === "douyin" || platform === "bilibili") && bridgeConnected === false;
  const canSubmit = url.trim().length > 0 && !submitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setError("");
    setSubmitting(true);
    const now = new Date().toISOString();
    const accId = `acc-${Date.now()}`;
    const resolvedName = name.trim();

    // 1) 创建占位 Account — 必须先 await 把 stub 落到 main 进程 DB,
    //    否则下面 startAccountFetch 在 main lookup account 时找不到, 导致 done event 里
    //    accountPatch={} 没 id,renderer 不会把 fetchPhase 切回 ready,UI 永远停在"拉取中".
    const stub: Account = {
      id: accId,
      name: resolvedName,
      platform,
      externalUrl: url.trim(),
      avatarHint: resolvedName.slice(0, 2) || "…",
      fetchRange: range,
      fetchPhase: "fetching",
      createdAt: now,
      updatedAt: now,
    };
    upsertAccount(stub);
    if (window.videoAnalyzer?.upsertAccount) {
      try {
        await window.videoAnalyzer.upsertAccount(stub);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setSubmitting(false);
        return;
      }
    }

    // 2) 触发后台拉取
    try {
      if (window.videoAnalyzer?.startAccountFetch) {
        await window.videoAnalyzer.startAccountFetch({ accountId: accId, url: url.trim(), range });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
      return;
    }

    setSubmitting(false);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 dark:bg-black/60 backdrop-blur-sm flex items-center justify-center p-6">
      <div className="w-full max-w-md rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xl">
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-200 dark:border-slate-800">
          <div className="text-[10.5px] font-mono tracking-[0.14em] uppercase text-slate-500">添加账号</div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-900 dark:hover:text-slate-100">
            <X className="w-4 h-4" strokeWidth={1.5} />
          </button>
        </div>
        <div className="p-5 space-y-3.5">
          <Field label="账号主页链接">
            <input
              autoFocus
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://space.bilibili.com/946974"
              className="w-full h-9 px-3 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-[13px] text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:focus:ring-indigo-900/40"
            />
            {url && (
              <div className="mt-1.5 text-[10.5px] font-mono tracking-wider uppercase text-indigo-600 dark:text-indigo-400">
                平台 · {PLATFORM_LABEL[platform]}
              </div>
            )}
          </Field>
          <Field label="账号名 (可选,留空自动从平台拉取)">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="影视飓风"
              className="w-full h-9 px-3 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-[13px] text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:focus:ring-indigo-900/40"
            />
          </Field>
          <Field label="首次拉取范围">
            <div className="flex gap-1.5">
              {(["top10", "recent20", "all"] as AccountFetchRange[]).map((k) => (
                <button
                  key={k}
                  onClick={() => setRange(k)}
                  className={`flex-1 h-8 px-2 rounded-md text-[12px] border ${
                    range === k
                      ? "bg-indigo-50 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300 border-indigo-200 dark:border-indigo-800/50"
                      : "bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800"
                  }`}
                >
                  {RANGE_LABEL[k]}
                </button>
              ))}
            </div>
          </Field>
        </div>
        {showBridgeHint && (
          <div className="mx-5 mb-3 rounded-md border border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-[12px] text-amber-800 dark:text-amber-200 flex items-start gap-2">
            <span className="leading-relaxed flex-1">
              {platform === "douyin"
                ? "抖音风控较严, 没装 Chrome 插件大概率拉不到视频。"
                : "B 站投稿接口偶发 412 风控, 装 Chrome 插件后稳定很多。"}
            </span>
            <button
              type="button"
              onClick={() => { setLocation({ module: "settings" }); onClose(); }}
              className="shrink-0 text-[11.5px] underline underline-offset-2 hover:text-amber-900 dark:hover:text-amber-100"
            >
              去设置
            </button>
          </div>
        )}
        {error && (
          <div className="mx-5 mb-3 rounded-md border border-rose-200 dark:border-rose-900/50 bg-rose-50 dark:bg-rose-950/30 px-3 py-2 text-[12px] text-rose-700 dark:text-rose-300">
            {error}
          </div>
        )}
        <div className="flex items-center gap-2 px-5 py-3 border-t border-slate-200 dark:border-slate-800">
          <span className="text-[11px] font-mono uppercase tracking-wider text-slate-500 flex-1">
            点击后立即关闭, 后台拉取
          </span>
          <button onClick={onClose} disabled={submitting} className="h-8 px-3 rounded-md text-[12.5px] text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50">
            取消
          </button>
          <button
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="h-8 px-3 rounded-md text-[12.5px] font-medium bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-200 dark:disabled:bg-slate-800 disabled:text-slate-400 text-white"
          >
            添加
          </button>
        </div>
      </div>
    </div>
  );
}

const Field: FunctionComponent<{ label: string; children: ReactNode }> = ({ label, children }) => (
  <div>
    <label className="block text-[10.5px] font-mono tracking-wider uppercase text-slate-500 mb-1.5">{label}</label>
    {children}
  </div>
);

// ─────────────────────────────────────────────────────────────
// 账号详情屏

function AccountDetailScreen({ tab: initialTab = "methodology" }: { tab?: "methodology" | "videos" | "hooks" }) {
  const ctx = useApp();
  const {
    accounts, setLocation, projects, setProjects, reportByAnalysis, upsertAccount,
    accountVideosByAccountId, accountFetchUi, refreshAccountVideos,
    setActiveProjectId,
  } = ctx;
  const id = activeAccountId();
  const account = accounts.find((a) => a.id === id);
  const [tab, setTab] = useState<"methodology" | "videos" | "hooks">(initialTab);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState("");

  const accountVideos = useMemo(() => (id ? accountVideosByAccountId[id] || [] : []), [accountVideosByAccountId, id]);

  // 进入详情时刷一次 (兜底,事件流之外的迟滞情况)
  useEffect(() => {
    if (id) refreshAccountVideos(id);
  }, [id, refreshAccountVideos]);

  const fetchingUi = id ? accountFetchUi[id] : undefined;
  const fetching = !!fetchingUi || account?.fetchPhase === "fetching";

  const completedVideos = useMemo(
    () => accountVideos.filter((v) => v.analysisProjectId && projects.find((p) => p.id === v.analysisProjectId && p.status === "completed")),
    [accountVideos, projects],
  );

  const triggerFetch = async (range: AccountFetchRange) => {
    if (!account || !account.externalUrl) return;
    if (!window.videoAnalyzer?.startAccountFetch) return;
    if (tab !== "videos") setTab("videos");
    const patched = { ...account, fetchRange: range, fetchPhase: "fetching" as const, updatedAt: new Date().toISOString() };
    upsertAccount(patched);
    // 先把 fetchRange/fetchPhase 落到 main 进程 DB,再启动后台拉取;
    // 避免 main 端读到的还是上一次的 range 或 stale fetchPhase.
    try {
      if (window.videoAnalyzer.upsertAccount) await window.videoAnalyzer.upsertAccount(patched);
    } catch (err) { console.warn("upsertAccount before fetch failed", err); }
    window.videoAnalyzer.startAccountFetch({ accountId: account.id, url: account.externalUrl, range })
      .catch((err) => console.warn("startAccountFetch failed", err));
  };

  const generateMethodology = async () => {
    if (!account) return;
    if (completedVideos.length === 0) {
      setGenError("至少需要 1 条已完成拆解分析的视频。");
      return;
    }
    setGenError("");
    setGenerating(true);
    try {
      const videoSummaries = completedVideos.map((v) => {
        const proj = projects.find((p) => p.id === v.analysisProjectId);
        const r = proj?.currentAnalysisId ? reportByAnalysis[proj.currentAnalysisId] : undefined;
        return {
          title: v.title,
          summary: r?.globalSummary || r?.summary || "",
          structure: r?.structure,
          pacing: r?.pacing,
          editingStyle: r?.editingStyle,
          composition: r?.composition,
        };
      });
      const result = await window.videoAnalyzer?.generateAccountMethodology?.({
        accountName: account.name,
        videoSummaries,
      });
      if (result?.methodology) {
        upsertAccount({ ...account, methodology: result.methodology, updatedAt: new Date().toISOString() });
      }
    } catch (e) {
      setGenError(e instanceof Error ? e.message : String(e));
    }
    setGenerating(false);
  };

  const backToList: AppLocation = { module: "account", screen: "list" };

  if (!account) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center bg-slate-50 dark:bg-[#0A0A0B] gap-4">
        <p className="text-[13px] text-slate-500">未找到账号</p>
        <button
          onClick={() => setLocation(backToList)}
          className="h-9 px-4 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-[13px] text-slate-700 dark:text-slate-300"
        >
          返回账号列表
        </button>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col bg-slate-50 dark:bg-[#0A0A0B] overflow-hidden">
      <header className="border-b border-slate-200 dark:border-slate-800 bg-white/70 dark:bg-slate-900/40 px-6 py-3 shrink-0 flex items-center gap-3">
        <button
          onClick={() => setLocation(backToList)}
          className="inline-flex items-center gap-1.5 h-8 px-2 rounded-md text-[13px] text-slate-600 dark:text-slate-300 hover:bg-slate-200/60 dark:hover:bg-slate-800/60"
        >
          <ArrowLeft className="w-3.5 h-3.5" strokeWidth={1.5} />
          账号分析
        </button>
        <div className="w-px h-4 bg-slate-200 dark:bg-slate-800" />
        <h2 className="text-[14px] font-semibold text-slate-900 dark:text-slate-100">{account.name || (account.fetchPhase === "fetching" ? "拉取中…" : "未知账号")}</h2>
        <span className="text-[10.5px] font-mono px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400">
          {PLATFORM_LABEL[account.platform]}
        </span>
        <div className="flex-1" />
        <RangeDropdown current={account.fetchRange || "top10"} disabled={fetching} onPick={triggerFetch} />
        <button
          onClick={() => triggerFetch(account.fetchRange || "top10")}
          disabled={fetching}
          title="重新拉取头像 / 粉丝 / 视频列表"
          className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-[12.5px] text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50"
        >
          <RefreshCw className={`w-3 h-3 ${fetching ? "animate-spin" : ""}`} strokeWidth={1.5} />
          {fetching ? "拉取中…" : "刷新拉取"}
        </button>
        <button
          onClick={generateMethodology}
          disabled={generating}
          title={completedVideos.length === 0 ? "需要先拆解分析至少 1 条视频" : "跨视频汇总方法论"}
          className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-[12.5px] bg-indigo-50 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300 border border-indigo-200/70 dark:border-indigo-800/50 hover:bg-indigo-100 dark:hover:bg-indigo-900/40 disabled:opacity-50"
        >
          <Sparkles className="w-3 h-3" strokeWidth={1.5} />
          {generating ? "汇总中…" : `汇总方法论 (${completedVideos.length})`}
        </button>
        <button
          onClick={() => {
            const label = account.name || "该账号";
            if (!window.confirm(`确认删除「${label}」？相关视频数据和摘要也会一并删除。`)) return;
            ctx.removeAccount(account.id);
            setLocation(backToList);
          }}
          title="删除账号"
          className="inline-flex items-center justify-center w-8 h-8 rounded-md text-slate-500 dark:text-slate-400 hover:bg-rose-50 dark:hover:bg-rose-900/30 hover:text-rose-600 dark:hover:text-rose-400"
        >
          <X className="w-3.5 h-3.5" strokeWidth={1.5} />
        </button>
      </header>
      {genError && (
        <div className="mx-6 mt-2 rounded-md border border-rose-200 dark:border-rose-900/50 bg-rose-50 dark:bg-rose-950/30 px-3 py-2 text-[12.5px] text-rose-700 dark:text-rose-300">
          {genError}
        </div>
      )}
      {fetchingUi && (
        <div className="mx-6 mt-2 rounded-md border border-indigo-200 dark:border-indigo-900/50 bg-indigo-50 dark:bg-indigo-950/30 px-3 py-2 text-[12.5px] text-indigo-700 dark:text-indigo-300 flex items-center gap-2">
          <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={1.5} />
          <span className="font-mono uppercase tracking-wider">{fetchingUi.stage} · {fetchingUi.progress}%</span>
          {fetchingUi.message && <span className="truncate">— {fetchingUi.message}</span>}
        </div>
      )}
      {account.fetchPhase === "failed" && !fetchingUi && (
        <div className="mx-6 mt-2 rounded-md border border-rose-200 dark:border-rose-900/50 bg-rose-50 dark:bg-rose-950/30 px-3 py-2 text-[12.5px] text-rose-700 dark:text-rose-300 whitespace-pre-wrap">
          拉取失败 · {account.fetchError}
        </div>
      )}

      <main className="flex-1 overflow-y-auto">
        <div className="max-w-5xl mx-auto px-9 py-8">
          <div className="flex items-start gap-5 mb-8">
            <AccountAvatar account={account} size={64} fontSize={14} />
            <div className="flex-1 min-w-0">
              <h1 className="text-[22px] font-semibold tracking-tight text-slate-900 dark:text-slate-100">{account.name || (account.fetchPhase === "fetching" ? "拉取中…" : "未知账号")}</h1>
              <div className="text-[12.5px] font-mono tracking-wider text-slate-600 dark:text-slate-400 mt-1">
                {PLATFORM_LABEL[account.platform]}
                {account.followers && <span> · {account.followers} 粉丝</span>}
                {accountVideos.length > 0 && <span> · {accountVideos.length} 条视频</span>}
              </div>
              {account.bio && (
                <p className="text-[12.5px] text-slate-600 dark:text-slate-400 mt-2 leading-relaxed line-clamp-2 max-w-xl">
                  {account.bio}
                </p>
              )}
            </div>
          </div>

          <div className="flex border-b border-slate-200 dark:border-slate-800 mb-6">
            {([
              ["methodology", "方法论"],
              ["videos", `视频 ${accountVideos.length}`],
              ["hooks", "开场样本"],
            ] as const).map(([k, l]) => (
              <button
                key={k}
                onClick={() => setTab(k)}
                className={`py-2.5 mr-6 text-[14px] -mb-px ${
                  tab === k
                    ? "text-slate-900 dark:text-slate-100 font-medium border-b-2 border-slate-900 dark:border-slate-100"
                    : "text-slate-500 dark:text-slate-400 border-b-2 border-transparent hover:text-slate-700 dark:hover:text-slate-300"
                }`}
              >
                {l}
              </button>
            ))}
          </div>

          {tab === "methodology" && <MethodologyTab methodology={account.methodology} />}
          {tab === "videos" && (
            <VideosTab
              account={account}
              videos={accountVideos}
              projects={projects}
              onReload={() => triggerFetch(account.fetchRange || "top10")}
              fetching={fetching}
              ctx={ctx}
              setProjects={setProjects}
              setActiveProjectId={setActiveProjectId}
              setLocation={setLocation}
            />
          )}
          {tab === "hooks" && <HooksTab videos={accountVideos} />}
        </div>
      </main>
    </div>
  );
}

const RangeDropdown: FunctionComponent<{
  current: AccountFetchRange;
  disabled?: boolean;
  onPick: (r: AccountFetchRange) => void;
}> = ({ current, disabled, onPick }) => {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        onClick={() => !disabled && setOpen((o) => !o)}
        disabled={disabled}
        className="inline-flex items-center gap-1 h-8 px-2.5 rounded-md text-[12.5px] text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50"
      >
        <span className="font-mono uppercase tracking-wider text-[10.5px] text-slate-500">范围</span>
        <span>{RANGE_LABEL[current]}</span>
        <ChevronDown className="w-3 h-3 text-slate-400" strokeWidth={1.5} />
      </button>
      {open && (
        <div className="absolute right-0 mt-1 w-36 z-30 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-lg overflow-hidden">
          {(["top10", "recent20", "all"] as AccountFetchRange[]).map((k) => (
            <button
              key={k}
              onClick={() => { setOpen(false); if (k !== current) onPick(k); }}
              className={`w-full text-left px-3 py-2 text-[12.5px] ${
                k === current ? "bg-indigo-50 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300" : "text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
              }`}
            >
              {RANGE_LABEL[k]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

function MethodologyTab({ methodology }: { methodology?: AccountMethodology }) {
  if (!methodology || !(methodology.hooks || methodology.pacing || methodology.structure || methodology.visual)) {
    return (
      <div className="border border-dashed border-slate-300 dark:border-slate-700 rounded-xl bg-white/50 dark:bg-slate-900/30 px-8 py-12 text-center">
        <Sparkles className="w-5 h-5 mx-auto text-slate-400 dark:text-slate-500 mb-2" strokeWidth={1.5} />
        <p className="text-[13.5px] text-slate-600 dark:text-slate-400">
          方法论还未生成。
          <br />
          先拉取并分析该账号下的视频,系统会自动跨视频汇总方法论。
        </p>
      </div>
    );
  }
  const items: Array<{ k: string; m?: { summary: string; sampleVideoIds?: string[] } }> = [
    { k: "开场风格 / Hooks", m: methodology.hooks },
    { k: "节奏画像", m: methodology.pacing },
    { k: "结构模板", m: methodology.structure },
    { k: "视觉风格", m: methodology.visual },
  ];
  return (
    <div className="grid gap-3 grid-cols-1 md:grid-cols-2">
      {items.map(({ k, m }) =>
        m ? (
          <div key={k} className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/40 p-4">
            <h3 className="text-[14px] font-semibold tracking-tight text-slate-900 dark:text-slate-100 mb-2">{k}</h3>
            <p className="text-[13px] leading-relaxed text-slate-700 dark:text-slate-300">{m.summary}</p>
            {(m.sampleVideoIds?.length ?? 0) > 0 && (
              <div className="text-[10.5px] font-mono tracking-wider uppercase text-indigo-600 dark:text-indigo-400 mt-3">
                引用 · {m.sampleVideoIds!.length} 条视频
              </div>
            )}
          </div>
        ) : null,
      )}
    </div>
  );
}

function formatVideoDuration(sec: number): string {
  if (!sec || sec <= 0) return "—";
  const s = Math.round(sec);
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    return `${h}:${String(m % 60).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  }
  return `${m}:${String(r).padStart(2, "0")}`;
}

function formatTimestamp(sec: number): string {
  const s = Math.round(sec);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

function formatCount(n: number): string {
  if (n >= 1_0000) return `${(n / 1_0000).toFixed(1).replace(/\.0$/, "")}万`;
  return String(n);
}

function VideosTab({
  account,
  videos,
  projects,
  onReload,
  fetching,
  ctx,
  setProjects,
  setActiveProjectId,
  setLocation,
}: {
  account: Account;
  videos: AccountVideo[];
  projects: Project[];
  onReload: () => void;
  fetching: boolean;
  ctx: ReturnType<typeof useApp>;
  setProjects: ReturnType<typeof useApp>["setProjects"];
  setActiveProjectId: ReturnType<typeof useApp>["setActiveProjectId"];
  setLocation: ReturnType<typeof useApp>["setLocation"];
}) {
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [liveProgress, setLiveProgress] = useState<Record<string, { progress: number; message: string }>>({});
  const [selectedVideoId, setSelectedVideoId] = useState<string | null>(null);
  const selectedVideo = selectedVideoId ? videos.find((v) => v.id === selectedVideoId) : null;

  // ── 队列 ──
  const [queue, setQueue] = useState<{ type: "summary" | "analyze"; ids: string[]; index: number; cancelled: boolean } | null>(null);
  const launchedRef = useRef<Set<string>>(new Set());

  // 订阅实时摘要进度
  useEffect(() => {
    if (!window.videoAnalyzer?.onAccountVideoSummaryStatus) return;
    const off = window.videoAnalyzer.onAccountVideoSummaryStatus((evt) => {
      if (evt.status === "summarizing" && evt.progress != null) {
        setLiveProgress((m) => ({ ...m, [evt.accountVideoId]: { progress: evt.progress!, message: evt.message || "" } }));
      } else if (evt.status === "done" || evt.status === "failed" || evt.status === "idle") {
        setLiveProgress((m) => { const n = { ...m }; delete n[evt.accountVideoId]; return n; });
        launchedRef.current.delete(evt.accountVideoId);
      }
    });
    return () => { off?.(); };
  }, []);

  const fireSummarize = useCallback((avId: string) => {
    if (launchedRef.current.has(avId)) return;
    launchedRef.current.add(avId);
    setRowError((m) => { const n = { ...m }; delete n[avId]; return n; });
    window.videoAnalyzer?.summarizeAccountVideo({ accountVideoId: avId }).catch((e: unknown) => {
      launchedRef.current.delete(avId);
      setRowError((m) => ({ ...m, [avId]: e instanceof Error ? e.message : String(e) }));
    });
  }, []);

  const cancelSummarize = useCallback((avId: string) => {
    window.videoAnalyzer?.cancelSummarizeVideo(avId).catch(() => {});
  }, []);

  const fireAnalyze = useCallback(async (av: AccountVideo) => {
    if (launchedRef.current.has(av.id)) return;
    launchedRef.current.add(av.id);
    setRowError((m) => { const n = { ...m }; delete n[av.id]; return n; });
    try {
      if (!window.videoAnalyzer) throw new Error("浏览器预览环境不支持分析");
      const dl = await window.videoAnalyzer.downloadVideo(av.externalUrl);
      const projectId = dl.projectId || `proj-${Date.now()}-${av.id}`;
      const now = new Date().toISOString();
      const newProject: Project = {
        id: projectId,
        source: { type: "url", url: av.externalUrl, platform: (av.platform === "bilibili" || av.platform === "douyin" || av.platform === "xiaohongshu" || av.platform === "tiktok") ? av.platform : "unknown" },
        localVideoPath: dl.mediaUrl,
        localFilePath: dl.filePath,
        videoName: dl.title || av.title,
        durationSec: dl.durationSec || av.durationSec,
        width: dl.width || 0,
        height: dl.height || 0,
        orientation: dl.orientation || "landscape",
        status: "analyzing" as const,
        kind: "analysis" as const,
        accountId: account.id,
        thumbnailUrl: av.thumbnailUrl,
        titleAutoGenerated: !!dl.title,
        createdAt: now,
        updatedAt: now,
      };
      setProjects((prev) => {
        const filtered = prev.filter((p) => p.id !== projectId);
        return [newProject, ...filtered];
      });
      await window.videoAnalyzer.upsertProject(newProject).catch(() => {});
      const avPatched: AccountVideo = { ...av, analysisProjectId: projectId };
      ctx.upsertAccountVideoLocal(avPatched);
    } catch (e) {
      setRowError((m) => ({ ...m, [av.id]: e instanceof Error ? e.message : String(e) }));
    } finally {
      launchedRef.current.delete(av.id);
    }
  }, [account.id, ctx, setProjects]);

  // ── 队列处理：依赖 videos 状态变化推进 ──
  useEffect(() => {
    if (!queue || queue.cancelled) return;
    if (queue.index >= queue.ids.length) {
      setQueue(null);
      return;
    }
    const currentId = queue.ids[queue.index];
    const av = videos.find((v) => v.id === currentId);
    if (!av) {
      setQueue((q) => q ? { ...q, index: q.index + 1 } : null);
      return;
    }

    if (queue.type === "summary") {
      if (av.summaryStatus === "done" || av.summaryStatus === "failed") {
        setQueue((q) => q && !q.cancelled ? { ...q, index: q.index + 1 } : null);
        return;
      }
      if (av.summaryStatus !== "summarizing" && !launchedRef.current.has(av.id)) {
        fireSummarize(av.id);
      }
    } else {
      if (av.analysisProjectId) {
        setQueue((q) => q && !q.cancelled ? { ...q, index: q.index + 1 } : null);
        return;
      }
      if (!launchedRef.current.has(av.id)) {
        fireAnalyze(av);
      }
    }
  }, [queue?.index, queue?.cancelled, queue?.type, videos, fireSummarize, fireAnalyze]);

  const startBatch = (type: "summary" | "analyze") => {
    if (queue) return;
    let ids: string[];
    if (type === "summary") {
      ids = videos.filter((v) => !v.videoSummary && v.summaryStatus !== "summarizing" && v.summaryStatus !== "done").map((v) => v.id);
    } else {
      ids = videos.filter((v) => v.summaryStatus === "done" && !v.analysisProjectId).map((v) => v.id);
    }
    if (ids.length === 0) return;
    setQueue({ type, ids, index: 0, cancelled: false });
  };

  const cancelQueue = () => {
    if (!queue) return;
    const currentId = queue.ids[queue.index];
    setQueue((q) => q ? { ...q, cancelled: true } : null);
    if (currentId && queue.type === "summary") cancelSummarize(currentId);
    setTimeout(() => setQueue(null), 100);
  };

  const openVideoDetail = (av: AccountVideo) => {
    if (!av.analysisProjectId) return;
    const proj = projects.find((p) => p.id === av.analysisProjectId);
    if (!proj) return;
    setActiveProjectId(proj.id);
    if (proj.status === "completed") setLocation({ module: "analysis", screen: "workspace" });
    else setLocation({ module: "analysis", screen: "progress" });
  };

  if (videos.length === 0) {
    return (
      <div className="border border-dashed border-slate-300 dark:border-slate-700 rounded-xl bg-white/50 dark:bg-slate-900/30 px-8 py-12 text-center">
        <p className="text-[13.5px] text-slate-600 dark:text-slate-400">
          {fetching ? "正在拉取视频列表…" : "还没拉取该账号的视频。"}
        </p>
        <button
          onClick={onReload}
          disabled={fetching}
          className="mt-5 inline-flex items-center gap-1.5 h-9 px-4 rounded-md bg-indigo-600 hover:bg-indigo-700 text-white text-[13px] font-medium disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${fetching ? "animate-spin" : ""}`} strokeWidth={2} />
          {fetching ? "拉取中…" : "立即拉取"}
        </button>
      </div>
    );
  }

  // ── 二级详情页 ──
  if (selectedVideo) {
    const sv = selectedVideo;
    const svLive = liveProgress[sv.id];
    const svSummarizing = sv.summaryStatus === "summarizing" || launchedRef.current.has(sv.id);
    const svHasSummary = sv.summaryStatus === "done" && !!sv.videoSummary;
    const svFailed = sv.summaryStatus === "failed";
    const svProj = sv.analysisProjectId ? projects.find((p) => p.id === sv.analysisProjectId) : undefined;

    return (
      <div className="space-y-4">
        <button
          onClick={() => setSelectedVideoId(null)}
          className="inline-flex items-center gap-1.5 h-8 px-2 rounded-md text-[13px] text-slate-600 dark:text-slate-300 hover:bg-slate-200/60 dark:hover:bg-slate-800/60"
        >
          <ArrowLeft className="w-3.5 h-3.5" strokeWidth={1.5} />
          返回列表
        </button>

        {/* 视频信息 */}
        <div className="flex gap-4 items-start">
          <div className="h-[120px] rounded-lg bg-slate-200 dark:bg-slate-800 shrink-0 overflow-hidden">
            {sv.thumbnailUrl
              ? <img src={sv.thumbnailUrl} alt={sv.title} referrerPolicy="no-referrer" className="h-full w-auto object-cover" />
              : <span className="flex items-center justify-center h-full w-[120px] text-[11px] font-mono text-slate-400">无封面</span>}
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-[16px] font-semibold text-slate-900 dark:text-slate-100">{sv.title}</h3>
            <div className="text-[11px] font-mono tracking-wider text-slate-500 dark:text-slate-400 mt-1.5 flex items-center gap-2 flex-wrap">
              <span>{formatVideoDuration(sv.durationSec)}</span>
              {sv.viewCount ? <span>· {formatViews(sv.viewCount)}</span> : null}
              {sv.likeCount ? <span>· {formatCount(sv.likeCount)}赞</span> : null}
              {sv.commentCount ? <span>· {formatCount(sv.commentCount)}评</span> : null}
              {sv.uploadDate && <span>· {sv.uploadDate}</span>}
            </div>
            <div className="flex items-center gap-2 mt-3">
              {!svHasSummary && !svSummarizing && !svFailed && (
                <button onClick={() => fireSummarize(sv.id)} className="inline-flex items-center gap-1 h-7 px-2.5 rounded-md text-[11.5px] font-medium bg-indigo-600 hover:bg-indigo-700 text-white">
                  <Sparkles className="w-3 h-3" strokeWidth={2} />内容分析
                </button>
              )}
              {svFailed && (
                <button onClick={() => fireSummarize(sv.id)} className="inline-flex items-center gap-1 h-7 px-2.5 rounded-md text-[11.5px] font-medium bg-rose-50 dark:bg-rose-900/30 text-rose-700 dark:text-rose-300">
                  <AlertTriangle className="w-3 h-3" strokeWidth={2} />重试分析
                </button>
              )}
              {svSummarizing && (
                <button onClick={() => cancelSummarize(sv.id)} className="inline-flex items-center gap-1 h-7 px-2.5 rounded-md text-[11.5px] font-medium text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-900/30">
                  <X className="w-3 h-3" strokeWidth={2} />取消
                </button>
              )}
              {svHasSummary && !sv.analysisProjectId && (
                <button onClick={() => fireAnalyze(sv)} className="inline-flex items-center gap-1 h-7 px-2.5 rounded-md text-[11.5px] font-medium border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800">
                  <Play className="w-3 h-3" strokeWidth={2} />拆解分析
                </button>
              )}
              {svProj && (
                <button onClick={() => openVideoDetail(sv)} className="inline-flex items-center gap-1 h-7 px-2.5 rounded-md text-[11.5px] font-medium text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/30">
                  <ChevronRight className="w-3 h-3" strokeWidth={2} />查看拆解结果
                </button>
              )}
            </div>
          </div>
        </div>

        {/* 分析进度 */}
        {svSummarizing && (
          <div className="rounded-lg border border-indigo-200 dark:border-indigo-800/50 bg-indigo-50/60 dark:bg-indigo-950/30 p-4">
            <div className="flex items-center gap-2 text-[13px] font-medium text-indigo-800 dark:text-indigo-200">
              <Loader2 className="w-4 h-4 animate-spin" strokeWidth={2} />
              <span>{svLive?.message || "分析中"}</span>
              <span className="ml-auto font-mono">{svLive?.progress ?? 0}%</span>
            </div>
            <div className="mt-2 h-2 rounded-full bg-indigo-100 dark:bg-indigo-900/40 overflow-hidden">
              <div className="h-full bg-indigo-600 dark:bg-indigo-500 rounded-full transition-all" style={{ width: `${svLive?.progress ?? 0}%` }} />
            </div>
          </div>
        )}

        {/* 分析失败 */}
        {svFailed && sv.summaryError && (
          <div className="rounded-lg border border-rose-200 dark:border-rose-900/50 bg-rose-50 dark:bg-rose-950/30 p-3 text-[12.5px] text-rose-700 dark:text-rose-300">
            {sv.summaryError}
          </div>
        )}

        {/* 分析结果 */}
        {svHasSummary && (
          <SummaryDetail summary={sv.videoSummary!} analysisProjectId={sv.analysisProjectId} onOpenAnalysis={() => openVideoDetail(sv)} />
        )}

        {/* 行错误 */}
        {rowError[sv.id] && (
          <div className="rounded-lg border border-rose-200 dark:border-rose-900/50 bg-rose-50 dark:bg-rose-950/30 p-3 text-[12.5px] text-rose-700 dark:text-rose-300">
            {rowError[sv.id]}
          </div>
        )}
      </div>
    );
  }

  const unsummarizedCount = videos.filter((v) => !v.videoSummary && v.summaryStatus !== "summarizing" && v.summaryStatus !== "done").length;
  const summarizedNotAnalyzedCount = videos.filter((v) => v.summaryStatus === "done" && !v.analysisProjectId).length;

  return (
    <div className="space-y-3">
      {/* ── 队列进度条 ── */}
      {queue && !queue.cancelled && (
        <div className="flex items-center gap-3 rounded-lg border border-indigo-200 dark:border-indigo-800/50 bg-indigo-50/60 dark:bg-indigo-950/30 px-4 py-2.5">
          <Loader2 className="w-3.5 h-3.5 animate-spin text-indigo-600 dark:text-indigo-400 shrink-0" strokeWidth={2} />
          <div className="flex-1 min-w-0">
            <div className="text-[12.5px] font-medium text-indigo-800 dark:text-indigo-200">
              {queue.type === "summary" ? "批量摘要" : "批量拆解"} · {Math.min(queue.index + 1, queue.ids.length)}/{queue.ids.length}
            </div>
            <div className="mt-1.5 h-1 rounded-full bg-indigo-100 dark:bg-indigo-900/40 overflow-hidden">
              <div className="h-full bg-indigo-600 dark:bg-indigo-500 rounded-full transition-all" style={{ width: `${((queue.index) / queue.ids.length) * 100}%` }} />
            </div>
          </div>
          <button
            onClick={cancelQueue}
            className="shrink-0 inline-flex items-center gap-1 h-7 px-2.5 rounded-md text-[11.5px] font-medium text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-900/30"
          >
            <X className="w-3 h-3" strokeWidth={2} />
            取消
          </button>
        </div>
      )}

      {/* ── 工具栏 ── */}
      <div className="flex items-center gap-3 flex-wrap">
        <span className="text-[11px] font-mono uppercase tracking-wider text-slate-500">
          共 {videos.length} 条 · 待摘要 {unsummarizedCount}{summarizedNotAnalyzedCount > 0 ? ` · 可拆解 ${summarizedNotAnalyzedCount}` : ""}
        </span>
        <div className="flex-1" />
        {summarizedNotAnalyzedCount > 0 && (
          <button
            onClick={() => startBatch("analyze")}
            disabled={!!queue}
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-[12.5px] border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50"
          >
            <Play className="w-3 h-3" strokeWidth={2} />
            全部拆解 ({summarizedNotAnalyzedCount})
          </button>
        )}
        {unsummarizedCount > 0 && (
          <button
            onClick={() => startBatch("summary")}
            disabled={!!queue}
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-[12.5px] bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 hover:bg-slate-800 dark:hover:bg-slate-200 disabled:opacity-50"
          >
            <Sparkles className="w-3 h-3" strokeWidth={2} />
            全部摘要 ({unsummarizedCount})
          </button>
        )}
      </div>

      {/* ── 视频列表 ── */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/40 overflow-hidden divide-y divide-slate-100 dark:divide-slate-800/80">
        {videos.map((v) => {
          const proj = v.analysisProjectId ? projects.find((p) => p.id === v.analysisProjectId) : undefined;
          const rawStatus = proj?.status || "not_analyzed";
          const analysisStatus: "completed" | "analyzing" | "downloading" | "failed" | "not_analyzed" =
            rawStatus === "download_failed" ? "failed" : rawStatus;
          const err = rowError[v.id];
          const hasSummary = v.summaryStatus === "done" && !!v.videoSummary;
          const isSummarizing = v.summaryStatus === "summarizing" || launchedRef.current.has(v.id);
          const summaryFailed = v.summaryStatus === "failed";
          const live = liveProgress[v.id];
          const inQueue = queue && !queue.cancelled && queue.ids.includes(v.id) && queue.ids.indexOf(v.id) > queue.index;
          const clickable = isSummarizing || hasSummary || summaryFailed || !!v.analysisProjectId;

          return (
            <div
              key={v.id}
              onClick={() => clickable && setSelectedVideoId(v.id)}
              className={`w-full flex items-center gap-3.5 px-4 py-3 text-left ${clickable ? "cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/40" : ""}`}
            >
              <div className="h-[54px] rounded bg-slate-200 dark:bg-slate-800 shrink-0 overflow-hidden flex items-center justify-center">
                {v.thumbnailUrl
                  ? <img src={v.thumbnailUrl} alt={v.title} referrerPolicy="no-referrer" className="h-full w-auto object-cover" />
                  : <span className="text-[10.5px] font-mono text-slate-400 px-4">无封面</span>}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[14px] font-medium text-slate-900 dark:text-slate-100 truncate">{v.title}</div>
                <div className="text-[10.5px] font-mono tracking-wider text-slate-500 dark:text-slate-400 mt-1 flex items-center gap-2 flex-wrap">
                  <span>{formatVideoDuration(v.durationSec)}</span>
                  {v.viewCount ? <span>· {formatViews(v.viewCount)}</span> : null}
                  {v.likeCount ? <span>· {formatCount(v.likeCount)}赞</span> : null}
                  {v.commentCount ? <span>· {formatCount(v.commentCount)}评</span> : null}
                  {isSummarizing && (
                    <span className="px-1.5 py-0.5 rounded bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300">
                      {live ? `分析中 ${live.progress}%` : "分析中"}
                    </span>
                  )}
                  {summaryFailed && <span className="px-1.5 py-0.5 rounded bg-rose-50 dark:bg-rose-900/30 text-rose-700 dark:text-rose-300">失败</span>}
                  {hasSummary && <span className="px-1.5 py-0.5 rounded bg-sky-50 dark:bg-sky-900/30 text-sky-700 dark:text-sky-300">已分析</span>}
                  {hasSummary && typeof v.videoSummary === "object" && v.videoSummary.topic && (
                    <span className="text-slate-600 dark:text-slate-300 normal-case tracking-normal">{v.videoSummary.topic}</span>
                  )}
                  {inQueue && <span className="px-1.5 py-0.5 rounded bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300">排队中</span>}
                </div>
                {err && <div className="text-[11px] text-rose-600 dark:text-rose-400 mt-1">{err}</div>}
              </div>
              <div className="flex items-center gap-2 shrink-0" onClick={(e) => e.stopPropagation()}>
                {!hasSummary && !isSummarizing && !summaryFailed && !inQueue && (
                  <span role="button" onClick={() => fireSummarize(v.id)} className="inline-flex items-center gap-1 h-7 px-2.5 rounded-md text-[11.5px] font-medium bg-indigo-600 hover:bg-indigo-700 text-white">
                    <Sparkles className="w-3 h-3" strokeWidth={2} />内容分析
                  </span>
                )}
              </div>
              {clickable && <ChevronRight className="w-3.5 h-3.5 text-slate-400 dark:text-slate-500 shrink-0" strokeWidth={1.5} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SummaryDetail({ summary, analysisProjectId, onOpenAnalysis }: {
  summary: VideoContentAnalysis | string;
  analysisProjectId?: string;
  onOpenAnalysis: () => void;
}) {
  // 兼容旧版纯字符串摘要
  if (typeof summary === "string") {
    return (
      <div className="px-4 pb-3 -mt-1">
        <p className="text-[12.5px] leading-relaxed text-slate-600 dark:text-slate-400">{summary}</p>
        {analysisProjectId && (
          <button onClick={(e) => { e.stopPropagation(); onOpenAnalysis(); }} className="mt-2 inline-flex items-center gap-1 h-7 px-2.5 rounded-md text-[11.5px] font-medium text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/30">
            <ChevronRight className="w-3 h-3" strokeWidth={2} />查看拆解结果
          </button>
        )}
      </div>
    );
  }

  const hasFrames = summary.frames && summary.frames.length > 0;
  const hasTranscript = summary.transcript?.text;

  return (
    <div className="space-y-4">
      {/* 选题 + 受众 */}
      {(summary.topic || summary.target) && (
        <div className="flex gap-3 flex-wrap">
          {summary.topic && (
            <div className="rounded-md border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50 px-3 py-2 flex-1 min-w-[180px]">
              <div className="text-[11px] font-semibold text-slate-900 dark:text-slate-100 mb-0.5">选题</div>
              <div className="text-[12.5px] leading-relaxed text-slate-700 dark:text-slate-300">{summary.topic}</div>
            </div>
          )}
          {summary.target && (
            <div className="rounded-md border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50 px-3 py-2 flex-1 min-w-[180px]">
              <div className="text-[11px] font-semibold text-slate-900 dark:text-slate-100 mb-0.5">受众</div>
              <div className="text-[12.5px] leading-relaxed text-slate-700 dark:text-slate-300">{summary.target}</div>
            </div>
          )}
        </div>
      )}

      {/* 内容描述 */}
      <div>
        <div className="text-[11px] font-semibold text-slate-900 dark:text-slate-100 mb-1">内容描述</div>
        <p className="text-[12.5px] leading-relaxed text-slate-600 dark:text-slate-400">{summary.summary}</p>
      </div>

      {/* 标签 */}
      {summary.tags?.length > 0 && (
        <div className="flex gap-1.5 flex-wrap">
          {summary.tags.map((t) => (
            <span key={t} className="text-[10.5px] font-mono px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400">{t}</span>
          ))}
        </div>
      )}

      {/* 关键帧 */}
      {hasFrames && (
        <div>
          <div className="text-[11px] font-semibold text-slate-900 dark:text-slate-100 mb-1.5">关键帧 · {summary.frames!.length}</div>
          <div className="flex gap-1.5 overflow-x-auto pb-1">
            {summary.frames!.map((f, i) => (
              <div key={i} className="shrink-0">
                <img src={f.url} alt={`${f.timeSec.toFixed(1)}s`} className="max-h-[100px] w-auto rounded bg-slate-200 dark:bg-slate-800" />
                <div className="text-[10px] font-mono text-slate-500 dark:text-slate-400 text-center mt-0.5">{formatTimestamp(f.timeSec)}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 字幕 */}
      {hasTranscript && (
        <div>
          <div className="text-[11px] font-semibold text-slate-900 dark:text-slate-100 mb-1">字幕</div>
          <div className="rounded-md border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/40 px-3 py-2 max-h-[280px] overflow-y-auto">
            {summary.transcript!.segments?.length > 0 ? (
              <div className="space-y-0.5">
                {summary.transcript!.segments.map((seg, i) => (
                  <div key={i} className="flex gap-2 text-[12px] leading-relaxed">
                    <span className="font-mono text-slate-400 dark:text-slate-500 shrink-0 w-[36px]">{formatTimestamp(seg.startSec)}</span>
                    <span className="text-slate-700 dark:text-slate-300">{seg.text}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-[12px] leading-relaxed text-slate-600 dark:text-slate-400">{summary.transcript!.text}</p>
            )}
          </div>
        </div>
      )}

      {analysisProjectId && (
        <button onClick={(e) => { e.stopPropagation(); onOpenAnalysis(); }} className="inline-flex items-center gap-1 h-7 px-2.5 rounded-md text-[11.5px] font-medium text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/30">
          <ChevronRight className="w-3 h-3" strokeWidth={2} />查看拆解结果
        </button>
      )}
    </div>
  );
}

function statusChipClass(status: "completed" | "analyzing" | "downloading" | "failed" | "not_analyzed"): string {
  if (status === "completed") return "bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300";
  if (status === "analyzing") return "bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300";
  if (status === "downloading") return "bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300";
  if (status === "failed") return "bg-rose-50 dark:bg-rose-900/30 text-rose-700 dark:text-rose-300";
  return "bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400";
}

function statusLabel(status: "completed" | "analyzing" | "downloading" | "failed" | "not_analyzed"): string {
  if (status === "completed") return "已分析";
  if (status === "analyzing") return "分析中";
  if (status === "downloading") return "下载中";
  if (status === "failed") return "失败";
  return "未分析";
}

function formatViews(n: number): string {
  if (n >= 1_0000) return `${(n / 1_0000).toFixed(1).replace(/\.0$/, "")}万播放`;
  return `${n} 播放`;
}

function HooksTab({ videos }: { videos: AccountVideo[] }) {
  if (videos.length === 0) {
    return (
      <div className="border border-dashed border-slate-300 dark:border-slate-700 rounded-xl bg-white/50 dark:bg-slate-900/30 px-8 py-12 text-center">
        <p className="text-[13.5px] text-slate-600 dark:text-slate-400">
          开场样本会在视频分析完成后自动抽取。
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-2.5">
      {videos.slice(0, 5).map((v) => (
        <div key={v.id} className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/40 p-4 flex gap-3.5">
          <div className="h-[68px] rounded bg-slate-200 dark:bg-slate-800 shrink-0 overflow-hidden">
            {v.thumbnailUrl && <img src={v.thumbnailUrl} alt={v.title} referrerPolicy="no-referrer" className="h-full w-auto object-cover" />}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[14px] font-medium text-slate-900 dark:text-slate-100 truncate">{v.title}</div>
            <div className="text-[10.5px] font-mono tracking-wider text-slate-500 dark:text-slate-400 mt-1">开场 00:00–00:08</div>
            <p className="text-[13.5px] text-slate-700 dark:text-slate-300 mt-2">
              <span className="text-slate-500">「</span>开场样本将在视频分析完成后自动抽取并展示<span className="text-slate-500">」</span>
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}
