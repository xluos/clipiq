// 镜头级合并 (金字塔管线第二层):
//
// 把 detectScenes 切出的 shot, 加上 shot 内抽到的 frame captions, 加上落在 shot
// 区间内的字幕, 用 medium_text 槽位的模型合并成"这个镜头讲了什么" + 代表帧。
//
// 设计要点:
// - **batched**: 一次 LLM 调用合并多个 shot, 减少 round-trip; 30 个 shot 按 N/批
//   要 30/N 次调用而不是 30 次。batch 越小, 单批 prompt 越短, 弱模型出 JSON 截断的
//   概率越低; batch 越大单批吐越多但容易超 context。
//   batchSize 不传 → 按 provider.contextSize 和该批 shots 的实际 prompt 长度动态算
//   (chooseBatchSize), 留 15% 输出 + 600 token 模板成本后能塞下几个就用几个,
//   范围 [1, 12]; 显式传值则跳过自动算。
// - 没有图传上去, 输入全是文本 (frame caption + 字幕), 因为 medium_text 槽位
//   不要求 vision capability。tokens 主要由 prompt 长度决定。
// - 失败的 shot 给 fallback shotDescription (字幕 + 第一帧 caption 拼一下), 不阻断。
// - 不并发: 单序串行, 失败仅影响该 batch, 总耗时是 batches × 平均单次。
//   未来如果用本地 medium 模型 (llama-server) 同样保单实例避免争资源。
// - 走 openai-client 的 callJsonCompletion 统一入口, 按 provider.endpointType
//   自动分流 chat/completions vs responses (GPT-5 等 reasoning 模型在 sub2api 这种
//   代理下必须走 responses + SSE 才能拿到 content)。

const { callJsonCompletion } = require("./openai-client.cjs");

const ALLOWED_BATCH_SIZE = { min: 1, max: 12, default: 3 };

function clampBatchSize(n) {
  if (!Number.isFinite(n)) return ALLOWED_BATCH_SIZE.default;
  return Math.max(ALLOWED_BATCH_SIZE.min, Math.min(ALLOWED_BATCH_SIZE.max, Math.round(n)));
}

// 估单个 shot 的 prompt token 成本: 时间戳行 + 字幕 + 每帧 caption + 元数据
// 中文 ~0.5 token/字 (英文略低, 这里用 0.5 保守估)
function estimateShotPromptTokens(shot) {
  let chars = 30; // SHOT N [a.bs - c.ds] 时间戳行
  if (shot.subtitleText) chars += shot.subtitleText.length;
  if (Array.isArray(shot.frames)) {
    for (const f of shot.frames) {
      // caption 长度 + "[Fi] @x.xs salience=N: " 这种元数据 (~25 字)
      chars += (f.caption?.length || 30) + 25;
    }
  }
  return Math.ceil(chars * 0.5);
}

// 按 ctx 给"结构化输出能力"经验上限:
// 单纯 token 预算够 ≠ LLM 真能稳定吐出 N 个 shot 的合法 JSON。本地 2B/4B 即使
// ctx 塞得下 10 个 shot, 输出端常出 JSON 截断或非合规 markdown。这条曲线粗粒度
// 把 ctx 当成模型能力的代理变量 (大 ctx 模型通常也大参数), 不让 batch 超过该档。
function ctxToBatchCap(ctx) {
  if (ctx <= 2048) return 2;
  if (ctx <= 4096) return 3;
  if (ctx <= 8192) return 4;
  if (ctx <= 16384) return 6;
  if (ctx <= 32768) return 8;
  return ALLOWED_BATCH_SIZE.max;
}

// 按 provider.contextSize + 该批 shots 实际 prompt 长度动态选 batch
//
// 算法两条线取 min:
// (a) token 预算: usable = ctx - outputReserve - systemOverhead, 单 shot 估 prompt+输出
// (b) ctx 经验上限 ctxToBatchCap, 防止本地小模型输出端崩
//
// 预算细项:
//   ctx                 = provider.contextSize (manifest 标注, 兜底 8192)
//   outputReserve       = max(800, ctx*15%)             给 JSON 输出留
//   systemOverhead      = 600                           system + user 模板固定成本
//   perShotOutput       = 80 token                      每个 shot 输出 30-80 字 + JSON 包装
//   avgShotPromptTokens = 取 shots 里最长的 5 个的平均  防偶发长字幕段把整批撑爆
function chooseBatchSize(provider, shots) {
  if (!Array.isArray(shots) || shots.length === 0) return ALLOWED_BATCH_SIZE.default;
  const ctx = Number(provider?.contextSize) > 0 ? Number(provider.contextSize) : 8192;
  const outputReserve = Math.max(800, Math.floor(ctx * 0.15));
  const systemOverhead = 600;
  const usable = ctx - outputReserve - systemOverhead;
  if (usable <= 0) return ALLOWED_BATCH_SIZE.min;

  const sampleCount = Math.min(5, shots.length);
  const top = shots
    .map(estimateShotPromptTokens)
    .sort((a, b) => b - a)
    .slice(0, sampleCount);
  const avgShotPromptTokens = Math.max(1, top.reduce((a, b) => a + b, 0) / top.length);
  const perShotOutput = 80;

  const batchFromBudget = Math.floor(usable / (avgShotPromptTokens + perShotOutput));
  const batchFromCap = ctxToBatchCap(ctx);
  const batch = Math.min(batchFromBudget, batchFromCap);
  return Math.max(ALLOWED_BATCH_SIZE.min, Math.min(ALLOWED_BATCH_SIZE.max, batch));
}

function formatShotForPrompt(shot, indexInBatch) {
  const lines = [];
  lines.push(`SHOT ${indexInBatch} [${shot.startSec.toFixed(1)}s - ${shot.endSec.toFixed(1)}s]`);
  if (shot.subtitleText && shot.subtitleText.trim()) {
    lines.push(`字幕: ${shot.subtitleText.trim()}`);
  } else {
    lines.push("字幕: (无)");
  }
  if (Array.isArray(shot.frames) && shot.frames.length > 0) {
    lines.push("画面 (按时间序):");
    shot.frames.forEach((f, i) => {
      const cap = f.caption?.trim() || `${f.subject || "未识别"} · ${f.signature || ""}`.trim();
      const sal = typeof f.salience === "number" ? ` salience=${f.salience}` : "";
      lines.push(`  [F${i}] @${f.midSec.toFixed(1)}s${sal}: ${cap}`);
    });
  } else {
    lines.push("画面: (该镜头无抽帧)");
  }
  return lines.join("\n");
}

function buildMergePrompt(batchShots) {
  const system =
    "你是视频拉片助理。我会给你一段视频里的若干个镜头, 每个镜头包含: 时间范围 / 字幕 / 镜头内若干帧的画面描述。" +
    "你的任务是为每个镜头生成一段更高层次的'镜头内容描述', 并挑出代表帧。\n\n" +
    "规则:\n" +
    "- shotDescription: 30-80 汉字一段话, 综合画面 + 字幕信息, 说出'镜头里在做什么 / 在讲什么 / 情绪或氛围'。\n" +
    "- shotDescription 不要罗列帧, 要写出一个整体观察。\n" +
    "- representativeFrameIndex: 从该镜头的 F0/F1/... 中挑出 1-3 个最能代表镜头的帧 index (按信息量, 不超过镜头实有帧数)。\n" +
    "- 直接输出严格 JSON, 不要思考过程, 不要 markdown 围栏。";

  const userBlocks = batchShots.map((shot, i) => formatShotForPrompt(shot, i));
  const user =
    "请为下列 " +
    batchShots.length +
    " 个镜头各自生成描述和代表帧。注意 shotIndex 必须跟下面列出的顺序对应 (0, 1, 2, ...)。\n\n" +
    userBlocks.join("\n\n") +
    "\n\n请输出 JSON: { \"shots\": [{ \"shotIndex\": 0, \"shotDescription\": \"...\", \"representativeFrameIndex\": [0] }, ...] }";

  return { system, user };
}

const MERGE_SCHEMA = {
  type: "object",
  properties: {
    shots: {
      type: "array",
      items: {
        type: "object",
        properties: {
          shotIndex: { type: "integer", minimum: 0 },
          shotDescription: { type: "string", maxLength: 240 },
          representativeFrameIndex: {
            type: "array",
            items: { type: "integer", minimum: 0 },
            maxItems: 3,
          },
        },
        required: ["shotIndex", "shotDescription", "representativeFrameIndex"],
        additionalProperties: false,
      },
    },
  },
  required: ["shots"],
  additionalProperties: false,
};

// 走 openai-client 统一入口, 按 provider.endpointType 自动分流 chat/completions vs responses。
// medium_text 槽位的 provider 已经被 shapeEffectiveProvider 处理过 baseUrl/apiKeyRef/model/endpointType。
// 返回 { parsed, usage, model } —— 上游需要按 batch 统计 token 消耗。
async function callMediumText(provider, systemText, userText, signal) {
  if (!provider?.baseUrl || !provider?.apiKeyRef || !provider?.model) {
    throw new Error("medium_text provider 配置不全 (baseUrl/apiKeyRef/model 缺失)");
  }
  // max_tokens 不再 hardcode 1500, 走 openai-client deriveDefaultMaxTokens (ctx*0.25 clamp [1500,16000])。
  // settings 里 ctx slider 调大 → output 预算自动跟着大, thinking 模型也能装下 reasoning + content。
  // 调用方仍可在 provider.maxOutputTokens 显式覆盖。
  const result = await callJsonCompletion(provider, {
    systemText,
    userText,
    temperature: 0.2,
    signal,
  });
  if (!result.parsed) {
    throw new Error(
      `medium_text 解析失败 (raw text 为空或不是合法 JSON; 走的 endpoint=${provider.endpointType})`,
    );
  }
  return result;
}

// 生成兜底 shotDescription (LLM 失败 / 单批崩了时, 不让管线断)
function fallbackShotDescription(shot) {
  const firstFrameCap = shot.frames?.[0]?.caption?.trim() || "";
  const sub = shot.subtitleText?.trim() || "";
  if (firstFrameCap && sub) return `${firstFrameCap} 旁白: ${sub}`;
  if (firstFrameCap) return firstFrameCap;
  if (sub) return `旁白: ${sub}`;
  return "(画面与字幕信息均缺失)";
}

/**
 * @param {{
 *   shots: Array<{
 *     startSec: number,
 *     endSec: number,
 *     subtitleText?: string,
 *     frames: Array<{ caption?: string, subject?: string, signature?: string, salience?: number, midSec: number }>,
 *   }>,
 *   provider: object,
 *   batchSize?: number,
 *   handle?: { abortController?: AbortController, cancelled?: boolean },
 *   onProgress?: (info: { done: number, total: number, batchIndex: number }) => void,
 * }} args
 * @returns {Promise<Array<{ shotDescription: string, representativeFrameIndex: number[] }>>}
 */
// 把一个 batch 全部用 fallback 描述填进 result 数组
function fillBatchWithFallback(batch, result, baseIndex) {
  for (let j = 0; j < batch.length; j++) {
    const local = batch[j];
    const frameCount = Array.isArray(local.frames) ? local.frames.length : 0;
    result[baseIndex + j] = {
      shotDescription: fallbackShotDescription(local),
      representativeFrameIndex: frameCount > 0 ? [0] : [],
    };
  }
}

const GIVE_UP_AFTER_CONSECUTIVE_FAIL = 3;
const MAX_BATCH_RETRIES = 2;

async function mergeShots({ shots, provider, batchSize, concurrency: concurrencyOpt, handle, onProgress, cache }) {
  const size = batchSize == null ? chooseBatchSize(provider, shots) : clampBatchSize(batchSize);
  const concurrency = Math.max(1, Math.min(12, Number(concurrencyOpt) || 1));
  // eslint-disable-next-line no-console
  console.log(
    `[shot-merger] batchSize=${size} concurrency=${concurrency} (${batchSize == null ? "auto" : "explicit"}) · ctx=${provider?.contextSize ?? "?"} · shots=${shots.length}`,
  );
  const result = new Array(shots.length);
  let completedShots = 0;
  let consecutiveFail = 0;
  let cacheHits = 0;
  let givenUp = false;
  const usageAgg = { promptTokens: 0, completionTokens: 0, totalTokens: 0, callCount: 0 };
  let echoedModel = null;

  // 把所有 batch 预切好
  const batches = [];
  for (let i = 0; i < shots.length; i += size) {
    batches.push({ startIdx: i, batch: shots.slice(i, i + size), batchNum: batches.length + 1 });
  }

  // 单 batch 处理逻辑 (含缓存查询 + 重试)
  const processBatch = async ({ startIdx, batch, batchNum }) => {
    if (handle?.cancelled) throw new Error("cancelled");

    // 缓存查询
    if (cache) {
      try {
        const hit = await cache.lookup(batch);
        if (Array.isArray(hit?.entries) && hit.entries.length === batch.length) {
          for (let j = 0; j < batch.length; j++) result[startIdx + j] = hit.entries[j];
          cacheHits += batch.length;
          completedShots += batch.length;
          if (onProgress) onProgress({ done: completedShots, total: shots.length, batchIndex: batchNum, mode: "cache-hit" });
          return;
        }
      } catch { /* 缓存读失败 → 走 LLM */ }
    }

    if (givenUp) {
      fillBatchWithFallback(batch, result, startIdx);
      completedShots += batch.length;
      if (onProgress) onProgress({ done: completedShots, total: shots.length, batchIndex: batchNum, mode: "fallback-shortcut" });
      return;
    }

    const { system, user } = buildMergePrompt(batch);
    for (let attempt = 0; attempt <= MAX_BATCH_RETRIES; attempt++) {
      if (handle?.cancelled) throw new Error("cancelled");
      try {
        const callResult = await callMediumText(provider, system, user, handle?.abortController?.signal);
        const parsed = callResult.parsed;
        if (callResult.usage) {
          usageAgg.promptTokens += callResult.usage.promptTokens;
          usageAgg.completionTokens += callResult.usage.completionTokens;
          usageAgg.totalTokens += callResult.usage.totalTokens;
          usageAgg.callCount += 1;
        } else {
          usageAgg.callCount += 1;
        }
        if (callResult.model) echoedModel = callResult.model;
        const out = Array.isArray(parsed?.shots) ? parsed.shots : [];
        if (out.length === 0) throw new Error("parsed JSON 缺少 shots 字段");

        consecutiveFail = 0;
        const batchEntries = [];
        for (let j = 0; j < batch.length; j++) {
          const local = batch[j];
          const match = out.find((s) => Number(s.shotIndex) === j) || out[j];
          const frameCount = Array.isArray(local.frames) ? local.frames.length : 0;
          const rawIdxs = Array.isArray(match?.representativeFrameIndex) ? match.representativeFrameIndex : [];
          const repIdxs = rawIdxs.map((n) => Math.floor(Number(n))).filter((n) => Number.isFinite(n) && n >= 0 && n < frameCount);
          const desc = typeof match?.shotDescription === "string" && match.shotDescription.trim()
            ? match.shotDescription.trim().slice(0, 240)
            : fallbackShotDescription(local);
          const entry = { shotDescription: desc, representativeFrameIndex: repIdxs.length > 0 ? repIdxs : frameCount > 0 ? [0] : [] };
          result[startIdx + j] = entry;
          batchEntries.push(entry);
        }
        if (cache) {
          try { await cache.store(batch, { entries: batchEntries }, { batchIndex: batchNum }); }
          catch { /* 写缓存失败不阻塞 */ }
        }
        completedShots += batch.length;
        if (onProgress) onProgress({ done: completedShots, total: shots.length, batchIndex: batchNum, mode: "ok" });
        return;
      } catch (error) {
        if (handle?.cancelled) throw error;
        if (attempt < MAX_BATCH_RETRIES) {
          console.warn(`[shot-merger] batch ${batchNum} 第 ${attempt + 1} 次失败, 重试:`, error?.message || error);
          continue;
        }
        consecutiveFail += 1;
        console.warn(`[shot-merger] batch ${batchNum} 重试 ${MAX_BATCH_RETRIES} 次仍失败 (#${consecutiveFail} 连续), 走 fallback:`, error?.message || error);
        fillBatchWithFallback(batch, result, startIdx);
        completedShots += batch.length;
        if (onProgress) onProgress({ done: completedShots, total: shots.length, batchIndex: batchNum, mode: "fallback-batch" });
        if (consecutiveFail >= GIVE_UP_AFTER_CONSECUTIVE_FAIL) {
          givenUp = true;
          console.warn(`[shot-merger] 连续 ${consecutiveFail} 个 batch 失败, 放弃 LLM 路径, 后续直接 fallback`);
        }
        return;
      }
    }
  };

  // 并发池: 同时最多 concurrency 个 batch 在飞
  if (concurrency <= 1) {
    for (const b of batches) await processBatch(b);
  } else {
    let cursor = 0;
    const inflight = new Set();
    const launch = () => {
      while (inflight.size < concurrency && cursor < batches.length) {
        const b = batches[cursor++];
        const p = processBatch(b).finally(() => { inflight.delete(p); });
        inflight.add(p);
      }
    };
    launch();
    while (inflight.size > 0) {
      await Promise.race(inflight);
      launch();
    }
  }
  if (typeof result.cacheHits === "undefined") {
    Object.defineProperty(result, "cacheHits", { value: cacheHits, enumerable: false });
  }
  // 把 batch 维度的 usage 总和挂在数组上, 主流程按阶段记账 (不影响下标遍历)
  Object.defineProperty(result, "usage", {
    value: usageAgg.callCount > 0 ? usageAgg : null,
    enumerable: false,
  });
  Object.defineProperty(result, "echoedModel", { value: echoedModel, enumerable: false });
  return result;
}

module.exports = { mergeShots };
