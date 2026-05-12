const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("videoAnalyzer", {
  getRuntimeStatus: () => ipcRenderer.invoke("runtime:getStatus"),
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
  loadConfig: () => ipcRenderer.invoke("config:load"),
  saveConfig: (config) => ipcRenderer.invoke("config:save", config),
  listProjects: () => ipcRenderer.invoke("projects:list"),
  upsertProject: (project) => ipcRenderer.invoke("projects:upsert", project),
  deleteProject: (projectId) => ipcRenderer.invoke("projects:delete", projectId),
  getNodes: (projectId) => ipcRenderer.invoke("nodes:get", projectId),
  setNodes: (projectId, nodes) => ipcRenderer.invoke("nodes:set", projectId, nodes),
  getReport: (projectId) => ipcRenderer.invoke("report:get", projectId),
  setReport: (projectId, report) => ipcRenderer.invoke("report:set", projectId, report),
  analyzeProject: (payload) => ipcRenderer.invoke("analysis:start", payload),
  cancelAnalysis: (projectId) => ipcRenderer.invoke("analysis:cancel", projectId),
  isAnalysisActive: (projectId) => ipcRenderer.invoke("analysis:isActive", projectId),
  onAnalysisProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("analysis:progress", listener);
    return () => ipcRenderer.removeListener("analysis:progress", listener);
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
});
