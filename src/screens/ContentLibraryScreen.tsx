// 内容库 — 一级页。三 Tab:账号 / 收藏夹 / 其他视频。
// 账号视图复用 AccountScreen 的 AccountGrid / AccountDetailScreen;
// 收藏夹二级页是 CollectionDetailScreen;视频管理(所有视频)降为二级页(module video)。
import { useMemo, useState } from "react";
import { useApp } from "../AppContext";
import { useCollections, useUpsertCollection } from "../queries/collections";
import { useVideos } from "../queries/videos";
import { AccountGrid, AccountDetailScreen } from "./AccountScreen";
import { CollectionDetailScreen } from "./CollectionDetailScreen";
import { VideoRow, VideoRowList } from "../components/VideoRow";
import type { Collection } from "../types";
import { FolderPlus, FolderOpen, Film, ChevronRight, Library, ListVideo, X } from "lucide-react";

// 当前选中的收藏夹(镜像 AccountScreen 的 sessionStorage 模式)。
const ACTIVE_COLLECTION_KEY = "clipiq-active-collection-id";
export function activeCollectionId(): string | null {
  try { return window.sessionStorage.getItem(ACTIVE_COLLECTION_KEY); } catch { return null; }
}
export function setActiveCollectionId(id: string | null) {
  try {
    if (id) window.sessionStorage.setItem(ACTIVE_COLLECTION_KEY, id);
    else window.sessionStorage.removeItem(ACTIVE_COLLECTION_KEY);
  } catch { /* noop */ }
}

const TAB_KEY = "clipiq-content-library-tab";
type HubTab = "accounts" | "collections" | "others";

export function ContentLibraryScreen() {
  const { currentLocation } = useApp();
  if (currentLocation.module !== "account") return null;
  const screen = currentLocation.screen;
  if (screen === "detail") return <AccountDetailScreen />;
  if (screen === "methodology") return <AccountDetailScreen tab="methodology" />;
  if (screen === "collection") return <CollectionDetailScreen />;
  return <ContentLibraryHub />;
}

function ContentLibraryHub() {
  const { goModule } = useApp();
  const [tab, setTab] = useState<HubTab>(() => {
    try { return (window.sessionStorage.getItem(TAB_KEY) as HubTab) || "accounts"; } catch { return "accounts"; }
  });
  const selectTab = (t: HubTab) => {
    setTab(t);
    try { window.sessionStorage.setItem(TAB_KEY, t); } catch { /* noop */ }
  };

  return (
    <div className="flex-1 flex flex-col bg-slate-50 dark:bg-[#0A0A0B] overflow-hidden">
      <header className="border-b border-slate-200 dark:border-slate-800 bg-white/70 dark:bg-slate-900/40 px-8 pt-5 shrink-0">
        <div className="max-w-6xl mx-auto">
          <div className="text-[10.5px] font-mono tracking-[0.14em] uppercase text-slate-500 dark:text-slate-400">
            LIBRARY
          </div>
          <div className="flex items-baseline gap-3 mt-1.5">
            <h1 className="text-[22px] font-semibold tracking-tight text-slate-900 dark:text-slate-100">内容库</h1>
            <div className="flex-1" />
            <button
              onClick={() => goModule("video")}
              className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 text-[13px]"
            >
              <ListVideo className="w-3.5 h-3.5" strokeWidth={1.5} />
              查看所有视频
            </button>
          </div>

          <div className="flex gap-6 mt-4" role="tablist">
            {([
              ["accounts", "账号", Library],
              ["collections", "收藏夹", FolderOpen],
              ["others", "其他视频", Film],
            ] as const).map(([k, label, Icon]) => {
              const active = tab === k;
              return (
                <button
                  key={k}
                  role="tab"
                  aria-selected={active}
                  onClick={() => selectTab(k)}
                  className={`relative flex items-center gap-1.5 pb-2.5 text-[14px] -mb-px transition-colors ${
                    active
                      ? "text-slate-900 dark:text-slate-100 font-medium"
                      : "text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" strokeWidth={1.5} />
                  {label}
                  {active && <span className="absolute left-0 right-0 -bottom-px h-[2px] bg-indigo-600 rounded-full" />}
                </button>
              );
            })}
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto px-8">
        <div className="max-w-6xl mx-auto py-7">
          {tab === "accounts" && <AccountGrid />}
          {tab === "collections" && <CollectionsTab />}
          {tab === "others" && <OtherVideosTab />}
        </div>
      </main>
    </div>
  );
}

// ─────────────────────────────────────────────
// 收藏夹 Tab
function CollectionsTab() {
  const { setLocation } = useApp();
  const collections = (useCollections().data ?? []).filter((c) => c.kind !== "account");
  const [newOpen, setNewOpen] = useState(false);

  const open = (c: Collection) => {
    setActiveCollectionId(c.id);
    setLocation({ module: "account", screen: "collection" });
  };

  return (
    <div>
      <div className="flex items-center gap-3 mb-5">
        <span className="text-[11.5px] font-mono text-slate-500 dark:text-slate-400">{collections.length} 个收藏夹</span>
        <div className="flex-1" />
        <button
          onClick={() => setNewOpen(true)}
          className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md bg-indigo-600 hover:bg-indigo-700 text-white text-[13px] font-medium"
        >
          <FolderPlus className="w-3.5 h-3.5" strokeWidth={2} />
          新建收藏夹
        </button>
      </div>

      {collections.length === 0 ? (
        <div className="border border-dashed border-slate-300 dark:border-slate-700 rounded-xl bg-white/50 dark:bg-slate-900/30 px-8 py-16 text-center">
          <div className="w-12 h-12 mx-auto rounded-xl bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 flex items-center justify-center mb-4">
            <FolderOpen className="w-5 h-5 text-slate-500 dark:text-slate-400" strokeWidth={1.5} />
          </div>
          <h2 className="text-[16px] font-semibold tracking-tight text-slate-900 dark:text-slate-100">还没有收藏夹</h2>
          <p className="mt-2 text-[13.5px] text-slate-600 dark:text-slate-400 max-w-md mx-auto leading-relaxed">
            建一个收藏夹,把零散视频归拢到一起管理。
          </p>
        </div>
      ) : (
        <div className="grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
          {collections.map((c) => (
            <button
              key={c.id}
              onClick={() => open(c)}
              className="text-left rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#14151a] p-4 hover:border-slate-300 dark:hover:border-slate-700 transition-colors group"
            >
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-lg bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 flex items-center justify-center shrink-0">
                  <FolderOpen className="w-5 h-5 text-slate-500 dark:text-slate-400" strokeWidth={1.5} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-[14px] font-semibold text-slate-900 dark:text-slate-100 truncate">{c.name}</div>
                  {c.description && (
                    <div className="text-[12px] text-slate-500 dark:text-slate-400 mt-0.5 line-clamp-2">{c.description}</div>
                  )}
                </div>
                <ChevronRight className="w-4 h-4 text-slate-400 shrink-0 group-hover:text-slate-600 dark:group-hover:text-slate-300" strokeWidth={1.5} />
              </div>
            </button>
          ))}
        </div>
      )}

      {newOpen && <NewCollectionDialog onClose={() => setNewOpen(false)} onCreated={open} />}
    </div>
  );
}

function NewCollectionDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (c: Collection) => void }) {
  const upsert = useUpsertCollection();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const now = new Date().toISOString();
    const col: Collection = {
      id: crypto.randomUUID(),
      name: trimmed,
      description: description.trim() || undefined,
      kind: "manual",
      createdAt: now,
      updatedAt: now,
    };
    await upsert.mutateAsync(col);
    onClose();
    onCreated(col);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 dark:bg-black/50" onClick={onClose}>
      <div
        className="w-[420px] max-w-[90vw] rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#14151a] shadow-xl p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-[15px] font-semibold text-slate-900 dark:text-slate-100">新建收藏夹</h2>
          <button onClick={onClose} className="w-7 h-7 rounded-md flex items-center justify-center text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800">
            <X className="w-4 h-4" strokeWidth={1.5} />
          </button>
        </div>
        <label className="block text-[12px] text-slate-500 dark:text-slate-400 mb-1">名称</label>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
          placeholder="例如:开场钩子合集"
          className="w-full h-9 px-3 text-[13.5px] rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:focus:ring-indigo-900/40 mb-3"
        />
        <label className="block text-[12px] text-slate-500 dark:text-slate-400 mb-1">描述(可选)</label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          className="w-full px-3 py-2 text-[13.5px] rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:focus:ring-indigo-900/40 resize-none"
        />
        <div className="flex justify-end gap-2 mt-4">
          <button onClick={onClose} className="h-9 px-3 rounded-md text-[13px] text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800">取消</button>
          <button
            onClick={submit}
            disabled={!name.trim() || upsert.isPending}
            className="h-9 px-4 rounded-md text-[13px] bg-indigo-600 hover:bg-indigo-700 text-white font-medium disabled:opacity-50"
          >
            创建
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// 其他视频 Tab(无账号、无收藏夹的散视频)
function OtherVideosTab() {
  const { accounts, analysesByVideo, setActiveVideoId, setLocation } = useApp();
  const videos = useVideos({ unassigned: true }).data ?? [];
  const accountMap = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);

  const open = (videoId: string) => {
    setActiveVideoId(videoId);
    setLocation({ module: "video", screen: "detail" });
  };

  if (videos.length === 0) {
    return (
      <div className="text-center py-16 text-[13px] text-slate-500">
        <Film className="w-10 h-10 mx-auto mb-3 text-slate-300 dark:text-slate-600" strokeWidth={1} />
        没有未归类的视频。从首页粘贴链接、或在收藏夹里新增视频。
      </div>
    );
  }

  return (
    <div>
      <div className="text-[11.5px] font-mono text-slate-500 dark:text-slate-400 mb-4">{videos.length} 条未归类</div>
      <VideoRowList>
        {videos.map((v) => (
          <VideoRow
            key={v.id}
            video={v}
            accountName={v.accountId ? accountMap.get(v.accountId)?.name : null}
            analyses={analysesByVideo[v.id]}
            onClick={() => open(v.id)}
            right={<ChevronRight className="w-3.5 h-3.5 text-slate-400" strokeWidth={1.5} />}
          />
        ))}
      </VideoRowList>
    </div>
  );
}
