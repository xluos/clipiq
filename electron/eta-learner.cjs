// 在线 ETA 学习器: 扫 userData/eta-samples.jsonl, 按 (providerId, model) 反推 decode TPS,
// 持久化到 userData/eta-baselines.json, 给 eta-estimator 的 pickModelTps 用。
//
// 数据流:
//   每次 analyzeProject 跑完, main.cjs append 一行 sample 到 eta-samples.jsonl;
//   sample.stages[i].tokenDelta = [{ stage, providerId, model, source, promptTokens,
//     completionTokens, callCount, ... }]; 一个中文 stage 内可能含多个 ledger bucket。
//   学习器把 wall time 减掉估的 prefill, 反推 decode TPS:
//     decodeMs = wallMs - promptTokens / hardcodedPrefillTps * 1000 - overheadMs
//     decodeTps = completionTokens / decodeMs * 1000
//   多次 sample 取中位 (抗 outlier), 写回 baselines.json。
//
// 颗粒度: (providerId, model) — TPS 是模型本质属性, 跨 text-stage 共用。
//
// vision stage (main-analysis / prefilter) wall_time 还含 per-frame image encode, 单从 wall
// 反推 TPS 会偏低。当前学习器只收 text stage; 本地 vision stage 仍走 estimator 的 hardcoded
// 路径。如果未来想精准, 可在 record 时同步记 framesInPrompt 单独减掉 image encode 时间。

const fs = require("node:fs/promises");
const path = require("node:path");

const SAMPLES_FILE = "eta-samples.jsonl";
const BASELINES_FILE = "eta-baselines.json";

// 学习器排除的 stage (vision / wall 含 image encode, 不可直接套 TPS)
const SKIP_LEARN_STAGES = new Set(["prefilter", "main-analysis"]);
// 太短的 stage 不学 (噪声: 网络抖动 / cold start / cache 命中)
const MIN_STAGE_MS = 800;
// 太少 completion token 不学 (信噪比差)
const MIN_COMPLETION_TOKENS = 200;
// 至少多少个独立 sample 才认 baseline 已稳
const MIN_SAMPLE_COUNT = 2;

// 反推 decode TPS 时用的 prefill TPS 假设 (按模型档位; 不同档位 prefill 速度差异大)。
// 没匹配到就用通用云端 fallback。
const PREFILL_TPS_HINT = {
  qwen3_5_0_8b_q4km: 500,
  qwen3_5_4b_q4km: 300,
  qwen3_5_9b_q4km: 250,
};
const CLOUD_PREFILL_TPS_HINT = 800;
const CLOUD_NETWORK_OVERHEAD_MS = 1300; // round trip + JSON
const LOCAL_OVERHEAD_MS = 1500; // grammar 编译 + JSON parse

async function readSamples(userDataDir) {
  const filePath = path.join(userDataDir, SAMPLES_FILE);
  let content;
  try { content = await fs.readFile(filePath, "utf8"); }
  catch { return []; }
  const out = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { out.push(JSON.parse(trimmed)); }
    catch { /* 损坏行跳过 */ }
  }
  return out;
}

async function loadBaselines(userDataDir) {
  const file = path.join(userDataDir, BASELINES_FILE);
  try {
    const text = await fs.readFile(file, "utf8");
    const obj = JSON.parse(text);
    return obj && typeof obj === "object" && obj.providers ? obj : { providers: {} };
  } catch { return { providers: {} }; }
}

async function saveBaselines(userDataDir, baselines) {
  const file = path.join(userDataDir, BASELINES_FILE);
  await fs.writeFile(file, JSON.stringify(baselines, null, 2));
}

function median(nums) {
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// 反推 decode TPS: 从 (wallMs, promptTokens, completionTokens) 减去 prefill + overhead
function reverseDecodeTps({ wallMs, promptTokens, completionTokens, source, model }) {
  const isLocal = source === "local_llama";
  const prefillTps = isLocal
    ? (PREFILL_TPS_HINT[model] || 250)
    : CLOUD_PREFILL_TPS_HINT;
  const overheadMs = isLocal ? LOCAL_OVERHEAD_MS : CLOUD_NETWORK_OVERHEAD_MS;
  const prefillMs = (promptTokens / prefillTps) * 1000;
  const decodeMs = wallMs - prefillMs - overheadMs;
  if (decodeMs < 500) return null; // 减完几乎没剩, 不可信
  return completionTokens / decodeMs * 1000;
}

// 主入口: 从 sample 文件重算所有 baseline
async function recomputeFromSamples(userDataDir) {
  const samples = await readSamples(userDataDir);
  const buckets = new Map(); // (providerId|model) → array of { tps, ... }

  for (const sample of samples) {
    if (sample.outcome !== "ok") continue; // 失败 / 取消的 timing 不可靠
    if (!Array.isArray(sample.stages)) continue;
    for (const stage of sample.stages) {
      if (!stage.durationMs || stage.durationMs < MIN_STAGE_MS) continue;
      if (!Array.isArray(stage.tokenDelta) || stage.tokenDelta.length === 0) continue;
      const totalCallCount = stage.tokenDelta.reduce((s, e) => s + (e.callCount || 0), 0) || 1;
      for (const entry of stage.tokenDelta) {
        if (!entry.providerId || !entry.model) continue;
        if (SKIP_LEARN_STAGES.has(entry.stage)) continue;
        if (!entry.completionTokens || entry.completionTokens < MIN_COMPLETION_TOKENS) continue;
        if (!entry.callCount) continue;
        const share = (entry.callCount || 1) / totalCallCount;
        const myDuration = stage.durationMs * share;
        if (myDuration <= 0) continue;
        const tps = reverseDecodeTps({
          wallMs: myDuration,
          promptTokens: entry.promptTokens || 0,
          completionTokens: entry.completionTokens,
          source: entry.source,
          model: entry.model,
        });
        if (!tps || tps <= 0) continue;
        const key = `${entry.providerId}|${entry.model}`;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push({
          tps,
          source: entry.source,
          completionTokens: entry.completionTokens,
          promptTokens: entry.promptTokens || 0,
          callCount: entry.callCount,
          stage: entry.stage,
          sampledAt: sample.startedAt,
        });
      }
    }
  }

  const providers = {};
  for (const [key, samples] of buckets) {
    if (samples.length < MIN_SAMPLE_COUNT) continue;
    const tpsMedian = median(samples.map((s) => s.tps));
    const [providerId, model] = key.split("|");
    providers[key] = {
      providerId,
      model,
      source: samples[0].source,
      tps: Math.round(tpsMedian * 10) / 10,
      sampleCount: samples.length,
      // 给排查用; estimator 不直接消费 perCallMs
      avgCompletionTokens: Math.round(samples.reduce((s, x) => s + x.completionTokens, 0) / samples.length),
      avgPromptTokens: Math.round(samples.reduce((s, x) => s + x.promptTokens, 0) / samples.length),
      lastUpdated: new Date().toISOString(),
    };
  }
  return { providers };
}

async function updateAndSave(userDataDir) {
  const next = await recomputeFromSamples(userDataDir);
  await saveBaselines(userDataDir, next);
  return next;
}

function lookupTps(baselines, providerId, model) {
  if (!baselines?.providers) return null;
  const key = `${providerId || ""}|${model || ""}`;
  return baselines.providers[key]?.tps || null;
}

module.exports = {
  readSamples,
  loadBaselines,
  saveBaselines,
  recomputeFromSamples,
  updateAndSave,
  lookupTps,
  SAMPLES_FILE,
  BASELINES_FILE,
};
