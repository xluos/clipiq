// 素材库模块 — v2 Phase 1。子屏: list / upload / shot-list / shot-detail。
// 路由通过 useApp().currentLocation.screen 切换。
// 数据模型: Project.kind = "asset",Project.shots[] 是分镜结果。
// PRODUCT.md §4.2: 复用 analyzeProject 全管线 + shot-merger 做素材分镜。

import { type FunctionComponent, useMemo, useState } from "react";
import { useApp } from "../AppContext";
import type { AppLocation, Project, Shot } from "../types";
import {
  Folder,
  Upload as UploadIcon,
  ArrowLeft,
  Star,
  Film,
  Camera,
  Search,
  Plus,
} from "lucide-react";

export function LibraryScreen() {
  const { currentLocation } = useApp();
  if (currentLocation.module !== "library") return null;
  const screen = currentLocation.screen;

  if (screen === "list") return <LibraryListScreen />;
  if (screen === "upload") return <LibraryUploadScreen />;
  if (screen === "shot-list") return <ShotListScreen />;
  if (screen === "shot-detail") return <ShotDetailScreen />;
  return <LibraryListScreen />;
}

// ─────────────────────────────────────────────────────────────────────
// list: 已入库素材网格

function LibraryListScreen() {
  const { projects, setLocation } = useApp();
  const [query, setQuery] = useState("");

  // 只看 kind=asset 的项目;旧数据(没 kind)默认 analysis,不出现在素材库
  const assets = useMemo(() => {
    const filtered = projects.filter((p) => p.kind === "asset");
    if (!query.trim()) return filtered;
    const q = query.trim().toLowerCase();
    return filtered.filter((p) => p.videoName.toLowerCase().includes(q));
  }, [projects, query]);

  const goUpload: AppLocation = { module: "library", screen: "upload" };
  const openShotList = (id: string): AppLocation => ({ module: "library", screen: "shot-list" });

  return (
    <div className="flex-1 flex flex-col bg-slate-50 dark:bg-[#0A0A0B] overflow-hidden">
      <header className="border-b border-slate-200 dark:border-slate-800 bg-white/70 dark:bg-slate-900/40 px-8 py-5 shrink-0">
        <div className="max-w-6xl mx-auto flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 flex items-center justify-center">
              <Folder className="w-4 h-4 text-slate-700 dark:text-slate-300" strokeWidth={1.5} />
            </div>
            <div>
              <h1 className="text-[17px] font-semibold tracking-tight text-slate-900 dark:text-slate-100">素材库</h1>
              <p className="text-[12.5px] text-slate-500 dark:text-slate-400 mt-0.5">
                {assets.length} 条素材 · 自动分镜 · 可检索镜头索引
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" strokeWidth={1.5} />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索素材"
                className="h-9 pl-8 pr-3 text-[13px] w-56 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:focus:ring-indigo-900/40"
              />
            </div>
            <button
              onClick={() => setLocation(goUpload)}
              className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md bg-indigo-600 hover:bg-indigo-700 text-white text-[13px] font-medium"
            >
              <Plus className="w-3.5 h-3.5" strokeWidth={2} />
              上传素材
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto">
        <div className="max-w-6xl mx-auto px-8 py-8">
          {assets.length === 0 ? (
            <EmptyLibrary onUpload={() => setLocation(goUpload)} />
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
              {assets.map((a) => (
                <AssetCard key={a.id} asset={a} onClick={() => setLocation(openShotList(a.id))} />
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

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

const AssetCard: FunctionComponent<{ asset: Project; onClick: () => void }> = ({ asset, onClick }) => {
  const shotCount = asset.shots?.length ?? 0;
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
      <div className="px-3 py-2.5">
        <div className="text-[13px] font-medium text-slate-900 dark:text-slate-100 truncate">{asset.videoName}</div>
        <div className="mt-1 flex items-center gap-2 text-[10.5px] font-mono tracking-wider uppercase text-slate-500 dark:text-slate-400">
          <Camera className="w-3 h-3" strokeWidth={1.5} />
          {shotCount > 0 ? `${shotCount} 镜头` : "未分镜"}
        </div>
      </div>
    </button>
  );
};

// ─────────────────────────────────────────────────────────────────────
// upload: 上传过渡屏

function LibraryUploadScreen() {
  const { setLocation } = useApp();
  const backToList: AppLocation = { module: "library", screen: "list" };

  return (
    <div className="flex-1 flex flex-col bg-slate-50 dark:bg-[#0A0A0B] overflow-hidden">
      <header className="border-b border-slate-200 dark:border-slate-800 bg-white/70 dark:bg-slate-900/40 px-8 py-5 shrink-0">
        <div className="max-w-4xl mx-auto flex items-center gap-2">
          <button
            onClick={() => setLocation(backToList)}
            className="w-8 h-8 -ml-2 rounded-md text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100 hover:bg-slate-200/60 dark:hover:bg-slate-800/60 flex items-center justify-center"
          >
            <ArrowLeft className="w-4 h-4" strokeWidth={1.5} />
          </button>
          <h1 className="text-[15px] font-semibold tracking-tight text-slate-900 dark:text-slate-100">上传素材</h1>
        </div>
      </header>
      <main className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-8 py-12">
          <div className="border-2 border-dashed border-slate-300 dark:border-slate-700 rounded-xl bg-white dark:bg-slate-900/30 px-8 py-16 text-center">
            <UploadIcon className="w-8 h-8 mx-auto text-slate-400 dark:text-slate-500 mb-3" strokeWidth={1.5} />
            <p className="text-[14px] font-medium text-slate-700 dark:text-slate-200">把视频文件拖到这里</p>
            <p className="mt-1.5 text-[12.5px] text-slate-500 dark:text-slate-400">或粘贴链接 / 输入本地路径</p>
            <p className="mt-6 text-[11px] font-mono tracking-wider uppercase text-slate-400 dark:text-slate-500">
              素材分镜管线还在接入中
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// shot-list: 单条素材的镜头列表

function ShotListScreen() {
  const { setLocation, projects } = useApp();
  // 简化版: 拿第一条 asset 作为 demo (后续接入 router params)
  const asset = projects.find((p) => p.kind === "asset");
  const backToList: AppLocation = { module: "library", screen: "list" };
  const openDetail: AppLocation = { module: "library", screen: "shot-detail" };

  if (!asset) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center bg-slate-50 dark:bg-[#0A0A0B]">
        <p className="text-[13px] text-slate-500">没有可显示的素材</p>
        <button
          onClick={() => setLocation(backToList)}
          className="mt-4 h-9 px-4 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-[13px] text-slate-700 dark:text-slate-300"
        >
          返回素材库
        </button>
      </div>
    );
  }

  const shots: Shot[] = asset.shots ?? [];

  return (
    <div className="flex-1 flex flex-col bg-slate-50 dark:bg-[#0A0A0B] overflow-hidden">
      <header className="border-b border-slate-200 dark:border-slate-800 bg-white/70 dark:bg-slate-900/40 px-8 py-4 shrink-0">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setLocation(backToList)}
            className="w-8 h-8 -ml-2 rounded-md text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100 hover:bg-slate-200/60 dark:hover:bg-slate-800/60 flex items-center justify-center"
          >
            <ArrowLeft className="w-4 h-4" strokeWidth={1.5} />
          </button>
          <div className="flex-1 min-w-0">
            <h1 className="text-[15px] font-semibold tracking-tight text-slate-900 dark:text-slate-100 truncate">{asset.videoName}</h1>
            <div className="flex items-center gap-3 mt-0.5 text-[11px] font-mono tracking-wider uppercase text-slate-500 dark:text-slate-400">
              <span>{formatDuration(asset.durationSec)}</span>
              <span>·</span>
              <span>{shots.length} 镜头</span>
              {asset.assetTags && asset.assetTags.length > 0 && (
                <>
                  <span>·</span>
                  <span className="font-sans normal-case tracking-normal">{asset.assetTags.join(" / ")}</span>
                </>
              )}
            </div>
          </div>
        </div>
      </header>

      <div className="flex-1 grid grid-cols-1 lg:grid-cols-[1fr_360px] overflow-hidden">
        {/* 视频预览区 */}
        <div className="flex flex-col bg-slate-900 dark:bg-black overflow-hidden">
          <div className="flex-1 flex items-center justify-center p-8">
            {asset.localVideoPath ? (
              <video
                src={asset.localVideoPath}
                controls
                className="max-w-full max-h-full rounded-lg border border-slate-800"
              />
            ) : (
              <div className="aspect-video w-full max-w-3xl rounded-lg border border-slate-800 bg-slate-800/60 flex items-center justify-center text-slate-500 text-[13px]">
                视频预览
              </div>
            )}
          </div>
        </div>

        {/* 右侧 Shot 列表 */}
        <aside className="border-l border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/40 overflow-y-auto">
          <div className="p-4 border-b border-slate-200 dark:border-slate-800">
            <div className="text-[10.5px] font-mono tracking-[0.14em] uppercase text-slate-500 dark:text-slate-400">镜头索引</div>
          </div>
          {shots.length === 0 ? (
            <div className="p-6 text-center text-[12.5px] text-slate-500 dark:text-slate-400">
              这条素材还没分镜。<br />
              <span className="text-[11px] font-mono tracking-wider uppercase mt-2 inline-block">分镜管线接入中</span>
            </div>
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800/80">
              {shots.map((s) => (
                <li key={s.id}>
                  <button
                    onClick={() => setLocation(openDetail)}
                    className="w-full text-left px-4 py-3 hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-[11px] tracking-wider uppercase text-slate-500 dark:text-slate-400">
                        #{String(s.shotIndex).padStart(2, "0")} · {formatTimeRange(s.startSec, s.endSec)}
                      </span>
                      {s.isFavorite && <Star className="w-3 h-3 text-amber-500" strokeWidth={1.5} fill="currentColor" />}
                    </div>
                    <p className="mt-1.5 text-[13px] leading-relaxed text-slate-700 dark:text-slate-300 line-clamp-2">{s.description}</p>
                    {s.usageTags.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {s.usageTags.map((t) => (
                          <span
                            key={t}
                            className="text-[10.5px] font-mono px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400"
                          >
                            {t}
                          </span>
                        ))}
                      </div>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// shot-detail: 单镜头的详情(stub)

function ShotDetailScreen() {
  const { setLocation } = useApp();
  const backToShotList: AppLocation = { module: "library", screen: "shot-list" };
  return (
    <div className="flex-1 flex flex-col bg-slate-50 dark:bg-[#0A0A0B] overflow-hidden">
      <header className="border-b border-slate-200 dark:border-slate-800 bg-white/70 dark:bg-slate-900/40 px-8 py-4 shrink-0">
        <button
          onClick={() => setLocation(backToShotList)}
          className="inline-flex items-center gap-1.5 h-8 px-2 rounded-md text-[13px] text-slate-600 dark:text-slate-300 hover:bg-slate-200/60 dark:hover:bg-slate-800/60"
        >
          <ArrowLeft className="w-3.5 h-3.5" strokeWidth={1.5} />
          返回镜头列表
        </button>
      </header>
      <main className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-8 py-12 text-[13.5px] text-slate-600 dark:text-slate-400">
          镜头详情视图即将上线: 放大预览 / 完整字幕 / 用途建议 / 相似镜头 / 被引用记录。
        </div>
      </main>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// utils

function pad2(n: number) {
  return n < 10 ? `0${n}` : `${n}`;
}

function formatDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${pad2(r)}`;
}

function formatTimeRange(start: number, end: number): string {
  return `${formatDuration(start)} – ${formatDuration(end)}`;
}
