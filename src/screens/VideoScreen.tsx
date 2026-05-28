import React, { type FunctionComponent, type ReactNode, useMemo, useState } from "react";
import { useApp } from "../AppContext";
import type { Video, Analysis, AppLocation } from "../types";
import {
  Film, Search, Trash2, Play, ChevronRight, ArrowLeft, ExternalLink,
  BarChart3, Sparkles, Clock, CheckCircle2, XCircle, Loader2,
} from "lucide-react";
import { useConfirm } from "../components/ConfirmDialog";

export function VideoScreen() {
  const { currentLocation } = useApp();
  if (currentLocation.module !== "video") return null;
  if (currentLocation.screen === "detail") return <VideoDetailScreen />;
  return <VideoListScreen />;
}

function formatDuration(sec: number) {
  if (!Number.isFinite(sec) || sec <= 0) return "—";
  const m = Math.floor(sec / 60);
  const s = Math.round(sec - m * 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function formatCount(n?: number) {
  if (n == null) return null;
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万`;
  return String(n);
}

function formatDate(iso?: string) {
  if (!iso) return "—";
  const d = new Date(iso);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${m}-${dd} ${hh}:${mm}`;
}

const PLATFORM_LABEL: Record<string, string> = {
  bilibili: "B站", douyin: "抖音", xiaohongshu: "小红书", youtube: "YouTube", tiktok: "TikTok",
};

// ─────────────────────────────────────────────
// 视频列表
function VideoListScreen() {
  const { videos, accounts, analysesByVideo, setLocation, setActiveVideoId, removeVideo } = useApp();
  const confirm = useConfirm();
  const [query, setQuery] = useState("");
  const [platformFilter, setPlatformFilter] = useState<string | null>(null);
  const [sort, setSort] = useState<"updated" | "views" | "likes">("updated");

  const accountMap = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);

  const filtered = useMemo(() => {
    let list = [...videos];
    if (platformFilter) list = list.filter((v) => v.platform === platformFilter);
    if (query) {
      const q = query.toLowerCase();
      list = list.filter((v) => v.title.toLowerCase().includes(q) || v.platform?.toLowerCase().includes(q));
    }
    if (sort === "views") list.sort((a, b) => (b.viewCount ?? 0) - (a.viewCount ?? 0));
    else if (sort === "likes") list.sort((a, b) => (b.likeCount ?? 0) - (a.likeCount ?? 0));
    else list.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    return list;
  }, [videos, platformFilter, query, sort]);

  const platforms = useMemo(() => {
    const s = new Set(videos.map((v) => v.platform).filter(Boolean));
    return Array.from(s) as string[];
  }, [videos]);

  const handleDelete = async (videoId: string) => {
    const ok = await confirm({ title: "删除视频", description: "视频及其所有分析记录、磁盘文件将被永久删除。", confirmLabel: "删除", destructive: true });
    if (!ok) return;
    removeVideo(videoId);
  };

  const openDetail = (videoId: string) => {
    setActiveVideoId(videoId);
    setLocation({ module: "video", screen: "detail" });
  };

  return (
    <div className="flex-1 flex flex-col bg-slate-50 dark:bg-[#0A0A0B] overflow-hidden">
      <header className="border-b border-slate-200 dark:border-slate-800 bg-white/70 dark:bg-slate-900/40 px-8 py-5 shrink-0">
        <div className="max-w-6xl mx-auto">
          <div className="text-[10.5px] font-mono tracking-[0.14em] uppercase text-slate-500 dark:text-slate-400">
            视频管理 · VIDEOS
          </div>
          <div className="flex items-baseline gap-3 mt-1.5">
            <h1 className="text-[22px] font-semibold tracking-tight text-slate-900 dark:text-slate-100">所有视频</h1>
            <span className="text-[11.5px] font-mono text-slate-500 dark:text-slate-400">{videos.length} 条</span>
          </div>
          <div className="flex items-center gap-2 mt-4">
            {platforms.map((p) => (
              <button
                key={p}
                onClick={() => setPlatformFilter(platformFilter === p ? null : p)}
                className={`h-7 px-3 rounded-full border text-[12px] transition-colors ${
                  platformFilter === p
                    ? "bg-indigo-50 dark:bg-indigo-950/40 border-indigo-200 dark:border-indigo-800/50 text-indigo-700 dark:text-indigo-300"
                    : "bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
                }`}
              >
                {PLATFORM_LABEL[p] || p}
              </button>
            ))}
            <div className="flex-1" />
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as typeof sort)}
              className="h-7 px-2 text-[12px] rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300"
            >
              <option value="updated">最近更新</option>
              <option value="views">播放量</option>
              <option value="likes">点赞数</option>
            </select>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-400" strokeWidth={1.5} />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索视频"
                className="h-7 pl-7 pr-3 text-[12px] w-48 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:focus:ring-indigo-900/40"
              />
            </div>
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto">
        <div className="max-w-6xl mx-auto px-8 py-6">
          {filtered.length === 0 ? (
            <div className="text-center py-16 text-[13px] text-slate-500">
              <Film className="w-10 h-10 mx-auto mb-3 text-slate-300 dark:text-slate-600" strokeWidth={1} />
              {videos.length === 0 ? "还没有视频。从首页粘贴链接或从账号页拉取。" : "没有匹配的视频"}
            </div>
          ) : (
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#14151a] overflow-hidden divide-y divide-slate-100 dark:divide-slate-800/80">
              {filtered.map((v) => {
                const acc = v.accountId ? accountMap.get(v.accountId) : null;
                const analyses = analysesByVideo[v.id] || [];
                const contentCount = analyses.filter((a) => a.pipelineId === "builtin-content").length;
                const pipelineCount = analyses.filter((a) => a.pipelineId === "builtin-pipeline").length;
                return (
                  <div
                    key={v.id}
                    onClick={() => openDetail(v.id)}
                    className="flex items-center gap-3.5 px-4 py-3 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/40"
                  >
                    <div className="w-[72px] h-[48px] rounded bg-slate-200 dark:bg-slate-800 shrink-0 overflow-hidden flex items-center justify-center">
                      {v.thumbnailUrl
                        ? <img src={v.thumbnailUrl} alt="" referrerPolicy="no-referrer" className="w-full h-full object-cover" />
                        : <Film className="w-4 h-4 text-slate-400" strokeWidth={1.5} />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-[13.5px] font-medium text-slate-900 dark:text-slate-100 truncate">{v.title}</div>
                      <div className="text-[10.5px] font-mono text-slate-500 dark:text-slate-400 mt-0.5 flex items-center gap-2 flex-wrap">
                        <span>{formatDuration(v.durationSec)}</span>
                        {v.platform && <span>{PLATFORM_LABEL[v.platform] || v.platform}</span>}
                        {acc && <span>· {acc.name}</span>}
                        {formatCount(v.viewCount) && <span>· {formatCount(v.viewCount)}播放</span>}
                        {contentCount > 0 && <span className="px-1.5 py-0.5 rounded bg-sky-50 dark:bg-sky-900/30 text-sky-700 dark:text-sky-300">内容×{contentCount}</span>}
                        {pipelineCount > 0 && <span className="px-1.5 py-0.5 rounded bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300">拆解×{pipelineCount}</span>}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                      <button onClick={() => handleDelete(v.id)} title="删除视频" className="w-7 h-7 rounded-md flex items-center justify-center text-slate-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:text-rose-400 dark:hover:bg-rose-900/30">
                        <Trash2 className="w-3.5 h-3.5" strokeWidth={1.5} />
                      </button>
                    </div>
                    <ChevronRight className="w-3.5 h-3.5 text-slate-400 shrink-0" strokeWidth={1.5} />
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

// ─────────────────────────────────────────────
// 视频详情
function VideoDetailScreen() {
  const { activeVideoId, videos, accounts, analysesByVideo, setLocation, setActiveVideoId, setActiveAnalysisId, removeVideo, startAnalysis } = useApp();
  const confirm = useConfirm();
  const video = videos.find((v) => v.id === activeVideoId);
  if (!video) {
    return (
      <div className="flex-1 flex items-center justify-center text-slate-500">
        <button onClick={() => setLocation({ module: "video", screen: "list" })} className="underline">返回视频列表</button>
      </div>
    );
  }

  const account = video.accountId ? accounts.find((a) => a.id === video.accountId) : null;
  const analyses = analysesByVideo[video.id] || [];
  const contentAnalyses = analyses.filter((a) => a.pipelineId === "builtin-content");
  const pipelineAnalyses = analyses.filter((a) => a.pipelineId === "builtin-pipeline");

  const goBack = () => setLocation({ module: "video", screen: "list" });

  const openAnalysis = (analysisId: string) => {
    setActiveVideoId(video.id);
    setActiveAnalysisId(analysisId);
    setLocation({ module: "analysis", screen: "report" });
  };

  const handleDelete = async () => {
    const ok = await confirm({ title: "删除视频", description: "视频及其所有分析记录将被永久删除。", confirmLabel: "删除", destructive: true });
    if (!ok) return;
    removeVideo(video.id);
    goBack();
  };

  const handleStartAnalysis = (pipelineId: string) => {
    startAnalysis(video.id, pipelineId);
  };

  return (
    <div className="flex-1 flex flex-col bg-slate-50 dark:bg-[#0A0A0B] overflow-hidden">
      <header className="border-b border-slate-200 dark:border-slate-800 bg-white/70 dark:bg-slate-900/40 px-8 py-5 shrink-0">
        <div className="max-w-6xl mx-auto">
          <button onClick={goBack} className="inline-flex items-center gap-1.5 text-[12.5px] text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 mb-3">
            <ArrowLeft className="w-3.5 h-3.5" strokeWidth={1.5} />返回列表
          </button>
          <div className="flex items-start gap-5">
            <div className="w-[120px] h-[80px] rounded-lg bg-slate-200 dark:bg-slate-800 shrink-0 overflow-hidden">
              {video.thumbnailUrl
                ? <img src={video.thumbnailUrl} alt="" referrerPolicy="no-referrer" className="w-full h-full object-cover" />
                : <div className="w-full h-full flex items-center justify-center"><Film className="w-6 h-6 text-slate-400" /></div>}
            </div>
            <div className="flex-1 min-w-0">
              <h1 className="text-[20px] font-semibold tracking-tight text-slate-900 dark:text-slate-100 leading-snug">{video.title}</h1>
              <div className="text-[11.5px] font-mono text-slate-500 dark:text-slate-400 mt-1.5 flex items-center gap-3 flex-wrap">
                <span>{formatDuration(video.durationSec)}</span>
                {video.platform && <span>{PLATFORM_LABEL[video.platform] || video.platform}</span>}
                {formatCount(video.viewCount) && <span>{formatCount(video.viewCount)}播放</span>}
                {formatCount(video.likeCount) && <span>{formatCount(video.likeCount)}赞</span>}
                {formatCount(video.commentCount) && <span>{formatCount(video.commentCount)}评</span>}
                {account && (
                  <button
                    onClick={() => { setLocation({ module: "account", screen: "detail" }); }}
                    className="text-indigo-600 dark:text-indigo-400 hover:underline"
                  >
                    {account.name}
                  </button>
                )}
              </div>
            </div>
            <div className="flex gap-2 shrink-0">
              <button
                onClick={() => handleStartAnalysis("builtin-content")}
                className="h-8 px-3 rounded-md text-[12.5px] border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1.5"
              >
                <Sparkles className="w-3 h-3" strokeWidth={2} />内容分析
              </button>
              <button
                onClick={() => handleStartAnalysis("builtin-pipeline")}
                className="h-8 px-3 rounded-md text-[12.5px] bg-indigo-600 hover:bg-indigo-700 text-white inline-flex items-center gap-1.5"
              >
                <BarChart3 className="w-3 h-3" strokeWidth={2} />结构拆解
              </button>
              <button onClick={handleDelete} title="删除视频" className="h-8 w-8 rounded-md flex items-center justify-center text-slate-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:text-rose-400 dark:hover:bg-rose-900/30 border border-slate-200 dark:border-slate-700">
                <Trash2 className="w-3.5 h-3.5" strokeWidth={1.5} />
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto">
        <div className="max-w-6xl mx-auto px-8 py-6 space-y-6">
          {/* 内容分析记录 */}
          <AnalysisGroup
            title="内容分析"
            icon={<Sparkles className="w-4 h-4" strokeWidth={1.5} />}
            analyses={contentAnalyses}
            onOpen={openAnalysis}
            emptyHint="还没有内容分析记录"
            renderPreview={(a) => {
              const result = a.result as any;
              return result?.topic ? <span className="text-slate-600 dark:text-slate-300">{result.topic}</span> : null;
            }}
          />

          {/* 结构拆解记录 */}
          <AnalysisGroup
            title="结构拆解"
            icon={<BarChart3 className="w-4 h-4" strokeWidth={1.5} />}
            analyses={pipelineAnalyses}
            onOpen={openAnalysis}
            emptyHint="还没有结构拆解记录"
            renderPreview={(a) => {
              const result = a.result as any;
              const nodeCount = result?.nodes?.length;
              return nodeCount ? <span className="text-slate-600 dark:text-slate-300">{nodeCount} 个节点</span> : null;
            }}
          />
        </div>
      </main>
    </div>
  );
}

// ─────────────────────────────────────────────
// 分析记录分组卡片
const AnalysisGroup: FunctionComponent<{
  title: string;
  icon: ReactNode;
  analyses: Analysis[];
  onOpen: (id: string) => void;
  emptyHint: string;
  renderPreview: (a: Analysis) => ReactNode;
}> = ({ title, icon, analyses, onOpen, emptyHint, renderPreview }) => {
  const { removeVideo } = useApp();

  const handleDeleteAnalysis = async (analysisId: string) => {
    if (!window.videoAnalyzer) return;
    await window.videoAnalyzer.deleteAnalysis(analysisId);
  };

  const statusIcon = (status: string) => {
    if (status === "completed") return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" strokeWidth={1.5} />;
    if (status === "analyzing") return <Loader2 className="w-3.5 h-3.5 text-indigo-600 animate-spin" strokeWidth={1.5} />;
    if (status === "failed") return <XCircle className="w-3.5 h-3.5 text-rose-500" strokeWidth={1.5} />;
    return <Clock className="w-3.5 h-3.5 text-slate-400" strokeWidth={1.5} />;
  };

  return (
    <section>
      <div className="flex items-center gap-2 mb-2">
        <span className="text-slate-600 dark:text-slate-400">{icon}</span>
        <h2 className="text-[14px] font-semibold text-slate-900 dark:text-slate-100">{title}</h2>
        <span className="text-[11px] font-mono text-slate-400">{analyses.length}</span>
      </div>
      {analyses.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-200 dark:border-slate-700 px-4 py-6 text-center text-[12.5px] text-slate-500">{emptyHint}</div>
      ) : (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#14151a] overflow-hidden divide-y divide-slate-100 dark:divide-slate-800/80">
          {analyses.map((a) => (
            <div
              key={a.id}
              onClick={() => a.status === "completed" && onOpen(a.id)}
              className={`flex items-center gap-3 px-4 py-2.5 ${a.status === "completed" ? "cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/40" : ""}`}
            >
              {statusIcon(a.status)}
              <div className="flex-1 min-w-0">
                <div className="text-[12.5px] text-slate-700 dark:text-slate-300 flex items-center gap-2">
                  <span>{formatDate(a.createdAt)}</span>
                  {a.durationMs && <span className="text-slate-400">· {(a.durationMs / 1000).toFixed(0)}s</span>}
                  {renderPreview(a)}
                </div>
                {a.errorMessage && <div className="text-[11px] text-rose-500 mt-0.5 truncate">{a.errorMessage}</div>}
              </div>
              <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                <button onClick={() => handleDeleteAnalysis(a.id)} title="删除分析记录" className="w-6 h-6 rounded flex items-center justify-center text-slate-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-900/30">
                  <Trash2 className="w-3 h-3" strokeWidth={1.5} />
                </button>
              </div>
              {a.status === "completed" && <ChevronRight className="w-3 h-3 text-slate-400 shrink-0" strokeWidth={1.5} />}
            </div>
          ))}
        </div>
      )}
    </section>
  );
};
