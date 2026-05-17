// 远程 model id → capability tags 的离线推断规则.
// 数据表来源:抄自 cherry-studio main 分支 (https://github.com/CherryHQ/cherry-studio
// /tree/main/src/renderer/src/config/models),挑了我们用得到的 capability:
// vision / reasoning / fast / long_context / audio_transcription / embedding / rerank.
// 我们没有 function_calling / web_search / image_generation,故未抄那几条.
//
// 维护方式:cherry 每加几个 model family,直接同步过来.allowed/excluded 数组各对应
// "肯定是 / 肯定不是"两端,中间通过 negative-lookahead 组合成一条 regex.

const VISION_ALLOWED = [
  // 通配 / 多模态家族
  "vision",
  "llava",
  "moondream",
  "minicpm",
  "pixtral",
  // GPT 全系列
  "gpt-4(?:-[\\w-]+)",
  "gpt-4\\.1(?:-[\\w-]+)?",
  "gpt-4o(?:-[\\w-]+)?",
  "gpt-4\\.5(?:-[\\w-]+)",
  "gpt-5(?:-[\\w-]+)?",
  "chatgpt-4o(?:-[\\w-]+)?",
  "o1(?:-[\\w-]+)?",
  "o3(?:-[\\w-]+)?",
  "o4(?:-[\\w-]+)?",
  // Claude
  "claude-3",
  "claude-haiku-4",
  "claude-sonnet-4",
  "claude-opus-4",
  // Gemini
  "gemini-1\\.5",
  "gemini-2\\.0",
  "gemini-2\\.5",
  "gemini-3(?:\\.\\d)?-(?:flash|pro)(?:-preview)?",
  "gemini-(flash|pro|flash-lite)-latest",
  "gemini-exp",
  // 国内 Qwen / GLM / DeepSeek / Doubao / Kimi / Step / MiMo
  "glm-4(?:\\.\\d+)?v(?:-[\\w-]+)?",
  "glm-5v-turbo",
  "qwen-vl",
  "qwen2-vl",
  "qwen2\\.5-vl",
  "qwen3-vl",
  "qwen3\\.[5-9](?:-[\\w-]+)?",
  "qwen2\\.5-omni",
  "qwen3-omni(?:-[\\w-]+)?",
  "qwen-omni(?:-[\\w-]+)?",
  "qvq",
  "deepseek-vl(?:[\\w-]+)?",
  "doubao-seed-1[.-][68](?:-[\\w-]+)?",
  "doubao-seed-2[.-]0(?:-[\\w-]+)?",
  "doubao-seed-code(?:-[\\w-]+)?",
  "kimi-k2\\.[56](?:-[\\w-]+)?",
  "kimi-latest",
  "kimi-thinking-preview",
  "kimi-vl-a3b-thinking(?:-[\\w-]+)?",
  "step-1o(?:.*vision)?",
  "step-1v(?:-[\\w-]+)?",
  "mimo-v2\\.5$",
  "mimo-v2-omni(?:-[\\w-]+)?",
  // Llama / Gemma / Mistral / Grok / InternVL
  "internvl2",
  "grok-vision-beta",
  "grok-4(?:-[\\w-]+)?",
  "gemma-?[3-4](?:[-.\\w]+)?",
  "gemma3(?:[-:\\w]+)?",
  "llama-guard-4(?:-[\\w-]+)?",
  "llama-4(?:-[\\w-]+)?",
  "mistral-large-(2512|latest)",
  "mistral-medium-(2508|latest)",
  "mistral-small",
];

const VISION_EXCLUDED = [
  "gpt-4-\\d+-preview",
  "gpt-4-turbo-preview",
  "gpt-4-32k",
  "gpt-4-\\d+",
  "o1-mini",
  "o3-mini",
  "o1-preview",
  "aidc-ai/marco-o1",
];

const VISION_REGEX = new RegExp(
  `\\b(?!(?:${VISION_EXCLUDED.join("|")})\\b)(${VISION_ALLOWED.join("|")})\\b`,
  "i",
);

// reasoning 单条复杂 regex,来源:cherry-studio config/models/reasoning.ts
// 关键 group:o-series / id 含 reasoning|reasoner|thinking|think / -r\d+ /
// qwq / hunyuan-t1 / glm-zero-preview / grok-3-mini / grok-4 / grok-4-fast
// negative lookahead 排除 "-non-reasoning" 后缀
const REASONING_REGEX =
  /^(?!.*-non-reasoning\b)(o\d+(?:-[\w-]+)?|.*\b(?:reasoning|reasoner|thinking|think)\b.*|.*-[rR]\d+.*|.*\bqwq(?:-[\w-]+)?\b.*|.*\bhunyuan-t1(?:-[\w-]+)?\b.*|.*\bglm-zero-preview\b.*|.*\bgrok-(?:3-mini|4|4-fast)(?:-[\w-]+)?\b.*)$/i;

// embedding / rerank 短路用:这种模型不该带任何 modality tag
const EMBEDDING_REGEX =
  /(?:^text-|embed|bge-|e5-|llm2vec|retrieval|uae-|gte-|jina-clip|jina-embeddings|voyage-)/i;
const RERANK_REGEX = /(?:rerank|re-rank|re-ranker|re-ranking|retrieval|retriever)/i;

// 这些是我们项目自己的需求,cherry 没有对应概念
// fast:UI 上用来标"低延迟变体". \b 包裹避免 'mini' 误中 'gemini' 这种子串.
const FAST_ALLOWED = [
  "mini",
  "flash",
  "turbo",
  "nano",
  "haiku",
  "lite",
  "[1-3]b", // 1b / 2b / 3b
  "[0-9]\\.5b", // 0.5b
];
const FAST_REGEX = new RegExp(`\\b(?:${FAST_ALLOWED.join("|")})\\b`, "i");

// long_context:128k / 200k / 256k / 1m
const LONG_CONTEXT_REGEX = /(?:^|[-_])(128k|200k|256k|1m|long(?:-?context)?)(?:[-_]|$)/i;

// audio:whisper / asr / transcribe / speech / stt
const AUDIO_REGEX = /(?:whisper|asr|transcribe|speech|stt(?:[-_]|$))/i;

// 把 "OpenAI/gpt-5.4" / "azure/gpt-4o" 这种命名空间前缀剥掉,转 lowercase
// cherry 内部叫 getLowerBaseModelName,语义一致.
function getLowerBaseModelName(rawId, separator = "/") {
  const lower = String(rawId || "").toLowerCase();
  const idx = lower.lastIndexOf(separator);
  return idx >= 0 ? lower.slice(idx + 1) : lower;
}

// 用 ModelDescriptor.capabilities 的 enum:
// "vision" | "audio_transcription" | "reasoning" | "fast" | "long_context" | "text"
// 没匹到任何 modality 时回落 "text".
function inferCapabilitiesFromRemoteId(rawId) {
  const id = getLowerBaseModelName(rawId);
  if (!id) return ["text"];

  // embedding / rerank 模型不该有任何 modality
  if (EMBEDDING_REGEX.test(id) || RERANK_REGEX.test(id)) return [];

  const caps = new Set();
  if (VISION_REGEX.test(id)) caps.add("vision");
  if (AUDIO_REGEX.test(id)) caps.add("audio_transcription");
  if (REASONING_REGEX.test(id)) caps.add("reasoning");
  if (FAST_REGEX.test(id)) caps.add("fast");
  if (LONG_CONTEXT_REGEX.test(id)) caps.add("long_context");
  if (!caps.has("vision") && !caps.has("audio_transcription")) caps.add("text");
  return Array.from(caps);
}

module.exports = {
  VISION_REGEX,
  REASONING_REGEX,
  EMBEDDING_REGEX,
  RERANK_REGEX,
  FAST_REGEX,
  LONG_CONTEXT_REGEX,
  AUDIO_REGEX,
  getLowerBaseModelName,
  inferCapabilitiesFromRemoteId,
};
