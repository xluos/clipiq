// whisper.cpp 后端: 通过 ai-model-daemon 的 /v1/audio/transcriptions 代理调用。
// daemon 自动管理 whisper-server 生命周期和模型加载。

const fs = require("node:fs/promises");
const OpenCC = require("opencc-js");
const daemonClient = require("../daemon-client.cjs");
const { normalizeTranscriptSegments } = require("./transcript-normalizer.cjs");

const SIMPLIFIED_PROMPT = "以下是普通话的句子，请使用简体中文输出。";
const t2sConverter = OpenCC.Converter({ from: "t", to: "cn" });

function isChineseLang(lang) {
  if (!lang) return false;
  const v = String(lang).toLowerCase();
  return v === "zh" || v === "chinese" || v.startsWith("zh-") || v.startsWith("zh_");
}

async function isAvailable() {
  try {
    const bins = await daemonClient.getBinariesStatus();
    return !!bins?.whisperServer?.available;
  } catch {
    return false;
  }
}

async function ensureModel(modelId, onProgress) {
  return daemonClient.downloadModel(modelId, onProgress);
}

async function warmup(modelId) {
  return daemonClient.startWhisper(modelId);
}

async function transcribe({ wavPath, modelId, language, onProgress, handle }) {
  if (!modelId) throw new Error("缺少 modelId");

  if (onProgress) onProgress({ stage: "load", message: "正在准备本地语音引擎" });

  if (onProgress) onProgress({ stage: "decode", message: "正在读取音频内容" });
  const fileBytes = await fs.readFile(wavPath);

  const isZh = isChineseLang(language);
  if (onProgress) onProgress({ stage: "infer", message: "本地语音引擎推理中" });

  const data = await daemonClient.transcribe(fileBytes, {
    model: modelId,
    response_format: "verbose_json",
    language: language || undefined,
    temperature: "0",
    prompt: isZh ? SIMPLIFIED_PROMPT : undefined,
  });

  const detectedLang = data?.language || language || null;
  const shouldSimplify = isChineseLang(detectedLang) || isChineseLang(language);
  const normalize = (s) => {
    const t = String(s || "").trim();
    return shouldSimplify && t ? t2sConverter(t) : t;
  };

  const segments = normalizeTranscriptSegments(data?.segments, normalize);
  const fullText =
    typeof data?.text === "string" && data.text.trim()
      ? normalize(data.text)
      : segments.map((s) => s.text).join(" ").trim();

  return {
    schemaVersion: "v2",
    language: detectedLang,
    text: fullText,
    segments,
    duration: Number(data?.duration) || (segments.length ? segments[segments.length - 1].end : 0),
  };
}

module.exports = { backend: "whisper_cpp", isAvailable, ensureModel, warmup, transcribe };
