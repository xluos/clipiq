import { useApp } from "../AppContext";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ArrowLeft, CheckCircle2, Download, FileText, AlertTriangle, Search, RefreshCw } from "lucide-react";
import { formatTime } from "@/lib/utils";
import { useEffect, useMemo, useRef, useState, type FC, type PointerEvent as ReactPointerEvent } from "react";
import type { ExportFormat } from "../electron-api";
import type { AnalysisNode, AnalysisTiming, DanmakuReport, VideoGenre, MethodologyTag, MethodologyMiss } from "../types";
import { useVideoFrames } from "@/lib/use-video-frames";

const REPORT_SECTIONS = [
  { id: "summary", label: "整体摘要" },
  { id: "structure", label: "结构拆解" },
  { id: "methodology", label: "方法论诊断" },
  { id: "emotion", label: "情感曲线" },
  { id: "audience", label: "观众反应" },
  { id: "pacing", label: "节奏分析" },
  { id: "editing", label: "剪辑风格" },
  { id: "composition", label: "构图特点" },
  { id: "takeaways", label: "核心洞察" },
] as const;

// 弹幕情绪 → 颜色 (与 WorkspaceScreen 保持一致)
const AUDIENCE_EMOTION_COLORS: Record<string, string> = {
  joy: "#f59e0b",
  surprise: "#06b6d4",
  anger: "#ef4444",
  sadness: "#3b82f6",
  disgust: "#84cc16",
  neutral: "#94a3b8",
};

const STAGE_PALETTE = [
  "from-indigo-500 to-indigo-400",
  "from-violet-500 to-violet-400",
  "from-sky-500 to-sky-400",
  "from-emerald-500 to-emerald-400",
  "from-amber-500 to-amber-400",
  "from-rose-500 to-rose-400",
  "from-fuchsia-500 to-fuchsia-400",
  "from-teal-500 to-teal-400",
];

const STAGE_LABELS: Record<string, string> = {
  inspect: "视频解析",
  metadata: "视频解析",
  probe: "视频解析",
  download: "素材下载",
  fetch: "素材下载",
  transcribe: "语音转写",
  audio: "语音转写",
  asr: "语音转写",
  keyframe: "关键帧抽取",
  frames: "关键帧抽取",
  extract: "关键帧抽取",
  llm: "模型分析",
  analyze: "模型分析",
  analysis: "模型分析",
  methodology: "方法论评估",
  audit: "方法论评估",
  postprocess: "后处理",
  finalize: "后处理",
  export: "导出整理",
};

function humanStage(name: string) {
  const key = name.toLowerCase();
  if (STAGE_LABELS[key]) return STAGE_LABELS[key];
  for (const k of Object.keys(STAGE_LABELS)) {
    if (key.includes(k)) return STAGE_LABELS[k];
  }
  return name;
}

const GENRE_LABELS: Record<VideoGenre, string> = {
  vlog: "Vlog",
  review: "测评 / 产品",
  travel: "风景 / 旅拍",
  tutorial: "教程 / 演示",
  knowledge: "知识 / 科普",
  documentary: "纪录片 / 专题",
  "short-drama": "短剧 / 剧情",
  other: "其他",
};

const LENGTH_LABELS: Record<string, string> = {
  short: "短视频（<60s）",
  mid: "中视频（1-3min）",
  long: "中长视频（3-10min）",
  deep: "深度长视频（10min+）",
};

const CATEGORY_LABELS: Record<string, string> = {
  hook: "钩子",
  structure: "结构",
  pacing: "节奏",
  engagement: "留存",
  sound: "声画",
  density: "信息密度",
  completion: "完播",
  visual: "视觉",
};

function formatDuration(ms: number) {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(2)} s`;
  const m = Math.floor(ms / 60000);
  const s = ((ms % 60000) / 1000).toFixed(1);
  return `${m}m ${s}s`;
}

export function ReportScreen() {
  const { setCurrentScreen, reportByProject, activeProjectId, projects, setProjects, nodesByProject, providers } = useApp();
  const [exportStatus, setExportStatus] = useState("");
  const [activeSection, setActiveSection] = useState<string>("summary");
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const project = projects.find(p => p.id === activeProjectId);
  const report = reportByProject[activeProjectId || ""];
  const nodes = nodesByProject[activeProjectId || ""] || [];
  const provider = providers.find(p => p.id === project?.providerId);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    // Scroll-spy: pick the last section whose top has crossed the activation
    // line; if scrolled to bottom, force-select the last section so short
    // trailing sections never get out-shadowed by taller earlier ones.
    const ACTIVATION_OFFSET = 96;
    const BOTTOM_EPSILON = 4;

    type SectionEntry = { id: string; el: HTMLElement };
    const sectionEls: SectionEntry[] = [];
    for (const { id } of REPORT_SECTIONS) {
      const el = container.querySelector(`#${id}`) as HTMLElement | null;
      if (el) sectionEls.push({ id, el });
    }

    if (sectionEls.length === 0) return;

    const update = () => {
      if (container.scrollTop + container.clientHeight >= container.scrollHeight - BOTTOM_EPSILON) {
        setActiveSection(sectionEls[sectionEls.length - 1].id);
        return;
      }
      const activationLine = container.scrollTop + ACTIVATION_OFFSET;
      let active = sectionEls[0].id;
      for (const { id, el } of sectionEls) {
        if (el.offsetTop <= activationLine) active = id;
        else break;
      }
      setActiveSection(active);
    };

    update();
    container.addEventListener("scroll", update, { passive: true });
    const resizeObserver = new ResizeObserver(update);
    resizeObserver.observe(container);
    sectionEls.forEach(({ el }) => resizeObserver.observe(el));

    return () => {
      container.removeEventListener("scroll", update);
      resizeObserver.disconnect();
    };
  }, [report]);

  const scrollToSection = (id: string) => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const target = container.querySelector(`#${id}`) as HTMLElement | null;
    if (!target) return;
    container.scrollTo({ top: target.offsetTop - 24, behavior: "smooth" });
    setActiveSection(id);
  };

  if (!project || !report) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center bg-slate-50 dark:bg-[#0A0A0B]">
        <FileText className="w-16 h-16 text-slate-300 dark:text-slate-700 mb-4" />
        <h2 className="text-xl font-semibold text-slate-700 dark:text-slate-300">暂无项目或报告数据</h2>
        <p className="text-sm text-slate-500 mt-2">请先完成视频分析以生成报告</p>
        <Button className="mt-6" onClick={() => setCurrentScreen("home")}>
          返回首页
        </Button>
      </div>
    );
  }

  const keyNodes = nodes.filter(n => n.isHighlight || n.nodeTypes.includes('emotion_turn'));

  const reportTitle = (() => {
    const rawName = (project.videoName || "").trim();
    const cleaned = rawName.replace(/\.[a-z0-9]{2,5}$/i, "").replace(/[_-]+/g, " ").trim();
    if (cleaned && !/^未命名/i.test(cleaned)) return cleaned;
    const highlight = nodes.find(n => n.isHighlight) || nodes[0];
    if (highlight?.title) return highlight.title;
    const sentence = (report.summary || "").trim().split(/[。!?\n]/)[0];
    if (sentence) return sentence.slice(0, 28);
    return "视频分析报告";
  })();

  const reportSubtitle = (() => {
    const bits: string[] = [];
    bits.push(`${formatTime(project.durationSec)} · ${project.orientation === "portrait" ? "竖屏" : project.orientation === "square" ? "方形" : "横屏"}`);
    if (project.source.type === "url") {
      const u = project.source.url.replace(/^https?:\/\//, "");
      bits.push(u.length > 40 ? u.slice(0, 40) + "…" : u);
    }
    if (report.methodologyAudit) {
      const genreLabel = GENRE_LABELS[report.methodologyAudit.detectedGenre];
      if (genreLabel) bits.push(genreLabel);
    }
    return bits.join(" · ");
  })();

  const totalDuration = Math.max(project.durationSec || 0, 1);
  const sortedHighlights = nodes.filter(n => n.isHighlight).sort((a, b) => a.startSec - b.startSec);
  const firstHighlight = sortedHighlights[0];
  const lastHighlight = sortedHighlights[sortedHighlights.length - 1];
  const hookEnd = nodes[0] ? Math.min(nodes[0].endSec, totalDuration * 0.2) : totalDuration * 0.1;
  const climaxStart = lastHighlight ? Math.max(lastHighlight.startSec, totalDuration * 0.55) : totalDuration * 0.7;
  const climaxEnd = lastHighlight ? Math.min(lastHighlight.endSec + 1, totalDuration * 0.95) : totalDuration * 0.9;
  const turnPoint = firstHighlight
    ? Math.max(hookEnd + (totalDuration - hookEnd) * 0.2, firstHighlight.startSec - 1)
    : (hookEnd + climaxStart) / 2;
  const turnEnd = Math.max(turnPoint + Math.max(totalDuration * 0.06, 2), climaxStart);

  const rawBoundaries = [0, hookEnd, turnPoint, turnEnd, climaxEnd, totalDuration];
  const boundaries: number[] = [];
  for (const value of rawBoundaries) {
    const next = Math.min(Math.max(value, boundaries[boundaries.length - 1] ?? 0), totalDuration);
    boundaries.push(next);
  }

  // v2: 结构段从 5 装饰色改成命中/非命中两态。
  // 命中 = 该段时间区间内有高光节点 → accent-soft。非命中 → muted。
  // 这样和方法论审计结果呼应,装饰色不再和情绪用色撞车 (chat 建议 + DESIGN.md "no decorative palette spam")
  const segmentHasHighlight = (segStart: number, segEnd: number) =>
    nodes.some((n) => n.isHighlight && n.startSec >= segStart && n.startSec < segEnd);

  const segmentDefs = [
    { key: "hook",        label: "开头引子", detail: report.structure?.hook,        highlighted: segmentHasHighlight(boundaries[0], boundaries[1]) },
    { key: "development", label: "发展",     detail: report.structure?.development, highlighted: segmentHasHighlight(boundaries[1], boundaries[2]) },
    { key: "turn",        label: "转折",     detail: report.structure?.turn,        highlighted: segmentHasHighlight(boundaries[2], boundaries[3]) },
    { key: "climax",      label: "高潮",     detail: report.structure?.climax,      highlighted: segmentHasHighlight(boundaries[3], boundaries[4]) },
    { key: "ending",      label: "结尾",     detail: report.structure?.ending,      highlighted: segmentHasHighlight(boundaries[4], boundaries[5]) },
  ].map((d) => ({
    ...d,
    tone: d.highlighted
      ? "bg-indigo-50 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300 border-indigo-100 dark:border-indigo-800/50"
      : "bg-slate-50 dark:bg-slate-800/40 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700",
  })) as ReadonlyArray<{ key: string; label: string; detail?: string; highlighted: boolean; tone: string }>;

  const rawSegments = segmentDefs.map((def, index) => {
    const start = boundaries[index];
    const end = boundaries[index + 1];
    const width = Math.max(((end - start) / totalDuration) * 100, 4);
    return { ...def, width };
  });
  const totalWidth = rawSegments.reduce((sum, seg) => sum + seg.width, 0) || 1;
  const normalizedSegments = rawSegments.map((seg) => ({ ...seg, width: (seg.width / totalWidth) * 100 }));

  const handleReanalyzeWithGenre = (genre: VideoGenre | "auto") => {
    if (!project) return;
    setProjects((prev) =>
      prev.map((p) =>
        p.id === project.id
          ? {
              ...p,
              analysisOptions: {
                ...(p.analysisOptions || { mode: "standard", density: "standard", focus: "all" }),
                manualGenre: genre,
              },
              updatedAt: new Date().toISOString(),
            }
          : p
      )
    );
    setCurrentScreen("prepare");
  };

  const audit = report.methodologyAudit;
  const highlightCount = nodes.filter(n => n.isHighlight).length;
  const violationCount = audit?.violations?.length ?? 0;
  const hitCount = audit?.hits?.length ?? 0;
  const overallScore = audit?.overallScore;
  const heroSentence = (report.globalSummary || report.summary || "").trim().split(/[。!?\n]/)[0];
  const heroChips = [
    audit?.detectedGenre ? GENRE_LABELS[audit.detectedGenre] : null,
    nodes.length > 0 ? `${nodes.length} 个节点` : null,
    highlightCount > 0 ? `${highlightCount} 个高光` : null,
    violationCount > 0 ? `${violationCount} 处违反` : null,
  ].filter((x): x is string => Boolean(x));

  const handleExport = async (format: ExportFormat) => {
    if (!project || !report) return;
    setExportStatus("");
    if (window.videoAnalyzer) {
      const result = await window.videoAnalyzer.exportProject({ project, nodes, report, provider, format });
      if (!result.canceled) setExportStatus(`已导出到 ${result.filePath}`);
      return;
    }

    const payload = format === "json"
      ? JSON.stringify({ project, nodes, report, provider, exportedAt: new Date().toISOString() }, null, 2)
      : format === "csv"
        ? [
            ["start", "end", "title", "narrativeFunction", "emotionLabel", "isHighlight", "description", "note"],
            ...nodes.map(node => [formatTime(node.startSec), formatTime(node.endSec), node.title, node.narrativeFunction, node.emotionLabel, String(node.isHighlight), node.shotDescription, node.note || ""])
          ].map(row => row.map(cell => `"${String(cell).replaceAll('"', '""')}"`).join(",")).join("\n")
        : `# ${project.videoName}\n\n${report.summary}\n`;
    const blob = new Blob([payload], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${project.videoName}-analysis.${format === "markdown" ? "md" : format}`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex-1 flex h-full bg-slate-50 dark:bg-[#0A0A0B] overflow-hidden">
      {/* Report Sidebar */}
      <div className="w-56 border-r border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0E0E10] flex flex-col pt-4">
        <div className="px-4 pb-4 flex items-center space-x-2 border-b border-slate-200 dark:border-slate-800">
          <Button variant="ghost" size="icon" onClick={() => setCurrentScreen("workspace")} className="w-8 h-8 -ml-2 text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100">
            <ArrowLeft className="w-4 h-4" />
          </Button>
          <span className="font-semibold text-slate-800 dark:text-slate-200 text-sm truncate">返回工作台</span>
        </div>
        
        <div className="flex-1 overflow-y-auto p-4 space-y-1">
          {REPORT_SECTIONS.map(section => (
            <button
              key={section.id}
              type="button"
              onClick={() => scrollToSection(section.id)}
              className={`w-full text-left px-3 py-2 rounded-md text-sm transition-colors ${
                activeSection === section.id
                  ? "bg-indigo-50 dark:bg-indigo-600/20 text-indigo-600 dark:text-indigo-400 font-medium"
                  : "text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800/50"
              }`}
            >
              {section.label}
            </button>
          ))}
        </div>
      </div>

      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto px-8 pt-8 pb-16 md:px-12 flex relative">
        <div className="flex-1 max-w-4xl space-y-10 pb-32">
          <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div className="space-y-1 min-w-0">
              <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100 truncate" title={reportTitle}>
                {reportTitle}
              </h1>
              {reportSubtitle && (
                <p className="text-sm text-slate-500 dark:text-slate-400 line-clamp-1" title={reportSubtitle}>
                  {reportSubtitle}
                </p>
              )}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500 dark:text-slate-400 font-mono pt-1">
                {report.providerSnapshot?.name && (
                  <span>来源 · {report.providerSnapshot.name}</span>
                )}
                {report.providerSnapshot?.model && (
                  <span>模型 · {report.providerSnapshot.model}</span>
                )}
                {report.pipelineVersion && <span>流水线 · {report.pipelineVersion}</span>}
                {report.schemaVersion && <span>Schema · {report.schemaVersion}</span>}
                {report.generatedAt && (
                  <span>生成于 {new Date(report.generatedAt).toLocaleString()}</span>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Button variant="outline" size="sm" onClick={() => handleExport("json")} className="border-slate-200 dark:border-slate-800">JSON</Button>
              <Button variant="outline" size="sm" onClick={() => handleExport("csv")} className="border-slate-200 dark:border-slate-800">CSV</Button>
              <Button className="bg-indigo-600 hover:bg-indigo-700 text-white border-0" onClick={() => handleExport("markdown")}>
                <Download className="w-4 h-4 mr-2" />
                Markdown
              </Button>
            </div>
          </div>
          {exportStatus && <p className="text-xs text-emerald-600 dark:text-emerald-400">{exportStatus}</p>}

          {report.timings?.length ? (
            <TimingBar timings={report.timings} totalMs={report.totalDurationMs} />
          ) : null}

          {heroSentence && (
            <section className="space-y-3">
              <div className={`rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#14151a] p-6 md:p-7 grid grid-cols-1 ${typeof overallScore === "number" ? "md:grid-cols-[1fr_200px]" : ""} gap-8 items-center`}>
                <div className="min-w-0">
                  <div className="font-mono text-[10.5px] uppercase tracking-wider text-slate-500 mb-2">一句话定调</div>
                  <h2 className="text-[20px] font-semibold tracking-tight text-slate-900 dark:text-slate-100 leading-relaxed">
                    {heroSentence}
                  </h2>
                  {heroChips.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mt-4">
                      {heroChips.map((c, i) => (
                        <span key={i} className="inline-flex items-center h-6 px-2.5 rounded-full text-[11.5px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#14151a] text-slate-700 dark:text-slate-300 font-sans">
                          {c}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                {typeof overallScore === "number" && (
                  <div className="border-l border-slate-200 dark:border-slate-800 pl-6 text-center md:pl-7">
                    <div className="font-mono text-[48px] leading-none font-medium text-slate-900 dark:text-slate-100 tabular-nums tracking-tight">
                      {(overallScore / 10).toFixed(1)}
                    </div>
                    <div className="font-mono text-[10.5px] uppercase tracking-wider text-slate-500 mt-2">综合评分</div>
                  </div>
                )}
              </div>

              {(highlightCount > 0 || violationCount > 0 || hitCount > 0) && (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <FindingCard
                    label="高光节点"
                    value={String(highlightCount)}
                    hint={highlightCount > 0 ? undefined : "尚未识别高光节点"}
                  />
                  <FindingCard
                    label="方法论违反"
                    value={String(violationCount)}
                    hint={violationCount > 0 ? undefined : "未触发方法论违反"}
                    tone={violationCount > 0 ? "warn" : "default"}
                  />
                  <FindingCard
                    label="方法论命中"
                    value={String(hitCount)}
                    hint={hitCount > 0 ? undefined : "暂未命中规则"}
                  />
                </div>
              )}
            </section>
          )}

          <section id="summary" className="space-y-4 scroll-mt-6">
            <h2 className="text-lg font-semibold text-slate-800 dark:text-slate-100 border-l-4 border-indigo-500 pl-3">整体摘要</h2>
            <div className="bg-white dark:bg-[#0E0E10] border border-slate-200 dark:border-slate-800 p-6 rounded-xl shadow-sm text-slate-700 dark:text-slate-300 leading-relaxed text-sm whitespace-pre-line">
              {report.globalSummary || report.summary || "暂无整体摘要。"}
            </div>
            {report.globalSummary && report.summary && report.globalSummary !== report.summary && (
              <details className="bg-slate-50 dark:bg-slate-900/40 border border-slate-200 dark:border-slate-800 rounded-lg px-4 py-3 text-xs text-slate-500">
                <summary className="cursor-pointer select-none">主分析模型的摘要 (供对照)</summary>
                <div className="mt-2 whitespace-pre-line leading-relaxed text-slate-600 dark:text-slate-400">{report.summary}</div>
              </details>
            )}
          </section>

          <section id="structure" className="space-y-4 scroll-mt-6">
            <h2 className="text-lg font-semibold text-slate-800 dark:text-slate-100 border-l-4 border-indigo-500 pl-3">结构拆解</h2>
            <div className="bg-white dark:bg-[#0E0E10] border border-slate-200 dark:border-slate-800 p-6 rounded-xl shadow-sm space-y-6">
              <StructureTimeline
                segments={normalizedSegments.map((s, idx) => ({
                  ...s,
                  startSec: boundaries[idx],
                  endSec: boundaries[idx + 1],
                }))}
                videoSrc={project.localVideoPath}
                totalDuration={totalDuration}
              />
              <dl className="grid gap-3 text-sm md:grid-cols-2">
                {normalizedSegments.map((segment) => (
                  <div
                    key={`detail-${segment.key}`}
                    className="rounded-lg border border-slate-100 bg-slate-50/60 px-3 py-2 dark:border-slate-800 dark:bg-slate-900/40"
                  >
                    <dt className="text-xs font-semibold uppercase tracking-widest text-slate-500 dark:text-slate-400">{segment.label}</dt>
                    <dd className="mt-1 text-slate-700 dark:text-slate-300">{segment.detail || "暂无"}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </section>
          
          <section id="methodology" className="space-y-4 scroll-mt-6">
            <h2 className="text-lg font-semibold text-slate-800 dark:text-slate-100 border-l-4 border-indigo-500 pl-3">方法论诊断</h2>
            <MethodologyDiagnostics
              audit={audit}
              currentManualGenre={project.analysisOptions?.manualGenre || "auto"}
              onReanalyze={handleReanalyzeWithGenre}
              onSeekToNode={(time) => {
                window.sessionStorage.setItem(
                  "video-analyzer-pending-seek",
                  JSON.stringify({ projectId: project.id, time })
                );
                setCurrentScreen("workspace");
              }}
              nodes={nodes}
            />
          </section>

          <section id="emotion" className="space-y-4 scroll-mt-6">
            <h2 className="text-lg font-semibold text-slate-800 dark:text-slate-100 border-l-4 border-indigo-500 pl-3">情感曲线</h2>
            <div className="bg-white dark:bg-[#0E0E10] border border-slate-200 dark:border-slate-800 p-6 rounded-xl shadow-sm">
              <EmotionCurve
                nodes={nodes}
                totalDuration={totalDuration}
                onSeek={(time) => {
                  window.sessionStorage.setItem(
                    "video-analyzer-pending-seek",
                    JSON.stringify({ projectId: project.id, time })
                  );
                  setCurrentScreen("workspace");
                }}
              />
            </div>
          </section>

          <section id="pacing" className="space-y-4 scroll-mt-6">
            <h2 className="text-lg font-semibold text-slate-800 dark:text-slate-100 border-l-4 border-indigo-500 pl-3">节奏分析</h2>
            <div className="bg-white dark:bg-[#0E0E10] border border-slate-200 dark:border-slate-800 p-6 rounded-xl shadow-sm text-slate-700 dark:text-slate-300 leading-relaxed text-sm whitespace-pre-line">
              {report.pacing || "暂无节奏分析。"}
            </div>
          </section>

          <section id="editing" className="space-y-4 scroll-mt-6">
            <h2 className="text-lg font-semibold text-slate-800 dark:text-slate-100 border-l-4 border-indigo-500 pl-3">剪辑风格</h2>
            <div className="bg-white dark:bg-[#0E0E10] border border-slate-200 dark:border-slate-800 p-6 rounded-xl shadow-sm text-slate-700 dark:text-slate-300 leading-relaxed text-sm whitespace-pre-line">
              {report.editingStyle || "暂无剪辑风格分析。"}
            </div>
          </section>

          <section id="composition" className="space-y-4 scroll-mt-6">
            <h2 className="text-lg font-semibold text-slate-800 dark:text-slate-100 border-l-4 border-indigo-500 pl-3">构图特点</h2>
            <div className="bg-white dark:bg-[#0E0E10] border border-slate-200 dark:border-slate-800 p-6 rounded-xl shadow-sm text-slate-700 dark:text-slate-300 leading-relaxed text-sm whitespace-pre-line">
              {report.composition || "暂无构图分析。"}
            </div>
          </section>

          {report.danmaku && report.danmaku.totalCount > 0 && (
            <section id="audience" className="space-y-4 scroll-mt-6">
              <h2 className="text-lg font-semibold text-slate-800 dark:text-slate-100 border-l-4 border-indigo-500 pl-3">
                观众反应 · {report.danmaku.totalCount} 条弹幕
              </h2>
              <AudienceSection danmaku={report.danmaku} />
            </section>
          )}

          <section id="takeaways" className="space-y-4 scroll-mt-6">
             <h2 className="text-lg font-semibold text-slate-800 dark:text-slate-100 border-l-4 border-indigo-500 pl-3">核心洞察</h2>
             <div className="bg-white dark:bg-[#0E0E10] border border-slate-200 dark:border-slate-800 p-6 rounded-xl shadow-sm text-slate-700 dark:text-slate-300 leading-relaxed text-sm">
                {report.takeaways?.length ? (
                  <ul className="space-y-2 list-disc list-inside marker:text-indigo-500">
                    {report.takeaways.map((t, i) => (
                      <li key={i}>{t}</li>
                    ))}
                  </ul>
                ) : (
                  <p>暂无核心洞察。</p>
                )}
             </div>
          </section>

        </div>

        {/* Right Sidebar for Nodes */}
        <div className="w-72 ml-8 space-y-4 sticky top-8 self-start hidden lg:block">
          <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-200/80 uppercase tracking-widest pl-1">重点节点</h2>
          <div className="space-y-3">
            {keyNodes.length === 0 && (
              <p className="text-xs text-slate-500 dark:text-slate-400">尚未标记重点节点。</p>
            )}
            {keyNodes.slice(0,4).map(node => (
              <button
                key={node.id}
                onClick={() => {
                  window.sessionStorage.setItem("video-analyzer-pending-seek", JSON.stringify({ projectId: project.id, time: node.startSec }));
                  setCurrentScreen("workspace");
                }}
                className="flex w-full gap-3 group items-center text-left bg-white dark:bg-transparent p-2 rounded hover:bg-slate-50 dark:hover:bg-slate-800/50 transition border border-slate-100 dark:border-transparent"
              >
                <div className="w-20 h-12 rounded relative shrink-0 overflow-hidden border border-slate-200 dark:border-slate-800 bg-gradient-to-br from-slate-200 to-slate-300 dark:from-slate-800 dark:to-slate-900">
                  {node.thumbnailUrl ? (
                    <img
                      src={node.thumbnailUrl}
                      alt={node.title}
                      className="absolute inset-0 h-full w-full object-cover"
                    />
                  ) : null}
                  <div className="absolute inset-0 bg-black/10 dark:bg-black/20 group-hover:bg-black/0 transition-colors flex flex-col justify-end">
                    <span className="text-[9px] bg-black/60 text-white px-1 leading-tight w-fit m-0.5 rounded shadow-sm">
                      {formatTime(node.startSec)}
                    </span>
                  </div>
                </div>
                <div className="min-w-0">
                  <div className="text-xs font-medium text-slate-800 dark:text-slate-200 line-clamp-2 leading-snug">{node.title}</div>
                  {node.isHighlight && (
                    <div className="text-[10px] text-amber-600 dark:text-amber-400 mt-0.5">重点</div>
                  )}
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

type MethodologyDiagnosticsProps = {
  audit?: import("../types").MethodologyAudit;
  currentManualGenre: VideoGenre | "auto";
  onReanalyze: (genre: VideoGenre | "auto") => void;
  onSeekToNode: (time: number) => void;
  nodes: import("../types").AnalysisNode[];
};

function MethodologyDiagnostics({ audit, currentManualGenre, onReanalyze, onSeekToNode, nodes }: MethodologyDiagnosticsProps) {
  if (!audit) {
    return (
      <div className="bg-white dark:bg-[#0E0E10] border border-slate-200 dark:border-slate-800 p-6 rounded-xl shadow-sm text-sm text-slate-500 dark:text-slate-400">
        本次分析未生成方法论诊断结果（可能是旧版本结果或模型未启用）。重新分析后可获得按视频类型 + 时长匹配的剪辑方法论评估。
      </div>
    );
  }

  const violations = audit.violations || [];
  const misses = audit.misses || [];
  const hits = audit.hits || [];

  const findNodeWithTag = (ruleId: string) => {
    return nodes.find((n) => (n.methodologyTags || []).some((t) => t.ruleId === ruleId));
  };

  return (
    <div className="space-y-4">
      {/* 顶部：识别类型 + 时长档位 + 评分 */}
      <div className="bg-white dark:bg-[#0E0E10] border border-slate-200 dark:border-slate-800 p-6 rounded-xl shadow-sm space-y-4">
        <div className="grid gap-4 md:grid-cols-3">
          <div>
            <div className="text-xs uppercase tracking-widest text-slate-500 mb-1">识别类型</div>
            <div className="text-base font-semibold text-slate-800 dark:text-slate-100">
              {GENRE_LABELS[audit.detectedGenre] || audit.detectedGenre}
              {typeof audit.genreConfidence === "number" && (
                <span className="ml-2 text-xs font-normal text-slate-500">置信度 {(audit.genreConfidence * 100).toFixed(0)}%</span>
              )}
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
              {currentManualGenre === "auto" ? "（自动识别）" : "（用户指定）"}
            </p>
          </div>
          <div>
            <div className="text-xs uppercase tracking-widest text-slate-500 mb-1">时长档位</div>
            <div className="text-base font-semibold text-slate-800 dark:text-slate-100">
              {LENGTH_LABELS[audit.lengthBucket] || audit.lengthBucket}
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 truncate">
              规则集：{audit.appliedRuleSets.join(" + ")}
            </p>
          </div>
          <div>
            <div className="text-xs uppercase tracking-widest text-slate-500 mb-1">总评分</div>
            {typeof audit.overallScore === "number" ? (
              <>
                <div className="text-2xl font-semibold text-slate-800 dark:text-slate-100">{audit.overallScore}<span className="text-sm text-slate-500 font-normal"> / 100</span></div>
                <div className="mt-1 h-1.5 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-indigo-500 to-violet-500"
                    style={{ width: `${Math.max(2, audit.overallScore)}%` }}
                  />
                </div>
              </>
            ) : (
              <div className="text-sm text-slate-500">未评分</div>
            )}
          </div>
        </div>

        {/* 改类型 + 重新分析 */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-3 pt-4 border-t border-slate-100 dark:border-slate-800">
          <div className="text-xs text-slate-500 dark:text-slate-400 shrink-0">
            觉得识别不准？改类型重新分析：
          </div>
          <Select value={currentManualGenre} onValueChange={(value) => onReanalyze(value as VideoGenre | "auto")}>
            <SelectTrigger className="bg-slate-50 dark:bg-[#0A0A0B] border-slate-200 dark:border-slate-800 max-w-[260px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">自动识别</SelectItem>
              <SelectItem value="vlog">Vlog</SelectItem>
              <SelectItem value="review">测评 / 产品</SelectItem>
              <SelectItem value="travel">风景 / 旅拍</SelectItem>
              <SelectItem value="tutorial">教程 / 演示</SelectItem>
              <SelectItem value="knowledge">知识 / 科普</SelectItem>
              <SelectItem value="documentary">纪录片 / 专题</SelectItem>
              <SelectItem value="short-drama">短剧 / 剧情</SelectItem>
              <SelectItem value="other">其他</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="ghost" size="sm" className="text-xs text-slate-500" onClick={() => onReanalyze(currentManualGenre)}>
            <RefreshCw className="w-3.5 h-3.5 mr-1" />
            前往分析页
          </Button>
        </div>
      </div>

      {/* 做得不错的点（命中） */}
      <div className="bg-white dark:bg-[#0E0E10] border border-slate-200 dark:border-slate-800 p-6 rounded-xl shadow-sm">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100 flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-500" />
              做得不错的点 <span className="text-xs text-slate-500 font-normal">({hits.length})</span>
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">命中的方法论规则</p>
          </div>
        </div>
        {hits.length === 0 ? (
          <p className="text-xs text-slate-500 dark:text-slate-400">暂无</p>
        ) : (
          <ul className="space-y-2">
            {hits.map((h, idx) => (
              <MethodologyTagItem
                key={`h-${idx}`}
                tag={h}
                tone="hit"
                compact
                onClick={() => {
                  const node = findNodeWithTag(h.ruleId);
                  if (node) onSeekToNode(node.startSec);
                }}
                clickable={Boolean(findNodeWithTag(h.ruleId))}
              />
            ))}
          </ul>
        )}
      </div>

      {/* 可以改进的地方（违反） */}
      <div className="bg-white dark:bg-[#0E0E10] border border-slate-200 dark:border-slate-800 p-6 rounded-xl shadow-sm">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-500" />
              可以再打磨一下的地方 <span className="text-xs text-slate-500 font-normal">({violations.length})</span>
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">违反的方法论规则</p>
          </div>
        </div>
        {violations.length === 0 ? (
          <p className="text-xs text-slate-500 dark:text-slate-400">暂无</p>
        ) : (
          <ul className="space-y-3">
            {violations.map((v, idx) => (
              <MethodologyTagItem
                key={`v-${idx}`}
                tag={v}
                tone="violation"
                onClick={() => {
                  const node = findNodeWithTag(v.ruleId);
                  if (node) onSeekToNode(node.startSec);
                }}
                clickable={Boolean(findNodeWithTag(v.ruleId))}
              />
            ))}
          </ul>
        )}
      </div>

      {/* 建议补上的环节（缺失） */}
      <div className="bg-white dark:bg-[#0E0E10] border border-slate-200 dark:border-slate-800 p-6 rounded-xl shadow-sm">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100 flex items-center gap-2">
              <Search className="w-4 h-4 text-rose-500" />
              建议补上的环节 <span className="text-xs text-slate-500 font-normal">({misses.length})</span>
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">本应出现但缺失的方法论环节</p>
          </div>
        </div>
        {misses.length === 0 ? (
          <p className="text-xs text-slate-500 dark:text-slate-400">暂无</p>
        ) : (
          <ul className="space-y-3">
            {misses.map((m, idx) => (
              <MethodologyMissItem key={`m-${idx}`} miss={m} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

type MethodologyTagItemProps = {
  tag: MethodologyTag;
  tone: "hit" | "violation";
  compact?: boolean;
  onClick?: () => void;
  clickable?: boolean;
};

const MethodologyTagItem: FC<MethodologyTagItemProps> = ({ tag, tone, compact = false, onClick, clickable }) => {
  const toneClasses =
    tone === "hit"
      ? "border-emerald-200 dark:border-emerald-500/30 bg-emerald-50/40 dark:bg-emerald-500/5"
      : "border-amber-200 dark:border-amber-500/30 bg-amber-50/40 dark:bg-amber-500/5";
  return (
    <li
      onClick={clickable ? onClick : undefined}
      className={`rounded-lg border ${toneClasses} px-3 py-2 ${clickable ? "cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/40" : ""}`}
    >
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm font-medium text-slate-800 dark:text-slate-100">{tag.ruleName}</span>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800/60 text-slate-500">
          {CATEGORY_LABELS[tag.category] || tag.category}
        </span>
      </div>
      {!compact && tag.evidence && (
        <p className="text-xs text-slate-600 dark:text-slate-400 mt-1.5">
          <span className="font-medium text-slate-500 dark:text-slate-500">看到了：</span>
          {tag.evidence}
        </p>
      )}
      {tone === "violation" && tag.fixSuggestion && (
        <p className="text-xs text-slate-600 dark:text-slate-400 mt-1">
          <span className="font-medium text-amber-700 dark:text-amber-400">可以试试：</span>
          {tag.fixSuggestion}
        </p>
      )}
    </li>
  );
};

type MethodologyMissItemProps = { miss: MethodologyMiss };

const MethodologyMissItem: FC<MethodologyMissItemProps> = ({ miss }) => {
  // 虚线边框: miss 是"应有未有",没有挂在具体节点上,用虚线和 hit/violation 的实线两态视觉分离 (chat 建议)
  return (
    <li className="rounded-lg border border-dashed border-rose-300/70 dark:border-rose-500/40 bg-rose-50/40 dark:bg-rose-500/5 px-3 py-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm font-medium text-slate-800 dark:text-slate-100">{miss.ruleName}</span>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800/60 text-slate-500">
          {CATEGORY_LABELS[miss.category] || miss.category}
        </span>
      </div>
      {miss.expectedAt && (
        <p className="text-xs text-slate-600 dark:text-slate-400 mt-1.5">
          <span className="font-medium text-slate-500 dark:text-slate-500">建议补在：</span>
          {miss.expectedAt}
        </p>
      )}
      {miss.reason && (
        <p className="text-xs text-slate-600 dark:text-slate-400 mt-1">
          <span className="font-medium text-slate-500 dark:text-slate-500">为什么提它：</span>
          {miss.reason}
        </p>
      )}
      {miss.fixSuggestion && (
        <p className="text-xs text-slate-600 dark:text-slate-400 mt-1">
          <span className="font-medium text-rose-700 dark:text-rose-400">可以试试：</span>
          {miss.fixSuggestion}
        </p>
      )}
    </li>
  );
};

type EmotionCurveNode = Pick<AnalysisNode, "startSec" | "endSec" | "emotionIntensity" | "emotionLabel" | "isHighlight" | "title" | "shotDescription">;

function catmullRomPath(points: { x: number; y: number }[]): string {
  if (points.length === 0) return "";
  if (points.length === 1) return `M${points[0].x},${points[0].y}`;
  let d = `M${points[0].x.toFixed(1)},${points[0].y.toFixed(1)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] || points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] || p2;
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
  }
  return d;
}

function EmotionCurve({ nodes, totalDuration, onSeek }: { nodes: EmotionCurveNode[]; totalDuration: number; onSeek?: (time: number) => void }) {
  const [activeIdx, setActiveIdx] = useState<number | null>(null);
  if (!nodes.length) {
    return <p className="text-sm text-slate-500">尚未生成节点数据。</p>;
  }
  const width = 720;
  const height = 180;
  const padX = 32;
  const padY = 24;
  const safeDuration = Math.max(totalDuration, 1);
  const points = nodes.map((node, idx) => {
    const mid = (node.startSec + node.endSec) / 2;
    const x = padX + ((mid / safeDuration) * (width - padX * 2));
    const intensity = Math.max(0, Math.min(10, Number(node.emotionIntensity) || 0));
    const y = padY + (1 - intensity / 10) * (height - padY * 2);
    return { x, y, node, intensity, idx };
  });
  const path = catmullRomPath(points);
  const baseY = (height - padY).toFixed(1);
  const areaPath = `${path} L${points[points.length - 1].x.toFixed(1)},${baseY} L${points[0].x.toFixed(1)},${baseY} Z`;
  const gridLines = [0, 0.25, 0.5, 0.75, 1].map((p) => padY + p * (height - padY * 2));
  const active = activeIdx !== null ? points[activeIdx] : null;

  return (
    <div className="grid grid-cols-1 md:grid-cols-[1fr_220px] gap-4 items-start">
      <div className="space-y-2 min-w-0">
        <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-44">
          <defs>
            <linearGradient id="emotionGradient" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="rgb(99 102 241 / 0.4)" />
              <stop offset="100%" stopColor="rgb(99 102 241 / 0.02)" />
            </linearGradient>
          </defs>
          {gridLines.map((gy, i) => (
            <line key={i} x1={padX} x2={width - padX} y1={gy} y2={gy} stroke="rgb(148 163 184 / 0.18)" strokeWidth={1} strokeDasharray={i % 2 ? "2 4" : ""} />
          ))}
          <path d={areaPath} fill="url(#emotionGradient)" />
          <path d={path} fill="none" stroke="rgb(99 102 241)" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
          {points.map((p) => {
            const isActive = activeIdx === p.idx;
            return (
              <g key={`${p.node.title}-${p.idx}`} className="cursor-pointer" onMouseEnter={() => setActiveIdx(p.idx)} onMouseLeave={() => setActiveIdx((cur) => (cur === p.idx ? null : cur))} onClick={() => { setActiveIdx(p.idx); onSeek?.(p.node.startSec); }}>
                <circle cx={p.x} cy={p.y} r={12} fill="transparent" />
                <circle
                  cx={p.x}
                  cy={p.y}
                  r={isActive ? 6 : p.node.isHighlight ? 5 : 3.5}
                  fill={p.node.isHighlight ? "rgb(245 158 11)" : "rgb(99 102 241)"}
                  stroke="white"
                  strokeWidth={1.5}
                  className="transition-all"
                />
                {isActive && (
                  <line x1={p.x} x2={p.x} y1={padY} y2={height - padY} stroke="rgb(99 102 241 / 0.5)" strokeWidth={1} strokeDasharray="3 3" />
                )}
              </g>
            );
          })}
        </svg>
        <div className="flex justify-between text-[10px] text-slate-500 font-mono px-1">
          <span>0:00</span>
          <span>情绪强度 0-10 · 点击点位跳转</span>
          <span>{formatTime(safeDuration)}</span>
        </div>
      </div>
      <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-900/40 p-3 min-h-[160px]">
        {active ? (
          <div className="space-y-2">
            <div className="flex items-center gap-1.5">
              {active.node.isHighlight && <span className="text-amber-500 text-xs">★</span>}
              <span className="text-xs font-mono text-slate-500">{formatTime(active.node.startSec)}</span>
              <span className="text-xs text-slate-400">·</span>
              <span className="text-xs text-slate-500">情绪 {active.intensity}/10</span>
            </div>
            <p className="text-sm font-medium text-slate-800 dark:text-slate-100 line-clamp-2">{active.node.title}</p>
            <p className="text-[11px] text-emerald-600 dark:text-emerald-400">{active.node.emotionLabel}</p>
            {active.node.shotDescription && (
              <p className="text-xs text-slate-500 dark:text-slate-400 line-clamp-3 leading-relaxed">{active.node.shotDescription}</p>
            )}
            {onSeek && (
              <button
                className="text-xs text-indigo-600 dark:text-indigo-400 hover:underline"
                onClick={() => onSeek(active.node.startSec)}
              >
                跳转到此处 →
              </button>
            )}
          </div>
        ) : (
          <div className="text-xs text-slate-400 dark:text-slate-500 leading-relaxed">
            鼠标移到曲线上的点能看到对应片段的情绪标签和镜头描述，点击可跳回视频对应时间。
          </div>
        )}
      </div>
    </div>
  );
}

type StructureSegmentExt = {
  key: string;
  label: string;
  detail?: string;
  tone: string;
  width: number;
  startSec: number;
  endSec: number;
};

function StructureTimeline({ segments, videoSrc, totalDuration }: { segments: StructureSegmentExt[]; videoSrc?: string; totalDuration: number }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ x: number; time: number } | null>(null);
  const frames = useVideoFrames(videoSrc, totalDuration, 16);

  const handleMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const fraction = Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1);
    setHover({ x: fraction * rect.width, time: fraction * totalDuration });
  };

  const hoverFrame = useMemo(() => {
    if (!hover || frames.length === 0) return null;
    let best = frames[0];
    let bestDelta = Math.abs(frames[0].time - hover.time);
    for (const f of frames) {
      const d = Math.abs(f.time - hover.time);
      if (d < bestDelta) { best = f; bestDelta = d; }
    }
    return best;
  }, [hover, frames]);

  return (
    <div className="space-y-3">
      <div
        ref={containerRef}
        onPointerMove={handleMove}
        onPointerLeave={() => setHover(null)}
        className="relative"
      >
        <div className="flex h-12 rounded-lg overflow-hidden border border-slate-200 dark:border-slate-800 text-xs font-medium relative">
          {segments.map((segment) => (
            <div
              key={segment.key}
              style={{ width: `${segment.width}%` }}
              title={`${segment.label} · ${segment.detail || ""}`}
              className={`flex items-center justify-center border-r last:border-r-0 truncate px-2 ${segment.tone}`}
            >
              {segment.label}
            </div>
          ))}
        </div>
        {hover && (
          <div
            className="pointer-events-none absolute top-0 bottom-0 w-px bg-indigo-500/70"
            style={{ left: hover.x }}
          />
        )}
        {hover && hoverFrame && (
          <div
            className="pointer-events-none absolute bottom-full mb-2 -translate-x-1/2 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-1 shadow-lg z-30"
            style={{ left: Math.min(Math.max(hover.x, 80), (containerRef.current?.clientWidth || 0) - 80) }}
          >
            {hoverFrame.dataUrl ? (
              <img src={hoverFrame.dataUrl} alt="" className="block w-40 h-auto rounded" />
            ) : (
              <div className="w-40 h-24 rounded bg-slate-100 dark:bg-slate-800 animate-pulse" />
            )}
            <div className="mt-1 text-center font-mono text-[10px] text-slate-500 dark:text-slate-400">
              {formatTime(hover.time)}
            </div>
          </div>
        )}
      </div>
      <div className="flex justify-between text-[10px] text-slate-500 font-mono px-1">
        <span>0:00</span>
        <span>{formatTime(totalDuration)}</span>
      </div>
      {/* 段落帧序列 */}
      <div className="flex gap-1 h-12 rounded-md overflow-hidden bg-slate-50 dark:bg-slate-900/40 p-1">
        {segments.map((segment) => {
          const segFrames = frames.filter(f => f.time >= segment.startSec && f.time < segment.endSec);
          return (
            <div
              key={`strip-${segment.key}`}
              style={{ width: `${segment.width}%` }}
              className="flex gap-0.5 overflow-hidden"
              title={segment.label}
            >
              {segFrames.length > 0 ? segFrames.map((f) => (
                f.dataUrl ? (
                  <img key={f.time} src={f.dataUrl} alt="" className="h-full w-auto object-cover rounded-sm flex-shrink-0" />
                ) : (
                  <div key={f.time} className="h-full w-8 bg-slate-200 dark:bg-slate-800 rounded-sm flex-shrink-0 animate-pulse" />
                )
              )) : (
                <div className="h-full w-full bg-slate-200/40 dark:bg-slate-800/40 rounded-sm" />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TimingBar({ timings, totalMs }: { timings: AnalysisTiming[]; totalMs?: number }) {
  const total = totalMs || timings.reduce((acc, t) => acc + t.durationMs, 0);
  if (total <= 0) return null;

  type Aggregated = { label: string; durationMs: number; notes: string[]; stages: string[]; color: string };
  const buckets = new Map<string, Aggregated>();
  let colorIdx = 0;
  for (const t of timings) {
    const label = humanStage(t.stage);
    const existing = buckets.get(label);
    if (existing) {
      existing.durationMs += t.durationMs;
      existing.stages.push(t.stage);
      if (t.note) existing.notes.push(t.note);
    } else {
      buckets.set(label, {
        label,
        durationMs: t.durationMs,
        stages: [t.stage],
        notes: t.note ? [t.note] : [],
        color: STAGE_PALETTE[colorIdx % STAGE_PALETTE.length],
      });
      colorIdx++;
    }
  }
  const aggregated = Array.from(buckets.values()).sort((a, b) => b.durationMs - a.durationMs);

  // 合并 < 3% 的小项到「其他」, 避免色块过细 / 图例过散.
  // 只有 ≥ 2 个小项时才合并 (1 个小项合并意义不大, 直接展示)
  const SMALL_THRESHOLD = 0.03;
  const major: Aggregated[] = [];
  const minor: Aggregated[] = [];
  for (const item of aggregated) {
    if (item.durationMs / total < SMALL_THRESHOLD) minor.push(item);
    else major.push(item);
  }
  const displayed: Aggregated[] = [...major];
  if (minor.length >= 2) {
    displayed.push({
      label: `其他 (${minor.length} 项)`,
      durationMs: minor.reduce((acc, x) => acc + x.durationMs, 0),
      stages: minor.flatMap((x) => x.stages),
      notes: [
        ...minor.flatMap((x) => x.notes),
        ...minor.map((x) => `${x.label}: ${formatDuration(x.durationMs)}`),
      ],
      color: "from-slate-400 to-slate-300 dark:from-slate-600 dark:to-slate-700",
    });
  } else {
    displayed.push(...minor);
  }

  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0E0E10] p-3">
      <div className="flex items-baseline justify-between mb-2">
        <span className="text-[11px] uppercase tracking-widest text-slate-500 dark:text-slate-400">分析耗时分布</span>
        <span className="font-mono text-xs text-slate-700 dark:text-slate-200">总计 {formatDuration(total)}</span>
      </div>
      <div className="flex h-3 rounded-full overflow-hidden bg-slate-100 dark:bg-slate-800">
        {displayed.map((a) => {
          const pct = (a.durationMs / total) * 100;
          const tooltip = a.notes.length > 0
            ? `${a.label} · ${formatDuration(a.durationMs)} · ${pct.toFixed(1)}%\n${a.notes.join("\n")}`
            : `${a.label} · ${formatDuration(a.durationMs)} · ${pct.toFixed(1)}%`;
          return (
            <div
              key={a.label}
              style={{ width: `${pct}%` }}
              title={tooltip}
              className={`bg-gradient-to-r ${a.color}`}
            />
          );
        })}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
        {displayed.map((a) => {
          const pct = (a.durationMs / total) * 100;
          const tooltip = a.notes.length > 0 ? a.notes.join("\n") : undefined;
          return (
            <div
              key={a.label}
              className="flex items-center gap-1.5 text-[11px]"
              title={tooltip}
            >
              <span className={`inline-block w-2 h-2 rounded-full bg-gradient-to-r ${a.color}`} />
              <span className="text-slate-600 dark:text-slate-300">{a.label}</span>
              <span className="font-mono text-slate-400 dark:text-slate-500">{formatDuration(a.durationMs)} · {pct.toFixed(0)}%</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// 观众反应 section: 情绪分布柱状 + 词云(按 value 决定字号) + summary
function AudienceSection({ danmaku }: { danmaku: DanmakuReport }) {
  const axes = ["joy", "surprise", "anger", "sadness", "disgust"] as const;
  const axisLabelZh: Record<typeof axes[number], string> = {
    joy: "笑场",
    surprise: "惊讶",
    anger: "吐槽",
    sadness: "感伤",
    disgust: "无语",
  };

  // 整体平均情绪 (用所有非空 window 取平均)
  const totals = { joy: 0, surprise: 0, anger: 0, sadness: 0, disgust: 0 };
  let nonEmpty = 0;
  for (const w of danmaku.windows) {
    if (w.danmakuCount === 0) continue;
    nonEmpty++;
    for (const a of axes) totals[a] += w.intensities[a];
  }
  const avg = nonEmpty > 0
    ? axes.reduce((acc, a) => ({ ...acc, [a]: totals[a] / nonEmpty }), {} as Record<typeof axes[number], number>)
    : null;

  // 词云字号映射: value [min, max] → fontSize [12, 28]
  const values = danmaku.wordCloud.map((w) => w.value);
  const minV = values.length > 0 ? Math.min(...values) : 1;
  const maxV = values.length > 0 ? Math.max(...values) : 1;
  const sizeOf = (v: number) => {
    if (maxV <= minV) return 14;
    const t = (v - minV) / (maxV - minV);
    return Math.round(12 + t * 16);
  };

  return (
    <div className="bg-white dark:bg-[#0E0E10] border border-slate-200 dark:border-slate-800 p-6 rounded-xl shadow-sm space-y-6">
      {danmaku.summary && (
        <p className="text-sm text-slate-700 dark:text-slate-300 leading-relaxed">{danmaku.summary}</p>
      )}

      {avg && (
        <div className="grid grid-cols-5 gap-3">
          {axes.map((a) => {
            const v = avg[a];
            return (
              <div key={a} className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/40 p-3">
                <div className="flex items-center gap-1.5 mb-1.5">
                  <span
                    className="inline-block w-2 h-2 rounded-full"
                    style={{ background: AUDIENCE_EMOTION_COLORS[a] }}
                  />
                  <span className="text-xs text-slate-600 dark:text-slate-300">{axisLabelZh[a]}</span>
                </div>
                <div className="font-mono text-sm tabular-nums text-slate-700 dark:text-slate-200">
                  {(v * 100).toFixed(0)}%
                </div>
                <div className="mt-1.5 h-1 rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
                  <div
                    className="h-full rounded-full"
                    style={{ width: `${Math.round(v * 100)}%`, background: AUDIENCE_EMOTION_COLORS[a] }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {danmaku.wordCloud.length > 0 && (
        <div>
          <p className="text-[11px] text-slate-500 uppercase tracking-widest mb-3 font-bold">高频弹幕词</p>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-2 leading-snug">
            {danmaku.wordCloud.map((w) => (
              <span
                key={w.text}
                className="text-slate-700 dark:text-slate-300"
                style={{ fontSize: `${sizeOf(w.value)}px` }}
                title={`出现 ${w.value} 次`}
              >
                {w.text}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function FindingCard({ label, value, hint, tone = "default" }: {
  label: string;
  value: string;
  hint: string;
  tone?: "default" | "warn";
}) {
  const isWarn = tone === "warn";
  return (
    <div className={`rounded-lg border p-3.5 ${
      isWarn
        ? "border-amber-200 dark:border-amber-900/40 bg-amber-50 dark:bg-amber-950/30"
        : "border-slate-200 dark:border-slate-800 bg-white dark:bg-[#14151a]"
    }`}>
      <div className="flex items-center justify-between mb-1">
        <span className="font-mono text-[10.5px] uppercase tracking-wider text-slate-500">{label}</span>
        <span className={`font-mono text-[18px] font-medium tabular-nums leading-none ${
          isWarn ? "text-amber-700 dark:text-amber-300" : "text-slate-900 dark:text-slate-100"
        }`}>{value}</span>
      </div>
      <p className="text-[12.5px] text-slate-600 dark:text-slate-400 leading-snug mt-1">{hint}</p>
    </div>
  );
}
