const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("videoAnalyzer", {
  getRuntimeStatus: () => ipcRenderer.invoke("runtime:getStatus"),
  getSystemStats: () => ipcRenderer.invoke("system:getStats"),
  getProcessList: () => ipcRenderer.invoke("system:listProcesses"),
  openVideoFile: () => ipcRenderer.invoke("video:openFile"),
  inspectVideoPath: (path) => ipcRenderer.invoke("video:inspectPath", path),
  getPathForFile: (file) => {
    try {
      return webUtils?.getPathForFile?.(file) || "";
    } catch {
      return "";
    }
  },
  downloadVideo: (url) => ipcRenderer.invoke("video:downloadUrl", url),
  downloadVideoAsync: (url) => ipcRenderer.invoke("video:downloadUrlAsync", url),
  onDownloadComplete: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("download:complete", listener);
    return () => ipcRenderer.removeListener("download:complete", listener);
  },
  loadConfig: () => ipcRenderer.invoke("config:load"),
  saveConfig: (config) => ipcRenderer.invoke("config:save", config),
  getConfigField: (key) => ipcRenderer.invoke("config:getField", key),
  saveConfigField: (key, value) => ipcRenderer.invoke("config:setField", key, value),

  // v3: videos (替代 projects + accountVideos)
  listVideos: (filter) => ipcRenderer.invoke("videos:list", filter || {}),
  upsertVideo: (video) => ipcRenderer.invoke("videos:upsert", video),
  deleteVideo: (videoId) => ipcRenderer.invoke("videos:delete", videoId),

  // v3: analyses (result 统一列)
  listAnalyses: (videoId) => ipcRenderer.invoke("analyses:list", videoId),
  getAnalysis: (analysisId) => ipcRenderer.invoke("analyses:get", analysisId),
  deleteAnalysis: (analysisId) => ipcRenderer.invoke("analyses:delete", analysisId),
  updateAnalysisResult: (analysisId, result) => ipcRenderer.invoke("analyses:updateResult", analysisId, result),

  // v3: collections
  listCollections: () => ipcRenderer.invoke("collections:list"),
  upsertCollection: (collection) => ipcRenderer.invoke("collections:upsert", collection),
  deleteCollection: (collectionId) => ipcRenderer.invoke("collections:delete", collectionId),
  addVideoToCollection: (collectionId, videoId) => ipcRenderer.invoke("collections:addVideo", collectionId, videoId),
  removeVideoFromCollection: (collectionId, videoId) => ipcRenderer.invoke("collections:removeVideo", collectionId, videoId),
  listCollectionVideos: (collectionId) => ipcRenderer.invoke("collections:listVideos", collectionId),

  // v3: pipelines
  listPipelines: () => ipcRenderer.invoke("pipelines:list"),
  upsertPipeline: (pipeline) => ipcRenderer.invoke("pipelines:upsert", pipeline),
  deletePipeline: (pipelineId) => ipcRenderer.invoke("pipelines:delete", pipelineId),

  // v3: methodologies
  listMethodologies: (accountId) => ipcRenderer.invoke("methodologies:list", accountId),

  // accounts
  listAccounts: () => ipcRenderer.invoke("accounts:list"),
  upsertAccount: (account) => ipcRenderer.invoke("accounts:upsert", account),
  deleteAccount: (accountId) => ipcRenderer.invoke("accounts:delete", accountId),

  // studio sessions
  listSessions: () => ipcRenderer.invoke("sessions:list"),
  upsertSession: (session) => ipcRenderer.invoke("sessions:upsert", session),
  deleteSession: (sessionId) => ipcRenderer.invoke("sessions:delete", sessionId),

  // shots
  listShots: (videoId) => ipcRenderer.invoke("shots:list", videoId),
  setShotsForVideo: (videoId, shots) => ipcRenderer.invoke("shots:setForVideo", videoId, shots),

  // 后台拉取
  startAccountFetch: (payload) => ipcRenderer.invoke("accounts:startFetch", payload),
  cancelAccountFetch: (accountId) => ipcRenderer.invoke("accounts:cancelFetch", accountId),
  listAccountFetchInFlight: () => ipcRenderer.invoke("accounts:listFetchInFlight"),
  onAccountFetchProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("account:fetch:progress", listener);
    return () => ipcRenderer.removeListener("account:fetch:progress", listener);
  },
  onAccountFetchDone: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("account:fetch:done", listener);
    return () => ipcRenderer.removeListener("account:fetch:done", listener);
  },
  onAccountFetchFailed: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("account:fetch:failed", listener);
    return () => ipcRenderer.removeListener("account:fetch:failed", listener);
  },

  // 分析
  analyzeVideo: (payload) => ipcRenderer.invoke("analysis:start", payload),
  cancelAnalysis: (videoId) => ipcRenderer.invoke("analysis:cancel", videoId),
  isAnalysisActive: (videoId) => ipcRenderer.invoke("analysis:isActive", videoId),
  getLastAnalysisProgress: (videoId) => ipcRenderer.invoke("analysis:getLastProgress", videoId),
  getLastAnalysisBudget: (videoId) => ipcRenderer.invoke("analysis:getLastBudget", videoId),
  onAnalysisProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("analysis:progress", listener);
    return () => ipcRenderer.removeListener("analysis:progress", listener);
  },
  onAnalysisBudget: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("analysis:budget", listener);
    return () => ipcRenderer.removeListener("analysis:budget", listener);
  },

  // 轻量视频摘要 (内容分析管线)
  summarizeVideo: (payload) => ipcRenderer.invoke("analysis:summarize", payload),
  cancelSummarizeVideo: (videoId) => ipcRenderer.invoke("analysis:cancelSummarize", videoId),
  onVideoSummaryStatus: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("analysis:summary:status", listener);
    return () => ipcRenderer.removeListener("analysis:summary:status", listener);
  },

  // 方法论生成
  generateAccountMethodology: (payload) => ipcRenderer.invoke("accounts:generateMethodology", payload),

  // studio
  generateStudioSteps: (payload) => ipcRenderer.invoke("sessions:generateSteps", payload),
  analyzeVideoShots: (payload) => ipcRenderer.invoke("shots:analyze", payload),

  // 导出
  exportVideo: (payload) => ipcRenderer.invoke("video:export", payload),

  // provider 测试
  testProvider: (provider) => ipcRenderer.invoke("provider:testConnection", provider),

  // yt-dlp
  checkYtDlpUpdate: () => ipcRenderer.invoke("ytdlp:checkUpdate"),
  installYtDlp: () => ipcRenderer.invoke("ytdlp:install"),
  onYtDlpUpdateStatus: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("ytdlp:update-status", listener);
    return () => ipcRenderer.removeListener("ytdlp:update-status", listener);
  },
  onYtDlpProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("ytdlp:progress", listener);
    return () => ipcRenderer.removeListener("ytdlp:progress", listener);
  },

  // 数据管理
  getDataInfo: () => ipcRenderer.invoke("data:getInfo"),
  openDataFolder: (which) => ipcRenderer.invoke("data:openFolder", which),
  purgeAllData: () => ipcRenderer.invoke("data:purgeAll"),

  // 扩展桥
  extensionBridge: {
    getStatus: () => ipcRenderer.invoke("extensionBridge:getStatus"),
    rotateToken: () => ipcRenderer.invoke("extensionBridge:rotateToken"),
    onStatus: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on("extensionBridge:status", listener);
      return () => ipcRenderer.removeListener("extensionBridge:status", listener);
    },
  },

  // 镜像源
  mirror: {
    get: () => ipcRenderer.invoke("mirror:get"),
    set: (value) => ipcRenderer.invoke("mirror:set", value),
  },

  // 本地推理
  llama: {
    listModels: () => ipcRenderer.invoke("llama:listModels"),
    listManifest: () => ipcRenderer.invoke("llama:listManifest"),
    recomputeFit: (modelKey, contextSize) =>
      ipcRenderer.invoke("llama:recomputeFit", { modelKey, contextSize }),
    getStatus: () => ipcRenderer.invoke("llama:getStatus"),
    ensureBinary: () => ipcRenderer.invoke("llama:ensureBinary"),
    ensureModel: (modelKey) => ipcRenderer.invoke("llama:ensureModel", modelKey),
    cancelDownload: (modelKey) => ipcRenderer.invoke("llama:cancelDownload", modelKey),
    start: (modelKey) => ipcRenderer.invoke("llama:start", modelKey),
    stop: () => ipcRenderer.invoke("llama:stop"),
    selfTest: (payload) => ipcRenderer.invoke("llama:selfTest", payload),
    onProgress: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on("llama:progress", listener);
      return () => ipcRenderer.removeListener("llama:progress", listener);
    },
    onLog: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on("llama:log", listener);
      return () => ipcRenderer.removeListener("llama:log", listener);
    },
  },

  // 本地音频
  whisperCpp: {
    listModels: () => ipcRenderer.invoke("whisperCpp:listModels"),
    getStatus: () => ipcRenderer.invoke("whisperCpp:getStatus"),
    ensureModel: (modelKey) => ipcRenderer.invoke("whisperCpp:ensureModel", modelKey),
    cancelDownload: (modelKey) => ipcRenderer.invoke("whisperCpp:cancelDownload", modelKey),
    start: (modelKey) => ipcRenderer.invoke("whisperCpp:start", modelKey),
    stop: () => ipcRenderer.invoke("whisperCpp:stop"),
    onProgress: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on("whisperCpp:progress", listener);
      return () => ipcRenderer.removeListener("whisperCpp:progress", listener);
    },
    onLog: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on("whisperCpp:log", listener);
      return () => ipcRenderer.removeListener("whisperCpp:log", listener);
    },
  },

  // 诊断
  diagnostics: {
    getAnalysisSamples: () => ipcRenderer.invoke("diagnostics:getAnalysisSamples"),
    getTokenUsage: (analysisId) => ipcRenderer.invoke("diagnostics:getTokenUsage", analysisId),
    getFramesCheckpoint: (videoId) => ipcRenderer.invoke("diagnostics:getFramesCheckpoint", videoId),
    getTranscript: (videoId) => ipcRenderer.invoke("diagnostics:getTranscript", videoId),
    deleteSample: (videoId, startedAt) => ipcRenderer.invoke("diagnostics:deleteSample", videoId, startedAt),
    clearAllSamples: () => ipcRenderer.invoke("diagnostics:clearAllSamples"),
  },

  // 缓存
  cache: {
    getStats: () => ipcRenderer.invoke("cache:getStats"),
    list: (params) => ipcRenderer.invoke("cache:list", params || {}),
    clear: (params) => ipcRenderer.invoke("cache:clear", params || {}),
    setMaxBytes: (bytes) => ipcRenderer.invoke("cache:setMaxBytes", bytes),
    setDir: (dir) => ipcRenderer.invoke("cache:setDir", dir),
    browseDir: () => ipcRenderer.invoke("cache:browseDir"),
    openDir: () => ipcRenderer.invoke("cache:openDir"),
    getPolicy: () => ipcRenderer.invoke("cache:getPolicy"),
    setPolicy: (policy) => ipcRenderer.invoke("cache:setPolicy", policy),
  },
});
