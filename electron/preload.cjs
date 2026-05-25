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
  listProjects: () => ipcRenderer.invoke("projects:list"),
  upsertProject: (project) => ipcRenderer.invoke("projects:upsert", project),
  deleteProject: (projectId) => ipcRenderer.invoke("projects:delete", projectId),
  // v2: accounts / sessions / shots
  listAccounts: () => ipcRenderer.invoke("accounts:list"),
  upsertAccount: (account) => ipcRenderer.invoke("accounts:upsert", account),
  deleteAccount: (accountId) => ipcRenderer.invoke("accounts:delete", accountId),
  listSessions: () => ipcRenderer.invoke("sessions:list"),
  upsertSession: (session) => ipcRenderer.invoke("sessions:upsert", session),
  deleteSession: (sessionId) => ipcRenderer.invoke("sessions:delete", sessionId),
  listShots: (assetProjectId) => ipcRenderer.invoke("shots:list", assetProjectId),
  setShotsForAsset: (assetProjectId, shots) => ipcRenderer.invoke("shots:setForAsset", assetProjectId, shots),
  // v2 业务路径 — 账号视频独立表
  listAccountVideos: (accountId) => ipcRenderer.invoke("accountVideos:list", accountId),
  upsertAccountVideo: (video) => ipcRenderer.invoke("accountVideos:upsert", video),
  deleteAccountVideo: (videoId) => ipcRenderer.invoke("accountVideos:delete", videoId),
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
  generateAccountMethodology: (payload) => ipcRenderer.invoke("accounts:generateMethodology", payload),
  generateStudioSteps: (payload) => ipcRenderer.invoke("sessions:generateSteps", payload),
  analyzeAssetShots: (payload) => ipcRenderer.invoke("assets:analyzeShots", payload),
  getNodes: (projectId) => ipcRenderer.invoke("nodes:get", projectId),
  setNodes: (projectId, nodes) => ipcRenderer.invoke("nodes:set", projectId, nodes),
  getReport: (projectId) => ipcRenderer.invoke("report:get", projectId),
  setReport: (projectId, report) => ipcRenderer.invoke("report:set", projectId, report),
  analyzeProject: (payload) => ipcRenderer.invoke("analysis:start", payload),
  resetAnalysis: (projectId) => ipcRenderer.invoke("analysis:reset", projectId),
  cancelAnalysis: (projectId) => ipcRenderer.invoke("analysis:cancel", projectId),
  isAnalysisActive: (projectId) => ipcRenderer.invoke("analysis:isActive", projectId),
  getLastAnalysisProgress: (projectId) => ipcRenderer.invoke("analysis:getLastProgress", projectId),
  getLastAnalysisBudget: (projectId) => ipcRenderer.invoke("analysis:getLastBudget", projectId),
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
  exportProject: (payload) => ipcRenderer.invoke("project:export", payload),
  testProvider: (provider) => ipcRenderer.invoke("provider:testConnection", provider),
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
  getDataInfo: () => ipcRenderer.invoke("data:getInfo"),
  openDataFolder: (which) => ipcRenderer.invoke("data:openFolder", which),
  purgeProjects: () => ipcRenderer.invoke("data:purgeProjects"),
  extensionBridge: {
    getStatus: () => ipcRenderer.invoke("extensionBridge:getStatus"),
    rotateToken: () => ipcRenderer.invoke("extensionBridge:rotateToken"),
    onStatus: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on("extensionBridge:status", listener);
      return () => ipcRenderer.removeListener("extensionBridge:status", listener);
    },
  },
  mirror: {
    get: () => ipcRenderer.invoke("mirror:get"),
    set: (value) => ipcRenderer.invoke("mirror:set", value),
  },
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
  whisperCpp: {
    listModels: () => ipcRenderer.invoke("whisperCpp:listModels"),
    getStatus: () => ipcRenderer.invoke("whisperCpp:getStatus"),
    ensureModel: (modelKey) => ipcRenderer.invoke("whisperCpp:ensureModel", modelKey),
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
  diagnostics: {
    getAnalysisSamples: () => ipcRenderer.invoke("diagnostics:getAnalysisSamples"),
    getTokenUsage: (projectId) => ipcRenderer.invoke("diagnostics:getTokenUsage", projectId),
  },
  cache: {
    getStats: () => ipcRenderer.invoke("cache:getStats"),
    list: (params) => ipcRenderer.invoke("cache:list", params || {}),
    clear: (params) => ipcRenderer.invoke("cache:clear", params || {}),
    setMaxBytes: (bytes) => ipcRenderer.invoke("cache:setMaxBytes", bytes),
    setDir: (dir) => ipcRenderer.invoke("cache:setDir", dir),
    browseDir: () => ipcRenderer.invoke("cache:browseDir"),
    openDir: () => ipcRenderer.invoke("cache:openDir"),
  },
});
