import type {
  Account,
  AccountFetchRange,
  Analysis,
  AnalysisOptions,
  Collection,
  Methodology,
  Pipeline,
  Shot,
  SlotOverrides,
  StudioSession,
  Video,
} from "../types";

type VideoFilter = {
  accountId?: string;
  collectionId?: string;
  platform?: string;
  status?: string;
};

const api = () => window.videoAnalyzer;

export const ipc = {
  // videos
  listVideos: (filter?: VideoFilter): Promise<Video[]> =>
    api()?.listVideos(filter) ?? Promise.resolve([]),
  upsertVideo: (video: Video) =>
    api()?.upsertVideo(video) ?? Promise.resolve({ ok: true as const }),
  deleteVideo: (videoId: string) =>
    api()?.deleteVideo(videoId) ?? Promise.resolve({ ok: true as const }),

  // analyses
  listAnalyses: (videoId: string): Promise<Analysis[]> =>
    api()?.listAnalyses(videoId) ?? Promise.resolve([]),
  listAllAnalyses: (): Promise<Analysis[]> =>
    api()?.listAllAnalyses() ?? Promise.resolve([]),
  getAnalysis: (analysisId: string): Promise<Analysis | null> =>
    api()?.getAnalysis(analysisId) ?? Promise.resolve(null),
  deleteAnalysis: (analysisId: string) =>
    api()?.deleteAnalysis(analysisId) ?? Promise.resolve({ ok: true as const }),
  updateAnalysisResult: (analysisId: string, result: unknown) =>
    api()?.updateAnalysisResult(analysisId, result) ?? Promise.resolve({ ok: true as const }),

  // accounts
  listAccounts: (): Promise<Account[]> =>
    api()?.listAccounts() ?? Promise.resolve([]),
  upsertAccount: (account: Account) =>
    api()?.upsertAccount(account) ?? Promise.resolve({ ok: true as const }),
  deleteAccount: (accountId: string) =>
    api()?.deleteAccount(accountId) ?? Promise.resolve({ ok: true as const }),

  // collections
  listCollections: (): Promise<Collection[]> =>
    api()?.listCollections() ?? Promise.resolve([]),
  upsertCollection: (collection: Collection) =>
    api()?.upsertCollection(collection) ?? Promise.resolve({ ok: true as const }),
  deleteCollection: (collectionId: string) =>
    api()?.deleteCollection(collectionId) ?? Promise.resolve({ ok: true as const }),
  listCollectionVideos: (collectionId: string): Promise<Video[]> =>
    api()?.listCollectionVideos(collectionId) ?? Promise.resolve([]),

  // pipelines
  listPipelines: (): Promise<Pipeline[]> =>
    api()?.listPipelines() ?? Promise.resolve([]),

  // methodologies
  listMethodologies: (accountId: string): Promise<Methodology[]> =>
    api()?.listMethodologies(accountId) ?? Promise.resolve([]),

  // sessions
  listSessions: (): Promise<StudioSession[]> =>
    api()?.listSessions() ?? Promise.resolve([]),
  upsertSession: (session: StudioSession) =>
    api()?.upsertSession(session) ?? Promise.resolve({ ok: true as const }),
  deleteSession: (sessionId: string) =>
    api()?.deleteSession(sessionId) ?? Promise.resolve({ ok: true as const }),

  // shots
  listShots: (videoId?: string): Promise<Shot[]> =>
    api()?.listShots(videoId) ?? Promise.resolve([]),
  setShotsForVideo: (videoId: string, shots: Shot[]) =>
    api()?.setShotsForVideo(videoId, shots) ?? Promise.resolve({ ok: true as const }),

  // config
  loadConfig: () => api()?.loadConfig() ?? Promise.resolve(null),
  saveConfig: (config: import("../types").AppConfig) =>
    api()?.saveConfig(config) ?? Promise.resolve({ ok: true as const }),

  // analysis actions
  analyzeVideo: (payload: { videoId: string; pipelineId: string; options?: AnalysisOptions; slotOverrides?: SlotOverrides }) =>
    api()?.analyzeVideo(payload) ?? Promise.reject(new Error("Electron API not available")),
  resumeAnalysis: (analysisId: string) =>
    api()?.resumeAnalysis(analysisId) ?? Promise.reject(new Error("Electron API not available")),
  cancelAnalysis: (videoId: string) =>
    api()?.cancelAnalysis(videoId) ?? Promise.resolve({ cancelled: false }),
  isAnalysisActive: (videoId: string) =>
    api()?.isAnalysisActive(videoId) ?? Promise.resolve(false),

  // account fetch
  startAccountFetch: (payload: { accountId: string; url: string; range: AccountFetchRange }) =>
    api()?.startAccountFetch(payload) ?? Promise.resolve({ ok: true as const, accepted: false, reason: "no api" }),

  // summarize
  summarizeVideo: (payload: { videoId: string; slotOverrides?: SlotOverrides; customPrompt?: string }) =>
    api()?.summarizeVideo(payload) ?? Promise.resolve({ ok: true as const, accepted: false, reason: "no api" }),
};
