import { useApp } from "../AppContext";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Download, FileText } from "lucide-react";
import { formatTime } from "@/lib/utils";
import { useEffect, useRef, useState } from "react";
import type { ExportFormat } from "../electron-api";

const REPORT_SECTIONS = [
  { id: "summary", label: "整体摘要" },
  { id: "structure", label: "结构拆解" },
  { id: "emotion", label: "情感曲线" },
  { id: "pacing", label: "节奏分析" },
  { id: "editing", label: "剪辑风格" },
  { id: "composition", label: "构图特点" },
  { id: "takeaways", label: "核心洞察" },
] as const;

export function ReportScreen() {
  const { setCurrentScreen, reportByProject, activeProjectId, projects, nodesByProject, providers } = useApp();
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

  const segmentDefs = [
    { key: "hook", label: "开头引子", detail: report.structure?.hook, tone: "bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 border-slate-200 dark:border-slate-700" },
    { key: "development", label: "发展", detail: report.structure?.development, tone: "bg-indigo-50 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300 border-indigo-100 dark:border-indigo-800/50" },
    { key: "turn", label: "转折", detail: report.structure?.turn, tone: "bg-amber-50 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 border-amber-100 dark:border-amber-800/50" },
    { key: "climax", label: "高潮", detail: report.structure?.climax, tone: "bg-purple-50 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300 border-purple-100 dark:border-purple-800/50" },
    { key: "ending", label: "结尾", detail: report.structure?.ending, tone: "bg-emerald-50 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 border-emerald-100 dark:border-emerald-800/50" },
  ] as const;

  const rawSegments = segmentDefs.map((def, index) => {
    const start = boundaries[index];
    const end = boundaries[index + 1];
    const width = Math.max(((end - start) / totalDuration) * 100, 4);
    return { ...def, width };
  });
  const totalWidth = rawSegments.reduce((sum, seg) => sum + seg.width, 0) || 1;
  const normalizedSegments = rawSegments.map((seg) => ({ ...seg, width: (seg.width / totalWidth) * 100 }));

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
              <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">总结报告</h1>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500 dark:text-slate-400 font-mono">
                {report.providerSnapshot?.name && (
                  <span>来源 · {report.providerSnapshot.name}</span>
                )}
                {report.providerSnapshot?.model && (
                  <span>模型 · {report.providerSnapshot.model}</span>
                )}
                {report.providerSnapshot?.inputMode && (
                  <span>输入模式 · {report.providerSnapshot.inputMode}</span>
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

          <section id="summary" className="space-y-4 scroll-mt-6">
            <h2 className="text-lg font-semibold text-slate-800 dark:text-slate-100 border-l-4 border-indigo-500 pl-3">整体摘要</h2>
            <div className="bg-white dark:bg-[#0E0E10] border border-slate-200 dark:border-slate-800 p-6 rounded-xl shadow-sm text-slate-700 dark:text-slate-300 leading-relaxed text-sm whitespace-pre-line">
              {report.summary || "暂无整体摘要。"}
            </div>
          </section>

          <section id="structure" className="space-y-4 scroll-mt-6">
            <h2 className="text-lg font-semibold text-slate-800 dark:text-slate-100 border-l-4 border-indigo-500 pl-3">结构拆解</h2>
            <div className="bg-white dark:bg-[#0E0E10] border border-slate-200 dark:border-slate-800 p-6 rounded-xl shadow-sm space-y-6">
              <div className="flex flex-col space-y-2">
                <div className="flex h-12 rounded-lg overflow-hidden border border-slate-200 dark:border-slate-800 text-xs font-medium relative">
                  {normalizedSegments.map((segment) => (
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
                <div className="flex justify-between text-[10px] text-slate-500 font-mono px-1">
                  <span>0:00</span>
                  <span>{formatTime(project.durationSec)}</span>
                </div>
              </div>
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
          
          <section id="emotion" className="space-y-4 scroll-mt-6">
            <h2 className="text-lg font-semibold text-slate-800 dark:text-slate-100 border-l-4 border-indigo-500 pl-3">情感曲线</h2>
            <div className="bg-white dark:bg-[#0E0E10] border border-slate-200 dark:border-slate-800 p-6 rounded-xl shadow-sm">
              <EmotionCurve nodes={nodes} totalDuration={totalDuration} />
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

function EmotionCurve({ nodes, totalDuration }: { nodes: { startSec: number; endSec: number; emotionIntensity: number; isHighlight: boolean; title: string }[]; totalDuration: number }) {
  if (!nodes.length) {
    return <p className="text-sm text-slate-500">尚未生成节点数据。</p>;
  }
  const width = 720;
  const height = 160;
  const padX = 24;
  const padY = 18;
  const safeDuration = Math.max(totalDuration, 1);
  const points = nodes.map(node => {
    const mid = (node.startSec + node.endSec) / 2;
    const x = padX + ((mid / safeDuration) * (width - padX * 2));
    const intensity = Math.max(0, Math.min(10, Number(node.emotionIntensity) || 0));
    const y = padY + (1 - intensity / 10) * (height - padY * 2);
    return { x, y, node, intensity };
  });
  const path = points.map((p, idx) => `${idx === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const areaPath = `${path} L${points[points.length - 1].x.toFixed(1)},${(height - padY).toFixed(1)} L${points[0].x.toFixed(1)},${(height - padY).toFixed(1)} Z`;
  return (
    <div className="space-y-2">
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-44">
        <defs>
          <linearGradient id="emotionGradient" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="rgb(59 130 246 / 0.45)" />
            <stop offset="100%" stopColor="rgb(59 130 246 / 0.05)" />
          </linearGradient>
        </defs>
        <path d={areaPath} fill="url(#emotionGradient)" />
        <path d={path} fill="none" stroke="rgb(37 99 235)" strokeWidth={2} />
        {points.map(({ x, y, node, intensity }) => (
          <g key={node.title + x}>
            <circle cx={x} cy={y} r={node.isHighlight ? 5 : 3.5} fill={node.isHighlight ? "rgb(245 158 11)" : "rgb(37 99 235)"} stroke="white" strokeWidth={1.5} />
            <title>{`${node.title} · 情绪 ${intensity}/10`}</title>
          </g>
        ))}
      </svg>
      <div className="flex justify-between text-[10px] text-slate-500 font-mono px-1">
        <span>0:00</span>
        <span>情绪强度 0-10</span>
        <span>{formatTime(safeDuration)}</span>
      </div>
    </div>
  );
}
