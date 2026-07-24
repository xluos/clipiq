// 剪辑助手模块 — v2 Phase 3
// list: 剪辑会话卡片列表 (目标 / 应用方法论 / 引用素材 / 状态 badge)
// editor: 三栏布局 (输入设置 / 推荐输出 / 引用面板)

import { type FunctionComponent, useEffect, useMemo, useState } from "react";
import { useApp } from "../AppContext";
import type {
  EditPackageExportResult,
  EditPlanPreview,
  EditReplacementCandidate,
} from "../electron-api";
import { useTaskQueueStore } from "../stores/tasks";
import {
  formatStudioDuration,
  parseStudioDuration,
} from "./studio-duration";
import type {
  AppLocation,
  EditFeedbackAction,
  EditPlan,
  EmotionTone,
  OverlayItem,
  OverlayTemplateDefinition,
  StudioSession,
  StudioStep,
} from "../types";
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
  ArrowDown,
  ArrowUp,
  Captions,
  Trash2,
  Music2,
  Mic2,
  Sparkles,
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

const EMOTION_TONE_LABELS: Record<EmotionTone, string> = {
  neutral: "中性",
  calm: "平静",
  warm: "温暖",
  upbeat: "轻快",
  tense: "紧张",
  reflective: "回味",
};

function variantPlansForActivePlan(
  plans: EditPlan[],
  activePlan: EditPlan | null,
): EditPlan[] {
  const groupId = activePlan?.provenance.variant?.groupId;
  if (!groupId) return [];
  const latestByKey = new Map<string, EditPlan>();
  for (const plan of plans) {
    const variant = plan.provenance.variant;
    if (variant?.groupId !== groupId || latestByKey.has(variant.key)) continue;
    latestByKey.set(variant.key, plan);
  }
  if (activePlan?.provenance.variant) {
    latestByKey.set(activePlan.provenance.variant.key, activePlan);
  }
  return [...latestByKey.values()].sort((left, right) =>
    (left.provenance.variant?.index || 0)
    - (right.provenance.variant?.index || 0));
}

function editPlanComparisonFacts(plan: EditPlan): {
  clipCount: number;
  videoCount: number;
  emotionLabels: string;
} {
  const video = plan.tracks.find((track) => track.kind === "video");
  const clips = video?.kind === "video" ? video.items : [];
  return {
    clipCount: clips.length,
    videoCount: new Set(clips.map((clip) => clip.videoId)).size,
    emotionLabels: [...new Set(
      (plan.emotionSegments || []).map((segment) =>
        EMOTION_TONE_LABELS[segment.tone]),
    )].join(" / "),
  };
}

function replaceVariantBranch(
  plans: EditPlan[],
  nextPlan: EditPlan,
): EditPlan[] {
  const variant = nextPlan.provenance.variant;
  if (!variant) return [];
  const next = plans.filter((plan) =>
    plan.provenance.variant?.groupId === variant.groupId
    && plan.provenance.variant.key !== variant.key);
  next.push(nextPlan);
  return next.sort((left, right) =>
    (left.provenance.variant?.index || 0)
    - (right.provenance.variant?.index || 0));
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
const DURATION_OPTIONS = [
  "30 sec",
  "60 sec",
  "90 sec",
  "3 min ± 0.5",
  "5 min ± 1",
  "10 min ± 1",
  "15 min ± 2",
];

function StudioEditorScreen() {
  const { sessions, accounts, projects, upsertSession, setLocation } = useApp();
  const sid = activeSessionId();
  const session = sessions.find((x) => x.id === sid);

  const [goalDraft, setGoalDraft] = useState(session?.goal || "");
  const [platform, setPlatform] = useState(session?.targetPlatform || PLATFORM_OPTIONS[0]);
  const [duration, setDuration] = useState(
    formatStudioDuration(session?.targetDurationSec)
    || DURATION_OPTIONS[1],
  );
  const [appliedMethodologies, setAppliedMethodologies] = useState<string[]>(session?.appliedMethodologies || []);
  const [usedAssetIds, setUsedAssetIds] = useState<string[]>(session?.usedAssetIds || []);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState("");
  const [preview, setPreview] = useState<EditPlanPreview | null>(null);
  const [currentPlan, setCurrentPlan] = useState<EditPlan | null>(null);
  const [variantPlans, setVariantPlans] = useState<EditPlan[]>([]);
  const [overlayTemplates, setOverlayTemplates] = useState<
    OverlayTemplateDefinition[]
  >([]);
  const [previewError, setPreviewError] = useState("");
  const [editError, setEditError] = useState("");
  const [editingAction, setEditingAction] = useState("");
  const [replacingClipId, setReplacingClipId] = useState("");
  const [replacementCandidates, setReplacementCandidates] = useState<
    Record<string, EditReplacementCandidate[]>
  >({});
  const [exportingPackage, setExportingPackage] = useState(false);
  const [exportResult, setExportResult] = useState<EditPackageExportResult | null>(null);
  const [exportError, setExportError] = useState("");
  const [renderingPreview, setRenderingPreview] = useState(false);
  const [subtitleMode, setSubtitleMode] = useState<"burn" | "external">("burn");
  const [musicBusy, setMusicBusy] = useState(false);
  const [musicError, setMusicError] = useState("");
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
    if (!session) return;
    setGoalDraft(session.goal || "");
    setPlatform(session.targetPlatform || PLATFORM_OPTIONS[0]);
    setDuration(
      formatStudioDuration(session.targetDurationSec)
      || DURATION_OPTIONS[1],
    );
    setAppliedMethodologies(session.appliedMethodologies || []);
    setUsedAssetIds(session.usedAssetIds || []);
  }, [session?.id]);

  useEffect(() => {
    let disposed = false;
    setPreview(null);
    setCurrentPlan(null);
    setPreviewError("");
    const planId = session?.currentEditPlanId;
    const api = window.videoAnalyzer;
    if (!planId || !api) return () => { disposed = true; };
    Promise.all([
      api.getEditPlan?.(planId) || Promise.resolve(null),
      api.getEditPlanPreview?.(planId) || Promise.resolve(null),
      api.listEditPlans?.(session.id) || Promise.resolve([]),
      api.listOverlayTemplates?.() || Promise.resolve([]),
    ])
      .then(([plan, previewValue, plans, templates]) => {
        if (disposed) return;
        setCurrentPlan(plan);
        setPreview(previewValue);
        setVariantPlans(variantPlansForActivePlan(plans, plan));
        setOverlayTemplates(templates);
      })
      .catch(() => {});
    return () => { disposed = true; };
  }, [session?.currentEditPlanId, session?.id]);

  const save = (patch: Partial<StudioSession> = {}) => {
    if (!session) return;
    upsertSession({
      ...session,
      goal: goalDraft,
      targetPlatform: platform,
      targetDurationSec: parseStudioDuration(duration),
      appliedMethodologies,
      usedAssetIds,
      ...patch,
      updatedAt: new Date().toISOString(),
    });
  };

  const regenerateSteps = async (variantCount: 1 | 3 = 1) => {
    if (!session) return;
    if (!goalDraft.trim()) {
      setGenError("先填剪辑目标");
      return;
    }
    setGenError("");
    setGenerating(true);
    const totalSec = parseStudioDuration(duration);
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
        variantCount,
      });
      const steps = editPlanToStudioSteps(result.plan, assetProjects);
      setCurrentPlan(result.plan);
      setVariantPlans(variantPlansForActivePlan(result.plans, result.plan));
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

  const activateVariant = async (plan: EditPlan) => {
    if (
      !session
      || plan.id === currentPlan?.id
      || !window.videoAnalyzer?.activateEditPlan
    ) {
      return;
    }
    setEditError("");
    setEditingAction("activate_variant");
    try {
      const result = await window.videoAnalyzer.activateEditPlan({
        sessionId: session.id,
        planId: plan.id,
      });
      const [previewValue] = await Promise.all([
        window.videoAnalyzer.getEditPlanPreview?.(plan.id) || Promise.resolve(null),
      ]);
      const steps = editPlanToStudioSteps(result.plan, assetProjects);
      setCurrentPlan(result.plan);
      setPreview(previewValue);
      setReplacingClipId("");
      setReplacementCandidates({});
      upsertSession({
        ...session,
        steps,
        missingShots: collectMissingShots(steps),
        currentEditPlanId: result.plan.id,
        output: { kind: "draft" },
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      setEditError(error instanceof Error ? error.message : String(error));
    } finally {
      setEditingAction("");
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

  const applyFeedback = async (action: EditFeedbackAction) => {
    const planId = currentPlan?.id || session?.currentEditPlanId;
    if (!planId || !window.videoAnalyzer?.applyEditPlanFeedback || !session) {
      setEditError("当前环境不能保存粗剪调整");
      return false;
    }
    setEditError("");
    setEditingAction(action.type);
    try {
      const result = await window.videoAnalyzer.applyEditPlanFeedback({
        planId,
        action,
      });
      const steps = editPlanToStudioSteps(result.plan, assetProjects);
      setCurrentPlan(result.plan);
      setVariantPlans((current) => replaceVariantBranch(current, result.plan));
      setPreview(null);
      setReplacingClipId("");
      setReplacementCandidates({});
      upsertSession({
        ...session,
        steps,
        missingShots: collectMissingShots(steps),
        currentEditPlanId: result.plan.id,
        output: { kind: "draft" },
        updatedAt: new Date().toISOString(),
      });
      return true;
    } catch (error) {
      setEditError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setEditingAction("");
    }
  };

  const showReplacementCandidates = async (clipId: string) => {
    if (!currentPlan || !window.videoAnalyzer?.listEditReplacementCandidates) {
      setEditError("当前环境不能加载替换镜头");
      return;
    }
    setEditError("");
    setReplacingClipId(clipId);
    if (replacementCandidates[clipId]) return;
    setEditingAction("load_replacements");
    try {
      const candidates = await window.videoAnalyzer.listEditReplacementCandidates({
        planId: currentPlan.id,
        clipId,
      });
      setReplacementCandidates((current) => ({
        ...current,
        [clipId]: candidates,
      }));
    } catch (error) {
      setEditError(error instanceof Error ? error.message : String(error));
      setReplacingClipId("");
    } finally {
      setEditingAction("");
    }
  };

  const exportPackage = async () => {
    const planId = currentPlan?.id || session?.currentEditPlanId;
    if (!planId || !window.videoAnalyzer?.exportEditPlanPackage) {
      setExportError("当前环境不能导出素材包");
      return;
    }
    setExportError("");
    setExportResult(null);
    setExportingPackage(true);
    try {
      const result = await window.videoAnalyzer.exportEditPlanPackage({ planId });
      if (!result.cancelled) setExportResult(result);
    } catch (error) {
      setExportError(error instanceof Error ? error.message : String(error));
    } finally {
      setExportingPackage(false);
    }
  };

  const selectMusic = async () => {
    const planId = currentPlan?.id || session?.currentEditPlanId;
    if (!planId || !window.videoAnalyzer?.selectEditPlanMusic || !session) {
      setMusicError("当前环境不能添加 BGM");
      return;
    }
    setMusicError("");
    setMusicBusy(true);
    try {
      const result = await window.videoAnalyzer.selectEditPlanMusic({ planId });
      if (!("plan" in result)) return;
      const steps = editPlanToStudioSteps(result.plan, assetProjects);
      setCurrentPlan(result.plan);
      setVariantPlans((current) => replaceVariantBranch(current, result.plan));
      setPreview(null);
      upsertSession({
        ...session,
        steps,
        missingShots: collectMissingShots(steps),
        currentEditPlanId: result.plan.id,
        output: { kind: "draft" },
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      setMusicError(error instanceof Error ? error.message : String(error));
    } finally {
      setMusicBusy(false);
    }
  };

  const synthesizeVoiceover = async (
    anchorClipId: string,
    audioClipId: string | undefined,
    text: string,
  ) => {
    const planId = currentPlan?.id || session?.currentEditPlanId;
    if (!planId || !window.videoAnalyzer?.synthesizeEditPlanVoiceover || !session) {
      setEditError("当前环境不能合成旁白");
      return false;
    }
    setEditError("");
    setEditingAction("synthesize_voiceover");
    try {
      const result = await window.videoAnalyzer.synthesizeEditPlanVoiceover({
        planId,
        anchorClipId,
        ...(audioClipId ? { audioClipId } : {}),
        text,
      });
      const steps = editPlanToStudioSteps(result.plan, assetProjects);
      setCurrentPlan(result.plan);
      setVariantPlans((current) => replaceVariantBranch(current, result.plan));
      setPreview(null);
      upsertSession({
        ...session,
        steps,
        missingShots: collectMissingShots(steps),
        currentEditPlanId: result.plan.id,
        output: { kind: "draft" },
        updatedAt: new Date().toISOString(),
      });
      return true;
    } catch (error) {
      setEditError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setEditingAction("");
    }
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
  const currentVideoTrack = currentPlan?.tracks.find((track) => track.kind === "video");
  const currentCaptionTrack = currentPlan?.tracks.find((track) => track.kind === "caption");
  const currentAudioTrack = currentPlan?.tracks.find((track) => track.kind === "audio");
  const currentOverlayTrack = currentPlan?.tracks.find((track) => track.kind === "overlay");
  const currentMusics = currentAudioTrack?.kind === "audio"
    ? currentAudioTrack.items
      .filter((clip) => clip.kind === "music")
      .sort((left, right) => left.timelineInUs - right.timelineInUs)
    : [];
  const currentVoiceovers = currentAudioTrack?.kind === "audio"
    ? currentAudioTrack.items.filter((clip) => clip.kind === "voiceover")
    : [];
  const currentBeatSuggestions = currentMusics.flatMap((music) =>
    (music.beatSyncSuggestions || []).map((suggestion) => ({
      music,
      suggestion,
    })));
  const pendingBeatSuggestions = currentBeatSuggestions.filter(({ suggestion }) =>
    Math.abs(suggestion.offsetUs) > 1_000);
  const alignedBeatSuggestionCount = currentBeatSuggestions.length
    - pendingBeatSuggestions.length;
  const evidenceQuality = currentPlan?.provenance.evidenceQuality;

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
        {currentPlan?.parentPlanId && (
          <button
            onClick={() => applyFeedback({
              type: "restore_plan",
              targetPlanId: currentPlan.parentPlanId as string,
            })}
            disabled={Boolean(editingAction)}
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-[12.5px] text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50"
          >
            <ArrowLeft className="w-3 h-3" strokeWidth={1.5} />
            撤销上一步
          </button>
        )}
        <button
          onClick={() => regenerateSteps(1)}
          disabled={generating}
          className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-[12.5px] text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50"
        >
          <RefreshCw className={`w-3 h-3 ${generating ? "animate-spin" : ""}`} strokeWidth={1.5} />
          {generating ? "LLM 生成中…" : "重新生成"}
        </button>
        <button
          onClick={() => regenerateSteps(3)}
          disabled={generating}
          className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-slate-300 dark:border-slate-700 text-[12.5px] text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50"
        >
          <Scissors className="w-3 h-3" strokeWidth={1.5} />
          生成对比
        </button>
        <button
          onClick={exportPackage}
          disabled={!currentPlan || exportingPackage}
          className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-[12.5px] bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white"
        >
          <Download className="w-3 h-3" strokeWidth={1.5} />
          {exportingPackage ? "导出中…" : "导出素材包"}
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
          <KVRow
            label="目标时长"
            value={duration}
            options={DURATION_OPTIONS.includes(duration)
              ? DURATION_OPTIONS
              : [duration, ...DURATION_OPTIONS]}
            onChange={(v) => {
              setDuration(v);
              save({ targetDurationSec: parseStudioDuration(v) });
            }}
          />

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
          {variantPlans.length > 1 && (
            <section className="mb-4 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/60 p-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-[10.5px] font-mono tracking-[0.14em] uppercase text-slate-500">
                    方案对比
                  </div>
                  <div className="mt-1 text-[12px] text-slate-600 dark:text-slate-400">
                    独立预览与调整
                  </div>
                </div>
                <span className="text-[10.5px] font-mono text-slate-500">
                  {variantPlans.length} 个版本
                </span>
              </div>
              <div className="mt-2 grid grid-cols-3 gap-2">
                {variantPlans.map((plan) => {
                  const variant = plan.provenance.variant;
                  const facts = editPlanComparisonFacts(plan);
                  const active = currentPlan?.id === plan.id;
                  return (
                    <button
                      key={plan.id}
                      onClick={() => activateVariant(plan)}
                      disabled={active || Boolean(editingAction)}
                      className={`min-w-0 rounded-md border p-2 text-left disabled:opacity-100 ${
                        active
                          ? "border-indigo-300 dark:border-indigo-700 bg-indigo-50 dark:bg-indigo-950/40"
                          : "border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950/50 hover:border-slate-300 dark:hover:border-slate-600"
                      }`}
                    >
                      <div className="flex items-center gap-1.5">
                        <span className={`min-w-0 flex-1 truncate text-[12px] font-medium ${
                          active
                            ? "text-indigo-700 dark:text-indigo-300"
                            : "text-slate-900 dark:text-slate-100"
                        }`}>
                          {variant?.label || "粗剪版本"}
                        </span>
                        {active && (
                          <Check className="w-3 h-3 text-indigo-600 dark:text-indigo-400" strokeWidth={2} />
                        )}
                      </div>
                      <div className="mt-1 line-clamp-2 text-[10.5px] leading-relaxed text-slate-500 dark:text-slate-400">
                        {variant?.description}
                      </div>
                      <div className="mt-1.5 text-[10px] font-mono text-slate-500 dark:text-slate-400">
                        {facts.clipCount} 镜头 · {facts.videoCount} 素材 · {formatTimeShort(plan.actualDurationUs / 1_000_000)}
                      </div>
                      {facts.emotionLabels && (
                        <div className="mt-0.5 truncate text-[10px] text-slate-500 dark:text-slate-400">
                          {facts.emotionLabels}
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            </section>
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
          {evidenceQuality && (
            <section className="mb-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/60 p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="text-[10.5px] font-mono tracking-[0.14em] uppercase text-slate-500">
                  分析证据
                </div>
                <span className={`text-[10.5px] font-mono ${
                  evidenceQuality.planning.readiness === "ready"
                    ? "text-emerald-700 dark:text-emerald-300"
                    : evidenceQuality.planning.readiness === "blocked"
                      ? "text-rose-700 dark:text-rose-300"
                      : "text-amber-700 dark:text-amber-300"
                }`}>
                  {evidenceQuality.planning.readiness === "ready"
                    ? "可用"
                    : evidenceQuality.planning.readiness === "blocked"
                      ? "不可用"
                      : "部分可用"}
                </span>
              </div>
              <div className="mt-2 grid grid-cols-4 gap-2">
                {[
                  ["语义", evidenceQuality.semantic.capability === "segment"
                    ? `分段 ${Math.round(evidenceQuality.semantic.segmentCoverageRatio * 100)}%`
                    : evidenceQuality.semantic.capability === "none"
                      ? "无"
                      : `镜头 ${Math.round(evidenceQuality.semantic.coverageRatio * 100)}%`],
                  ["字幕", evidenceQuality.transcript.capability === "word"
                    ? "逐字"
                    : evidenceQuality.transcript.capability === "segment"
                      ? "分段"
                      : "无"],
                  ["人物", evidenceQuality.identity.capability === "cross_video"
                    ? `跨素材 ${evidenceQuality.identity.crossVideoPersonCount}`
                    : evidenceQuality.identity.capability === "tracking"
                      ? "单素材轨迹"
                      : "无"],
                  ["说话人", evidenceQuality.speakers.capability === "linked"
                    ? "已关联人物"
                    : evidenceQuality.speakers.capability === "diarized"
                      ? "已分离"
                      : "无"],
                ].map(([label, value]) => (
                  <div key={label} className="rounded-md bg-slate-50 dark:bg-slate-800/60 px-2 py-1.5">
                    <div className="text-[10px] text-slate-500">{label}</div>
                    <div className="mt-0.5 text-[11.5px] font-mono text-slate-800 dark:text-slate-200">
                      {value}
                    </div>
                  </div>
                ))}
              </div>
              {evidenceQuality.planning.issues.slice(0, 3).map((issue) => (
                <div
                  key={issue.code}
                  className="mt-1.5 text-[11px] text-slate-600 dark:text-slate-400"
                >
                  {issue.message}
                </div>
              ))}
            </section>
          )}
          {editError && (
            <div className="mb-3 rounded-md border border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-[12px] text-amber-700 dark:text-amber-300">
              {editError}
            </div>
          )}
          {exportResult && (
            <div className="mb-3 rounded-md border border-emerald-200 dark:border-emerald-900/50 bg-emerald-50 dark:bg-emerald-950/30 px-3 py-2">
              <div className="text-[12px] text-emerald-800 dark:text-emerald-200">
                素材包已导出 · {exportResult.fileCount} 个文件
              </div>
              <div className="mt-1 text-[10.5px] font-mono text-emerald-700 dark:text-emerald-300 break-all">
                {exportResult.packagePath}
              </div>
              {exportResult.warnings.map((warning) => (
                <div key={`${warning.code}-${warning.itemId || ""}`} className="mt-1 text-[11px] text-amber-700 dark:text-amber-300">
                  {warning.message}
                </div>
              ))}
            </div>
          )}
          {exportError && (
            <div className="mb-3 rounded-md border border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-[12px] text-amber-700 dark:text-amber-300">
              {exportError}
            </div>
          )}

          {steps.length === 0 ? (
            <div className="border border-dashed border-slate-300 dark:border-slate-700 rounded-xl bg-white dark:bg-slate-900/30 px-8 py-12 text-center">
              <Wand2 className="w-5 h-5 mx-auto text-slate-400 dark:text-slate-500 mb-3" strokeWidth={1.5} />
              <p className="text-[13.5px] text-slate-700 dark:text-slate-300 font-medium">先填好剪辑目标 + 应用方法论</p>
              <p className="text-[12.5px] text-slate-500 dark:text-slate-400 mt-2 max-w-md mx-auto">
                然后点右上角「重新生成」让系统基于素材库 × 方法论给出叙事骨架
              </p>
              <button
                onClick={() => regenerateSteps(1)}
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
                      {currentVideoTrack?.kind === "video"
                        && currentVideoTrack.items[i]
                        && currentVoiceovers
                          .filter((voiceover) =>
                            voiceover.anchorClipId === currentVideoTrack.items[i].id)
                          .map((voiceover) => (
                            <div
                              key={voiceover.id}
                              className="flex items-center gap-2 text-[11.5px] text-slate-600 dark:text-slate-400"
                            >
                              <Mic2 className="w-3 h-3 text-slate-400" strokeWidth={1.5} />
                              <span className="truncate">旁白：{voiceover.ttsText}</span>
                              <span className="font-mono text-[10.5px]">
                                {voiceover.sourcePath ? "已合成" : "待合成"}
                              </span>
                            </div>
                          ))}
                    </div>
                    {currentVideoTrack?.kind === "video" && currentVideoTrack.items[i] && (
                      <div className="mt-3 flex flex-wrap items-center gap-1.5">
                        <button
                          onClick={() => applyFeedback({
                            type: "keep_clip",
                            clipId: currentVideoTrack.items[i].id,
                          })}
                          disabled={Boolean(editingAction)}
                          className="h-7 px-2 rounded-md border border-slate-300 dark:border-slate-700 text-[11.5px] text-slate-600 dark:text-slate-300 disabled:opacity-50"
                        >
                          保留
                        </button>
                        <button
                          onClick={() => applyFeedback({
                            type: "move_clip",
                            clipId: currentVideoTrack.items[i].id,
                            toIndex: i - 1,
                          })}
                          disabled={Boolean(editingAction) || i === 0}
                          aria-label="镜头上移"
                          className="h-7 w-7 inline-flex items-center justify-center rounded-md border border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-300 disabled:opacity-30"
                        >
                          <ArrowUp className="w-3 h-3" strokeWidth={1.5} />
                        </button>
                        <button
                          onClick={() => applyFeedback({
                            type: "move_clip",
                            clipId: currentVideoTrack.items[i].id,
                            toIndex: i + 1,
                          })}
                          disabled={Boolean(editingAction) || i === currentVideoTrack.items.length - 1}
                          aria-label="镜头下移"
                          className="h-7 w-7 inline-flex items-center justify-center rounded-md border border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-300 disabled:opacity-30"
                        >
                          <ArrowDown className="w-3 h-3" strokeWidth={1.5} />
                        </button>
                        <button
                          onClick={() => {
                            const clip = currentVideoTrack.items[i];
                            applyFeedback({
                              type: "trim_clip",
                              clipId: clip.id,
                              sourceInUs: clip.sourceInUs,
                              sourceOutUs: clip.sourceOutUs - 500_000,
                            });
                          }}
                          disabled={
                            Boolean(editingAction)
                            || currentVideoTrack.items[i].sourceOutUs
                              - currentVideoTrack.items[i].sourceInUs <= 700_000
                          }
                          className="h-7 px-2 rounded-md border border-slate-300 dark:border-slate-700 text-[11.5px] text-slate-600 dark:text-slate-300 disabled:opacity-30"
                        >
                          缩短 0.5s
                        </button>
                        <button
                          onClick={() => showReplacementCandidates(currentVideoTrack.items[i].id)}
                          disabled={Boolean(editingAction)}
                          className="h-7 px-2 rounded-md border border-slate-300 dark:border-slate-700 text-[11.5px] text-slate-600 dark:text-slate-300 disabled:opacity-50"
                        >
                          替换
                        </button>
                        {i > 0 && (
                          <button
                            onClick={() => {
                              const left = currentVideoTrack.items[i - 1];
                              const right = currentVideoTrack.items[i];
                              const transition = currentPlan?.transitions.find((item) =>
                                item.fromClipId === left.id && item.toClipId === right.id);
                              const enable = !transition || transition.type === "cut";
                              applyFeedback({
                                type: "set_transition",
                                fromClipId: left.id,
                                toClipId: right.id,
                                transitionType: enable ? "dissolve" : "cut",
                                durationUs: enable ? 300_000 : 0,
                              });
                            }}
                            disabled={Boolean(editingAction)}
                            className="h-7 px-2 rounded-md border border-slate-300 dark:border-slate-700 text-[11.5px] text-slate-600 dark:text-slate-300 disabled:opacity-50"
                          >
                            {currentPlan?.transitions.some((item) =>
                              item.toClipId === currentVideoTrack.items[i].id && item.type !== "cut")
                              ? "改为硬切"
                              : "启用叠化"}
                          </button>
                        )}
                        <button
                          onClick={() => applyFeedback({
                            type: "delete_clip",
                            clipId: currentVideoTrack.items[i].id,
                          })}
                          disabled={Boolean(editingAction) || currentVideoTrack.items.length <= 1}
                          className="h-7 px-2 inline-flex items-center gap-1 rounded-md border border-red-200 dark:border-red-900/60 text-[11.5px] text-red-600 dark:text-red-300 disabled:opacity-30"
                        >
                          <Trash2 className="w-3 h-3" strokeWidth={1.5} />
                          删除
                        </button>
                        {currentCaptionTrack?.kind === "caption" && (
                          currentCaptionTrack.items
                            .filter((cue) => cue.sourceClipId === currentVideoTrack.items[i].id)
                            .slice(0, 1)
                            .map((cue) => (
                              <CaptionEditor
                                key={`${currentPlan?.id}-${cue.id}`}
                                initialText={cue.text}
                                disabled={Boolean(editingAction)}
                                onSave={(text) => applyFeedback({
                                  type: "update_caption",
                                  cueId: cue.id,
                                  text,
                                })}
                              />
                            ))
                        )}
                        {(() => {
                          const clip = currentVideoTrack.items[i];
                          const voiceover = currentVoiceovers.find((item) =>
                            item.anchorClipId === clip.id);
                          return (
                            <VoiceoverEditor
                              key={`${currentPlan?.id}-${voiceover?.id || clip.id}`}
                              initialText={voiceover?.ttsText || ""}
                              synthesized={Boolean(voiceover?.sourcePath)}
                              disabled={Boolean(editingAction)}
                              busy={editingAction === "synthesize_voiceover"}
                              onSave={(text) => synthesizeVoiceover(
                                clip.id,
                                voiceover?.id,
                                text,
                              )}
                              onRemove={voiceover
                                ? () => applyFeedback({
                                  type: "remove_voiceover",
                                  audioClipId: voiceover.id,
                                })
                                : undefined}
                            />
                          );
                        })()}
                        {overlayTemplates.length > 0 && (
                          <OverlayTemplateEditor
                            key={`${currentPlan?.id}-overlay-${currentVideoTrack.items[i].id}`}
                            anchorClipId={currentVideoTrack.items[i].id}
                            templates={overlayTemplates}
                            overlays={currentOverlayTrack?.kind === "overlay"
                              ? currentOverlayTrack.items.filter((overlay) =>
                                overlay.anchorClipId === currentVideoTrack.items[i].id)
                              : []}
                            disabled={Boolean(editingAction)}
                            onApply={(templateKey, text) => applyFeedback({
                              type: "set_overlay_template",
                              anchorClipId: currentVideoTrack.items[i].id,
                              templateKey,
                              ...(text.trim() ? { text: text.trim() } : {}),
                            })}
                            onRemove={(overlayId) => applyFeedback({
                              type: "remove_overlay",
                              overlayId,
                            })}
                          />
                        )}
                        {replacingClipId === currentVideoTrack.items[i].id && (
                          <div className="basis-full mt-1 flex items-center gap-1.5">
                            <select
                              defaultValue=""
                              disabled={Boolean(editingAction)}
                              onChange={(event) => {
                                if (!event.target.value) return;
                                applyFeedback({
                                  type: "replace_clip",
                                  clipId: currentVideoTrack.items[i].id,
                                  replacementCandidateId: event.target.value,
                                  intent: "用户替换镜头",
                                });
                              }}
                              className="h-8 flex-1 min-w-0 px-2 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-[12px] text-slate-700 dark:text-slate-200"
                            >
                              <option value="">
                                {editingAction === "load_replacements"
                                  ? "加载候选中…"
                                  : (replacementCandidates[currentVideoTrack.items[i].id]?.length || 0) > 0
                                    ? "选择候选片段"
                                    : "没有未使用的候选片段"}
                              </option>
                              {(replacementCandidates[currentVideoTrack.items[i].id] || [])
                                .map((candidate) => (
                                  <option
                                    key={candidate.candidateId}
                                    value={candidate.candidateId}
                                  >
                                    {candidate.description || candidate.subtitle || candidate.shotId}
                                    {" · "}
                                    {(candidate.startUs / 1_000_000).toFixed(1)}-
                                    {(candidate.endUs / 1_000_000).toFixed(1)}s
                                  </option>
                                ))}
                            </select>
                            <button
                              onClick={() => setReplacingClipId("")}
                              className="h-8 px-2 rounded-md border border-slate-300 dark:border-slate-700 text-[11.5px] text-slate-600 dark:text-slate-300"
                            >
                              取消
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </li>
                ))}
              </ol>

              <div className="flex gap-2.5 mt-5">
                <button
                  onClick={() => regenerateSteps(1)}
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

          {currentPlan && (
            <div className="rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/60 p-3 mb-3">
              <div className="flex items-center gap-1.5 text-[10.5px] font-mono tracking-wider uppercase text-slate-500 dark:text-slate-400">
                <Music2 className="w-3 h-3" strokeWidth={1.5} />
                {currentPlan.emotionSegments?.length
                  ? `情绪 BGM · ${currentPlan.emotionSegments.length} 段`
                  : "BGM"}
              </div>
              {currentMusics.length > 0 ? (
                <>
                  <div className="mt-2 space-y-1.5">
                    {currentMusics.map((music) => {
                      const durationUs = music.sourceOutUs - music.sourceInUs;
                      const endUs = music.timelineInUs + durationUs;
                      return (
                        <div
                          key={music.id}
                          className="rounded-md bg-slate-50 dark:bg-slate-950/70 px-2 py-1.5"
                        >
                          <div className="flex items-center gap-2">
                            <span className="min-w-0 flex-1 truncate text-[12px] text-slate-900 dark:text-slate-100">
                              {music.sourcePath?.split(/[\\/]/).pop() || "本地音频"}
                            </span>
                            <button
                              onClick={() => applyFeedback({
                                type: "remove_music",
                                audioClipId: music.id,
                              })}
                              disabled={musicBusy || Boolean(editingAction)}
                              aria-label={`移除 ${music.sourcePath?.split(/[\\/]/).pop() || "BGM"}`}
                              className="h-6 px-1.5 rounded-sm text-[10.5px] text-red-600 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/30 disabled:opacity-50"
                            >
                              移除
                            </button>
                          </div>
                          <div className="mt-0.5 text-[10.5px] font-mono text-slate-500 dark:text-slate-400">
                            {music.mood ? `${EMOTION_TONE_LABELS[music.mood]} · ` : ""}
                            {formatTimeShort(music.timelineInUs / 1_000_000)}
                            {"–"}{formatTimeShort(endUs / 1_000_000)}
                            {music.beatAnalysis?.status === "usable"
                              ? ` · ${music.beatAnalysis.bpm?.toFixed(1)} BPM`
                              : music.beatAnalysis?.status === "low_confidence"
                                ? ` · 置信度 ${Math.round(music.beatAnalysis.confidence * 100)}%`
                                : " · 无稳定节拍"}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <div className="mt-1.5 text-[10.5px] font-mono text-slate-500 dark:text-slate-400">
                    {pendingBeatSuggestions.length > 0
                      ? `${pendingBeatSuggestions.length} 个待对齐`
                      : alignedBeatSuggestionCount > 0
                        ? "切点已对齐"
                        : "暂无近邻切点"}
                  </div>
                  {pendingBeatSuggestions.length > 0 && (
                    <div className="mt-2 space-y-1.5">
                      {pendingBeatSuggestions.slice(0, 3).map(({ music, suggestion }) => {
                        const toIndex = currentVideoTrack?.kind === "video"
                          ? currentVideoTrack.items.findIndex((clip) =>
                            clip.id === suggestion.toClipId)
                          : -1;
                        const direction = suggestion.offsetUs > 0 ? "延后" : "提前";
                        const offsetMs = Math.round(Math.abs(suggestion.offsetUs) / 1_000);
                        return (
                          <div
                            key={`${music.id}-${suggestion.fromClipId}-${suggestion.toClipId}`}
                            className="flex items-center gap-2 rounded-md bg-slate-50 dark:bg-slate-950/70 px-2 py-1.5"
                          >
                            <span className="min-w-0 flex-1 truncate text-[10.5px] font-mono text-slate-600 dark:text-slate-400">
                              切到 #{String(Math.max(0, toIndex) + 1).padStart(2, "0")}
                              {" · "}{direction} {offsetMs} ms
                            </span>
                            <button
                              onClick={() => applyFeedback({
                                type: "apply_beat_sync",
                                audioClipId: music.id,
                                fromClipId: suggestion.fromClipId,
                                toClipId: suggestion.toClipId,
                                beatTimeUs: suggestion.beatTimeUs,
                              })}
                              disabled={Boolean(editingAction)}
                              aria-label={`对齐镜头 ${Math.max(0, toIndex) + 1} 卡点`}
                              className="h-7 px-2 rounded-md border border-slate-300 dark:border-slate-700 text-[11.5px] text-slate-700 dark:text-slate-300 disabled:opacity-50"
                            >
                              {editingAction === "apply_beat_sync" ? "对齐中…" : "对齐"}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  <div className="mt-2 flex items-center gap-1.5">
                    <button
                      onClick={selectMusic}
                      disabled={musicBusy || Boolean(editingAction)}
                      className="h-7 px-2 rounded-md border border-slate-300 dark:border-slate-700 text-[11.5px] text-slate-600 dark:text-slate-300 disabled:opacity-50"
                    >
                      {musicBusy ? "分析中…" : "替换编排"}
                    </button>
                  </div>
                </>
              ) : (
                <button
                  onClick={selectMusic}
                  disabled={musicBusy}
                  className="mt-2 h-8 w-full rounded-md border border-slate-300 dark:border-slate-700 text-[12px] text-slate-700 dark:text-slate-300 disabled:opacity-50"
                >
                  {musicBusy ? "分析中…" : "添加 BGM"}
                </button>
              )}
              {musicError && (
                <div className="mt-2 text-[11px] text-amber-700 dark:text-amber-300">
                  {musicError}
                </div>
              )}
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

const CaptionEditor: FunctionComponent<{
  initialText: string;
  disabled: boolean;
  onSave: (text: string) => Promise<boolean>;
}> = ({ initialText, disabled, onSave }) => {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(initialText);

  if (!editing) {
    return (
      <button
        onClick={() => setEditing(true)}
        disabled={disabled}
        className="h-7 px-2 inline-flex items-center gap-1 rounded-md border border-slate-300 dark:border-slate-700 text-[11.5px] text-slate-600 dark:text-slate-300 disabled:opacity-50"
      >
        <Captions className="w-3 h-3" strokeWidth={1.5} />
        改字幕
      </button>
    );
  }
  return (
    <div className="flex items-center gap-1.5 basis-full mt-1">
      <input
        value={value}
        onChange={(event) => setValue(event.target.value)}
        className="h-8 flex-1 min-w-0 px-2 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-[12px] text-slate-800 dark:text-slate-200"
      />
      <button
        onClick={async () => {
          if (await onSave(value)) setEditing(false);
        }}
        disabled={disabled || !value.trim()}
        className="h-8 px-2 rounded-md bg-indigo-600 text-white text-[11.5px] disabled:opacity-50"
      >
        保存
      </button>
      <button
        onClick={() => {
          setValue(initialText);
          setEditing(false);
        }}
        className="h-8 px-2 rounded-md border border-slate-300 dark:border-slate-700 text-[11.5px] text-slate-600 dark:text-slate-300"
      >
        取消
      </button>
    </div>
  );
};

const VoiceoverEditor: FunctionComponent<{
  initialText: string;
  synthesized: boolean;
  disabled: boolean;
  busy: boolean;
  onSave: (text: string) => Promise<boolean>;
  onRemove?: () => Promise<boolean>;
}> = ({ initialText, synthesized, disabled, busy, onSave, onRemove }) => {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(initialText);

  if (!editing) {
    return (
      <button
        onClick={() => setEditing(true)}
        disabled={disabled}
        className="h-7 px-2 inline-flex items-center gap-1 rounded-md border border-slate-300 dark:border-slate-700 text-[11.5px] text-slate-600 dark:text-slate-300 disabled:opacity-50"
      >
        <Mic2 className="w-3 h-3" strokeWidth={1.5} />
        {initialText ? (synthesized ? "改旁白" : "合成旁白") : "加旁白"}
      </button>
    );
  }

  return (
    <div className="basis-full mt-1 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/60 p-2">
      <textarea
        value={value}
        maxLength={500}
        onChange={(event) => setValue(event.target.value)}
        placeholder="输入这段镜头的旁白"
        className="min-h-16 w-full resize-y rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1.5 text-[12.5px] leading-relaxed text-slate-800 dark:text-slate-200"
      />
      <div className="mt-2 flex items-center gap-1.5">
        <button
          onClick={async () => {
            if (await onSave(value)) setEditing(false);
          }}
          disabled={disabled || !value.trim()}
          className="h-8 px-2 rounded-md bg-indigo-600 text-white text-[11.5px] disabled:opacity-50"
        >
          {busy ? "合成中…" : synthesized ? "重新合成" : "合成"}
        </button>
        {onRemove && (
          <button
            onClick={async () => {
              if (await onRemove()) setEditing(false);
            }}
            disabled={disabled}
            className="h-8 px-2 rounded-md text-[11.5px] text-red-600 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/30 disabled:opacity-50"
          >
            移除
          </button>
        )}
        <button
          onClick={() => {
            setValue(initialText);
            setEditing(false);
          }}
          className="h-8 px-2 rounded-md border border-slate-300 dark:border-slate-700 text-[11.5px] text-slate-600 dark:text-slate-300"
        >
          取消
        </button>
      </div>
    </div>
  );
};

const OverlayTemplateEditor: FunctionComponent<{
  anchorClipId: string;
  templates: OverlayTemplateDefinition[];
  overlays: OverlayItem[];
  disabled: boolean;
  onApply: (templateKey: string, text: string) => Promise<boolean>;
  onRemove: (overlayId: string) => Promise<boolean>;
}> = ({
  anchorClipId,
  templates,
  overlays,
  disabled,
  onApply,
  onRemove,
}) => {
  const [editing, setEditing] = useState(false);
  const [templateKey, setTemplateKey] = useState(templates[0]?.key || "");
  const [text, setText] = useState("");
  const selected = templates.find((template) => template.key === templateKey);
  const templateByKey = new Map<string, OverlayTemplateDefinition>(
    templates.map((template) => [template.key, template]),
  );

  if (!editing) {
    return (
      <button
        onClick={() => setEditing(true)}
        disabled={disabled || templates.length === 0}
        className="h-7 px-2 inline-flex items-center gap-1 rounded-md border border-slate-300 dark:border-slate-700 text-[11.5px] text-slate-600 dark:text-slate-300 disabled:opacity-50"
      >
        <Sparkles className="w-3 h-3" strokeWidth={1.5} />
        {overlays.length > 0 ? `视觉模板 · ${overlays.length}` : "加视觉模板"}
      </button>
    );
  }

  return (
    <div
      data-overlay-editor={anchorClipId}
      className="basis-full mt-1 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/60 p-2"
    >
      {overlays.length > 0 && (
        <div className="mb-2 space-y-1">
          {overlays.map((overlay) => (
            <div
              key={overlay.id}
              className="flex items-center gap-2 rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 px-2 py-1.5"
            >
              <span className="min-w-0 flex-1 truncate text-[11.5px] text-slate-700 dark:text-slate-300">
                {templateByKey.get(overlay.resourceKey || "")?.label || "视觉模板"}
                {overlay.text ? ` · ${overlay.text}` : ""}
              </span>
              <span className="font-mono text-[10px] text-slate-500">
                {formatTimeShort((overlay.endUs - overlay.startUs) / 1_000_000)}
              </span>
              <button
                onClick={() => onRemove(overlay.id)}
                disabled={disabled}
                className="h-6 px-1.5 rounded-sm text-[10.5px] text-red-600 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/30 disabled:opacity-50"
              >
                移除
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="flex items-center gap-1.5">
        <select
          value={templateKey}
          onChange={(event) => {
            setTemplateKey(event.target.value);
            setText("");
          }}
          disabled={disabled}
          className="h-8 min-w-32 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 text-[11.5px] text-slate-700 dark:text-slate-200"
        >
          {templates.map((template) => (
            <option key={template.key} value={template.key}>
              {template.label}
            </option>
          ))}
        </select>
        {selected?.textRequired && (
          <input
            value={text}
            maxLength={selected.maxTextLength}
            onChange={(event) => setText(event.target.value)}
            placeholder="输入花字"
            className="h-8 min-w-0 flex-1 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 text-[11.5px] text-slate-800 dark:text-slate-200"
          />
        )}
        <button
          onClick={async () => {
            if (selected && await onApply(selected.key, text)) {
              setEditing(false);
              setText("");
            }
          }}
          disabled={
            disabled
            || !selected
            || Boolean(selected.textRequired && !text.trim())
          }
          className="h-8 px-2 rounded-md bg-indigo-600 text-white text-[11.5px] disabled:opacity-50"
        >
          应用
        </button>
        <button
          onClick={() => {
            setText("");
            setEditing(false);
          }}
          className="h-8 px-2 rounded-md border border-slate-300 dark:border-slate-700 text-[11.5px] text-slate-600 dark:text-slate-300"
        >
          取消
        </button>
      </div>
      {selected && (
        <p className="mt-1.5 text-[10.5px] text-slate-500 dark:text-slate-400">
          {selected.description}
        </p>
      )}
    </div>
  );
};

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
  const captionTrack = plan.tracks.find((track) => track.kind === "caption");
  const durationWarning = plan.validation.warnings
    .find((issue) => issue.code === "TARGET_DURATION_MISS");

  return videoTrack.items.map((clip, index) => {
    const durationUs = Math.round((clip.sourceOutUs - clip.sourceInUs) / clip.speed);
    const startSec = clip.timelineInUs / 1_000_000;
    const endSec = (clip.timelineInUs + durationUs) / 1_000_000;
    const asset = assets.find((item) => item.id === clip.videoId);
    const subtitle = (captionTrack?.kind === "caption"
      ? captionTrack.items.filter((cue) => cue.sourceClipId === clip.id)
      : clip.evidence?.subtitleSegments || [])
      .map((segment) => segment.text)
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
