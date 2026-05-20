// 弹幕情绪聚合 + LLM 打分
//
// 输入: 全片弹幕 + 已切好的 shots (PR2 金字塔产物); 没 shots 时退化到固定 5s 桶
// 输出:
//   - windows: 每个桶一个 { startSec, endSec, danmakuCount, dominantEmotion, intensities, sampleTexts }
//   - nodeReactions: { [nodeId]: AudienceReaction }   用于挂到 node.audienceReaction
//
// 设计要点:
//   - 弹幕量级:1 小时视频常见 1k-10k 条 → 不能逐条喂 LLM。按桶聚合 + 取 top N + 频次摘要, 一次 LLM 调用评一批桶 (默认 8)
//   - 情绪 5 维: joy / surprise / anger / sadness / disgust, intensity 0-1
//   - LLM 失败一律返回 neutral 兜底, 不阻断主流程

const { callJsonCompletion } = require("./openai-client.cjs");

const FIXED_BUCKET_SEC = 5;
const SAMPLES_PER_WINDOW = 6;        // 喂 LLM 时每桶最多这些条
const NODE_SAMPLE_LIMIT = 4;          // 挂到 node 上时保留的样本数
const BATCH_SIZE = 8;                 // 一次 LLM 调用评几个桶
const EMOTION_AXES = ["joy", "surprise", "anger", "sadness", "disgust"];

// ---- 分桶 -------------------------------------------------------------------

function bucketByShots(messages, shots) {
  if (!Array.isArray(shots) || shots.length === 0) return null;
  const buckets = shots.map((s) => ({
    shotIndex: s.shotIndex,
    startSec: Number(s.startSec) || 0,
    endSec: Number(s.endSec) || 0,
    messages: [],
  }));
  for (const m of messages) {
    const t = Number(m.tSec);
    if (!Number.isFinite(t)) continue;
    // 二分: shots 已按时间升序, 找 startSec <= t < endSec 的那个
    let lo = 0;
    let hi = buckets.length - 1;
    let hit = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const b = buckets[mid];
      if (t < b.startSec) hi = mid - 1;
      else if (t >= b.endSec) lo = mid + 1;
      else { hit = mid; break; }
    }
    if (hit >= 0) buckets[hit].messages.push(m);
  }
  return buckets;
}

function bucketByFixed(messages, durationSec) {
  const total = Math.max(1, Math.ceil(durationSec / FIXED_BUCKET_SEC));
  const buckets = Array.from({ length: total }, (_, i) => ({
    shotIndex: undefined,
    startSec: i * FIXED_BUCKET_SEC,
    endSec: Math.min(durationSec, (i + 1) * FIXED_BUCKET_SEC),
    messages: [],
  }));
  for (const m of messages) {
    const idx = Math.min(total - 1, Math.max(0, Math.floor(Number(m.tSec) / FIXED_BUCKET_SEC)));
    buckets[idx].messages.push(m);
  }
  return buckets;
}

// ---- 频次摘要 ---------------------------------------------------------------
// 取每桶最有代表性的 N 条: 优先 weight 高的, 重复内容只保留 1 条 + 计数

function summarizeBucket(bucket) {
  const counts = new Map();
  for (const m of bucket.messages) {
    const key = String(m.text || "").trim();
    if (!key) continue;
    const prev = counts.get(key);
    if (prev) {
      prev.count++;
      if ((m.weight || 0) > prev.weight) prev.weight = m.weight || 0;
    } else {
      counts.set(key, { text: key, count: 1, weight: m.weight || 0 });
    }
  }
  const entries = [...counts.values()].sort(
    (a, b) => b.count - a.count || b.weight - a.weight || a.text.localeCompare(b.text),
  );
  return entries.slice(0, SAMPLES_PER_WINDOW);
}

// ---- LLM 调用 ---------------------------------------------------------------

function neutralWindow(bucket) {
  return {
    shotIndex: bucket.shotIndex,
    startSec: bucket.startSec,
    endSec: bucket.endSec,
    danmakuCount: bucket.messages.length,
    dominantEmotion: "neutral",
    intensities: { joy: 0, surprise: 0, anger: 0, sadness: 0, disgust: 0 },
    sampleTexts: bucket.messages.slice(0, NODE_SAMPLE_LIMIT).map((m) => m.text),
  };
}

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function pickDominant(intensities) {
  let best = "neutral";
  let bestV = 0.2;       // 阈值: 任何轴 < 0.2 视为整体中性
  for (const axis of EMOTION_AXES) {
    const v = clamp01(intensities[axis]);
    if (v > bestV) { best = axis; bestV = v; }
  }
  return best;
}

function buildPromptForBatch(items) {
  // items: [{ index, startSec, endSec, summaries: [{text,count}] }]
  const lines = items.map((it) => {
    const head = `桶 ${it.index} [${it.startSec.toFixed(1)}-${it.endSec.toFixed(1)}s, 共 ${it.totalCount} 条]`;
    const body = it.summaries
      .map((s) => `  · ${s.text}${s.count > 1 ? ` (×${s.count})` : ""}`)
      .join("\n");
    return `${head}\n${body || "  · (无内容)"}`;
  });
  return lines.join("\n\n");
}

async function callBatch(provider, batch, abortSignal) {
  const userText = [
    "下面是同一视频里若干时间段(桶)的代表性弹幕。每个桶给一个 5 维情绪强度评分,所有维度都在 0-1。",
    "维度定义:",
    "- joy: 笑点/喜悦/开心/认同",
    "- surprise: 惊讶/震撼/意外",
    "- anger: 愤怒/不满/吐槽/嘲讽",
    "- sadness: 难过/同情/失落",
    "- disgust: 反感/无语/不适",
    "",
    "再给一句 ≤20 汉字的简短中文总结(summary), 描述这一桶弹幕整体反应。如果没有明显情绪/弹幕极少, 总结写'中性反应'即可,各维度都给 0。",
    "",
    "# 弹幕样本",
    buildPromptForBatch(batch),
    "",
    "请严格输出 JSON:",
    `{ "windows": [ { "index": 0, "intensities": { "joy":0..1, "surprise":0..1, "anger":0..1, "sadness":0..1, "disgust":0..1 }, "summary": "..." } ] }`,
    "windows 数组要包含上面所有桶的评分,index 与桶号对应。",
  ].join("\n");

  const result = await callJsonCompletion(provider, {
    systemText:
      "你在帮一个视频拉片工具评弹幕情绪。只返回 JSON,不要 markdown 围栏,不要解释过程。",
    userText,
    temperature: 0.2,
    maxTokens: provider.maxOutputTokens ?? 3000,
    maxOutputTokens: provider.maxOutputTokens ?? 3000,
    signal: abortSignal,
  });
  return result; // { parsed, usage, model }
}

// ---- 主入口 -----------------------------------------------------------------

async function aggregateEmotions({
  messages,
  shots,
  durationSec,
  provider,
  handle,
  onProgress,
  cache,
}) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { windows: [], summary: "" };
  }

  const bucketsRaw = bucketByShots(messages, shots) || bucketByFixed(messages, durationSec || 1);
  // 跳过完全没弹幕的桶, 直接置 neutral, 不喂 LLM 浪费
  const windows = bucketsRaw.map(neutralWindow);

  const needLLM = bucketsRaw
    .map((b, i) => ({ b, i }))
    .filter(({ b }) => b.messages.length > 0);

  if (needLLM.length === 0 || !provider?.apiKeyRef) {
    return { windows, summary: "", usage: null, echoedModel: null };
  }

  const usageAgg = { promptTokens: 0, completionTokens: 0, totalTokens: 0, callCount: 0 };
  let echoedModel = null;

  let done = 0;
  for (let offset = 0; offset < needLLM.length; offset += BATCH_SIZE) {
    if (handle?.cancelled) break;
    const slice = needLLM.slice(offset, offset + BATCH_SIZE);
    const batch = slice.map(({ b, i }, idxInBatch) => ({
      index: idxInBatch,
      bucketIndex: i,
      startSec: b.startSec,
      endSec: b.endSec,
      totalCount: b.messages.length,
      summaries: summarizeBucket(b),
    }));

    // 缓存查询: 同一 batch (各桶的样本 + 时间) 之前评过就直接复用
    let parsed = null;
    let fromCache = false;
    if (cache) {
      try {
        const hit = await cache.lookup(batch);
        if (hit?.parsed) {
          parsed = hit.parsed;
          fromCache = true;
        }
      } catch {
        // ignore
      }
    }

    try {
      if (!parsed) {
        const callResult = await callBatch(provider, batch, handle?.abortController?.signal);
        parsed = callResult.parsed;
        if (callResult.usage) {
          usageAgg.promptTokens += callResult.usage.promptTokens;
          usageAgg.completionTokens += callResult.usage.completionTokens;
          usageAgg.totalTokens += callResult.usage.totalTokens;
          usageAgg.callCount += 1;
        } else {
          usageAgg.callCount += 1;
        }
        if (callResult.model) echoedModel = callResult.model;
      }
      const arr = Array.isArray(parsed?.windows) ? parsed.windows : [];
      for (const item of arr) {
        const idx = Number(item?.index);
        if (!Number.isFinite(idx) || idx < 0 || idx >= batch.length) continue;
        const bucketIndex = batch[idx].bucketIndex;
        const target = windows[bucketIndex];
        const src = batch[idx];
        const intensities = {
          joy: clamp01(item?.intensities?.joy),
          surprise: clamp01(item?.intensities?.surprise),
          anger: clamp01(item?.intensities?.anger),
          sadness: clamp01(item?.intensities?.sadness),
          disgust: clamp01(item?.intensities?.disgust),
        };
        target.intensities = intensities;
        target.dominantEmotion = pickDominant(intensities);
        target.sampleTexts = src.summaries
          .slice(0, NODE_SAMPLE_LIMIT)
          .map((s) => (s.count > 1 ? `${s.text} ×${s.count}` : s.text));
        if (typeof item?.summary === "string" && item.summary.trim()) {
          target.summary = String(item.summary).trim().slice(0, 40);
        }
      }
      if (!fromCache && cache && Array.isArray(arr) && arr.length > 0) {
        try { await cache.store(batch, { parsed }, {}); } catch { /* 写缓存失败不阻塞 */ }
      }
    } catch (err) {
      // 这一批失败保持 neutral, 继续下一批
      console.warn("[danmaku-emotion] batch failed:", err?.message || err);
    }

    done += slice.length;
    if (typeof onProgress === "function") {
      onProgress({ done, total: needLLM.length });
    }
  }

  // 全片情绪总结: 取所有非空桶的加权情绪, 给一句中文描述 (启发式, 不再调 LLM)
  const totals = { joy: 0, surprise: 0, anger: 0, sadness: 0, disgust: 0 };
  let nonEmpty = 0;
  for (const w of windows) {
    if (w.danmakuCount === 0) continue;
    nonEmpty++;
    for (const axis of EMOTION_AXES) totals[axis] += w.intensities[axis];
  }
  let summary = "";
  if (nonEmpty > 0) {
    const avg = {};
    for (const axis of EMOTION_AXES) avg[axis] = totals[axis] / nonEmpty;
    const sorted = EMOTION_AXES
      .map((axis) => ({ axis, v: avg[axis] }))
      .filter((x) => x.v >= 0.15)
      .sort((a, b) => b.v - a.v);
    const labelOf = (a) => ({ joy: "笑点密集", surprise: "惊喜频出", anger: "争议吐槽", sadness: "情绪低沉", disgust: "反感无语" }[a]);
    if (sorted.length === 0) summary = "观众反应整体平淡。";
    else if (sorted.length === 1) summary = `观众${labelOf(sorted[0].axis)}。`;
    else summary = `观众${labelOf(sorted[0].axis)},伴随${labelOf(sorted[1].axis)}。`;
  }

  return {
    windows,
    summary,
    usage: usageAgg.callCount > 0 ? usageAgg : null,
    echoedModel,
  };
}

// ---- 挂到节点上 -------------------------------------------------------------

function attachReactionsToNodes(nodes, windows, allMessages) {
  if (!Array.isArray(nodes) || !Array.isArray(windows)) return;
  for (const node of nodes) {
    const ns = Number(node.startSec);
    const ne = Number(node.endSec);
    if (!Number.isFinite(ns) || !Number.isFinite(ne)) continue;

    // 找区间内所有 window, 加权聚合 intensities (按 danmakuCount 加权)
    const overlapping = windows.filter(
      (w) => Math.max(0, Math.min(w.endSec, ne) - Math.max(w.startSec, ns)) > 0 && w.danmakuCount > 0,
    );
    const totalCount = overlapping.reduce((acc, w) => acc + w.danmakuCount, 0);
    if (totalCount === 0) continue;
    const intensities = { joy: 0, surprise: 0, anger: 0, sadness: 0, disgust: 0 };
    for (const w of overlapping) {
      for (const axis of EMOTION_AXES) {
        intensities[axis] += w.intensities[axis] * w.danmakuCount;
      }
    }
    for (const axis of EMOTION_AXES) intensities[axis] = intensities[axis] / totalCount;

    // 节点内代表性弹幕: 在区间内频次 top N
    const counts = new Map();
    for (const m of allMessages || []) {
      const t = Number(m.tSec);
      if (!Number.isFinite(t) || t < ns || t >= ne) continue;
      const key = String(m.text || "").trim();
      if (!key) continue;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    const samples = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, NODE_SAMPLE_LIMIT)
      .map(([text, c]) => (c > 1 ? `${text} ×${c}` : text));

    const dominant = pickDominant(intensities);
    const labelOf = (a) => ({ joy: "笑场", surprise: "惊讶", anger: "吐槽", sadness: "感伤", disgust: "无语" }[a]);
    const summary = dominant === "neutral" ? "反应平淡" : `集体${labelOf(dominant)}`;

    node.audienceReaction = {
      dominantEmotion: dominant,
      intensities,
      danmakuCount: totalCount,
      summary,
      // topTerms 由 wordcloud 模块单独写入
    };
  }
}

module.exports = {
  aggregateEmotions,
  attachReactionsToNodes,
  EMOTION_AXES,
};
