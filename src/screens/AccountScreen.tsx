// 账号分析模块 — v2 Phase 2
// list: UP 主卡片网格 (头像 / 平台 / 粉丝 / 已分析 / 方法论摘要 / 标签)
// detail: hero + 3 tabs (方法论 / 视频 / 开场样本)
// add-account: 添加账号 dialog (粘贴链接 → 自动识别平台)

import { type FunctionComponent, type ReactNode, useEffect, useMemo, useState } from "react";
import { useApp } from "../AppContext";
import type { AppLocation, Account, AccountPlatform, AccountMethodology } from "../types";
import {
  UserSquare2,
  ArrowLeft,
  Plus,
  RefreshCw,
  Sparkles,
  ChevronRight,
  X,
} from "lucide-react";

export function AccountScreen() {
  const { currentLocation, setLocation } = useApp();
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

// Avatar fallback: 头像 hint 没值时取名字前 2-3 字
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

// 真头像优先 + onError fallback 到字母占位 (B 站头像 referer 防盗链, img 标签会自动带 page referer,
// renderer 跑在 file:// / vite dev 起来后跨域请求图片需要 crossOrigin=anonymous 才不带 Origin)
const AccountAvatar: FunctionComponent<{
  account: Account;
  size: number; // px
  fontSize: number; // px
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
  const { accounts, setLocation, setActiveAccountId } = useAccountNav();
  const [addOpen, setAddOpen] = useState(false);

  const detailLoc = (id: string): AppLocation => ({ module: "account", screen: "detail" });
  const totalVideos = useMemo(
    () => accounts.reduce((sum, a) => sum + (a.videoIds?.length ?? 0), 0),
    [accounts],
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
                  onClick={() => {
                    setActiveAccountId(a.id);
                    setLocation(detailLoc(a.id));
                  }}
                />
              ))}
            </div>
          )}
        </div>
      </main>

      {addOpen && <AddAccountDialog onClose={() => setAddOpen(false)} />}
    </div>
  );
}

// 子组件 — AppContext + 本地 setActiveAccountId 通过 sessionStorage 跨屏共享
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

const AccountCard: FunctionComponent<{ account: Account; onClick: () => void }> = ({ account, onClick }) => {
  const analyzed = account.videoIds?.length ?? 0;
  const total = account.totalVideoCount ?? analyzed;
  const ratioComplete = total > 0 && analyzed === total;
  const methodologySummary = (() => {
    const m = account.methodology;
    if (!m) return null;
    return [m.hooks?.summary, m.pacing?.summary, m.structure?.summary, m.visual?.summary].filter(Boolean).join(" ");
  })();

  return (
    <button
      onClick={onClick}
      className="text-left p-4 rounded-xl bg-white dark:bg-slate-900/40 border border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700 transition-colors"
    >
      <div className="flex items-start gap-3">
        <AccountAvatar account={account} size={44} fontSize={12} />
        <div className="flex-1 min-w-0">
          <div className="text-[14.5px] font-semibold tracking-tight text-slate-900 dark:text-slate-100 truncate">{account.name}</div>
          <div className="text-[10.5px] font-mono tracking-wider uppercase text-slate-500 dark:text-slate-400 mt-1">
            {PLATFORM_LABEL[account.platform]}
            {account.followers && <span> · {account.followers} 粉丝</span>}
          </div>
        </div>
        <span
          className={`text-[10.5px] font-mono px-1.5 py-0.5 rounded ${
            ratioComplete
              ? "bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300"
              : "bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300"
          }`}
        >
          {analyzed}/{total || "?"}
        </span>
      </div>

      {(account.tags?.length ?? 0) > 0 && (
        <div className="flex gap-1 mt-3">
          {account.tags!.map((t) => (
            <span key={t} className="text-[10.5px] font-mono px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400">
              {t}
            </span>
          ))}
        </div>
      )}

      <div className="mt-3.5 px-3 py-2.5 bg-slate-50 dark:bg-slate-800/40 rounded-md">
        <div className="text-[10.5px] font-mono tracking-wider uppercase text-slate-500 dark:text-slate-400">方法论摘要</div>
        <p className="text-[12.5px] text-slate-700 dark:text-slate-300 leading-relaxed mt-1 line-clamp-2">
          {methodologySummary || "还未生成 — 拉取视频并分析后会自动汇总"}
        </p>
      </div>

      <div className="mt-3 flex items-center gap-2 text-[10.5px] font-mono tracking-wider uppercase text-slate-500 dark:text-slate-400">
        {account.updatedAt ? `更新于 ${formatRelative(account.updatedAt)}` : "刚创建"}
        <div className="flex-1" />
        <RefreshCw className="w-3 h-3 text-slate-400 dark:text-slate-500" strokeWidth={1.5} />
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
// 添加账号 dialog

function detectPlatform(url: string): AccountPlatform {
  const u = url.toLowerCase();
  if (u.includes("bilibili.com") || u.includes("b23.tv")) return "bilibili";
  if (u.includes("douyin.com")) return "douyin";
  if (u.includes("xiaohongshu.com") || u.includes("xhslink.com")) return "xiaohongshu";
  if (u.includes("youtube.com") || u.includes("youtu.be")) return "youtube";
  if (u.includes("tiktok.com")) return "tiktok";
  return "unknown";
}

function AddAccountDialog({ onClose }: { onClose: () => void }) {
  const { upsertAccount, setProjects, setLocation } = useApp();
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [range, setRange] = useState<"top10" | "recent20" | "all">("top10");
  const [fetching, setFetching] = useState(false);
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
  // 抖音 / B 站没桥时给提示 (B 站 wbi 偶发 412, 抖音几乎必失败)
  const showBridgeHint =
    (platform === "douyin" || platform === "bilibili") && bridgeConnected === false;
  // 账号名可以不填,fetch 后用平台拉到的 uploader/title 自动补
  const canSubmit = url.trim().length > 0 && !fetching;

  const limitOf = (r: typeof range) => (r === "top10" ? 10 : r === "recent20" ? 20 : 50);

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setError("");
    const now = new Date().toISOString();
    const accId = `acc-${Date.now()}`;
    let videoIds: string[] = [];
    let totalVideoCount = 0;
    let resolvedName = name.trim();
    let resolvedAvatarUrl: string | undefined;
    let resolvedFollowers: string | undefined;
    let resolvedBio: string | undefined;
    let resolvedExternalId: string | undefined;
    let resolvedPlatform = platform;

    if (!window.videoAnalyzer?.fetchAccountVideos) {
      setError("浏览器预览模式不支持账号拉取,请在 Electron 应用内操作");
      return;
    }

    setFetching(true);
    try {
      const result = await window.videoAnalyzer.fetchAccountVideos({ url: url.trim(), limit: limitOf(range) });
      totalVideoCount = result.totalVideoCount ?? result.videos.length;
      resolvedAvatarUrl = result.accountAvatarUrl ?? undefined;
      resolvedFollowers = result.accountFollowers ?? undefined;
      resolvedBio = result.accountBio ?? undefined;
      resolvedExternalId = result.accountExternalId ?? undefined;
      if (result.accountPlatform) resolvedPlatform = result.accountPlatform;
      if (!resolvedName) {
        resolvedName = result.accountUploader || result.accountTitle || "(未命名账号)";
      }

      // 把每条视频创建成 kind=account_video 的 Project (status=not_analyzed)
      const newProjects = result.videos.map((v) => {
        const projectId = `acvid-${accId}-${v.id}`;
        videoIds.push(projectId);
        return {
          id: projectId,
          source: {
            type: "url" as const,
            url: v.externalUrl,
            platform:
              resolvedPlatform === "bilibili" || resolvedPlatform === "douyin" ||
              resolvedPlatform === "xiaohongshu" || resolvedPlatform === "tiktok"
                ? resolvedPlatform
                : ("unknown" as const),
          },
          localVideoPath: "",
          videoName: v.title,
          durationSec: v.durationSec,
          width: 0,
          height: 0,
          orientation: "landscape" as const,
          status: "not_analyzed" as const,
          kind: "account_video" as const,
          accountId: accId,
          titleAutoGenerated: true,
          createdAt: now,
          updatedAt: now,
        };
      });
      setProjects((prev) => [...newProjects, ...prev]);
      for (const p of newProjects) {
        window.videoAnalyzer?.upsertProject(p).catch(() => { /* noop */ });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setFetching(false);
      return;
    }
    setFetching(false);

    const acc: Account = {
      id: accId,
      name: resolvedName || "(未命名账号)",
      platform: resolvedPlatform,
      externalUrl: url.trim(),
      externalId: resolvedExternalId,
      avatarUrl: resolvedAvatarUrl,
      avatarHint: (resolvedName || "?").slice(0, 2),
      bio: resolvedBio,
      followers: resolvedFollowers,
      tags: [],
      videoIds,
      totalVideoCount,
      createdAt: now,
      updatedAt: now,
    };
    upsertAccount(acc);
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
              {([
                ["top10", "热门 Top 10"],
                ["recent20", "最近 20 条"],
                ["all", "全部"],
              ] as const).map(([k, l]) => (
                <button
                  key={k}
                  onClick={() => setRange(k)}
                  className={`flex-1 h-8 px-2 rounded-md text-[12px] border ${
                    range === k
                      ? "bg-indigo-50 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300 border-indigo-200 dark:border-indigo-800/50"
                      : "bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800"
                  }`}
                >
                  {l}
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
              onClick={() => setLocation({ module: "settings" })}
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
            {fetching ? "拉取头像 / 视频列表..." : "确认后拉取头像、粉丝、视频列表"}
          </span>
          <button onClick={onClose} disabled={fetching} className="h-8 px-3 rounded-md text-[12.5px] text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50">
            取消
          </button>
          <button
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="h-8 px-3 rounded-md text-[12.5px] font-medium bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-200 dark:disabled:bg-slate-800 disabled:text-slate-400 text-white"
          >
            {fetching ? "拉取中…" : "添加"}
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
// 账号详情屏 — hero + 3 tabs

function AccountDetailScreen({ tab: initialTab = "methodology" }: { tab?: "methodology" | "videos" | "hooks" }) {
  const { accounts, setLocation, projects, setProjects, reportByProject, upsertAccount } = useApp();
  const id = activeAccountId();
  const account = accounts.find((a) => a.id === id);
  const [tab, setTab] = useState<"methodology" | "videos" | "hooks">(initialTab);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState("");
  const [reloading, setReloading] = useState(false);
  const [reloadError, setReloadError] = useState("");
  const [reloadWarnings, setReloadWarnings] = useState<string[]>([]);

  const accountVideos = useMemo(
    () => projects.filter((p) => p.kind === "account_video" && p.accountId === id),
    [projects, id],
  );

  const completedVideos = useMemo(
    () => accountVideos.filter((v) => v.status === "completed" && reportByProject[v.id]),
    [accountVideos, reportByProject],
  );

  const reloadVideos = async () => {
    if (!account || !account.externalUrl) {
      setReloadError("账号缺少主页 URL,无法重新拉取");
      return;
    }
    if (!window.videoAnalyzer?.fetchAccountVideos) {
      setReloadError("浏览器预览环境不支持账号拉取");
      return;
    }
    setReloading(true);
    setReloadError("");
    setReloadWarnings([]);
    try {
      const result = await window.videoAnalyzer.fetchAccountVideos({ url: account.externalUrl, limit: 20 });
      const now = new Date().toISOString();
      const existingUrls = new Set(
        accountVideos
          .map((p) => (p.source && p.source.type === "url" ? p.source.url : ""))
          .filter(Boolean),
      );
      const newProjects = result.videos
        .filter((v) => !existingUrls.has(v.externalUrl))
        .map((v) => ({
          id: `acvid-${account.id}-${v.id}`,
          source: {
            type: "url" as const,
            url: v.externalUrl,
            platform:
              account.platform === "bilibili" || account.platform === "douyin" ||
              account.platform === "xiaohongshu" || account.platform === "tiktok"
                ? account.platform
                : ("unknown" as const),
          },
          localVideoPath: "",
          videoName: v.title,
          durationSec: v.durationSec,
          width: 0,
          height: 0,
          orientation: "landscape" as const,
          status: "not_analyzed" as const,
          kind: "account_video" as const,
          accountId: account.id,
          titleAutoGenerated: true,
          createdAt: now,
          updatedAt: now,
        }));
      if (newProjects.length > 0) {
        setProjects((prev) => [...newProjects, ...prev]);
        for (const p of newProjects) {
          window.videoAnalyzer?.upsertProject(p).catch(() => { /* noop */ });
        }
      }
      const mergedIds = Array.from(new Set([...(account.videoIds ?? []), ...newProjects.map((p) => p.id)]));
      upsertAccount({
        ...account,
        avatarUrl: result.accountAvatarUrl ?? account.avatarUrl,
        followers: result.accountFollowers ?? account.followers,
        bio: result.accountBio ?? account.bio,
        totalVideoCount: result.totalVideoCount ?? account.totalVideoCount,
        videoIds: mergedIds,
        updatedAt: now,
      });
      const warnings = (result as { warnings?: string[] }).warnings;
      if (warnings && warnings.length > 0) setReloadWarnings(warnings);
    } catch (e) {
      setReloadError(e instanceof Error ? e.message : String(e));
    }
    setReloading(false);
  };

  const generateMethodology = async () => {
    if (!account) return;
    if (completedVideos.length === 0) {
      setGenError("至少需要 1 条已完成分析的视频。先在视频 tab 里跑分析,再来汇总。");
      return;
    }
    setGenError("");
    setGenerating(true);
    try {
      const videoSummaries = completedVideos.map((v) => {
        const r = reportByProject[v.id];
        return {
          title: v.videoName,
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
        <h2 className="text-[14px] font-semibold text-slate-900 dark:text-slate-100">{account.name}</h2>
        <span className="text-[10.5px] font-mono px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400">
          {PLATFORM_LABEL[account.platform]}
        </span>
        <div className="flex-1" />
        <button
          onClick={reloadVideos}
          disabled={reloading}
          title="重新拉取头像 / 粉丝 / 视频列表"
          className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-[12.5px] text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50"
        >
          <RefreshCw className={`w-3 h-3 ${reloading ? "animate-spin" : ""}`} strokeWidth={1.5} />
          {reloading ? "拉取中…" : "刷新拉取"}
        </button>
        <button
          onClick={generateMethodology}
          disabled={generating}
          title={completedVideos.length === 0 ? "需要先分析至少 1 条视频" : "调 LLM 跨视频汇总方法论"}
          className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-[12.5px] bg-indigo-50 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300 border border-indigo-200/70 dark:border-indigo-800/50 hover:bg-indigo-100 dark:hover:bg-indigo-900/40 disabled:opacity-50"
        >
          <Sparkles className="w-3 h-3" strokeWidth={1.5} />
          {generating ? "汇总中…" : `汇总方法论 (${completedVideos.length})`}
        </button>
      </header>
      {genError && (
        <div className="mx-6 mt-2 rounded-md border border-rose-200 dark:border-rose-900/50 bg-rose-50 dark:bg-rose-950/30 px-3 py-2 text-[12.5px] text-rose-700 dark:text-rose-300">
          {genError}
        </div>
      )}
      {reloadError && (
        <div className="mx-6 mt-2 rounded-md border border-rose-200 dark:border-rose-900/50 bg-rose-50 dark:bg-rose-950/30 px-3 py-2 text-[12.5px] text-rose-700 dark:text-rose-300 whitespace-pre-wrap">
          {reloadError}
        </div>
      )}
      {reloadWarnings.length > 0 && (
        <div className="mx-6 mt-2 rounded-md border border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-[12.5px] text-amber-800 dark:text-amber-300 space-y-1">
          {reloadWarnings.map((w, i) => <div key={i}>· {w}</div>)}
        </div>
      )}

      <main className="flex-1 overflow-y-auto">
        <div className="max-w-5xl mx-auto px-9 py-8">
          {/* hero */}
          <div className="flex items-start gap-5 mb-8">
            <AccountAvatar account={account} size={64} fontSize={14} />
            <div className="flex-1 min-w-0">
              <h1 className="text-[22px] font-semibold tracking-tight text-slate-900 dark:text-slate-100">{account.name}</h1>
              <div className="text-[12.5px] font-mono tracking-wider text-slate-600 dark:text-slate-400 mt-1">
                {PLATFORM_LABEL[account.platform]}
                {account.followers && <span> · {account.followers} 粉丝</span>}
                {accountVideos.length > 0 && <span> · 已分析 {accountVideos.length} 条</span>}
              </div>
              {account.bio && (
                <p className="text-[12.5px] text-slate-600 dark:text-slate-400 mt-2 leading-relaxed line-clamp-2 max-w-xl">
                  {account.bio}
                </p>
              )}
            </div>
          </div>

          {/* tabs */}
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
          {tab === "videos" && <VideosTab videos={accountVideos} onReload={reloadVideos} reloading={reloading} />}
          {tab === "hooks" && <HooksTab account={account} videos={accountVideos} />}
        </div>
      </main>
    </div>
  );
}

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

function VideosTab({
  videos,
  onReload,
  reloading,
}: {
  videos: ReturnType<typeof useApp>["projects"];
  onReload: () => void | Promise<void>;
  reloading: boolean;
}) {
  if (videos.length === 0) {
    return (
      <div className="border border-dashed border-slate-300 dark:border-slate-700 rounded-xl bg-white/50 dark:bg-slate-900/30 px-8 py-12 text-center">
        <p className="text-[13.5px] text-slate-600 dark:text-slate-400">还没拉取该账号的视频。</p>
        <button
          onClick={onReload}
          disabled={reloading}
          className="mt-5 inline-flex items-center gap-1.5 h-9 px-4 rounded-md bg-indigo-600 hover:bg-indigo-700 text-white text-[13px] font-medium disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${reloading ? "animate-spin" : ""}`} strokeWidth={2} />
          {reloading ? "拉取中…" : "立即拉取视频列表"}
        </button>
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/40 overflow-hidden divide-y divide-slate-100 dark:divide-slate-800/80">
      {videos.map((v) => {
        return (
          <div
            key={v.id}
            className="w-full flex items-center gap-3.5 px-4 py-3 hover:bg-slate-50 dark:hover:bg-slate-800/40"
          >
            <div className="w-[94px] h-[54px] rounded bg-slate-200 dark:bg-slate-800 shrink-0 overflow-hidden flex items-center justify-center">
              {v.thumbnailUrl
                ? <img src={v.thumbnailUrl} alt={v.videoName} referrerPolicy="no-referrer" className="w-full h-full object-cover" />
                : <span className="text-[10.5px] font-mono text-slate-400">无封面</span>}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[14px] font-medium text-slate-900 dark:text-slate-100 truncate">{v.videoName}</div>
              <div className="text-[10.5px] font-mono tracking-wider text-slate-500 dark:text-slate-400 mt-1 flex items-center gap-2">
                <span>{formatVideoDuration(v.durationSec)}</span>
                <span
                  className={`px-1.5 py-0.5 rounded ${
                    v.status === "completed"
                      ? "bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300"
                      : v.status === "analyzing"
                      ? "bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300"
                      : "bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400"
                  }`}
                >
                  {v.status === "completed" ? "已分析" : v.status === "analyzing" ? "分析中" : "未分析"}
                </span>
              </div>
            </div>
            <ChevronRight className="w-3.5 h-3.5 text-slate-400 dark:text-slate-500" strokeWidth={1.5} />
          </div>
        );
      })}
    </div>
  );
}

function HooksTab({ account, videos }: { account: Account; videos: ReturnType<typeof useApp>["projects"] }) {
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
          <div className="w-[120px] h-[68px] rounded bg-slate-200 dark:bg-slate-800 shrink-0 overflow-hidden">
            {v.thumbnailUrl && <img src={v.thumbnailUrl} alt={v.videoName} className="w-full h-full object-cover" />}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[14px] font-medium text-slate-900 dark:text-slate-100 truncate">{v.videoName}</div>
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
