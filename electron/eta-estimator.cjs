// 各 stage 预估耗时计算器。
//
// 模型: 每个 LLM stage 的 wall time = prefill (prompt tokens / prefillTps) +
//       decode (estimated completion tokens / decodeTps) + per-frame image encode (vision only)
//       + 固定开销 (HTTP / grammar / JSON)。
//
// 早期版本 (commit 235d0af) 用 base + perFrame 拟合 probe fixture, 结果跟生产 workload
// 严重低估 (主分析 5.3x / 镜头合并 3.4x): 因为 probe completion 几百 tok, 实际生产 5000-7000
// tok。改成 token-driven 之后, eta-learner 学到的 TPS 也能直接喂回来覆盖 hardcoded。
//
// 基础数据来源: eta-samples.jsonl sample #9 (2026-05-21 M3 Pro Metal, 110.9s 视频, Qwen3.5-9B
// Q4_K_M, ctx 32K) 实测:
//   - main-analysis: prompt 8291 tok / completion 7008 tok / wall 407.6s → decode≈20 tok/s,
//     prefill 用余量 ~250 tok/s 反推
//   - shot-merger batch=6, 3 batches, wall 163s 总 → ~54s/batch
//
// stage 名必须跟 main.cjs send(stage) 字符串严格 prefix 匹配 (ProgressScreen 用 startsWith
// join), 否则 ProgressScreen 找不到 stage 预算, 退化成线性外推。修过的对齐:
//   main 用 "模型分析画面" / "准备分析素材" / "识别视频类型" / "提取音轨" / "字幕识别",
//   不是 "主分析" / "整理素材" / "识别题材" / "音频转码" / "音频转录"。

// 各本地模型的 decode 速度 (tok/s) 和 prefill 速度 (tok/s) on M3 Pro Metal Q4_K_M.
// decodeTps 是关键: completion tokens / decodeTps 主导一切长输出 stage 的耗时。
const LOCAL_MODEL_TPS = {
  qwen3_5_0_8b_q4km: { decode: 200, prefill: 1500 },
  qwen3_5_4b_q4km: { decode: 30, prefill: 400 },
  qwen3_5_9b_q4km: { decode: 20, prefill: 300 },
};

// per-frame image encode (vision LLM 加载 jpeg → token 的额外开销, 不算在 prompt prefill 里)
const PER_FRAME_IMAGE_ENCODE_MS = {
  qwen3_5_0_8b_q4km: 300,
  qwen3_5_4b_q4km: 800,
  qwen3_5_9b_q4km: 1200,
};

// 云端 fallback (没 learner TPS 时用; learner 学到就覆盖)
const CLOUD_FALLBACK_TPS = 60;
const CLOUD_FALLBACK_PREFILL_TPS = 800;
const CLOUD_NETWORK_LATENCY_MS = 800;

function pickModelTps(provider, learnedBaselines) {
  // 优先 learner 学到的; 否则 hardcoded; 都没有给云端 fallback
  if (learnedBaselines?.providers && provider?.id && provider?.model) {
    const learned = learnedBaselines.providers[`${provider.id}|${provider.model}`];
    if (learned?.tps) {
      return { decode: learned.tps, prefill: learned.prefillTps || learned.tps * 12, source: "learned" };
    }
  }
  if (provider?.source === "local_llama" && LOCAL_MODEL_TPS[provider.model]) {
    return { ...LOCAL_MODEL_TPS[provider.model], source: "hardcoded" };
  }
  return { decode: CLOUD_FALLBACK_TPS, prefill: CLOUD_FALLBACK_PREFILL_TPS, source: "fallback" };
}

// 基础公式: 估单次 LLM 调用的 wall time
function estimateLlmCallMs({ promptTokens, completionTokens, framesInPrompt = 0, provider, learnedBaselines }) {
  const tps = pickModelTps(provider, learnedBaselines);
  const prefillMs = (promptTokens / tps.prefill) * 1000;
  const decodeMs = (completionTokens / tps.decode) * 1000;
  const imageEncodeMs =
    framesInPrompt > 0 && provider?.source === "local_llama"
      ? framesInPrompt * (PER_FRAME_IMAGE_ENCODE_MS[provider.model] || 1000)
      : framesInPrompt * 1500; // 云端 vision
  const overheadMs = provider?.source === "local_llama" ? 300 : CLOUD_NETWORK_LATENCY_MS + 500;
  return prefillMs + decodeMs + imageEncodeMs + overheadMs;
}

// 各 LLM stage 的 token / frame 量级估算 (基于 #9 + 经验)
//
// shot-merger per batch (按 #9 14 shots / 3 batch / 163s 实测拟合):
//   - prompt: shotsPerBatch * 500 tok (含字幕片段 + scene 元数据)
//   - completion: shotsPerBatch * 150 tok (每个 shot 输出一句 shotDescription)
function estimateShotMergerBatch(batchSize, provider, learnedBaselines) {
  return estimateLlmCallMs({
    promptTokens: batchSize * 500,
    completionTokens: batchSize * 150,
    provider,
    learnedBaselines,
  });
}

// summarizer (全局聚合):
//   - prompt: shotContexts JSON (shots * 300) + transcript (≤4000 chars ≈ 6000 tok) + catalog
//   - completion: ~3000 tok (genre + summary + structureHint)
function estimateSummarizerCall(shotsCount, transcriptChars, provider, learnedBaselines) {
  const transcriptTokens = Math.round((transcriptChars || 0) * 1.5);
  return estimateLlmCallMs({
    promptTokens: shotsCount * 300 + transcriptTokens + 1500,
    completionTokens: 3000,
    provider,
    learnedBaselines,
  });
}

// detect-genre (兜底, 没 shotContexts 时跑):
//   - prompt: transcript + catalog ≈ 3000 tok
//   - completion: ~800 tok
function estimateDetectGenreCall(transcriptChars, provider, learnedBaselines) {
  const transcriptTokens = Math.round((transcriptChars || 0) * 1.5);
  return estimateLlmCallMs({
    promptTokens: transcriptTokens + 1500,
    completionTokens: 800,
    provider,
    learnedBaselines,
  });
}

// chunk-pass 主分析:
//   - prompt: globalSummary + shotContexts + transcript chunk + frames
//     按 #9 实测 1 chunk = 8291 tok prompt → 拟合公式: 1500 (template) + framesPerChunk * 400 +
//     transcriptChars * 1.5 + shotsCount * 200
//   - completion: 按 framesPerChunk 输出 nodes JSON, 每帧 ~800 tok 节点描述
//     #9: 7 帧 (实际 prefilter 后) → 7008 tok ≈ 1000 tok/frame
function estimateChunkPassCall(framesPerChunk, transcriptCharsInChunk, shotsCount, provider, learnedBaselines) {
  const transcriptTokens = Math.round((transcriptCharsInChunk || 0) * 1.5);
  return estimateLlmCallMs({
    promptTokens: 1500 + framesPerChunk * 400 + transcriptTokens + shotsCount * 100,
    completionTokens: framesPerChunk * 1000,
    framesInPrompt: framesPerChunk,
    provider,
    learnedBaselines,
  });
}

// audit-pass (chunks > 1 时, 无 frames):
//   - prompt: 所有 chunk 节点 JSON 摘要 ≈ 4000 tok
//   - completion: ~2500 tok (校准 + 全局补充)
function estimateAuditCall(provider, learnedBaselines) {
  return estimateLlmCallMs({
    promptTokens: 4000,
    completionTokens: 2500,
    provider,
    learnedBaselines,
  });
}

// 单 prefilter 调用 (1 frame): prompt ~300 tok + 1 frame, completion ~85 tok
function estimatePrefilterPerFrame(provider, learnedBaselines) {
  return estimateLlmCallMs({
    promptTokens: 300,
    completionTokens: 85,
    framesInPrompt: 1,
    provider,
    learnedBaselines,
  });
}

// 弹幕情绪聚合: 每个时间桶一次, prompt 含若干弹幕原文 ~600 tok, completion ~300 tok
function estimateDanmakuBucketCall(provider, learnedBaselines) {
  return estimateLlmCallMs({
    promptTokens: 600,
    completionTokens: 300,
    provider,
    learnedBaselines,
  });
}

// ---------- 数量级推算 ----------
// shots: M3 Pro 实测短视频 (110s) 14 shots ≈ 1 shot / 8s。
// 长视频 cut 密度趋稳, 用 / 7.5 兼顾。
function estimateShotsCount(durationSec) {
  return Math.max(1, Math.round(durationSec / 7.5));
}

// candidateFrames: 与 main.cjs targetFrameCount + candidateFrameCount 对齐
function estimateTargetFrameCount(durationSec, options) {
  const density = options?.density || "standard";
  const mode = options?.mode || "standard";
  const base = density === "dense" ? 6 : density === "sparse" ? 2 : 4;
  const detailBoost = mode === "detailed" ? 1 : mode === "quick" ? -1 : 0;
  const durationMin = Math.max(0.5, durationSec / 60);
  const target = Math.round(durationMin * (base + detailBoost));
  const upper = Math.max(32, Math.round(durationMin * 4));
  return Math.max(6, Math.min(upper, target));
}

function estimateCandidateFrames(durationSec, options, hasPrefilter, scenesCount) {
  const target = estimateTargetFrameCount(durationSec, options);
  if (!hasPrefilter) return target;
  const sc = scenesCount || estimateShotsCount(durationSec);
  const perSecFloor = Math.ceil(durationSec);
  const floor = Math.max(target, sc, perSecFloor);
  const desired = Math.max(Math.round(floor * 1.5), floor + 8);
  return Math.max(floor, desired);
}

// keptFrames: prefilter 之后留给主分析的帧数 (经验保留率 ~40%)
function estimateKeptFrames(candidateFrames, hasPrefilter) {
  if (!hasPrefilter) return candidateFrames;
  return Math.max(4, Math.round(candidateFrames * 0.4));
}

// chunks: token 预算近似 — 与 main.cjs planAnalysisChunks 对齐
function estimateChunksCount(durationSec, contextSize, keptFrames, shotsCount, transcriptChars, isLocalProvider) {
  if (keptFrames != null && shotsCount != null) {
    const ctxSize = contextSize || 8192;
    const reserveOutput = Math.max(1500, Math.floor(ctxSize * 0.25));
    const safetyMargin = Math.max(256, Math.floor(ctxSize * 0.05));
    const budget = ctxSize - reserveOutput - 800 - safetyMargin;
    const tokPerFrame = isLocalProvider ? 280 : 800;
    const totalTok = keptFrames * tokPerFrame + shotsCount * 300
      + Math.round((transcriptChars || 0) * 1.5);
    if (budget > 0) return Math.max(1, Math.ceil(totalTok / budget));
  }
  const ctxK = (contextSize || 8192) / 1024;
  const secPerChunk = Math.max(60, ctxK * 18);
  return Math.max(1, Math.ceil(durationSec / secPerChunk));
}

// transcript 字数估算: 中文短视频 ~5 char/sec (无字幕场景给 0)
function estimateTranscriptChars(durationSec, hasAudio) {
  if (!hasAudio) return 0;
  return Math.round(durationSec * 5);
}

// whisper / api audio
function estimateAudioMs(durationSec, audioProvider) {
  if (!audioProvider) return 0;
  // 本地 whisper-cpp metal: M3 Pro base 实测 ~32ms/sec
  if (audioProvider.source === "local_whisper" || audioProvider.source === "local") {
    return Math.round(durationSec * 35);
  }
  // 云端 (groq whisper-large): ~50ms/sec + 网络
  return Math.round(durationSec * 50 + 2000);
}

// shot-merger batch size: 与 shot-merger.cjs ctxToBatchCap 对齐
function estimateShotMergerBatchSize(contextSize) {
  const ctx = contextSize || 8192;
  if (ctx <= 2048) return 2;
  if (ctx <= 4096) return 3;
  if (ctx <= 8192) return 4;
  if (ctx <= 16384) return 6;
  if (ctx <= 32768) return 8;
  return 12;
}

// ---------- 主入口 ----------
function computeBudget({
  durationSec,
  hasAudio = true,
  platform, // "bilibili" / "douyin" / "url" / "local"
  complexVisionProvider, // 主分析 (chunk-pass / single-pass)
  mediumTextProvider, // shot-merger / summarizer
  audioProvider, // whisper
  prefilterEnabled,
  prefilterModelKey,
  contextSize,
  options,
  learnedBaselines,
  actualScenesCount,
  actualCandidateFrames,
} = {}) {
  if (!durationSec || durationSec <= 0) {
    return { totalMs: 0, stages: [], note: "missing durationSec" };
  }

  const shotsCount = actualScenesCount || estimateShotsCount(durationSec);
  const candidateFrames = actualCandidateFrames
    || estimateCandidateFrames(durationSec, options, prefilterEnabled, shotsCount);
  const keptFrames = estimateKeptFrames(candidateFrames, prefilterEnabled);
  const transcriptChars = estimateTranscriptChars(durationSec, hasAudio);
  const effectiveCtx = contextSize ?? complexVisionProvider?.contextSize;
  const isLocal = complexVisionProvider?.source === "local_llama";
  const chunksCount = estimateChunksCount(
    durationSec, effectiveCtx, keptFrames, shotsCount, transcriptChars, isLocal,
  );
  const framesPerChunk = chunksCount > 0 ? Math.ceil(keptFrames / chunksCount) : keptFrames;
  const transcriptCharsPerChunk = chunksCount > 0 ? Math.round(transcriptChars / chunksCount) : transcriptChars;
  const shotMergerBatchSize = estimateShotMergerBatchSize(
    mediumTextProvider?.contextSize ?? effectiveCtx,
  );

  const stages = [];

  // 1. ffmpeg / 选点 (CPU)
  stages.push({ stage: "读取视频信息", estMs: 600, kind: "cpu" });
  stages.push({ stage: "检测镜头切换", estMs: Math.round(durationSec * 30), kind: "ffmpeg" });
  stages.push({ stage: "本地推理预检", estMs: prefilterEnabled ? 600 : 100, kind: "cpu" });
  stages.push({ stage: "挑选关键画面", estMs: 100, kind: "cpu" });
  stages.push({ stage: "抽取关键画面", estMs: candidateFrames * 500, kind: "ffmpeg", note: `${candidateFrames} 帧` });

  // 2. 本地初筛 (vision LLM 逐帧)
  if (prefilterEnabled && prefilterModelKey) {
    const prefilterProvider = { source: "local_llama", model: prefilterModelKey };
    const perFrame = estimatePrefilterPerFrame(prefilterProvider, learnedBaselines);
    stages.push({
      stage: "本地初筛",
      estMs: candidateFrames * perFrame,
      kind: "llm-vision",
      note: `${candidateFrames} 帧 × ${prefilterModelKey}`,
    });
  }

  // 3. 音频转录 (注意: main 用 "提取音轨" / "字幕识别", 不是 "音频转码" / "音频转录")
  if (hasAudio) {
    stages.push({ stage: "提取音轨", estMs: 500, kind: "ffmpeg" });
    stages.push({
      stage: "字幕识别",
      estMs: estimateAudioMs(durationSec, audioProvider),
      kind: "whisper",
      note: audioProvider?.source === "local_whisper" ? "本地 whisper" : "云端",
    });
  }

  // 4. 镜头合并 (shot-merger, 文本 LLM 按 batch)
  if (mediumTextProvider?.baseUrl) {
    const batches = Math.ceil(shotsCount / shotMergerBatchSize);
    const perBatch = estimateShotMergerBatch(shotMergerBatchSize, mediumTextProvider, learnedBaselines);
    stages.push({
      stage: "镜头合并",
      estMs: batches * perBatch,
      kind: "llm-text",
      note: `${shotsCount} 个镜头 / batch=${shotMergerBatchSize} → ${batches} 次`,
    });
  }

  // 5. 全局聚合 (summarizer); shotContexts 在手才跑, 否则 detectGenre 兜底
  if (mediumTextProvider?.baseUrl) {
    stages.push({
      stage: "全局聚合",
      estMs: estimateSummarizerCall(shotsCount, transcriptChars, mediumTextProvider, learnedBaselines),
      kind: "llm-text",
    });
  }

  // 6. 准备分析素材 (CPU, 整理 frames + transcripts 喂给主分析)
  stages.push({ stage: "准备分析素材", estMs: 200, kind: "cpu" });

  // 7. 识别视频类型 (detect-genre fallback, 仅 summarizer 失败/无 shotContexts 时跑;
  //    summarizer 成功时跳过, 所以不计入 budget 总和, 避免重复算 — 但保留一个 stage 位让
  //    ProgressScreen 能 startsWith 匹配上 send("识别视频类型...") 的 progress 区间)。
  if (complexVisionProvider?.baseUrl) {
    stages.push({
      stage: "识别视频类型",
      estMs: 0,
      kind: "llm-text",
      note: "全局聚合成功时跳过, 不计入预算",
    });
  }

  // 8. 主分析 (chunk-pass × N)
  if (complexVisionProvider?.baseUrl) {
    const perChunk = estimateChunkPassCall(
      framesPerChunk,
      transcriptCharsPerChunk,
      shotsCount,
      complexVisionProvider,
      learnedBaselines,
    );
    stages.push({
      stage: "模型分析画面",
      estMs: chunksCount * perChunk,
      kind: "llm-vision",
      note: `${chunksCount} 段 × ${framesPerChunk} 帧/段`,
    });

    // 9. audit-pass (仅 chunked 模式 chunks > 1)
    if (chunksCount > 1) {
      stages.push({
        stage: "主分析(审计)",
        estMs: estimateAuditCall(complexVisionProvider, learnedBaselines),
        kind: "llm-text",
      });
    }
  }

  // 10. 弹幕 (B 站)
  if (platform === "bilibili") {
    stages.push({ stage: "拉取弹幕", estMs: 3000, kind: "network" });
    if (mediumTextProvider?.baseUrl) {
      const buckets = Math.max(1, Math.ceil(durationSec / 30));
      const perBucket = estimateDanmakuBucketCall(mediumTextProvider, learnedBaselines);
      stages.push({ stage: "弹幕情绪聚合", estMs: buckets * perBucket, kind: "llm-text", note: `${buckets} 桶` });
    }
  }

  // 11. 整理结果 (thumbnails + report + SQLite, 跟 shots 数线性)
  stages.push({ stage: "整理结果", estMs: 1500 + shotsCount * 1000, kind: "cpu" });

  const totalMs = stages.reduce((sum, s) => sum + s.estMs, 0);

  return {
    totalMs: Math.round(totalMs),
    stages: stages.map((s) => ({ ...s, estMs: Math.round(s.estMs) })),
    inputs: {
      durationSec,
      candidateFrames,
      keptFrames,
      shotsCount,
      chunksCount,
      framesPerChunk,
      transcriptChars,
      contextSize: contextSize ?? complexVisionProvider?.contextSize ?? null,
    },
  };
}

module.exports = {
  computeBudget,
  LOCAL_MODEL_TPS,
  PER_FRAME_IMAGE_ENCODE_MS,
  estimateShotsCount,
  estimateCandidateFrames,
  estimateKeptFrames,
  estimateChunksCount,
  estimateLlmCallMs,
  estimateChunkPassCall,
  estimateShotMergerBatch,
  estimateShotMergerBatchSize,
};
