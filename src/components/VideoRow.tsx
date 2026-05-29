// 可复用的视频行(内容库「其他视频」/ 收藏夹详情 / 关联视频 picker 共用)。
// 样式对齐 VideoScreen 列表行:1px 边卡片内的 divide 行,缩略图 + 标题 + mono 元数据。
import { type FunctionComponent, type ReactNode } from "react";
import { Film } from "lucide-react";
import type { Video, Analysis } from "../types";

export const PLATFORM_LABEL: Record<string, string> = {
  bilibili: "B站", douyin: "抖音", xiaohongshu: "小红书", youtube: "YouTube", tiktok: "TikTok",
};

export function formatDuration(sec: number) {
  if (!Number.isFinite(sec) || sec <= 0) return "—";
  const m = Math.floor(sec / 60);
  const s = Math.round(sec - m * 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function formatCount(n?: number) {
  if (n == null) return null;
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万`;
  return String(n);
}

export const VideoRow: FunctionComponent<{
  video: Video;
  accountName?: string | null;
  analyses?: Analysis[];
  onClick?: () => void;
  right?: ReactNode;
}> = ({ video, accountName, analyses, onClick, right }) => {
  const contentCount = (analyses || []).filter((a) => a.pipelineId === "builtin-content").length;
  const pipelineCount = (analyses || []).filter((a) => a.pipelineId === "builtin-pipeline").length;
  return (
    <div
      onClick={onClick}
      className={`flex items-center gap-3.5 px-4 py-3 ${onClick ? "cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/40" : ""}`}
    >
      <div className="w-[72px] h-[48px] rounded bg-slate-200 dark:bg-slate-800 shrink-0 overflow-hidden flex items-center justify-center">
        {video.thumbnailUrl
          ? <img src={video.thumbnailUrl} alt="" referrerPolicy="no-referrer" className="w-full h-full object-cover" />
          : <Film className="w-4 h-4 text-slate-400" strokeWidth={1.5} />}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[13.5px] font-medium text-slate-900 dark:text-slate-100 truncate">{video.title}</div>
        <div className="text-[10.5px] font-mono text-slate-500 dark:text-slate-400 mt-0.5 flex items-center gap-2 flex-wrap">
          <span>{formatDuration(video.durationSec)}</span>
          {video.platform && <span>{PLATFORM_LABEL[video.platform] || video.platform}</span>}
          {accountName && <span>· {accountName}</span>}
          {formatCount(video.viewCount) && <span>· {formatCount(video.viewCount)}播放</span>}
          {contentCount > 0 && <span className="px-1.5 py-0.5 rounded bg-sky-50 dark:bg-sky-900/30 text-sky-700 dark:text-sky-300">内容×{contentCount}</span>}
          {pipelineCount > 0 && <span className="px-1.5 py-0.5 rounded bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300">拆解×{pipelineCount}</span>}
        </div>
      </div>
      {right && <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>{right}</div>}
    </div>
  );
}

/** 1px 边的列表容器(包 VideoRow,divide 分隔)。 */
export function VideoRowList({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#14151a] overflow-hidden divide-y divide-slate-100 dark:divide-slate-800/80">
      {children}
    </div>
  );
}
