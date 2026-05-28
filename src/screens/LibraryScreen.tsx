// 素材库模块 — v2 Phase 1
// list 网格 + filter chips + 标签 + 搜索
// ShotList 双栏: 视频预览 + 镜头索引

import { type FunctionComponent, type ReactNode, useMemo, useState } from "react";
import { useApp } from "../AppContext";
import type { AppLocation, Project, Shot } from "../types";
import {
  Folder,
  Upload as UploadIcon,
  ArrowLeft,
  Star,
  Film,
  Search,
  Plus,
  Play,
  Sparkles,
} from "lucide-react";

export function LibraryScreen() {
  const { currentLocation } = useApp();
  if (currentLocation.module !== "library") return null;
  const screen = currentLocation.screen;
  if (screen === "shot-list") return <ShotListScreen />;
  if (screen === "shot-detail") return <ShotDetailScreen />;
  if (screen === "upload") return <LibraryUploadScreen />;
  return <LibraryListScreen />;
}

function activeAssetId(): string | null {
  try { return window.sessionStorage.getItem("clipiq-active-asset-id"); } catch { return null; }
}
function setActiveAssetId(id: string | null) {
  try {
    if (id) window.sessionStorage.setItem("clipiq-active-asset-id", id);
    else window.sessionStorage.removeItem("clipiq-active-asset-id");
  } catch { /* noop */ }
}

// ─────────────────────────────────────────────────────────────
// list

const ASSET_TAG_OPTIONS = ["采访", "主拍", "B-roll", "空镜", "动画"];

function LibraryListScreen() {
  const { projects, setLocation, shotsByAsset } = useApp();
  const [tab, setTab] = useState<"all" | "unused" | "used" | "favorite">("all");
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const assets = useMemo(() => projects.filter((p) => p.kind === "asset"), [projects]);
  const totalDurationSec = useMemo(() => assets.reduce((sum, a) => sum + (a.durationSec || 0), 0), [assets]);

  const filtered = useMemo(() => {
    return assets.filter((a) => {
      if (tab === "favorite") {
        const shots = shotsByAsset[a.id] || a.shots || [];
        if (!shots.some((s) => s.isFavorite)) return false;
      }
      if (tagFilter && !(a.assetTags || []).includes(tagFilter)) return false;
      if (query) {
        const q = query.toLowerCase();
        if (!a.videoName.toLowerCase().includes(q) && !(a.assetTags || []).some((t) => t.toLowerCase().includes(q))) {
          return false;
        }
      }
      return true;
    });
  }, [assets, tab, tagFilter, query, shotsByAsset]);

  const uploadLoc: AppLocation = { module: "library", screen: "upload" };
  const shotListLoc: AppLocation = { module: "library", screen: "shot-list" };

  return (
    <div className="flex-1 flex flex-col bg-slate-50 dark:bg-[#0A0A0B] overflow-hidden">
      <header className="border-b border-slate-200 dark:border-slate-800 bg-white/70 dark:bg-slate-900/40 px-8 py-5 shrink-0">
        <div className="max-w-6xl mx-auto">
          <div className="text-[10.5px] font-mono tracking-[0.14em] uppercase text-slate-500 dark:text-slate-400">
            素材库 · LIBRARY
          </div>
          <div className="flex items-baseline gap-3 mt-1.5">
            <h1 className="text-[22px] font-semibold tracking-tight text-slate-900 dark:text-slate-100">所有素材</h1>
            <span className="text-[11.5px] font-mono text-slate-500 dark:text-slate-400">
              {assets.length} 条 · {formatTotalDuration(totalDurationSec)} 总时长
            </span>
            <div className="flex-1" />
            <button
              onClick={() => setLocation(uploadLoc)}
              className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-[13px] text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
            >
              <UploadIcon className="w-3.5 h-3.5" strokeWidth={1.5} />
              导入素材
            </button>
          </div>
          {/* filters */}
          <div className="flex items-center gap-1.5 mt-4">
            {([
              ["all", "全部"],
              ["unused", "未用过"],
              ["used", "已用"],
              ["favorite", "收藏"],
            ] as const).map(([k, l]) => (
              <FilterChip key={k} active={tab === k} onClick={() => setTab(k)}>{l}</FilterChip>
            ))}
            <div className="w-px h-4 bg-slate-200 dark:bg-slate-800 mx-1" />
            {ASSET_TAG_OPTIONS.map((t) => (
              <FilterChip key={t} active={tagFilter === t} onClick={() => setTagFilter(tagFilter === t ? null : t)}>{t}</FilterChip>
            ))}
            <div className="flex-1" />
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-400" strokeWidth={1.5} />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索素材名 / 标签"
                className="h-7 pl-7 pr-3 text-[12px] w-52 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:focus:ring-indigo-900/40"
              />
            </div>
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto">
        <div className="max-w-6xl mx-auto px-8 py-8">
          {assets.length === 0 ? (
            <EmptyLibrary onUpload={() => setLocation(uploadLoc)} />
          ) : filtered.length === 0 ? (
            <div className="text-center py-12 text-[13px] text-slate-500">没有匹配的素材</div>
          ) : (
            <div className="grid gap-[18px]" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}>
              {filtered.map((a) => (
                <AssetCard
                  key={a.id}
                  asset={a}
                  shots={shotsByAsset[a.id] || a.shots || []}
                  onClick={() => {
                    setActiveAssetId(a.id);
                    setLocation(shotListLoc);
                  }}
                />
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

const FilterChip: FunctionComponent<{ active?: boolean; onClick: () => void; children: ReactNode }> = ({ active, onClick, children }) => (
  <button
    onClick={onClick}
    className={`inline-flex items-center h-7 px-3 rounded-full border text-[12px] transition-colors ${
      active
        ? "bg-indigo-50 dark:bg-indigo-950/40 border-indigo-200 dark:border-indigo-800/50 text-indigo-700 dark:text-indigo-300"
        : "bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
    }`}
  >
    {children}
  </button>
);

function EmptyLibrary({ onUpload }: { onUpload: () => void }) {
  return (
    <div className="border border-dashed border-slate-300 dark:border-slate-700 rounded-xl bg-white/50 dark:bg-slate-900/30 px-8 py-16 text-center">
      <div className="w-12 h-12 mx-auto rounded-xl bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 flex items-center justify-center mb-4">
        <Film className="w-5 h-5 text-slate-500 dark:text-slate-400" strokeWidth={1.5} />
      </div>
      <h2 className="text-[16px] font-semibold tracking-tight text-slate-900 dark:text-slate-100">素材库还是空的</h2>
      <p className="mt-2 text-[13.5px] text-slate-600 dark:text-slate-400 max-w-md mx-auto leading-relaxed">
        把拍摄素材上传到素材库,会自动分镜并描述每个镜头,后续在剪辑助手里可以直接用。
      </p>
      <button
        onClick={onUpload}
        className="mt-6 inline-flex items-center gap-1.5 h-9 px-4 rounded-md bg-indigo-600 hover:bg-indigo-700 text-white text-[13px] font-medium"
      >
        <UploadIcon className="w-3.5 h-3.5" strokeWidth={2} />
        上传第一条素材
      </button>
    </div>
  );
}

const AssetCard: FunctionComponent<{ asset: Project; shots: Shot[]; onClick: () => void }> = ({ asset, shots, onClick }) => {
  const shotCount = shots.length;
  return (
    <button
      onClick={onClick}
      className="text-left bg-white dark:bg-slate-900/40 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden hover:border-slate-300 dark:hover:border-slate-700 transition-colors"
    >
      <div className="aspect-video bg-gradient-to-br from-slate-700 to-slate-900 relative">
        {asset.thumbnailUrl && (
          <img src={asset.thumbnailUrl} alt={asset.videoName} className="absolute inset-0 w-full h-full object-cover" />
        )}
        <span className="absolute bottom-1.5 right-1.5 px-1.5 py-0.5 rounded bg-black/70 text-white font-mono text-[10px]">
          {formatDuration(asset.durationSec)}
        </span>
      </div>
      <div className="px-2.5 py-2">
        <div className="text-[12.5px] font-medium text-slate-900 dark:text-slate-100 truncate" title={asset.videoName}>{asset.videoName}</div>
        <div className="mt-1 flex items-center gap-1.5 text-[10.5px] font-mono tracking-wider text-slate-500 dark:text-slate-400">
          <span>{shotCount} 镜头</span>
          {asset.updatedAt && <span>· {formatDate(asset.updatedAt)}</span>}
        </div>
        {(asset.assetTags?.length ?? 0) > 0 && (
          <div className="flex flex-wrap gap-1 mt-1.5">
            {asset.assetTags!.slice(0, 3).map((t) => (
              <span key={t} className="text-[10px] font-mono px-1 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400">
                {t}
              </span>
            ))}
          </div>
        )}
      </div>
    </button>
  );
};

// ─────────────────────────────────────────────────────────────
// upload (composer 简化版,接入主进程后会复用 HomeScreen 的 inspectVideoPath / openVideoFile)

function LibraryUploadScreen() {
  const { setLocation, setProjects, setActiveProjectId, setShotsForAsset } = useApp();
  const backToList: AppLocation = { module: "library", screen: "list" };
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string>("");

  const handlePickFile = async () => {
    setError("");
    if (!window.videoAnalyzer) {
      setError("当前为浏览器预览模式,主进程不可用");
      return;
    }
    try {
      setBusy("打开视频文件...");
      const video = await window.videoAnalyzer.openVideoFile();
      if (!video) { setBusy(""); return; }
      const id = `asset-${Date.now()}`;
      const now = new Date().toISOString();
      const newVideo: import("../types").Video = {
        id,
        title: video.filename,
        sourceType: "local",
        localPath: video.filePath,
        durationSec: video.durationSec,
        width: video.width,
        height: video.height,
        orientation: video.orientation,
        status: "ready",
        tags: [],
        createdAt: now,
        updatedAt: now,
      };
      setProjects((prev) => [newVideo as any, ...prev]);
      await window.videoAnalyzer.upsertVideo(newVideo);
      setActiveProjectId(id);
      setActiveAssetId(id);

      // 真分镜: ffmpeg scenedetect 切镜头边界,落库
      setBusy("ffmpeg 分镜中...");
      try {
        const result = await window.videoAnalyzer.analyzeVideoShots?.({
          videoId: id,
          filePath: video.filePath,
          durationSec: video.durationSec,
        });
        if (result?.shots) {
          setShotsForAsset(id, result.shots);
        }
      } catch (e) {
        // 分镜失败不阻塞,用户可以在 ShotList 里点 "重新分镜"
        console.warn("analyzeAssetShots failed:", e);
      }
      setBusy("");
      setLocation({ module: "library", screen: "shot-list" });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy("");
    }
  };

  return (
    <div className="flex-1 flex flex-col bg-slate-50 dark:bg-[#0A0A0B] overflow-hidden">
      <header className="border-b border-slate-200 dark:border-slate-800 bg-white/70 dark:bg-slate-900/40 px-8 py-3 shrink-0 flex items-center gap-3">
        <button
          onClick={() => setLocation(backToList)}
          className="inline-flex items-center gap-1.5 h-8 px-2 rounded-md text-[13px] text-slate-600 dark:text-slate-300 hover:bg-slate-200/60 dark:hover:bg-slate-800/60"
        >
          <ArrowLeft className="w-3.5 h-3.5" strokeWidth={1.5} />
          素材库
        </button>
        <h1 className="text-[14px] font-semibold tracking-tight text-slate-900 dark:text-slate-100">导入素材</h1>
      </header>
      <main className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-8 py-12">
          <button
            onClick={handlePickFile}
            disabled={!!busy}
            className="w-full border-2 border-dashed border-slate-300 dark:border-slate-700 rounded-xl bg-white dark:bg-slate-900/30 px-8 py-16 text-center hover:border-indigo-400 dark:hover:border-indigo-700 hover:bg-indigo-50/30 dark:hover:bg-indigo-950/20 transition-colors disabled:opacity-60"
          >
            <UploadIcon className="w-8 h-8 mx-auto text-slate-400 dark:text-slate-500 mb-3" strokeWidth={1.5} />
            <p className="text-[14px] font-medium text-slate-700 dark:text-slate-200">{busy || "点击选择视频文件"}</p>
            <p className="mt-1.5 text-[12.5px] text-slate-500 dark:text-slate-400">MP4 · MOV · MKV · WEBM · AVI · M4V</p>
            <p className="mt-6 text-[10.5px] font-mono tracking-wider uppercase text-slate-400 dark:text-slate-500">
              入库后会用 ffmpeg scenedetect 自动分镜
            </p>
          </button>
          {error && (
            <div className="mt-4 rounded-md border border-rose-200 dark:border-rose-900/50 bg-rose-50 dark:bg-rose-950/30 px-3 py-2.5 text-[13px] text-rose-700 dark:text-rose-300">
              {error}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// shot-list 双栏

const SHOT_KIND_LABEL: Record<string, string> = {
  wide: "WIDE",
  medium: "MEDIUM",
  close: "CLOSE",
  "extreme-close": "ECU",
  establishing: "ESTABLISH",
};

function ShotListScreen() {
  const { projects, shotsByAsset, setLocation, setShotsForAsset } = useApp();
  const id = activeAssetId();
  const asset = projects.find((p) => p.id === id && p.kind === "asset");
  const shots = (id && shotsByAsset[id]) || asset?.shots || [];
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [reanalyzing, setReanalyzing] = useState(false);

  const backToList: AppLocation = { module: "library", screen: "list" };

  if (!asset) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center bg-slate-50 dark:bg-[#0A0A0B] gap-4">
        <p className="text-[13px] text-slate-500">未找到素材</p>
        <button
          onClick={() => setLocation(backToList)}
          className="h-9 px-4 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-[13px] text-slate-700 dark:text-slate-300"
        >
          返回素材库
        </button>
      </div>
    );
  }

  // 真分镜 — ffmpeg scenedetect
  const reanalyzeShots = async () => {
    if (!asset.localFilePath) return;
    setReanalyzing(true);
    try {
      const result = await window.videoAnalyzer?.analyzeVideoShots?.({
        videoId: asset.id,
        filePath: (asset as any).localFilePath || (asset as any).localPath,
        durationSec: asset.durationSec,
      });
      if (result?.shots) {
        setShotsForAsset(asset.id, result.shots);
        setSelectedIdx(0);
      }
    } catch (e) {
      console.warn("reanalyzeShots failed:", e);
    }
    setReanalyzing(false);
  };

  const sel = shots[selectedIdx];

  return (
    <div className="flex-1 flex flex-col bg-slate-50 dark:bg-[#0A0A0B] overflow-hidden">
      <header className="border-b border-slate-200 dark:border-slate-800 bg-white/70 dark:bg-slate-900/40 px-6 py-3 shrink-0 flex items-center gap-3">
        <button
          onClick={() => setLocation(backToList)}
          className="inline-flex items-center gap-1.5 h-8 px-2 rounded-md text-[13px] text-slate-600 dark:text-slate-300 hover:bg-slate-200/60 dark:hover:bg-slate-800/60"
        >
          <ArrowLeft className="w-3.5 h-3.5" strokeWidth={1.5} />
          素材库
        </button>
        <div className="w-px h-4 bg-slate-200 dark:bg-slate-800" />
        <h1 className="text-[14px] font-semibold tracking-tight text-slate-900 dark:text-slate-100 truncate max-w-xl">{asset.videoName}</h1>
        <span className="text-[11px] font-mono text-slate-500 dark:text-slate-400">
          {formatDuration(asset.durationSec)} · {shots.length} 镜头
        </span>
        <div className="flex-1" />
        <button className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-[12.5px] text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800">
          <Sparkles className="w-3 h-3" strokeWidth={1.5} />
          用这条做剪辑
        </button>
      </header>

      <div className="flex-1 grid grid-cols-[1fr_440px] min-h-0">
        {/* 左:视频预览 + 镜头边界 timeline */}
        <div className="p-5 flex flex-col border-r border-slate-200 dark:border-slate-800 min-w-0">
          <div className="flex-1 min-h-0 relative rounded-lg overflow-hidden bg-gradient-to-br from-slate-800 to-slate-950 flex items-center justify-center">
            {asset.localVideoPath ? (
              <video
                key={asset.id}
                src={asset.localVideoPath}
                controls
                className="max-w-full max-h-full"
              />
            ) : (
              <div className="text-center text-slate-300">
                <div className="text-[10.5px] font-mono tracking-wider uppercase text-slate-400 mb-2">
                  SHOT #{String(selectedIdx + 1).padStart(2, "0")} / {shots.length}
                </div>
                <div className="text-[18px] font-medium">{sel?.description || "无镜头数据"}</div>
              </div>
            )}
          </div>
          <div className="mt-3.5">
            <div className="text-[10.5px] font-mono tracking-wider uppercase text-slate-500 dark:text-slate-400 mb-1.5">
              镜头边界 · {shots.length} 段
            </div>
            <div className="flex gap-0.5 h-3">
              {shots.length === 0 ? (
                <div className="flex-1 bg-slate-200 dark:bg-slate-800 rounded" />
              ) : shots.map((_, i) => (
                <button
                  key={i}
                  onClick={() => setSelectedIdx(i)}
                  className={`flex-1 rounded-sm cursor-pointer ${
                    selectedIdx === i ? "bg-indigo-600 dark:bg-indigo-500" : "bg-slate-300 dark:bg-slate-700 hover:bg-slate-400 dark:hover:bg-slate-600"
                  }`}
                />
              ))}
            </div>
          </div>
        </div>

        {/* 右:镜头索引 */}
        <aside className="overflow-y-auto bg-white dark:bg-slate-900/40 p-4">
          <div className="text-[10.5px] font-mono tracking-[0.14em] uppercase text-slate-500 dark:text-slate-400 mb-2.5 px-1">
            镜头索引
          </div>
          {shots.length === 0 ? (
            <div className="rounded-md border border-dashed border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/40 p-5 text-center">
              <p className="text-[12.5px] text-slate-600 dark:text-slate-400 leading-relaxed">
                这条素材还没分镜。
                <br />
                <span className="text-[10.5px] font-mono tracking-wider uppercase">ffmpeg scenedetect 切镜头边界</span>
              </p>
              <button
                onClick={reanalyzeShots}
                disabled={reanalyzing || !asset.localFilePath}
                className="mt-3 inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-[12.5px] border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50"
              >
                <Sparkles className="w-3 h-3" strokeWidth={1.5} />
                {reanalyzing ? "分镜中..." : "重新分镜"}
              </button>
            </div>
          ) : (
            <ul className="space-y-1.5">
              {shots.map((s, i) => {
                const active = selectedIdx === i;
                return (
                  <li key={s.id}>
                    <button
                      onClick={() => setSelectedIdx(i)}
                      className={`w-full text-left rounded-lg p-2.5 border ${
                        active
                          ? "bg-white dark:bg-slate-900 border-indigo-500 ring-2 ring-indigo-100 dark:ring-indigo-900/30"
                          : "border-transparent hover:bg-slate-100 dark:hover:bg-slate-800/40"
                      }`}
                    >
                      <div className="flex gap-2.5">
                        <div className="w-[66px] h-[38px] rounded bg-slate-300 dark:bg-slate-700 shrink-0 grid place-items-center text-slate-500 text-[10px]">
                          {s.thumbnailUrl ? (
                            <img src={s.thumbnailUrl} alt={`s${s.shotIndex}`} className="w-full h-full object-cover rounded" />
                          ) : (
                            <Play className="w-3 h-3" strokeWidth={1.5} />
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="text-[10.5px] font-mono text-slate-500 dark:text-slate-400">
                              #{String(s.shotIndex).padStart(2, "0")}
                            </span>
                            {s.shotType && (
                              <span className="text-[10px] font-mono tracking-wider uppercase px-1 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400">
                                {SHOT_KIND_LABEL[s.shotType] || s.shotType.toUpperCase()}
                              </span>
                            )}
                            <span className="text-[10.5px] font-mono text-slate-500 dark:text-slate-400 ml-auto">
                              {formatTimeRange(s.startSec, s.endSec)}
                            </span>
                            {s.isFavorite && <Star className="w-3 h-3 text-amber-500" strokeWidth={1.5} fill="currentColor" />}
                          </div>
                          <p className="mt-1 text-[12.5px] leading-relaxed text-slate-700 dark:text-slate-300 line-clamp-2">{s.description}</p>
                          {s.usageTags.length > 0 && (
                            <div className="mt-1 text-[10.5px] font-mono tracking-wider text-indigo-600 dark:text-indigo-400">
                              用途 · {s.usageTags.join(" / ")}
                            </div>
                          )}
                        </div>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </aside>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// shot-detail (留 placeholder)

function ShotDetailScreen() {
  const { setLocation } = useApp();
  return (
    <div className="flex-1 flex flex-col items-center justify-center bg-slate-50 dark:bg-[#0A0A0B] gap-4">
      <p className="text-[13px] text-slate-500">镜头详情视图开发中</p>
      <button
        onClick={() => setLocation({ module: "library", screen: "shot-list" })}
        className="h-9 px-4 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-[13px] text-slate-700 dark:text-slate-300"
      >
        返回镜头列表
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// utils

function pad2(n: number) { return n < 10 ? `0${n}` : `${n}`; }

function formatDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${pad2(r)}`;
}

function formatTimeRange(start: number, end: number): string {
  return `${formatDuration(start)}–${formatDuration(end)}`;
}

function formatTotalDuration(totalSec: number): string {
  const s = Math.max(0, Math.round(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}:${pad2(m)}:${pad2(r)}`;
  return `${m}:${pad2(r)}`;
}

function formatDate(iso: string): string {
  const dt = new Date(iso);
  const now = Date.now();
  const diffH = (now - dt.getTime()) / 3600_000;
  if (diffH < 24) return "今天";
  if (diffH < 48) return "昨天";
  return dt.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}
