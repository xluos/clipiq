// whisper.cpp 后端: 通过本地 whisper-server (multipart /inference) 调用。
//
// server 模式 vs CLI 模式:
//   server 模式跟 llama-runtime 同构, 可以 warmup, 切模型才重启;
//   CLI 模式每次推理冷启动 (~1-3s 加载模型), 不适合反复调用。
//   选 server 模式。
//
// whisper.cpp 1.7+ 的 server 接口:
//   POST /inference  multipart/form-data
//     file: 音频文件 (wav/mp3/flac/...)
//     response_format: json | verbose_json | text | srt | vtt
//     temperature, language, prompt 等转录参数同 CLI
//   GET /             返回简易 HTML 页面
//
// 返回的 verbose_json 形态 (whisper.cpp v1.8.4 实测):
//   {
//     task: "transcribe",
//     language: "chinese",
//     duration: 5.34,
//     text: "...",
//     segments: [{ id, text, start, end, tokens, words }],
//   }
//   start/end 直接是秒 (跟 OpenAI verbose_json 格式一致), 无需缩放。

const fs = require("node:fs/promises");
const OpenCC = require("opencc-js");
const whisperCppRuntime = require("../whisper-cpp-runtime.cjs");

// Whisper 训练语料里中文部分混了大量繁中字幕,language=zh 时常出现简繁混排。
// 双保险:1) initial_prompt 引导模型偏简体 2) 对输出统一跑 t2s 转换。
const SIMPLIFIED_PROMPT = "以下是普通话的句子，请使用简体中文输出。";
const t2sConverter = OpenCC.Converter({ from: "t", to: "cn" });

function isChineseLang(lang) {
  if (!lang) return false;
  const v = String(lang).toLowerCase();
  return v === "zh" || v === "chinese" || v.startsWith("zh-") || v.startsWith("zh_");
}

async function isAvailable() {
  // 静态检查 binary; 模型可懒加载, ensureModel 阶段会兜底
  const binary = whisperCppRuntime.resolveBinaryPath();
  return !!binary;
}

async function ensureModel(modelId, onProgress) {
  return whisperCppRuntime.ensureModel(modelId, onProgress);
}

async function warmup(modelId) {
  // 启动 server 即视为 warmup
  return whisperCppRuntime.start(modelId);
}

async function transcribe({ wavPath, modelId, language, onProgress, handle }) {
  if (!modelId) throw new Error("缺少 modelId");

  // 启动 / 复用 server
  if (onProgress) onProgress({ stage: "load", message: "正在准备本地语音引擎" });
  await whisperCppRuntime.start(modelId);
  const status = whisperCppRuntime.getStatus();
  if (!status.running || !status.port) {
    throw new Error(status.lastError || "whisper-server 未就绪");
  }

  if (onProgress) onProgress({ stage: "decode", message: "正在读取音频内容" });
  const fileBytes = await fs.readFile(wavPath);

  // 实测 whisper.cpp server 的 /inference 端点接受常规 multipart;
  // file 字段名固定 "file"; response_format=verbose_json 返回 token-level segments。
  const form = new FormData();
  form.append("file", new Blob([fileBytes], { type: "audio/wav" }), "audio.wav");
  form.append("response_format", "verbose_json");
  form.append("temperature", "0");
  if (language) form.append("language", language);
  if (isChineseLang(language)) form.append("prompt", SIMPLIFIED_PROMPT);

  if (onProgress) onProgress({ stage: "infer", message: "本地语音引擎推理中" });
  const response = await fetch(`http://127.0.0.1:${status.port}/inference`, {
    method: "POST",
    signal: handle?.abortController?.signal,
    body: form,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`whisper-server ${response.status}: ${detail.slice(0, 300)}`);
  }

  const data = await response.json();
  const detectedLang = data?.language || language || null;
  const shouldSimplify = isChineseLang(detectedLang) || isChineseLang(language);
  const normalize = (s) => {
    const t = String(s || "").trim();
    return shouldSimplify && t ? t2sConverter(t) : t;
  };

  const rawSegments = Array.isArray(data?.segments) ? data.segments : [];
  const segments = rawSegments.map((s) => ({
    start: Number(s.start) || 0,
    end: Number(s.end) || 0,
    text: normalize(s.text),
  }));
  const fullText =
    typeof data?.text === "string" && data.text.trim()
      ? normalize(data.text)
      : segments.map((s) => s.text).join(" ").trim();

  return {
    language: detectedLang,
    text: fullText,
    segments,
    duration: Number(data?.duration) || (segments.length ? segments[segments.length - 1].end : 0),
  };
}

module.exports = { backend: "whisper_cpp", isAvailable, ensureModel, warmup, transcribe };
