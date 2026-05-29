// ───────────────────────────────────────────────────────────────────────────
// IPC 契约唯一源 + preload 生成
//
// ⚠️ 为什么 manifest 定义在 preload 而不是单独文件:
//   Electron sandbox(本项目窗口默认开启)下,preload 里的 require 只能拿 "electron",
//   不能 require 本地文件。所以 preload 必须自包含 —— CHANNELS 直接定义在这里。
//   main.cjs / 测试 通过 ipc-contract.cjs 反向从本文件 re-export 拿 manifest。
//
// 新增 / 改 IPC = 只改下面的 CHANNELS。preload 从它循环生成 window.videoAnalyzer.*,
// 永远不会和契约漂移。暴露给 renderer 的是普通对象(contextBridge 不接受 Proxy / class 实例)。
//
// 字段:method(api 方法名) / channel(ipc channel) / kind(invoke|event|special) / ns(可选命名空间)
// ───────────────────────────────────────────────────────────────────────────

const CHANNELS = [
  // ── 运行时 / 系统 ──
  { method: "getRuntimeStatus", channel: "runtime:getStatus", kind: "invoke" },
  { method: "getSystemStats", channel: "system:getStats", kind: "invoke" },
  { method: "getProcessList", channel: "system:listProcesses", kind: "invoke" },

  // ── 视频文件 ──
  { method: "openVideoFile", channel: "video:openFile", kind: "invoke" },
  { method: "inspectVideoPath", channel: "video:inspectPath", kind: "invoke" },
  { method: "getPathForFile", channel: null, kind: "special" }, // webUtils,见 OVERRIDES
  { method: "downloadVideo", channel: "video:downloadUrl", kind: "invoke" },
  { method: "downloadVideoAsync", channel: "video:downloadUrlAsync", kind: "invoke" },
  { method: "onDownloadComplete", channel: "download:complete", kind: "event" },
  { method: "exportVideo", channel: "video:export", kind: "invoke" },

  // ── 配置 ──
  { method: "loadConfig", channel: "config:load", kind: "invoke" },
  { method: "saveConfig", channel: "config:save", kind: "invoke" },
  { method: "getConfigField", channel: "config:getField", kind: "invoke" },
  { method: "saveConfigField", channel: "config:setField", kind: "invoke" },

  // ── videos ──
  { method: "listVideos", channel: "videos:list", kind: "invoke" }, // 默认 {} ,见 OVERRIDES
  { method: "upsertVideo", channel: "videos:upsert", kind: "invoke" },
  { method: "deleteVideo", channel: "videos:delete", kind: "invoke" },

  // ── analyses ──
  { method: "listAnalyses", channel: "analyses:list", kind: "invoke" },
  { method: "listAllAnalyses", channel: "analyses:listAll", kind: "invoke" },
  { method: "getAnalysis", channel: "analyses:get", kind: "invoke" },
  { method: "deleteAnalysis", channel: "analyses:delete", kind: "invoke" },
  { method: "updateAnalysisResult", channel: "analyses:updateResult", kind: "invoke" },

  // ── collections ──
  { method: "listCollections", channel: "collections:list", kind: "invoke" },
  { method: "upsertCollection", channel: "collections:upsert", kind: "invoke" },
  { method: "deleteCollection", channel: "collections:delete", kind: "invoke" },
  { method: "addVideoToCollection", channel: "collections:addVideo", kind: "invoke" },
  { method: "removeVideoFromCollection", channel: "collections:removeVideo", kind: "invoke" },
  { method: "listCollectionVideos", channel: "collections:listVideos", kind: "invoke" },
  { method: "generateCollectionMethodology", channel: "collections:generateMethodology", kind: "invoke" },

  // ── pipelines ──
  { method: "listPipelines", channel: "pipelines:list", kind: "invoke" },
  { method: "upsertPipeline", channel: "pipelines:upsert", kind: "invoke" },
  { method: "deletePipeline", channel: "pipelines:delete", kind: "invoke" },

  // ── methodologies ──
  { method: "listMethodologies", channel: "methodologies:list", kind: "invoke" },

  // ── accounts ──
  { method: "listAccounts", channel: "accounts:list", kind: "invoke" },
  { method: "upsertAccount", channel: "accounts:upsert", kind: "invoke" },
  { method: "deleteAccount", channel: "accounts:delete", kind: "invoke" },
  { method: "startAccountFetch", channel: "accounts:startFetch", kind: "invoke" },
  { method: "cancelAccountFetch", channel: "accounts:cancelFetch", kind: "invoke" },
  { method: "listAccountFetchInFlight", channel: "accounts:listFetchInFlight", kind: "invoke" },
  { method: "generateAccountMethodology", channel: "accounts:generateMethodology", kind: "invoke" },
  { method: "onAccountFetchProgress", channel: "account:fetch:progress", kind: "event" },
  { method: "onAccountFetchDone", channel: "account:fetch:done", kind: "event" },
  { method: "onAccountFetchFailed", channel: "account:fetch:failed", kind: "event" },

  // ── studio sessions ──
  { method: "listSessions", channel: "sessions:list", kind: "invoke" },
  { method: "upsertSession", channel: "sessions:upsert", kind: "invoke" },
  { method: "deleteSession", channel: "sessions:delete", kind: "invoke" },
  { method: "generateStudioSteps", channel: "sessions:generateSteps", kind: "invoke" },

  // ── shots ──
  { method: "listShots", channel: "shots:list", kind: "invoke" },
  { method: "setShotsForVideo", channel: "shots:setForVideo", kind: "invoke" },
  { method: "analyzeVideoShots", channel: "shots:analyze", kind: "invoke" },

  // ── 分析 ──
  { method: "analyzeVideo", channel: "analysis:start", kind: "invoke" },
  { method: "resumeAnalysis", channel: "analysis:resume", kind: "invoke" },
  { method: "cancelAnalysis", channel: "analysis:cancel", kind: "invoke" },
  { method: "isAnalysisActive", channel: "analysis:isActive", kind: "invoke" },
  { method: "getLastAnalysisProgress", channel: "analysis:getLastProgress", kind: "invoke" },
  { method: "getLastAnalysisBudget", channel: "analysis:getLastBudget", kind: "invoke" },
  { method: "summarizeVideo", channel: "analysis:summarize", kind: "invoke" },
  { method: "cancelSummarizeVideo", channel: "analysis:cancelSummarize", kind: "invoke" },
  { method: "onTaskProgress", channel: "task:progress", kind: "event" },
  { method: "onAnalysisProgress", channel: "analysis:progress", kind: "event" },
  { method: "onAnalysisBudget", channel: "analysis:budget", kind: "event" },
  { method: "onVideoSummaryStatus", channel: "analysis:summary:status", kind: "event" },

  // ── 统一任务管理 ──
  { method: "listActiveTasks", channel: "task:list", kind: "invoke" },
  { method: "cancelTask", channel: "task:cancel", kind: "invoke" },

  // ── 通用后台任务队列(task-queue 调度器)──
  { method: "listQueueTasks", channel: "taskqueue:list", kind: "invoke" },
  { method: "cancelQueueTask", channel: "taskqueue:cancel", kind: "invoke" },
  { method: "removeQueueTask", channel: "taskqueue:remove", kind: "invoke" },
  { method: "onQueueTaskUpdate", channel: "taskqueue:update", kind: "event" },
  { method: "onQueueTaskRemoved", channel: "taskqueue:removed", kind: "event" },

  // ── provider ──
  { method: "testProvider", channel: "provider:testConnection", kind: "invoke" },

  // ── yt-dlp ──
  { method: "checkYtDlpUpdate", channel: "ytdlp:checkUpdate", kind: "invoke" },
  { method: "installYtDlp", channel: "ytdlp:install", kind: "invoke" },
  { method: "onYtDlpUpdateStatus", channel: "ytdlp:update-status", kind: "event" },
  { method: "onYtDlpProgress", channel: "ytdlp:progress", kind: "event" },

  // ── 数据管理 ──
  { method: "getDataInfo", channel: "data:getInfo", kind: "invoke" },
  { method: "openDataFolder", channel: "data:openFolder", kind: "invoke" },
  { method: "purgeAllData", channel: "data:purgeAll", kind: "invoke" },

  // ── 扩展桥 (ns: extensionBridge) ──
  { ns: "extensionBridge", method: "getStatus", channel: "extensionBridge:getStatus", kind: "invoke" },
  { ns: "extensionBridge", method: "rotateToken", channel: "extensionBridge:rotateToken", kind: "invoke" },
  { ns: "extensionBridge", method: "onStatus", channel: "extensionBridge:status", kind: "event" },

  // ── 镜像源 (ns: mirror) ──
  { ns: "mirror", method: "get", channel: "mirror:get", kind: "invoke" },
  { ns: "mirror", method: "set", channel: "mirror:set", kind: "invoke" },

  // ── 本地推理 (ns: llama) ──
  { ns: "llama", method: "listModels", channel: "llama:listModels", kind: "invoke" },
  { ns: "llama", method: "listManifest", channel: "llama:listManifest", kind: "invoke" },
  { ns: "llama", method: "recomputeFit", channel: "llama:recomputeFit", kind: "invoke" }, // 参数变形,见 OVERRIDES
  { ns: "llama", method: "getStatus", channel: "llama:getStatus", kind: "invoke" },
  { ns: "llama", method: "ensureBinary", channel: "llama:ensureBinary", kind: "invoke" },
  { ns: "llama", method: "ensureModel", channel: "llama:ensureModel", kind: "invoke" },
  { ns: "llama", method: "cancelDownload", channel: "llama:cancelDownload", kind: "invoke" },
  { ns: "llama", method: "start", channel: "llama:start", kind: "invoke" },
  { ns: "llama", method: "stop", channel: "llama:stop", kind: "invoke" },
  { ns: "llama", method: "selfTest", channel: "llama:selfTest", kind: "invoke" },
  { ns: "llama", method: "onProgress", channel: "llama:progress", kind: "event" },
  { ns: "llama", method: "onLog", channel: "llama:log", kind: "event" },

  // ── 本地音频 (ns: whisperCpp) ──
  { ns: "whisperCpp", method: "listModels", channel: "whisperCpp:listModels", kind: "invoke" },
  { ns: "whisperCpp", method: "getStatus", channel: "whisperCpp:getStatus", kind: "invoke" },
  { ns: "whisperCpp", method: "ensureModel", channel: "whisperCpp:ensureModel", kind: "invoke" },
  { ns: "whisperCpp", method: "cancelDownload", channel: "whisperCpp:cancelDownload", kind: "invoke" },
  { ns: "whisperCpp", method: "start", channel: "whisperCpp:start", kind: "invoke" },
  { ns: "whisperCpp", method: "stop", channel: "whisperCpp:stop", kind: "invoke" },
  { ns: "whisperCpp", method: "onProgress", channel: "whisperCpp:progress", kind: "event" },
  { ns: "whisperCpp", method: "onLog", channel: "whisperCpp:log", kind: "event" },

  // ── 诊断 (ns: diagnostics) ──
  { ns: "diagnostics", method: "getAnalysisSamples", channel: "diagnostics:getAnalysisSamples", kind: "invoke" },
  { ns: "diagnostics", method: "getTokenUsage", channel: "diagnostics:getTokenUsage", kind: "invoke" },
  { ns: "diagnostics", method: "getFramesCheckpoint", channel: "diagnostics:getFramesCheckpoint", kind: "invoke" },
  { ns: "diagnostics", method: "getTranscript", channel: "diagnostics:getTranscript", kind: "invoke" },
  { ns: "diagnostics", method: "deleteSample", channel: "diagnostics:deleteSample", kind: "invoke" },
  { ns: "diagnostics", method: "clearAllSamples", channel: "diagnostics:clearAllSamples", kind: "invoke" },

  // ── 缓存 (ns: cache) ──
  { ns: "cache", method: "getStats", channel: "cache:getStats", kind: "invoke" },
  { ns: "cache", method: "list", channel: "cache:list", kind: "invoke" }, // 默认 {} ,见 OVERRIDES
  { ns: "cache", method: "clear", channel: "cache:clear", kind: "invoke" }, // 默认 {} ,见 OVERRIDES
  { ns: "cache", method: "setMaxBytes", channel: "cache:setMaxBytes", kind: "invoke" },
  { ns: "cache", method: "setDir", channel: "cache:setDir", kind: "invoke" },
  { ns: "cache", method: "browseDir", channel: "cache:browseDir", kind: "invoke" },
  { ns: "cache", method: "openDir", channel: "cache:openDir", kind: "invoke" },
  { ns: "cache", method: "getPolicy", channel: "cache:getPolicy", kind: "invoke" },
  { ns: "cache", method: "setPolicy", channel: "cache:setPolicy", kind: "invoke" },
];

// 某条目的唯一 key(ns.method 形式),用于 OVERRIDES 命中判断
function entryKey(e) {
  return e.ns ? `${e.ns}.${e.method}` : e.method;
}

// 非纯透传的方法(默认参数 / 参数变形 / 走 webUtils)在这里登记 override。
// 工厂签名: ({ ipcRenderer, webUtils, channel }) => 实际方法
const OVERRIDES = {
  // 走 webUtils 拿 File 的真实路径,不是 ipc
  getPathForFile: ({ webUtils }) => (file) => {
    try {
      return webUtils?.getPathForFile?.(file) || "";
    } catch {
      return "";
    }
  },
  // filter 省略时回填 {}(main 端按对象解构)
  listVideos: ({ ipcRenderer, channel }) => (filter) => ipcRenderer.invoke(channel, filter || {}),
  // 两个标量参数包成对象再发
  "llama.recomputeFit": ({ ipcRenderer, channel }) => (modelKey, contextSize) =>
    ipcRenderer.invoke(channel, { modelKey, contextSize }),
  "cache.list": ({ ipcRenderer, channel }) => (params) => ipcRenderer.invoke(channel, params || {}),
  "cache.clear": ({ ipcRenderer, channel }) => (params) => ipcRenderer.invoke(channel, params || {}),
};

// 依赖以参数注入,方便单测(见 preload.smoke.test.js),生产由下方自执行块从 electron 取。
function buildApi(ipcRenderer, webUtils) {
  const makeInvoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);
  const makeEvent = (channel) => (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };

  const api = {};
  const target = (ns) => (ns ? (api[ns] ||= {}) : api);
  for (const entry of CHANNELS) {
    const key = entryKey(entry);
    const t = target(entry.ns);
    if (OVERRIDES[key]) {
      t[entry.method] = OVERRIDES[key]({ ipcRenderer, webUtils, channel: entry.channel });
      continue;
    }
    if (entry.kind === "invoke") t[entry.method] = makeInvoke(entry.channel);
    else if (entry.kind === "event") t[entry.method] = makeEvent(entry.channel);
    else throw new Error(`preload: "${key}" kind=${entry.kind} 没有 OVERRIDES 实现`);
  }
  return api;
}

module.exports = { buildApi, CHANNELS, entryKey };

// 自执行:Electron 加载 preload 时挂到 window.videoAnalyzer。
// 测试 / 主进程里 require("electron") 拿不到 contextBridge,守卫跳过。
const { contextBridge, ipcRenderer, webUtils } = require("electron");
if (contextBridge?.exposeInMainWorld) {
  contextBridge.exposeInMainWorld("videoAnalyzer", buildApi(ipcRenderer, webUtils));
}
