// 收藏夹二级页(module account / screen collection)。
// 看收藏夹内视频、关联已有视频(可选账号下的)、新增视频(可选发起分析)、移出、改名、删除。
import { useMemo, useState } from "react";
import { useApp } from "../AppContext";
import {
  useCollections,
  useUpsertCollection,
  useDeleteCollection,
  useAddVideoToCollection,
  useRemoveVideoFromCollection,
} from "../queries/collections";
import { useVideos, useUpsertVideo } from "../queries/videos";
import { VideoRow, VideoRowList } from "../components/VideoRow";
import { useConfirm } from "../components/ConfirmDialog";
import { activeCollectionId } from "./ContentLibraryScreen";
import type { Collection, Video } from "../types";
import { ArrowLeft, Plus, Link2, Trash2, X, Search, Check, FolderOpen, Loader2, Pencil } from "lucide-react";

export function CollectionDetailScreen() {
  const { goBack, accounts, analysesByVideo, setActiveVideoId, setLocation } = useApp();
  const confirm = useConfirm();

  const id = activeCollectionId();
  const collection = (useCollections().data ?? []).find((c) => c.id === id);
  const videos = useVideos(id ? { collectionId: id } : undefined).data ?? [];
  const accountMap = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);

  const upsertCollection = useUpsertCollection();
  const deleteCollection = useDeleteCollection();
  const removeVideo = useRemoveVideoFromCollection();

  const [associateOpen, setAssociateOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");

  if (!id || !collection) {
    return (
      <div className="flex-1 flex items-center justify-center text-slate-500">
        <button onClick={() => goBack()} className="underline">返回内容库</button>
      </div>
    );
  }

  const saveName = async () => {
    const next = nameDraft.trim();
    setEditingName(false);
    if (!next || next === collection.name) return;
    await upsertCollection.mutateAsync({ ...collection, name: next, updatedAt: new Date().toISOString() });
  };

  const handleDeleteCollection = async () => {
    const ok = await confirm({
      title: "删除收藏夹",
      description: "只删除收藏夹本身,里面的视频不会被删除。",
      confirmLabel: "删除",
      destructive: true,
    });
    if (!ok) return;
    await deleteCollection.mutateAsync(collection.id);
    goBack();
  };

  const open = (videoId: string) => {
    setActiveVideoId(videoId);
    setLocation({ module: "video", screen: "detail" });
  };

  return (
    <div className="flex-1 flex flex-col bg-slate-50 dark:bg-[#0A0A0B] overflow-hidden">
      <header className="border-b border-slate-200 dark:border-slate-800 bg-white/70 dark:bg-slate-900/40 px-8 py-5 shrink-0">
        <div className="max-w-6xl mx-auto">
          <button onClick={() => goBack()} className="inline-flex items-center gap-1.5 text-[12.5px] text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 mb-3">
            <ArrowLeft className="w-3.5 h-3.5" strokeWidth={1.5} />返回内容库
          </button>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 flex items-center justify-center shrink-0">
              <FolderOpen className="w-5 h-5 text-slate-500 dark:text-slate-400" strokeWidth={1.5} />
            </div>
            <div className="flex-1 min-w-0">
              {editingName ? (
                <input
                  autoFocus
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  onBlur={saveName}
                  onKeyDown={(e) => { if (e.key === "Enter") saveName(); if (e.key === "Escape") setEditingName(false); }}
                  className="text-[20px] font-semibold tracking-tight text-slate-900 dark:text-slate-100 bg-transparent border-b border-indigo-400 focus:outline-none w-full max-w-md"
                />
              ) : (
                <div className="flex items-center gap-2 group">
                  <h1 className="text-[20px] font-semibold tracking-tight text-slate-900 dark:text-slate-100 truncate">{collection.name}</h1>
                  <button
                    onClick={() => { setNameDraft(collection.name); setEditingName(true); }}
                    className="opacity-0 group-hover:opacity-100 w-6 h-6 rounded flex items-center justify-center text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                    title="改名"
                  >
                    <Pencil className="w-3.5 h-3.5" strokeWidth={1.5} />
                  </button>
                </div>
              )}
              <div className="text-[11.5px] font-mono text-slate-500 dark:text-slate-400 mt-0.5">{videos.length} 条视频</div>
            </div>
            <div className="flex gap-2 shrink-0">
              <button
                onClick={() => setAssociateOpen(true)}
                className="h-8 px-3 rounded-md text-[12.5px] border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1.5"
              >
                <Link2 className="w-3.5 h-3.5" strokeWidth={1.5} />关联已有视频
              </button>
              <button
                onClick={() => setAddOpen(true)}
                className="h-8 px-3 rounded-md text-[12.5px] bg-indigo-600 hover:bg-indigo-700 text-white inline-flex items-center gap-1.5"
              >
                <Plus className="w-3.5 h-3.5" strokeWidth={2} />新增视频
              </button>
              <button onClick={handleDeleteCollection} title="删除收藏夹" className="h-8 w-8 rounded-md flex items-center justify-center text-slate-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:text-rose-400 dark:hover:bg-rose-900/30 border border-slate-200 dark:border-slate-700">
                <Trash2 className="w-3.5 h-3.5" strokeWidth={1.5} />
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto px-8">
        <div className="max-w-6xl mx-auto py-6">
          {videos.length === 0 ? (
            <div className="text-center py-16 text-[13px] text-slate-500">
              <FolderOpen className="w-10 h-10 mx-auto mb-3 text-slate-300 dark:text-slate-600" strokeWidth={1} />
              收藏夹是空的。关联已有视频,或新增一个视频。
            </div>
          ) : (
            <VideoRowList>
              {videos.map((v) => (
                <VideoRow
                  key={v.id}
                  video={v}
                  accountName={v.accountId ? accountMap.get(v.accountId)?.name : null}
                  analyses={analysesByVideo[v.id]}
                  onClick={() => open(v.id)}
                  right={
                    <button
                      onClick={() => removeVideo.mutate({ collectionId: id, videoId: v.id })}
                      title="移出收藏夹"
                      className="w-7 h-7 rounded-md flex items-center justify-center text-slate-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:text-rose-400 dark:hover:bg-rose-900/30"
                    >
                      <X className="w-3.5 h-3.5" strokeWidth={1.5} />
                    </button>
                  }
                />
              ))}
            </VideoRowList>
          )}
        </div>
      </main>

      {associateOpen && <AssociateDialog collection={collection} existingIds={new Set(videos.map((v) => v.id))} onClose={() => setAssociateOpen(false)} />}
      {addOpen && <AddVideoDialog collectionId={id} onClose={() => setAddOpen(false)} />}
    </div>
  );
}

// ─────────────────────────────────────────────
// 关联已有视频(多选 picker,含账号下的视频)
function AssociateDialog({ collection, existingIds, onClose }: { collection: Collection; existingIds: Set<string>; onClose: () => void }) {
  const { accounts, analysesByVideo } = useApp();
  const all = useVideos().data ?? [];
  const add = useAddVideoToCollection();
  const accountMap = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all
      .filter((v) => !existingIds.has(v.id))
      .filter((v) => !q || v.title.toLowerCase().includes(q));
  }, [all, existingIds, query]);

  const toggle = (vid: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(vid)) next.delete(vid); else next.add(vid);
      return next;
    });
  };

  const submit = async () => {
    if (picked.size === 0) return;
    setSaving(true);
    for (const vid of picked) {
      await add.mutateAsync({ collectionId: collection.id, videoId: vid });
    }
    setSaving(false);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 dark:bg-black/50" onClick={onClose}>
      <div className="w-[560px] max-w-[92vw] max-h-[80vh] flex flex-col rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#14151a] shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-800">
          <h2 className="text-[15px] font-semibold text-slate-900 dark:text-slate-100">关联已有视频</h2>
          <button onClick={onClose} className="w-7 h-7 rounded-md flex items-center justify-center text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800">
            <X className="w-4 h-4" strokeWidth={1.5} />
          </button>
        </div>
        <div className="px-5 py-3 border-b border-slate-200 dark:border-slate-800">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" strokeWidth={1.5} />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索视频(含账号下的视频)"
              className="w-full h-9 pl-8 pr-3 text-[13px] rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:focus:ring-indigo-900/40"
            />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {candidates.length === 0 ? (
            <div className="text-center py-12 text-[13px] text-slate-500">没有可关联的视频</div>
          ) : (
            <div className="divide-y divide-slate-100 dark:divide-slate-800/80">
              {candidates.map((v) => {
                const checked = picked.has(v.id);
                return (
                  <div key={v.id} onClick={() => toggle(v.id)} className="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/40 flex items-center">
                    <div className={`ml-4 w-4 h-4 rounded border flex items-center justify-center shrink-0 ${checked ? "bg-indigo-600 border-indigo-600" : "border-slate-300 dark:border-slate-600"}`}>
                      {checked && <Check className="w-3 h-3 text-white" strokeWidth={3} />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <VideoRow video={v} accountName={v.accountId ? accountMap.get(v.accountId)?.name : null} analyses={analysesByVideo[v.id]} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <div className="flex items-center justify-between px-5 py-3 border-t border-slate-200 dark:border-slate-800">
          <span className="text-[12px] font-mono text-slate-500">{picked.size} 选中</span>
          <div className="flex gap-2">
            <button onClick={onClose} className="h-9 px-3 rounded-md text-[13px] text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800">取消</button>
            <button onClick={submit} disabled={picked.size === 0 || saving} className="h-9 px-4 rounded-md text-[13px] bg-indigo-600 hover:bg-indigo-700 text-white font-medium disabled:opacity-50 inline-flex items-center gap-1.5">
              {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={2} />}
              关联
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// 新增视频(URL 或本地路径)+ 可选发起分析
function AddVideoDialog({ collectionId, onClose }: { collectionId: string; onClose: () => void }) {
  const { startAnalysisForProject } = useApp();
  const upsertVideo = useUpsertVideo();
  const add = useAddVideoToCollection();
  const [input, setInput] = useState("");
  const [analyze, setAnalyze] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const pickFile = async () => {
    setError("");
    const api = window.videoAnalyzer;
    if (!api) { setError("当前环境不可用(浏览器预览)"); return; }
    try {
      const v = await api.openVideoFile();
      if (v) setInput(v.filePath);
    } catch (e) { setError(String((e as Error)?.message || e)); }
  };

  const submit = async () => {
    const value = input.trim();
    if (!value) return;
    const api = window.videoAnalyzer;
    if (!api) { setError("当前环境不可用(浏览器预览)"); return; }
    setBusy(true);
    setError("");
    try {
      const now = new Date().toISOString();
      let video: Video;
      if (/^https?:\/\//i.test(value)) {
        const dl = await api.downloadVideo(value);
        video = {
          id: dl.videoId,
          title: dl.title || dl.filename || "未命名视频",
          sourceType: "url",
          sourceUrl: value,
          platform: dl.platform,
          localPath: dl.filePath,
          durationSec: dl.durationSec,
          width: dl.width,
          height: dl.height,
          orientation: dl.orientation,
          thumbnailUrl: dl.thumbnailUrl || undefined,
          status: "ready",
          createdAt: now,
          updatedAt: now,
        };
      } else {
        const meta = await api.inspectVideoPath(value);
        video = {
          id: "vid-" + Date.now(),
          title: meta.filename || "本地视频",
          sourceType: "local",
          localPath: meta.filePath,
          durationSec: meta.durationSec,
          width: meta.width,
          height: meta.height,
          orientation: meta.orientation,
          status: "ready",
          createdAt: now,
          updatedAt: now,
        };
      }
      await upsertVideo.mutateAsync(video);
      await add.mutateAsync({ collectionId, videoId: video.id });
      onClose();
      if (analyze) startAnalysisForProject(video.id); // 跳进度屏
    } catch (e) {
      setError(String((e as Error)?.message || e));
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 dark:bg-black/50" onClick={onClose}>
      <div className="w-[460px] max-w-[92vw] rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#14151a] shadow-xl p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-[15px] font-semibold text-slate-900 dark:text-slate-100">新增视频</h2>
          <button onClick={onClose} className="w-7 h-7 rounded-md flex items-center justify-center text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800">
            <X className="w-4 h-4" strokeWidth={1.5} />
          </button>
        </div>
        <label className="block text-[12px] text-slate-500 dark:text-slate-400 mb-1">链接或本地路径</label>
        <div className="flex gap-2 mb-3">
          <input
            autoFocus
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
            placeholder="粘贴链接,或输入本地路径"
            className="flex-1 h-9 px-3 text-[13.5px] rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:focus:ring-indigo-900/40"
          />
          <button onClick={pickFile} className="h-9 px-3 rounded-md text-[13px] border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 shrink-0">选文件</button>
        </div>
        <label className="flex items-center gap-2 text-[13px] text-slate-700 dark:text-slate-300 cursor-pointer select-none">
          <input type="checkbox" checked={analyze} onChange={(e) => setAnalyze(e.target.checked)} className="accent-indigo-600" />
          添加后立即开始结构拆解
        </label>
        {error && <div className="text-[12px] text-rose-500 mt-3">{error}</div>}
        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onClose} className="h-9 px-3 rounded-md text-[13px] text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800">取消</button>
          <button onClick={submit} disabled={!input.trim() || busy} className="h-9 px-4 rounded-md text-[13px] bg-indigo-600 hover:bg-indigo-700 text-white font-medium disabled:opacity-50 inline-flex items-center gap-1.5">
            {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={2} />}
            添加
          </button>
        </div>
      </div>
    </div>
  );
}
