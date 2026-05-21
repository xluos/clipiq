// 各 stage 预估耗时计算器。
//
// baseline 数据来源: scripts/probe/reports/probe-2026-05-21T03-24-42-612Z (M-series Metal,
// Qwen3.5 Q4_K_M 三档实测)。每条函数都按 "实测中位 × 1.0" 给, 不再额外加 buffer —
// ProgressScreen 会用真实经过的 stage 时长去 calibrate 剩余预算, 偏低 / 偏高都会被纠正。
//
// 设计原则:
// - 每个 stage 估算只关心"这一段的纯计算量", 不算上下游
// - LLM 阶段用 (per-batch / per-frame / per-chunk) × 次数, 系数按 modelKey 查表
// - 云端模型 (非 local_llama) 给保守经验值, 后续接 telemetry 再细分
// - 没法精算的字段 (chunks 数 / shots 数 / frames 数) 用 durationSec 推算; main.cjs
//   实际跑到对应 stage 时可以发 budget update 修正 (本期未做)
//
// 输出 stage.stage 必须跟 main.cjs send(stage) 用的字符串保持 prefix 匹配, ProgressScreen
// 拿 stageLabel.startsWith(s.stage) 关联。

// per-frame prefilter 总耗时 (ms): 包含 prompt eval 305 tok + completion ~85 tok
// 探测: 0.8B=0.9s, 4B=3.0s, 9B=4.5s
const PREFILTER_PER_FRAME_MS = {
  qwen3_5_0_8b_q4km: 900,
  qwen3_5_4b_q4km: 3000,
  qwen3_5_9b_q4km: 4500,
};

// shot-merger per-batch ms, by batchSize. 实测中位 (跳过 truncated 那档)
const SHOT_MERGER_PER_BATCH_MS = {
  qwen3_5_0_8b_q4km: { 3: 2400, 6: 4900, 12: 8000 },
  qwen3_5_4b_q4km: { 3: 7200, 6: 13500, 12: 25500 },
  qwen3_5_9b_q4km: { 3: 7800, 6: 16000, 12: 40000 },
};

// chunk-pass per-chunk ms: y = base + framesPerChunk * perFrame
// 探测拟合 (4f / 8f 两点线性):
//   0.8B: 4f=7.4s, 8f=12.2s → base=2.6s, perFrame=1.2s
//   4B:   4f=32s,  8f=47s   → base=17s,  perFrame=3.75s
//   9B:   4f=32s,  8f=45s   → base=19s,  perFrame=3.25s
const CHUNK_PASS_COEFFS = {
  qwen3_5_0_8b_q4km: { base: 2600, perFrame: 1200 },
  qwen3_5_4b_q4km: { base: 17000, perFrame: 3750 },
  qwen3_5_9b_q4km: { base: 19000, perFrame: 3250 },
};

// audit-pass: 无图, 输入只有 nodes + transcript, 输出 ~1500-2500 tok
// 估算 = base (prompt eval) + 1800 tok / TPS
const AUDIT_TPS = {
  qwen3_5_0_8b_q4km: 110,
  qwen3_5_4b_q4km: 32,
  qwen3_5_9b_q4km: 20,
};

// 云端 fallback (没 telemetry, 经验值)
const CLOUD_FALLBACK = {
  prefilterPerFrameMs: 1500,
  shotMergerPerBatchMs: { 3: 4000, 6: 8000, 12: 14000 },
  chunkPassPerChunkMs: 25000,
  auditMs: 15000,
  tps: 60,
};

// 云端 picker 查 learned baseline; 没数据返回 null, 让上层 fallback hardcoded。
// 单次 call 估算 = 网络往返 + (估算 completion tokens / learnedTps)。
function lookupLearnedTps(learnedBaselines, provider) {
  if (!learnedBaselines?.providers || !provider?.id || !provider?.model) return null;
  return learnedBaselines.providers[`${provider.id}|${provider.model}`]?.tps || null;
}

function pickPrefilterPerFrameMs(modelKey) {
  return PREFILTER_PER_FRAME_MS[modelKey] || CLOUD_FALLBACK.prefilterPerFrameMs;
}

function pickShotMergerPerBatchMs(provider, batchSize, learnedBaselines) {
  if (provider?.source === "local_llama" && SHOT_MERGER_PER_BATCH_MS[provider.model]) {
    return SHOT_MERGER_PER_BATCH_MS[provider.model][batchSize] || SHOT_MERGER_PER_BATCH_MS[provider.model][6];
  }
  // 云端: 查 learner 拟合的 TPS
  const learnedTps = lookupLearnedTps(learnedBaselines, provider);
  if (learnedTps) {
    // 经验估 completion token: batch=3 → ~250, batch=6 → ~500, batch=12 → ~950
    const estTokens = batchSize === 3 ? 250 : batchSize === 6 ? 500 : 950;
    const networkLatencyMs = 800;
    return Math.round(networkLatencyMs + (estTokens / learnedTps) * 1000);
  }
  return CLOUD_FALLBACK.shotMergerPerBatchMs[batchSize] || CLOUD_FALLBACK.shotMergerPerBatchMs[6];
}

function pickChunkPassPerChunkMs(provider, framesPerChunk, learnedBaselines) {
  if (provider?.source === "local_llama" && CHUNK_PASS_COEFFS[provider.model]) {
    const c = CHUNK_PASS_COEFFS[provider.model];
    return c.base + framesPerChunk * c.perFrame;
  }
  // 云端 vision: 网络 + per-image encode (估 1500ms/张) + 输出 1000 tok / learnedTps
  const learnedTps = lookupLearnedTps(learnedBaselines, provider);
  if (learnedTps) {
    const imageEncodeMs = framesPerChunk * 1500;
    const outputMs = (1000 / learnedTps) * 1000;
    return Math.round(2000 + imageEncodeMs + outputMs);
  }
  return CLOUD_FALLBACK.chunkPassPerChunkMs + framesPerChunk * 500;
}

function pickAuditMs(provider, learnedBaselines) {
  if (provider?.source === "local_llama" && AUDIT_TPS[provider.model]) {
    // prompt eval (1500 tok) + completion (1800 tok / TPS)
    return Math.round(2500 + (1800 / AUDIT_TPS[provider.model]) * 1000);
  }
  const learnedTps = lookupLearnedTps(learnedBaselines, provider);
  if (learnedTps) {
    return Math.round(2000 + (1800 / learnedTps) * 1000);
  }
  return CLOUD_FALLBACK.auditMs;
}

function pickLightTextCallMs(provider, completionTokens, learnedBaselines) {
  if (provider?.source === "local_llama" && AUDIT_TPS[provider.model]) {
    return Math.round(2500 + (completionTokens / AUDIT_TPS[provider.model]) * 1000);
  }
  const learnedTps = lookupLearnedTps(learnedBaselines, provider);
  if (learnedTps) {
    return Math.round(1500 + (completionTokens / learnedTps) * 1000);
  }
  // fallback: 云端中等模型经验值
  return Math.round(2000 + (completionTokens / CLOUD_FALLBACK.tps) * 1000);
}

// ---------- 数量级推算 ----------
// shots: 每 ~3.5s 一个 shot 经验
function estimateShotsCount(durationSec) {
  return Math.max(1, Math.round(durationSec / 3.5));
}

// candidateFrames: 跟 main.cjs candidateFrameCount 大致对齐
// density: dense=6, standard=4, sparse=2 张/分钟基础; 开 prefilter 时 ~2.5x
function estimateCandidateFrames(durationSec, options, hasPrefilter) {
  const density = options?.density || "standard";
  const mode = options?.mode || "standard";
  const base = density === "dense" ? 6 : density === "sparse" ? 2 : 4;
  const detailBoost = mode === "detailed" ? 1 : mode === "quick" ? -1 : 0;
  const durationMin = Math.max(0.5, durationSec / 60);
  let n = Math.round(durationMin * (base + detailBoost));
  if (hasPrefilter) n = Math.round(n * 2.5);
  return Math.max(8, Math.min(300, n));
}

// chunks: 主分析 chunked split. ctx 越大单 chunk 装越多 → chunks 越少
// 经验 secPerChunk: 8K→144s, 16K→288s, 32K→576s
function estimateChunksCount(durationSec, contextSize) {
  const ctxK = (contextSize || 8192) / 1024;
  const secPerChunk = Math.max(60, ctxK * 18);
  return Math.max(1, Math.ceil(durationSec / secPerChunk));
}

// whisper / api audio
function estimateAudioMs(durationSec, audioProvider) {
  if (!audioProvider) return 0;
  // 本地 whisper-cpp metal: ~0.15x realtime
  if (audioProvider.source === "local_whisper" || audioProvider.source === "local") {
    return Math.round(durationSec * 150);
  }
  // 云端 (groq whisper-large): ~0.05x realtime + 网络
  return Math.round(durationSec * 50 + 2000);
}

// ---------- 主入口 ----------
// 输出: { totalMs, stages: [{ stage, estMs, kind, note? }] }
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
  learnedBaselines, // { providers: { "providerId|model": { tps, ... } } } — 学习器输出
} = {}) {
  if (!durationSec || durationSec <= 0) {
    return { totalMs: 0, stages: [], note: "missing durationSec" };
  }

  const candidateFrames = estimateCandidateFrames(durationSec, options, prefilterEnabled);
  const shotsCount = estimateShotsCount(durationSec);
  const chunksCount = estimateChunksCount(durationSec, contextSize ?? complexVisionProvider?.contextSize);
  const framesPerChunk = chunksCount > 0 ? Math.ceil(candidateFrames / chunksCount) : candidateFrames;
  const shotMergerBatchSize = 6;

  const stages = [];

  // 1. 视频探测 / 镜头检测 / 关键画面选点 (CPU + ffmpeg)
  stages.push({ stage: "读取视频信息", estMs: 1500, kind: "cpu" });
  stages.push({ stage: "检测镜头切换", estMs: Math.round(durationSec * 30), kind: "ffmpeg" });
  stages.push({ stage: "本地推理预检", estMs: prefilterEnabled ? 1000 : 200, kind: "cpu" });
  stages.push({ stage: "挑选关键画面", estMs: 800, kind: "cpu" });
  stages.push({ stage: "抽取关键画面", estMs: candidateFrames * 70, kind: "ffmpeg", note: `${candidateFrames} 帧` });

  // 2. 本地初筛 (vision LLM 逐帧)
  if (prefilterEnabled && prefilterModelKey) {
    stages.push({
      stage: "本地初筛",
      estMs: candidateFrames * pickPrefilterPerFrameMs(prefilterModelKey),
      kind: "llm-vision",
      note: `${candidateFrames} 帧 × ${prefilterModelKey}`,
    });
  }

  // 3. 音频转录
  if (hasAudio) {
    stages.push({ stage: "音频转码", estMs: 2500, kind: "ffmpeg" });
    stages.push({
      stage: "音频转录",
      estMs: estimateAudioMs(durationSec, audioProvider),
      kind: "whisper",
      note: audioProvider?.source === "local_whisper" ? "本地 whisper" : "云端",
    });
  }

  // 4. 整理素材
  stages.push({ stage: "整理素材", estMs: 600, kind: "cpu" });

  // 5. 全局聚合 (summarizer 之前的 detect-genre / globalSummary)
  if (mediumTextProvider?.baseUrl) {
    stages.push({ stage: "识别题材", estMs: pickLightTextCallMs(mediumTextProvider, 800, learnedBaselines), kind: "llm-text" });
    stages.push({ stage: "全局聚合", estMs: pickLightTextCallMs(mediumTextProvider, 1200, learnedBaselines), kind: "llm-text" });
  }

  // 6. 镜头合并 (shot-merger, 文本 LLM 按 batch)
  if (mediumTextProvider?.baseUrl) {
    const batches = Math.ceil(shotsCount / shotMergerBatchSize);
    const perBatch = pickShotMergerPerBatchMs(mediumTextProvider, shotMergerBatchSize, learnedBaselines);
    stages.push({
      stage: "镜头合并",
      estMs: batches * perBatch,
      kind: "llm-text",
      note: `${shotsCount} 个镜头 / batch=${shotMergerBatchSize} → ${batches} 次`,
    });
  }

  // 7. 主分析 (chunk-pass 或 single-pass)
  if (complexVisionProvider?.baseUrl) {
    const perChunk = pickChunkPassPerChunkMs(complexVisionProvider, framesPerChunk, learnedBaselines);
    stages.push({
      stage: "主分析",
      estMs: chunksCount * perChunk,
      kind: "llm-vision",
      note: `${chunksCount} 段 × ${framesPerChunk} 帧/段`,
    });

    // 8. audit-pass (仅 chunked 模式跑 — chunks > 1)
    if (chunksCount > 1) {
      stages.push({
        stage: "主分析(审计)",
        estMs: pickAuditMs(complexVisionProvider, learnedBaselines),
        kind: "llm-text",
      });
    }
  }

  // 9. 弹幕 (B 站)
  if (platform === "bilibili") {
    stages.push({ stage: "拉取弹幕", estMs: 3000, kind: "network" });
    if (mediumTextProvider?.baseUrl) {
      // 弹幕情绪聚合, 大约 ceil(durationSec/30) 个时间桶, 每桶一次 LLM 调用
      const buckets = Math.max(1, Math.ceil(durationSec / 30));
      const perBucket = pickLightTextCallMs(mediumTextProvider, 300, learnedBaselines);
      stages.push({ stage: "弹幕情绪聚合", estMs: buckets * perBucket, kind: "llm-text", note: `${buckets} 桶` });
    }
  }

  // 10. 标题生成 + 整理结果
  stages.push({ stage: "整理结果", estMs: 1500, kind: "cpu" });

  const totalMs = stages.reduce((sum, s) => sum + s.estMs, 0);

  return {
    totalMs: Math.round(totalMs),
    stages: stages.map((s) => ({ ...s, estMs: Math.round(s.estMs) })),
    inputs: {
      durationSec,
      candidateFrames,
      shotsCount,
      chunksCount,
      framesPerChunk,
      contextSize: contextSize ?? complexVisionProvider?.contextSize ?? null,
    },
  };
}

module.exports = {
  computeBudget,
  // 暴露查表用 helpers 给外部脚本 / 测试
  PREFILTER_PER_FRAME_MS,
  SHOT_MERGER_PER_BATCH_MS,
  CHUNK_PASS_COEFFS,
  AUDIT_TPS,
  estimateShotsCount,
  estimateCandidateFrames,
  estimateChunksCount,
};
