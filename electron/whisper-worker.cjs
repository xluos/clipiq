// 独立 utilityProcess: 跑 transformers.js whisper ASR,主进程通过 parentPort 通信。
// 设计要点:
// - 一个 worker 内 cache 已经加载的 pipeline,后续同模型转录直接复用
// - 任何崩溃 / OOM 都只影响本 worker,不会拖垮主进程
// - 主进程发 { type: 'transcribe' | 'warmup' | 'shutdown', ... },worker 回
//   { type: 'progress' | 'result' | 'error' }

const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");

const port = process.parentPort;
if (!port) {
  // 不是通过 utilityProcess.fork 启动的,直接退出
  process.exit(0);
}

// 诊断日志,主进程 stdout 监听在 utility 模式下不稳定,直接写文件方便排查
const LOG_PATH = "/tmp/clipiq-whisper-worker.log";
function dlog(msg) {
  try {
    fsSync.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {
    // ignore
  }
}
dlog(`worker boot pid=${process.pid} node=${process.versions.node}`);

process.on("uncaughtException", (e) => dlog(`uncaughtException: ${e.message}\n${e.stack}`));
process.on("unhandledRejection", (e) => dlog(`unhandledRejection: ${e?.message || e}`));

const pipelines = new Map();
let dispatcherApplied = false;

function send(message) {
  try {
    port.postMessage(message);
  } catch {
    // parent 已断开,忽略
  }
}

function applyProxyOnce() {
  if (dispatcherApplied) return;
  dispatcherApplied = true;
  const proxyUrl =
    process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy;
  if (!proxyUrl) return;
  try {
    const { ProxyAgent, setGlobalDispatcher } = require("undici");
    setGlobalDispatcher(new ProxyAgent(proxyUrl));
  } catch {
    // undici 不可用就走默认 fetch
  }
}

async function loadPipeline(modelId, mirror, cacheDir, onProgress) {
  const cacheKey = `${modelId}|${mirror || ""}|${cacheDir}`;
  if (pipelines.has(cacheKey)) return pipelines.get(cacheKey);
  dlog(`loadPipeline start modelId=${modelId} mirror=${mirror}`);
  applyProxyOnce();
  const transformers = await import("@huggingface/transformers");
  const env = transformers.env;
  env.allowLocalModels = false;
  env.cacheDir = cacheDir;
  if (mirror) env.remoteHost = mirror;
  await fs.mkdir(cacheDir, { recursive: true });
  const promise = transformers.pipeline("automatic-speech-recognition", modelId, {
    device: "cpu",
    dtype: "q8",
    progress_callback: (p) => {
      if (!onProgress) return;
      if (p?.status === "progress" && typeof p.progress === "number") {
        // 模型文件首次下载,把内部文件名隐藏,只显示百分比
        onProgress({ stage: "download", message: `首次下载语音模型 · ${Math.floor(p.progress)}%` });
      } else if (p?.status === "ready") {
        onProgress({ stage: "ready", message: "语音模型已加载" });
      }
    },
  }).then((p) => { dlog("pipeline ready"); return p; }).catch((e) => { dlog(`pipeline rejected: ${e.message}`); throw e; });
  pipelines.set(cacheKey, promise);
  promise.catch(() => pipelines.delete(cacheKey));
  return promise;
}

function decodeWavToFloat32(buffer) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let dataOffset = 44;
  for (let i = 12; i < buffer.length - 8; i += 1) {
    if (
      buffer[i] === 0x64 &&
      buffer[i + 1] === 0x61 &&
      buffer[i + 2] === 0x74 &&
      buffer[i + 3] === 0x61
    ) {
      dataOffset = i + 8;
      break;
    }
  }
  const sampleCount = Math.floor((buffer.length - dataOffset) / 2);
  const samples = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i += 1) {
    samples[i] = view.getInt16(dataOffset + i * 2, true) / 32768;
  }
  return samples;
}

async function handleTranscribe(requestId, payload) {
  const { wavPath, modelId, mirror, cacheDir, language } = payload;
  const onProgress = (p) => send({ type: "progress", requestId, ...p });
  try {
    onProgress({ stage: "load", message: "正在加载本地语音模型" });
    const asr = await loadPipeline(modelId, mirror, cacheDir, onProgress);
    onProgress({ stage: "decode", message: "正在读取音频内容" });
    const buffer = await fs.readFile(wavPath);
    const samples = decodeWavToFloat32(buffer);
    const duration = samples.length / 16000;
    onProgress({ stage: "infer", message: `正在识别 ${duration.toFixed(1)} 秒音频` });
    const result = await asr(samples, {
      language: language || undefined,
      return_timestamps: true,
      chunk_length_s: 30,
    });
    const chunks = Array.isArray(result?.chunks) ? result.chunks : [];
    const segments = chunks.map((c) => ({
      start: Array.isArray(c.timestamp) ? Number(c.timestamp[0]) || 0 : 0,
      end: Array.isArray(c.timestamp) ? Number(c.timestamp[1]) || 0 : 0,
      text: String(c.text || "").trim(),
    }));
    const fullText =
      typeof result?.text === "string" && result.text.trim()
        ? result.text.trim()
        : segments.map((s) => s.text).join(" ").trim();
    send({
      type: "result",
      requestId,
      transcript: {
        language: language || null,
        text: fullText,
        segments,
        duration,
      },
    });
  } catch (error) {
    send({
      type: "error",
      requestId,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
  }
}

async function handleWarmup(requestId, payload) {
  const { modelId, mirror, cacheDir } = payload;
  const onProgress = (p) => send({ type: "progress", requestId, ...p });
  try {
    const t0 = Date.now();
    await loadPipeline(modelId, mirror, cacheDir, onProgress);
    send({ type: "result", requestId, warmup: { modelId, elapsedMs: Date.now() - t0 } });
  } catch (error) {
    send({
      type: "error",
      requestId,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
  }
}

port.on("message", (event) => {
  // ⚠️ utilityProcess 的 parentPort 派发 MessageEvent,真实数据在 event.data;
  // 直接 msg.type 会拿到 undefined,worker 收不到任何任务。
  const msg = event && typeof event === "object" && "data" in event ? event.data : event;
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "transcribe") return handleTranscribe(msg.requestId, msg.payload);
  if (msg.type === "warmup") return handleWarmup(msg.requestId, msg.payload);
  if (msg.type === "shutdown") return process.exit(0);
});

process.on("uncaughtException", (error) => {
  send({ type: "fatal", message: error?.message || String(error), stack: error?.stack });
  // 让父进程 on('exit') 看到非 0 退出码
  setTimeout(() => process.exit(2), 50);
});

send({ type: "ready" });
