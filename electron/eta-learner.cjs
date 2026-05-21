// 在线 ETA 学习器: 扫 userData/eta-samples.jsonl, 按 (providerId, model) 算 effective TPS,
// 持久化到 userData/eta-baselines.json, 给 eta-estimator 的云端 picker 用。
//
// 数据流:
//   每次 analyzeProject 跑完, main.cjs append 一行 sample 到 eta-samples.jsonl;
//   sample.stages[i] 带 { stage, durationMs, tokenDelta: [...] } —— 关 stage 时 main 已经
//   把 tokenLedger 的 delta 摘出来挂上 (我加在 closeCurrentStage 里);
//   学习器 join (stage.durationMs, entry.completionTokens) 算 effective TPS,
//   汇总各 sample 取中位 (抗 outlier), 写回 baselines.json。
//
// 颗粒度: (providerId, model) — TPS 是模型本质属性, 跨 stage 共用 (text-only stage 适用)。
// vision 类 (chunk-pass / prefilter) wall_time 含 image encode 时间, 不能直接套 TPS,
// 当前学习器只收 text-stage 的样本 (跳过 stage="prefilter" 和 "main-analysis" 的样本)。
//
// 本地模型 (source="local_llama") 已在 eta-estimator 有 hardcoded baseline, 学习器跳过。

const fs = require("node:fs/promises");
const path = require("node:path");

const SAMPLES_FILE = "eta-samples.jsonl";
const BASELINES_FILE = "eta-baselines.json";

// 学习器排除的 stage (vision / 不可加性 — 见模块注释)
const SKIP_LEARN_STAGES = new Set(["prefilter", "main-analysis"]);
// 太短的 stage 不学 (噪声大: 网络抖动 / cold start 干扰)
const MIN_STAGE_MS = 200;
// 太少 completion token 不学 (除以小数字 TPS 抖动)
const MIN_COMPLETION_TOKENS = 50;
// 至少多少个独立 sample 才认 baseline 已稳
const MIN_SAMPLE_COUNT = 2;

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

// 主入口: 从 sample 文件重算所有 baseline
async function recomputeFromSamples(userDataDir) {
  const samples = await readSamples(userDataDir);
  const buckets = new Map(); // (providerId|model) → array of { tps, perCallMs, completionTokens, callCount }

  for (const sample of samples) {
    if (sample.outcome !== "ok") continue; // 失败 / 取消的 timing 不可靠
    if (!Array.isArray(sample.stages)) continue;
    for (const stage of sample.stages) {
      if (!stage.durationMs || stage.durationMs < MIN_STAGE_MS) continue;
      if (!Array.isArray(stage.tokenDelta) || stage.tokenDelta.length === 0) continue;
      // 这个中文 stage 内可能有多个 ledger bucket (并发 stage 调多个模型, 少见但理论上可能)。
      // 按 callCount 比例摊 durationMs。
      const totalCallCount = stage.tokenDelta.reduce((s, e) => s + (e.callCount || 0), 0) || 1;
      for (const entry of stage.tokenDelta) {
        if (!entry.providerId || !entry.model) continue;
        if (entry.source === "local_llama") continue; // 本地有 hardcoded
        if (SKIP_LEARN_STAGES.has(entry.stage)) continue; // vision stage 跳过
        if (!entry.completionTokens || entry.completionTokens < MIN_COMPLETION_TOKENS) continue;
        if (!entry.callCount) continue;
        const share = (entry.callCount || 1) / totalCallCount;
        const myDuration = stage.durationMs * share;
        if (myDuration <= 0) continue;
        const tps = entry.completionTokens / myDuration * 1000;
        const perCallMs = myDuration / entry.callCount;
        const key = `${entry.providerId}|${entry.model}`;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push({
          tps,
          perCallMs,
          completionTokens: entry.completionTokens,
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
      tps: Math.round(tpsMedian * 10) / 10,
      sampleCount: samples.length,
      // 跨 stage 各自的 perCallMs 不直接可比 (单 call 的 prompt 长度差异大),
      // 这里只记中位 perCallMs 给排查用, estimator 不直接消费
      perCallMsMedian: Math.round(median(samples.map((s) => s.perCallMs))),
      lastUpdated: new Date().toISOString(),
    };
  }
  return { providers };
}

// 增量更新 + 持久化, 给 main.cjs 在每次 analyzeProject 完调用
async function updateAndSave(userDataDir) {
  const next = await recomputeFromSamples(userDataDir);
  await saveBaselines(userDataDir, next);
  return next;
}

// learner 给 estimator 查 TPS 的接口 (估算者拿 provider 后调)
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
