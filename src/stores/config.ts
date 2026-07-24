import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import type {
  AppConfig,
  DefaultAnalysis,
  ModelProvider,
  PipelineId,
  PipelineSlotConfig,
  PipelineSlots,
  SlotAssignment,
  SlotOverrides,
  TaskSlotKey,
  TaskSlots,
} from "../types";

const LOCAL_STORAGE_KEY = "video-analyzer-state";

const DEFAULT_PROVIDERS: ModelProvider[] = [
  {
    id: "default-video",
    name: "默认视觉模型 (示例)",
    source: "remote",
    baseUrl: "https://api.openai.com/v1",
    apiKeyRef: "",
    endpointType: "openai_chat_completions",
    inputMode: "auto",
    models: [{ id: "gpt-4o-mini", label: "gpt-4o-mini", capabilities: ["vision", "reasoning"] }],
    model: "gpt-4o-mini",
    kind: "video",
  },
];

const DEFAULT_TASK_SLOTS: TaskSlots = {
  simple_vision: null,
  simple_text: null,
  medium_vision: null,
  medium_text: null,
  complex_vision: { providerId: "default-video", modelId: "gpt-4o-mini" },
  complex_text: { providerId: "default-video", modelId: "gpt-4o-mini" },
};

const DEFAULT_ANALYSIS: DefaultAnalysis = { preset: "standard", manualGenre: "auto" };

function buildDefaultPipelineSlots(ts: TaskSlots, audio: SlotAssignment): PipelineSlots {
  return {
    content: { taskSlots: { complex_vision: ts.complex_vision }, audioSlot: audio },
    pipeline: {
      taskSlots: { simple_vision: ts.simple_vision, medium_text: ts.medium_text, complex_vision: ts.complex_vision },
      audioSlot: audio,
    },
  };
}

interface ConfigState {
  providers: ModelProvider[];
  taskSlots: TaskSlots;
  audioSlot: SlotAssignment;
  pipelineSlots: PipelineSlots;
  defaultAnalysis: DefaultAnalysis;
  localModelOverrides: Record<string, { contextSize?: number }>;
  pendingSlotOverrides: Record<string, SlotOverrides>;
  _hydrated: boolean;

  setProviders: (fn: ModelProvider[] | ((prev: ModelProvider[]) => ModelProvider[])) => void;
  setTaskSlot: (key: TaskSlotKey, assignment: SlotAssignment) => void;
  setAudioSlot: (assignment: SlotAssignment) => void;
  setPipelineSlot: (pipelineId: PipelineId, slotKey: TaskSlotKey | "__audio__", assignment: SlotAssignment) => void;
  getPipelineSlot: (pipelineId: PipelineId, slotKey: TaskSlotKey | "__audio__") => SlotAssignment;
  setDefaultAnalysis: (fn: DefaultAnalysis | ((prev: DefaultAnalysis) => DefaultAnalysis)) => void;
  updateLocalModelOverride: (modelKey: string, patch: { contextSize?: number } | null) => void;
  setPendingSlotOverrides: (fn: Record<string, SlotOverrides> | ((prev: Record<string, SlotOverrides>) => Record<string, SlotOverrides>)) => void;

  /** @deprecated use getPipelineSlot with pipelineId */
  activeVideoProviderId: string | null;
  /** @deprecated */
  setActiveVideoProviderId: (id: string | null) => void;
  /** @deprecated */
  activeAudioProviderId: string | null;
  /** @deprecated */
  setActiveAudioProviderId: (id: string | null) => void;

  hydrate: (config: AppConfig) => void;
}

export const useConfigStore = create<ConfigState>()(
  subscribeWithSelector((set, get) => ({
    providers: DEFAULT_PROVIDERS,
    taskSlots: DEFAULT_TASK_SLOTS,
    audioSlot: null,
    pipelineSlots: buildDefaultPipelineSlots(DEFAULT_TASK_SLOTS, null),
    defaultAnalysis: DEFAULT_ANALYSIS,
    localModelOverrides: {},
    pendingSlotOverrides: {},
    _hydrated: false,

    setProviders: (fn) => set((s) => ({
      providers: typeof fn === "function" ? fn(s.providers) : fn,
    })),

    setTaskSlot: (key, assignment) => set((s) => ({
      taskSlots: { ...s.taskSlots, [key]: assignment },
    })),

    setAudioSlot: (assignment) => set({ audioSlot: assignment }),

    setPipelineSlot: (pipelineId, slotKey, assignment) => set((s) => {
      const cur = s.pipelineSlots[pipelineId] || { taskSlots: {}, audioSlot: null };
      if (slotKey === "__audio__") {
        return { pipelineSlots: { ...s.pipelineSlots, [pipelineId]: { ...cur, audioSlot: assignment } } };
      }
      return {
        pipelineSlots: { ...s.pipelineSlots, [pipelineId]: { ...cur, taskSlots: { ...cur.taskSlots, [slotKey]: assignment } } },
      };
    }),

    getPipelineSlot: (pipelineId, slotKey) => {
      const s = get();
      const pc = s.pipelineSlots[pipelineId];
      if (slotKey === "__audio__") return pc?.audioSlot !== undefined ? pc.audioSlot : s.audioSlot;
      const v = pc?.taskSlots?.[slotKey];
      return v !== undefined ? v : s.taskSlots[slotKey];
    },

    setDefaultAnalysis: (fn) => set((s) => ({
      defaultAnalysis: typeof fn === "function" ? fn(s.defaultAnalysis) : fn,
    })),

    updateLocalModelOverride: (modelKey, patch) => set((s) => {
      const next = { ...s.localModelOverrides };
      if (!patch) {
        delete next[modelKey];
      } else {
        const ctx = Number(patch.contextSize);
        if (ctx > 0) next[modelKey] = { contextSize: ctx };
        else delete next[modelKey];
      }
      return { localModelOverrides: next };
    }),

    setPendingSlotOverrides: (fn) => set((s) => ({
      pendingSlotOverrides: typeof fn === "function" ? fn(s.pendingSlotOverrides) : fn,
    })),

    activeVideoProviderId: null,
    setActiveVideoProviderId: (id) => {
      if (!id) {
        set((s) => ({ taskSlots: { ...s.taskSlots, complex_vision: null } }));
        return;
      }
      set((s) => {
        const existing = s.taskSlots.complex_vision;
        const provider = s.providers.find((p) => p.id === id);
        const modelId = existing?.providerId === id && existing?.modelId
          ? existing.modelId
          : provider?.models[0]?.id || "";
        return { taskSlots: { ...s.taskSlots, complex_vision: { providerId: id, modelId } } };
      });
    },

    activeAudioProviderId: null,
    setActiveAudioProviderId: (id) => {
      if (!id) { set({ audioSlot: null }); return; }
      set((s) => {
        const provider = s.providers.find((p) => p.id === id);
        if (s.audioSlot?.providerId === id && s.audioSlot?.modelId) return {};
        return { audioSlot: { providerId: id, modelId: provider?.models[0]?.id || "" } };
      });
    },

    hydrate: (config) => set({
      providers: config.providers?.length ? config.providers : DEFAULT_PROVIDERS,
      taskSlots: config.taskSlots || DEFAULT_TASK_SLOTS,
      audioSlot: config.audioSlot !== undefined ? config.audioSlot : null,
      pipelineSlots: config.pipelineSlots || buildDefaultPipelineSlots(config.taskSlots || DEFAULT_TASK_SLOTS, config.audioSlot ?? null),
      defaultAnalysis: config.defaultAnalysis || DEFAULT_ANALYSIS,
      localModelOverrides: config.localModelOverrides && typeof config.localModelOverrides === "object" ? config.localModelOverrides : {},
      _hydrated: true,
    }),
  })),
);

// Debounced persistence
let _persistTimer: ReturnType<typeof setTimeout> | undefined;
const PERSIST_FIELDS = (s: ConfigState) => [s.providers, s.taskSlots, s.audioSlot, s.pipelineSlots, s.defaultAnalysis, s.localModelOverrides] as const;

useConfigStore.subscribe(
  (s) => PERSIST_FIELDS(s),
  () => {
    const s = useConfigStore.getState();
    if (!s._hydrated) return;
    clearTimeout(_persistTimer);
    _persistTimer = setTimeout(() => {
      const config: AppConfig = {
        providers: s.providers,
        taskSlots: s.taskSlots,
        audioSlot: s.audioSlot,
        defaultAnalysis: s.defaultAnalysis,
        localModelOverrides: s.localModelOverrides,
        pipelineSlots: s.pipelineSlots,
        schemaVersion: 2,
      };
      if (window.videoAnalyzer) {
        window.videoAnalyzer.saveConfig(config).catch((err: unknown) => console.warn("saveConfig failed", err));
      } else {
        const existing = JSON.parse(window.localStorage.getItem(LOCAL_STORAGE_KEY) || "{}");
        window.localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify({ ...existing, ...config }));
      }
    }, 250);
  },
  { equalityFn: (a, b) => a.every((v, i) => v === b[i]) },
);
