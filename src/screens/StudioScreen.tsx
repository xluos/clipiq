// 剪辑助手模块 — v2 Phase 3
// list: 剪辑会话卡片列表 (目标 / 应用方法论 / 引用素材 / 状态 badge)
// editor: 三栏布局 (输入设置 / 推荐输出 / 引用面板)

import { type FunctionComponent, useEffect, useMemo, useState } from "react";
import { useApp } from "../AppContext";
import type { EditPlanPreview } from "../electron-api";
import { useTaskQueueStore } from "../stores/tasks";
import type { AppLocation, EditPlan, StudioSession, StudioStep } from "../types";
import {
  Wand2,
  Scissors,
  ArrowLeft,
  Plus,
  RefreshCw,
  Download,
  Search,
  AlertTriangle,
  FileText,
  Check,
  Play,
  Square,
} from "lucide-react";

export function StudioScreen() {
  const { currentLocation } = useApp();
  if (currentLocation.module !== "studio") return null;
  if (currentLocation.screen === "editor") return <StudioEditorScreen />;
  return <StudioListScreen />;
}

// ─────────────────────────────────────────────────────────────
// 会话列表

function activeSessionId(): string | null {
  try { return window.sessionStorage.getItem("clipiq-active-session-id"); } catch { return null; }
}
function setActiveSessionId(id: string | null) {
  try {
    if (id) window.sessionStorage.setItem("clipiq-active-session-id", id);
    else window.sessionStorage.removeItem("clipiq-active-session-id");
  } catch { /* noop */ }
}

function StudioListScreen() {
  const { sessions, setLocation, upsertSession } = useApp();
  const editorLoc: AppLocation = { module: "studio", screen: "editor" };

  const newSession = () => {
    const now = new Date().toISOString();
    const id = `ses-${Date.now()}`;
    const blank: StudioSession = {
      id,
      goal: "",
      appliedMethodologies: [],
      usedAssetIds: [],
      missingShots: [],
      createdAt: now,
      updatedAt: now,
      output: { kind: "idea" },
    };
    upsertSession(blank);
    setActiveSessionId(id);
    setLocation(editorLoc);
  };

  const openSession = (s: StudioSession) => {
    setActiveSessionId(s.id);
    setLocation(editorLoc);
  };

  return (
    <div className="flex-1 flex flex-col bg-slate-50 dark:bg-[#0A0A0B] overflow-hidden">
      <header className="border-b border-slate-200 dark:border-slate-800 bg-white/70 dark:bg-slate-900/40 px-8 py-5 shrink-0">
        <div className="max-w-5xl mx-auto">
          <div className="text-[10.5px] font-mono tracking-[0.14em] uppercase text-slate-500 dark:text-slate-400">
            剪辑助手 · STUDIO
          </div>
          <div className="flex items-baseline gap-3 mt-1.5">
            <h1 className="text-[22px] font-semibold tracking-tight text-slate-900 dark:text-slate-100">剪辑会话</h1>
            <span className="text-[11.5px] font-mono text-slate-500 dark:text-slate-400">{sessions.length} 条</span>
            <div className="flex-1" />
            <button
              onClick={newSession}
              className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md bg-indigo-600 hover:bg-indigo-700 text-white text-[13px] font-medium"
            >
              <Plus className="w-3.5 h-3.5" strokeWidth={2} />
              新建会话
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-8 py-8">
          {sessions.length === 0 ? (
            <EmptySessions onCreate={newSession} />
          ) : (
            <div className="space-y-3">
              {sessions.map((s) => (
                <SessionCard key={s.id} session={s} onClick={() => openSession(s)} />
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

function EmptySessions({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="border border-dashed border-slate-300 dark:border-slate-700 rounded-xl bg-white/50 dark:bg-slate-900/30 px-8 py-16 text-center">
      <div className="w-12 h-12 mx-auto rounded-xl bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 flex items-center justify-center mb-4">
        <Wand2 className="w-5 h-5 text-slate-500 dark:text-slate-400" strokeWidth={1.5} />
      </div>
      <h2 className="text-[16px] font-semibold tracking-tight text-slate-900 dark:text-slate-100">还没有剪辑会话</h2>
      <p className="mt-2 text-[13.5px] text-slate-600 dark:text-slate-400 max-w-md mx-auto leading-relaxed">
        输入剪辑目标,结合素材库和对标账号方法论,自动推荐剪辑思路和缺失镜头。
      </p>
      <button
        onClick={onCreate}
        className="mt-6 inline-flex items-center gap-1.5 h-9 px-4 rounded-md bg-indigo-600 hover:bg-indigo-700 text-white text-[13px] font-medium"
      >
        <Plus className="w-3.5 h-3.5" strokeWidth={2} />
        新建第一个会话
      </button>
    </div>
  );
}

const SessionCard: FunctionComponent<{ session: StudioSession; onClick: () => void }> = ({ session, onClick }) => {
  const outputKind = session.output?.kind ?? "idea";
  const badge = {
    draft: { label: "DRAFT", cls: "bg-indigo-50 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300" },
    "cut-list": { label: "CUT LIST", cls: "bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300" },
    idea: { label: "IDEA", cls: "bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300" },
  }[outputKind];

  return (
    <button
      onClick={onClick}
      className="w-full text-left p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/40 hover:border-slate-300 dark:hover:border-slate-700 transition-colors"
    >
      <div className="flex items-start gap-3.5">
        <div className="w-9 h-9 rounded-lg bg-indigo-50 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300 flex items-center justify-center shrink-0">
          <Scissors className="w-4 h-4" strokeWidth={1.5} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[14.5px] font-semibold tracking-tight text-slate-900 dark:text-slate-100 truncate">
            {session.goal || "未命名会话"}
          </div>
          <div className="flex items-center gap-4 mt-2 text-[10.5px] font-mono tracking-wider text-slate-500 dark:text-slate-400">
            <span>应用方法论 · {session.appliedMethodologies?.length ?? 0}</span>
            <span>引用素材 · {session.usedAssetIds?.length ?? 0}</span>
            <span>{session.updatedAt ? new Date(session.updatedAt).toLocaleDateString("zh-CN") : "—"}</span>
          </div>
        </div>
        <span className={`text-[10.5px] font-mono px-1.5 py-0.5 rounded ${badge.cls}`}>{badge.label}</span>
      </div>
    </button>
  );
};

// ─────────────────────────────────────────────────────────────
// 编辑器 — 三栏

const PLATFORM_OPTIONS = ["B 站知识区", "B 站测评区", "抖音科技", "小红书种草", "YouTube"];
const DURATION_OPTIONS = ["3 min ± 0.5", "5 min ± 1", "10 min ± 1", "15 min ± 2"];

function StudioEditorScreen() {
  const { sessions, accounts, projects, upsertSession, setLocation } = useApp();
  const sid = activeSessionId();
  const session = sessions.find((x) => x.id === sid);

  const [goalDraft, setGoalDraft] = useState(session?.goal || "");
  const [platform, setPlatform] = useState(session?.targetPlatform || PLATFORM_OPTIONS[0]);
  const [duration, setDuration] = useState(formatDuration(session?.targetDurationSec) || DURATION_OPTIONS[1]);
  const [appliedMethodologies, setAppliedMethodologies] = useState<string[]>(session?.appliedMethodologies || []);
  const [usedAssetIds, setUsedAssetIds] = useState<string[]>(session?.usedAssetIds || []);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState("");
  const [preview, setPreview] = useState<EditPlanPreview | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [renderingPreview, setRenderingPreview] = useState(false);
  const [subtitleMode, setSubtitleMode] = useState<"burn" | "external">("burn");
  const tasksById = useTaskQueueStore((state) => state.tasksById);

  const assetProjects = useMemo(() => projects.filter((p) => p.videoRole === "asset"), [projects]);
  const previewTask = useMemo(() => {
    if (!session?.currentEditPlanId) return undefined;
    return Object.values(tasksById)
      .filter((task) =>
        task.kind === "edit-preview" && task.refId === session.currentEditPlanId)
      .sort((a, b) => b.createdAt - a.createdAt)[0];
  }, [session?.currentEditPlanId, tasksById]);

  const backToList: AppLocation = { module: "studio", screen: "list" };

  useEffect(() => {
    let disposed = false;
    setPreview(null);
    setPreviewError("");
    const planId = session?.currentEditPlanId;
    if (!planId || !window.videoAnalyzer?.getEditPlanPreview) return () => { disposed = true; };
    window.videoAnalyzer.getEditPlanPreview(planId)
      .then((value) => {
        if (!disposed) setPreview(value);
      })
      .catch(() => {});
    return () => { disposed = true; };
  }, [session?.currentEditPlanId]);

  const save = (patch: Partial<StudioSession> = {}) => {
    if (!session) return;
    upsertSession({
      ...session,
      goal: goalDraft,
      targetPlatform: platform,
      targetDurationSec: parseDuration(duration),
      appliedMethodologies,
      usedAssetIds,
      ...patch,
      updatedAt: new Date().toISOString(),
    });
  };

  const regenerateSteps = async () => {
    if (!session) return;
    if (!goalDraft.trim()) {
      setGenError("先填剪辑目标");
      return;
    }
    setGenError("");
    setGenerating(true);
    const totalSec = parseDuration(duration);
    try {
      if (!window.videoAnalyzer?.generateEditPlan) {
        throw new Error("浏览器预览环境不能生成真实粗剪");
      }
      const result = await window.videoAnalyzer.generateEditPlan({
        sessionId: session.id,
        goal: goalDraft,
        targetDurationSec: totalSec,
        videoIds: usedAssetIds,
        methodologyIds: appliedMethodologies,
      });
      const steps = editPlanToStudioSteps(result.plan, assetProjects);
      setPreview(null);
      setPreviewError("");
      upsertSession({
        ...session,
        goal: goalDraft,
        targetPlatform: platform,
        targetDurationSec: totalSec,
        appliedMethodologies,
        usedAssetIds,
        steps,
        missingShots: collectMissingShots(steps),
        currentEditPlanId: result.plan.id,
        output: { kind: "draft" },
        updatedAt: new Date().toISOString(),
      });
    } catch (e) {
      setGenError(e instanceof Error ? e.message : String(e));
    } finally {
      setGenerating(false);
    }
  };

  const renderPreview = async () => {
    const planId = session?.currentEditPlanId;
    if (!planId) {
      setPreviewError("先生成真实粗剪方案");
      return;
    }
    if (!window.videoAnalyzer?.renderEditPlanPreview) {
      setPreviewError("浏览器预览环境不能运行 FFmpeg");
      return;
    }
    setPreviewError("");
    setRenderingPreview(true);
    try {
      const result = await window.videoAnalyzer.renderEditPlanPreview({
        planId,
        subtitleMode,
      });
      setPreview(result.preview);
    } catch (error) {
      setPreviewError(error instanceof Error ? error.message : String(error));
    } finally {
      setRenderingPreview(false);
    }
  };

  const cancelPreview = async () => {
    if (!previewTask || !window.videoAnalyzer?.cancelQueueTask) return;
    await window.videoAnalyzer.cancelQueueTask(previewTask.id);
  };

  if (!session) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center bg-slate-50 dark:bg-[#0A0A0B] gap-4">
        <p className="text-[13px] text-slate-500">未找到会话</p>
        <button
          onClick={() => setLocation(backToList)}
          className="h-9 px-4 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-[13px] text-slate-700 dark:text-slate-300"
        >
          返回会话列表
        </button>
      </div>
    );
  }

  const steps = session.steps || [];

  return (
    <div className="flex-1 flex flex-col bg-slate-50 dark:bg-[#0A0A0B] overflow-hidden">
      <header className="border-b border-slate-200 dark:border-slate-800 bg-white/70 dark:bg-slate-900/40 px-6 py-3 shrink-0 flex items-center gap-3">
        <button
          onClick={() => { save(); setLocation(backToList); }}
          className="inline-flex items-center gap-1.5 h-8 px-2 rounded-md text-[13px] text-slate-600 dark:text-slate-300 hover:bg-slate-200/60 dark:hover:bg-slate-800/60"
        >
          <ArrowLeft className="w-3.5 h-3.5" strokeWidth={1.5} />
          会话列表
        </button>
        <div className="w-px h-4 bg-slate-200 dark:bg-slate-800" />
        <h2 className="text-[14px] font-semibold text-slate-900 dark:text-slate-100 truncate max-w-md">
          {goalDraft.split("\n")[0] || "未命名会话"}
        </h2>
        <span className="text-[10.5px] font-mono px-1.5 py-0.5 rounded bg-indigo-50 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300">
          {(session.output?.kind || "idea").toUpperCase()}
        </span>
        <div className="flex-1" />
        <button
          onClick={regenerateSteps}
          disabled={generating}
          className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-[12.5px] text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50"
        >
          <RefreshCw className={`w-3 h-3 ${generating ? "animate-spin" : ""}`} strokeWidth={1.5} />
          {generating ? "LLM 生成中…" : "重新生成"}
        </button>
        <button className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-[12.5px] bg-indigo-600 hover:bg-indigo-700 text-white">
          <Download className="w-3 h-3" strokeWidth={1.5} />
          导出脚本
        </button>
      </header>

      <div className="flex-1 grid grid-cols-[320px_1fr_280px] min-h-0">
        {/* 左栏 输入设置 */}
        <aside className="overflow-y-auto p-5 border-r border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/30">
          <div className="text-[10.5px] font-mono tracking-[0.14em] uppercase text-slate-500 mb-2">输入设置</div>

          <div className="p-3.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/60 mb-3.5">
            <label className="block text-[10.5px] font-mono tracking-wider uppercase text-slate-500 mb-1.5">剪辑目标</label>
            <textarea
              value={goalDraft}
              onChange={(e) => setGoalDraft(e.target.value)}
              onBlur={() => save()}
              placeholder="做一条 10 分钟的「电池虚标」科普,适合 B 站知识区,前 30 秒必须给出反常识结论。"
              className="w-full min-h-[76px] p-2.5 text-[13px] resize-y rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:focus:ring-indigo-900/40"
            />
          </div>

          <KVRow label="目标平台" value={platform} options={PLATFORM_OPTIONS} onChange={(v) => { setPlatform(v); save({ targetPlatform: v }); }} />
          <KVRow label="目标时长" value={duration} options={DURATION_OPTIONS} onChange={(v) => { setDuration(v); save({ targetDurationSec: parseDuration(v) }); }} />

          <div className="text-[10.5px] font-mono tracking-[0.14em] uppercase text-slate-500 mt-5 mb-2">应用的方法论</div>
          {accounts.length === 0 && (
            <div className="text-[12px] text-slate-500 px-2 py-2.5 border border-dashed border-slate-300 dark:border-slate-700 rounded-md">
              先在「账号分析」里添加并分析账号,这里会出现可应用的方法论
            </div>
          )}
          {accounts.map((a) => {
            const active = appliedMethodologies.includes(a.id);
            return (
              <button
                key={a.id}
                onClick={() => {
                  const next = active ? appliedMethodologies.filter((x) => x !== a.id) : [...appliedMethodologies, a.id];
                  setAppliedMethodologies(next);
                  save({ appliedMethodologies: next });
                }}
                className={`w-full flex items-center gap-2 p-3 mb-1.5 rounded-md border text-left transition-colors ${
                  active
                    ? "bg-indigo-50 dark:bg-indigo-950/40 border-indigo-200 dark:border-indigo-800/50 ring-2 ring-indigo-100 dark:ring-indigo-900/30"
                    : "bg-white dark:bg-slate-900/60 border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/40"
                }`}
              >
                <div className="w-6 h-6 rounded-full bg-slate-900 dark:bg-slate-200 text-white dark:text-slate-900 text-[9px] flex items-center justify-center font-medium">
                  {(a.avatarHint || a.name).slice(0, 2)}
                </div>
                <span className={`text-[12.5px] flex-1 ${active ? "font-medium text-slate-900 dark:text-slate-100" : "text-slate-700 dark:text-slate-300"}`}>
                  {a.name}
                </span>
                {active && <Check className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400" strokeWidth={2} />}
              </button>
            );
          })}

          <div className="text-[10.5px] font-mono tracking-[0.14em] uppercase text-slate-500 mt-5 mb-2">
            引用素材池 · {usedAssetIds.length}
          </div>
          {assetProjects.length === 0 && (
            <div className="text-[12px] text-slate-500 px-2 py-2.5 border border-dashed border-slate-300 dark:border-slate-700 rounded-md">
              先在「素材库」里上传素材,这里会出现可引用的素材
            </div>
          )}
          {assetProjects.map((p) => {
            const active = usedAssetIds.includes(p.id);
            return (
              <button
                key={p.id}
                onClick={() => {
                  const next = active ? usedAssetIds.filter((x) => x !== p.id) : [...usedAssetIds, p.id];
                  setUsedAssetIds(next);
                  save({ usedAssetIds: next });
                }}
                className={`w-full flex gap-2.5 p-1.5 mb-1 rounded-md transition-colors text-left ${
                  active ? "bg-indigo-50 dark:bg-indigo-950/40" : "bg-white dark:bg-slate-900/60 hover:bg-slate-50 dark:hover:bg-slate-800/40"
                }`}
              >
                <div className="w-12 h-7 rounded bg-slate-300 dark:bg-slate-700 shrink-0 overflow-hidden">
                  {p.thumbnailUrl && <img src={p.thumbnailUrl} alt={p.title} className="w-full h-full object-cover" />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-[12px] text-slate-900 dark:text-slate-100 truncate">{p.title}</div>
                  <div className="text-[10.5px] font-mono text-slate-500 dark:text-slate-400">
                    {p.shots?.length ?? 0} 镜头 · {formatTimeShort(p.durationSec)}
                  </div>
                </div>
              </button>
            );
          })}
        </aside>

        {/* 中栏 推荐输出 */}
        <main className="overflow-y-auto px-7 py-6">
          <div className="text-[10.5px] font-mono tracking-[0.14em] uppercase text-slate-500 mb-2">推荐输出</div>
          <h2 className="text-[18px] font-semibold tracking-tight text-slate-900 dark:text-slate-100 mb-2">
            剪辑思路 {steps.length > 0 ? `· ${steps.length} 段叙事骨架` : "· 尚未生成"}
          </h2>
          {genError && (
            <div className="mb-3 rounded-md border border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-[12px] text-amber-700 dark:text-amber-300">
              {genError}
            </div>
          )}
          {session.currentEditPlanId && (
            <section className="mb-5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/40 overflow-hidden">
              {preview ? (
                <video
                  key={preview.mediaUrl}
                  controls
                  preload="metadata"
                  src={preview.mediaUrl}
                  className="w-full h-[360px] object-contain bg-slate-950"
                />
              ) : (
                <div className="h-[320px] flex items-center justify-center bg-slate-100 dark:bg-slate-950">
                  <Play className="w-7 h-7 text-slate-400" strokeWidth={1.5} />
                </div>
              )}
              <div className="px-3.5 py-3 border-t border-slate-200 dark:border-slate-800">
                <div className="flex items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-[12.5px] font-medium text-slate-900 dark:text-slate-100">
                      {preview ? "低清代理预览" : "代理预览尚未生成"}
                    </div>
                    <div className="mt-0.5 text-[10.5px] font-mono text-slate-500 dark:text-slate-400">
                      {preview
                        ? `${preview.width}×${preview.height} · ${preview.fps} fps · 缓存命中 ${preview.cacheHits}`
                        : "H.264 · AAC · 720p"}
                    </div>
                  </div>
                  <select
                    value={subtitleMode}
                    onChange={(event) => setSubtitleMode(event.target.value as "burn" | "external")}
                    disabled={renderingPreview}
                    className="h-8 px-2 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-[11.5px] text-slate-700 dark:text-slate-300"
                  >
                    <option value="burn">烧录字幕</option>
                    <option value="external">外挂 SRT</option>
                  </select>
                  {previewTask?.status === "running" || previewTask?.status === "queued" ? (
                    <button
                      onClick={cancelPreview}
                      className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-slate-300 dark:border-slate-700 text-[12px] text-slate-700 dark:text-slate-300"
                    >
                      <Square className="w-3 h-3" strokeWidth={1.5} />
                      取消
                    </button>
                  ) : (
                    <button
                      onClick={renderPreview}
                      disabled={renderingPreview}
                      className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-[12px]"
                    >
                      <Play className="w-3 h-3" strokeWidth={1.5} />
                      {preview ? "重新生成" : "生成预览"}
                    </button>
                  )}
                </div>
                {(previewTask?.status === "running" || previewTask?.status === "queued") && (
                  <div className="mt-2.5">
                    <div className="h-1.5 rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
                      <div
                        className="h-full bg-indigo-600 transition-[width]"
                        style={{ width: `${Math.max(2, previewTask.progress)}%` }}
                      />
                    </div>
                    <div className="mt-1 text-[10.5px] font-mono text-slate-500 dark:text-slate-400">
                      {previewTask.stage}{previewTask.message ? ` · ${previewTask.message}` : ""}
                    </div>
                  </div>
                )}
                {previewError && (
                  <div className="mt-2 text-[11.5px] text-amber-700 dark:text-amber-300">
                    {previewError}
                  </div>
                )}
                {preview?.warnings?.map((warning) => (
                  <div key={warning} className="mt-2 text-[11.5px] text-amber-700 dark:text-amber-300">
                    {warning}
                  </div>
                ))}
              </div>
            </section>
          )}

          {steps.length === 0 ? (
            <div className="border border-dashed border-slate-300 dark:border-slate-700 rounded-xl bg-white dark:bg-slate-900/30 px-8 py-12 text-center">
              <Wand2 className="w-5 h-5 mx-auto text-slate-400 dark:text-slate-500 mb-3" strokeWidth={1.5} />
              <p className="text-[13.5px] text-slate-700 dark:text-slate-300 font-medium">先填好剪辑目标 + 应用方法论</p>
              <p className="text-[12.5px] text-slate-500 dark:text-slate-400 mt-2 max-w-md mx-auto">
                然后点右上角「重新生成」让系统基于素材库 × 方法论给出叙事骨架
              </p>
              <button
                onClick={regenerateSteps}
                disabled={!goalDraft.trim()}
                className="mt-5 inline-flex items-center gap-1.5 h-9 px-4 rounded-md bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-200 dark:disabled:bg-slate-800 disabled:text-slate-400 text-white text-[13px] font-medium"
              >
                <RefreshCw className="w-3.5 h-3.5" strokeWidth={2} />
                生成剪辑思路
              </button>
            </div>
          ) : (
            <>
              {/* 时间线 */}
              <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/40 mb-6 overflow-hidden">
                <div className="flex h-14">
                  {steps.map((s, i) => {
                    const w = Math.max(((s.endSec ?? 0) - (s.startSec ?? 0)) || 60, 30);
                    const isHook = i === 0 || /钩|hook|开场/i.test(s.label);
                    return (
                      <div
                        key={i}
                        className={`px-3 py-2 ${isHook ? "bg-indigo-50 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300" : "bg-slate-50 dark:bg-slate-800/40 text-slate-700 dark:text-slate-300"} ${i < steps.length - 1 ? "border-r border-slate-200 dark:border-slate-700" : ""} min-w-0`}
                        style={{ flex: w }}
                      >
                        <div className="text-[10.5px] font-mono tracking-wider">#{String(i + 1).padStart(2, "0")}</div>
                        <div className="text-[12px] truncate">{s.label.split(" · ")[0]}</div>
                      </div>
                    );
                  })}
                </div>
                <div className="flex justify-between px-3 py-1.5 text-[10.5px] font-mono text-slate-500 dark:text-slate-400">
                  <span>00:00</span>
                  <span>{formatTimeShort(session.targetDurationSec)}</span>
                </div>
              </div>

              {/* 步骤列表 */}
              <ol className="space-y-0">
                {steps.map((s, i) => (
                  <li key={i} className="py-4 border-b border-slate-200 dark:border-slate-800 last:border-b-0">
                    <div className="flex items-baseline gap-2.5 mb-2">
                      <span className="text-[10.5px] font-mono tracking-wider text-indigo-600 dark:text-indigo-400">
                        {String(s.index).padStart(2, "0")}
                      </span>
                      <h3 className="text-[14px] font-semibold tracking-tight text-slate-900 dark:text-slate-100">{s.label}</h3>
                    </div>
                    <p className="text-[13.5px] leading-relaxed text-slate-700 dark:text-slate-300 mb-2.5">{s.body}</p>
                    <div className="space-y-1">
                      {s.shotRefs.map((ref, j) => (
                        <div key={j} className="flex items-center gap-2 text-[11.5px] font-mono text-slate-600 dark:text-slate-400">
                          <FileText className="w-3 h-3 text-slate-400" strokeWidth={1.5} />
                          <span>{ref.note || "镜头引用"}</span>
                        </div>
                      ))}
                      {s.missing && (
                        <div className="flex items-center gap-2 text-[11.5px] font-mono text-amber-700 dark:text-amber-300 mt-1.5">
                          <AlertTriangle className="w-3 h-3" strokeWidth={1.5} />
                          <span>缺失镜头 · {s.missing}</span>
                        </div>
                      )}
                    </div>
                  </li>
                ))}
              </ol>

              <div className="flex gap-2.5 mt-5">
                <button
                  onClick={regenerateSteps}
                  className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-[12.5px] text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
                >
                  <RefreshCw className="w-3.5 h-3.5" strokeWidth={1.5} />
                  重排
                </button>
              </div>
            </>
          )}
        </main>

        {/* 右栏 引用面板 */}
        <aside className="overflow-y-auto p-4 border-l border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/30">
          <div className="text-[10.5px] font-mono tracking-[0.14em] uppercase text-slate-500 mb-2">引用面板</div>

          {appliedMethodologies.length > 0 && (
            <div className="rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/60 p-3 mb-3">
              <div className="text-[10.5px] font-mono tracking-wider uppercase text-indigo-600 dark:text-indigo-400 mb-1.5">
                方法论 · {accounts.find((a) => a.id === appliedMethodologies[0])?.name || "未知"}
              </div>
              <p className="text-[12.5px] leading-relaxed text-slate-700 dark:text-slate-300">
                {accounts.find((a) => a.id === appliedMethodologies[0])?.methodology?.hooks?.summary ||
                  "该账号还未生成方法论 — 先在账号分析里跑完视频"}
              </p>
            </div>
          )}

          {usedAssetIds.length > 0 && (
            <div className="rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/60 p-3 mb-3">
              <div className="aspect-video rounded bg-slate-300 dark:bg-slate-700 mb-2 overflow-hidden">
                {(() => {
                  const a = assetProjects.find((p) => p.id === usedAssetIds[0]);
                  return a?.thumbnailUrl ? (
                    <img src={a.thumbnailUrl} alt={a.videoName} className="w-full h-full object-cover" />
                  ) : null;
                })()}
              </div>
              <div className="text-[12.5px] font-medium text-slate-900 dark:text-slate-100 truncate">
                {assetProjects.find((p) => p.id === usedAssetIds[0])?.videoName || "—"}
              </div>
              <div className="text-[10.5px] font-mono text-slate-500 dark:text-slate-400 mt-1">已选 {usedAssetIds.length} 条素材</div>
            </div>
          )}

          {steps.some((s) => s.missing) && (
            <div className="rounded-md border border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/30 p-3">
              <div className="flex items-center gap-1.5 text-[10.5px] font-mono tracking-wider uppercase text-amber-700 dark:text-amber-300 mb-1.5">
                <AlertTriangle className="w-3 h-3" strokeWidth={1.5} />
                缺失镜头 · {steps.filter((s) => s.missing).length} 项
              </div>
              <ul className="text-[12.5px] leading-relaxed text-slate-700 dark:text-slate-200 space-y-0.5">
                {steps.filter((s) => s.missing).map((s, i) => (
                  <li key={i}>· {s.missing}</li>
                ))}
              </ul>
              <button className="mt-2 inline-flex items-center gap-1.5 h-7 px-2 rounded text-[11.5px] text-slate-700 dark:text-slate-200 bg-white/70 dark:bg-slate-900/60 hover:bg-white dark:hover:bg-slate-900">
                <Search className="w-3 h-3" strokeWidth={1.5} />
                在素材库搜
              </button>
            </div>
          )}

          {appliedMethodologies.length === 0 && usedAssetIds.length === 0 && !steps.some((s) => s.missing) && (
            <div className="text-[12px] text-slate-500 px-2 py-3 border border-dashed border-slate-300 dark:border-slate-700 rounded-md">
              选中左栏的方法论 / 素材后,这里会显示引用细节
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

const KVRow: FunctionComponent<{
  label: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
}> = ({ label, value, options, onChange }) => {
  return (
    <div className="flex items-center justify-between px-3 py-2.5 mb-1.5 rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/60">
      <span className="text-[10.5px] font-mono tracking-wider uppercase text-slate-500 dark:text-slate-400">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="text-[12.5px] text-slate-900 dark:text-slate-100 bg-transparent border-0 focus:outline-none cursor-pointer"
      >
        {options.map((o) => (
          <option key={o} value={o} className="text-slate-900 bg-white">{o}</option>
        ))}
      </select>
    </div>
  );
};

function formatDuration(sec?: number): string | null {
  if (!sec) return null;
  if (sec < 60) return `${sec} sec`;
  const min = Math.round(sec / 60);
  return `${min} min ± 1`;
}

function parseDuration(s: string): number {
  const m = s.match(/(\d+)\s*min/);
  return m ? Number(m[1]) * 60 : 600;
}

function collectMissingShots(steps: StudioStep[]): string[] {
  return steps
    .map((step) => step.missing?.trim())
    .filter((value): value is string => Boolean(value));
}

function editPlanToStudioSteps(
  plan: EditPlan,
  assets: ReturnType<typeof useApp>["projects"],
): StudioStep[] {
  const videoTrack = plan.tracks.find((track) => track.kind === "video");
  if (!videoTrack || videoTrack.kind !== "video") return [];
  const durationWarning = plan.validation.warnings
    .find((issue) => issue.code === "TARGET_DURATION_MISS");

  return videoTrack.items.map((clip, index) => {
    const durationUs = Math.round((clip.sourceOutUs - clip.sourceInUs) / clip.speed);
    const startSec = clip.timelineInUs / 1_000_000;
    const endSec = (clip.timelineInUs + durationUs) / 1_000_000;
    const asset = assets.find((item) => item.id === clip.videoId);
    const subtitle = clip.evidence?.subtitleSegments
      ?.map((segment) => segment.text)
      .filter(Boolean)
      .join(" ");
    const body = [
      clip.evidence?.eventSummary,
      subtitle ? `对白：${subtitle}` : undefined,
    ].filter(Boolean).join(" · ") || clip.selectionReason;

    return {
      index: index + 1,
      label: `${clip.selectionReason} · ${formatTimeShort(startSec)}-${formatTimeShort(endSec)}`,
      startSec,
      endSec,
      body,
      shotRefs: [{
        assetProjectId: clip.videoId,
        shotId: clip.shotId,
        rangeStart: clip.sourceInUs / 1_000_000,
        rangeEnd: clip.sourceOutUs / 1_000_000,
        note: `${asset?.title || clip.videoId} · ${clip.evidence?.eventSummary || clip.shotId}`,
      }],
      ...(durationWarning && index === videoTrack.items.length - 1
        ? { missing: "有效素材不足，粗剪时长未达到目标" }
        : {}),
    };
  });
}

function formatTimeShort(sec?: number): string {
  if (sec == null) return "—";
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}
