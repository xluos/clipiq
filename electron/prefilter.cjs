// 本地初筛: 用启动中的 llama-server (Qwen3.5 系列) 对候选帧批量打标。
// 输出严格 JSON 结构 PrefilterTag,供主管线做"删空镜/dedup/排序"的二次精筛。
//
// 设计:
// - 单 server 单 in-flight 请求(llama-server 没并发推理优势,并行只会争资源)
// - 用 json_schema response_format 强约束输出,避免自由文本被解析失败
// - Qwen3.5 默认开 thinking 模式,system prompt 明确禁止 + 实在拿不到 content 时
//   兜底从 reasoning_content 提取 JSON
// - 每帧 30s 硬超时,失败的帧标 salience=5 中性值,不阻塞整体流程

const fs = require("node:fs/promises");

const SCENE_TYPES = [
  "outdoor", "indoor", "transition", "text_card",
  "person", "product", "ui", "landscape", "other",
];

const PREFILTER_SCHEMA = {
  type: "object",
  properties: {
    sceneType: { type: "string", enum: SCENE_TYPES },
    subject: { type: "string", maxLength: 24 },
    hasText: { type: "string", enum: ["none", "chinese", "english", "mixed"] },
    salience: { type: "integer", minimum: 0, maximum: 10 },
    isEmpty: { type: "boolean" },
    signature: { type: "string", maxLength: 24 },
    caption: { type: "string", maxLength: 90 },
  },
  required: ["sceneType", "subject", "hasText", "salience", "isEmpty", "signature", "caption"],
  additionalProperties: false,
};

const SYSTEM_PROMPT =
  "你是视频画面的打标器,直接输出严格 JSON。字段定义:\n" +
  "- sceneType: 镜头类型枚举\n" +
  "- subject: 画面里看到的主体,≤8 汉字(例:背包男生 / 山顶日出 / 餐厅招牌)\n" +
  "- hasText: 是否有可读文字(标题卡/字幕/招牌)\n" +
  "- salience: 信息量打分 0-10。**画面里只要有人/物/场景主体,至少给 5 分**;9-10 留给主体非常突出、动作或表情明确、构图有讲究的关键画面。\n" +
  "- isEmpty: **仅当画面是纯黑屏/纯白屏/无明显主体的过场色块时填 true**;只要看得见人或物就一律 false。\n" +
  "- signature: 3-5 个汉字精炼概括(用主体+地点),例:海边背包 / 山顶日出 / 早餐桌。避免太宽的词如'户外''室内'。\n" +
  "- caption: 一句话描述这张画面(≤30 汉字),重点说\"主体在做什么\" + \"画面氛围或镜头角度\"。不要复述 sceneType/subject 已有的字段,要写出运动 / 动作 / 神态 / 构图等增量信息(例:女生背包面带笑意走过石板路 / 俯拍 桌上摆满甜品和咖啡)。\n" +
  "不要思考过程,直接输出 JSON。";

const USER_PROMPT_TEXT =
  "看这张视频帧,按上面规则输出 JSON。";

function neutralTag(reason) {
  return {
    sceneType: "other",
    subject: "未识别",
    hasText: "none",
    salience: 5,
    isEmpty: false,
    signature: "未识别",
    caption: "",
    _error: reason,
  };
}

function extractJsonFromText(text) {
  if (!text) return null;
  const trimmed = String(text).trim();
  // 直接 parse
  try {
    return JSON.parse(trimmed);
  } catch {
    // ignore
  }
  // 大括号包裹的第一段
  const match = trimmed.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch {
      // ignore
    }
  }
  return null;
}

function sanitizeTag(raw) {
  if (!raw || typeof raw !== "object") return neutralTag("invalid-shape");
  const sceneType = SCENE_TYPES.includes(raw.sceneType) ? raw.sceneType : "other";
  const subject = typeof raw.subject === "string" && raw.subject.trim()
    ? raw.subject.trim().slice(0, 24)
    : "未识别";
  const hasText = ["none", "chinese", "english", "mixed"].includes(raw.hasText) ? raw.hasText : "none";
  let salience = Number(raw.salience);
  if (!Number.isFinite(salience)) salience = 5;
  salience = Math.max(0, Math.min(10, Math.round(salience)));
  const isEmpty = Boolean(raw.isEmpty);
  const signature = typeof raw.signature === "string" && raw.signature.trim()
    ? raw.signature.trim().slice(0, 24)
    : subject;
  const caption = typeof raw.caption === "string" && raw.caption.trim()
    ? raw.caption.trim().slice(0, 90)
    : "";
  return { sceneType, subject, hasText, salience, isEmpty, signature, caption };
}

async function tagOneFrame(port, imagePath, modelKey, signal) {
  const buf = await fs.readFile(imagePath);
  const dataUrl = `data:image/jpeg;base64,${buf.toString("base64")}`;
  const body = {
    model: modelKey || "local",
    // Qwen3.5 默认开 thinking,会吃完 max_tokens 而 content 为空。
    // 透传给 chat_template 关掉。
    chat_template_kwargs: { enable_thinking: false },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: dataUrl } },
          { type: "text", text: USER_PROMPT_TEXT },
        ],
      },
    ],
    // 输出预算: 6 字段 tag (~70 token) + caption ≤30 汉字 (~60 token) + JSON 结构 (~20 token) ≈ 150 token, 2x buffer。
    // 必须配合 enable_thinking: false; 不关 thinking 会把 budget 烧在 <think>...</think> 段上 content 为空,
    // 兜底走 neutralTag。json_schema strict:true 在 llama-server 端会翻译成 GBNF grammar 提前 stop, 不会浪费 budget。
    max_tokens: 280,
    temperature: 0.1,
    response_format: {
      type: "json_schema",
      json_schema: { name: "prefilter_tag", strict: true, schema: PREFILTER_SCHEMA },
    },
  };
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${detail.slice(0, 200)}`);
  }
  const json = await res.json();
  const choice = json?.choices?.[0]?.message;
  // 主路径: content;兜底: reasoning_content(thinking 模式泄漏时)
  const parsed = extractJsonFromText(choice?.content) || extractJsonFromText(choice?.reasoning_content);
  const tag = sanitizeTag(parsed);
  return { tag, usage: json.usage || null };
}

// 逐帧串行调本地 server。
// frames: [{ index, prefilterFramePath, ... }, ...]
// onProgress(i, total, tag) 每帧完成时回调。
async function tagFrames(frames, { port, modelKey, perFrameTimeoutMs = 30_000, onProgress } = {}) {
  if (!port) throw new Error("prefilter: 缺少本地 server 端口");
  const out = [];
  let totalTokens = 0;
  const startedAt = Date.now();
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const t0 = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), perFrameTimeoutMs);
    let tag;
    let usage = null;
    let error = null;
    try {
      const result = await tagOneFrame(port, f.prefilterFramePath || f.framePath, modelKey, controller.signal);
      tag = result.tag;
      usage = result.usage;
      if (usage?.total_tokens) totalTokens += usage.total_tokens;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      tag = neutralTag(error);
    } finally {
      clearTimeout(timer);
    }
    const elapsedMs = Date.now() - t0;
    out.push({ ...f, prefilterTag: tag, prefilterElapsedMs: elapsedMs, prefilterError: error });
    if (onProgress) onProgress(i, frames.length, tag, elapsedMs);
  }
  return {
    frames: out,
    totalElapsedMs: Date.now() - startedAt,
    totalTokens,
  };
}

// 相似度: 共字符比例。短文本(3-5 汉字)够用。
function signatureSimilarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const setA = new Set([...a]);
  const setB = new Set([...b]);
  let inter = 0;
  for (const c of setA) if (setB.has(c)) inter++;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

// 二次精筛:
// 1) 删 isEmpty 或 salience<=2
// 2) signature 相似 (>=0.7) 的同时间区域聚类,保留 salience 最高
// 3) cap 到 maxKeep(按 salience 排,然后恢复时间顺序)
// 4) 永远至少保留 minKeep 张(避免一刀切空)
function refineByTags(taggedFrames, { maxKeep = 12, minKeep = 4, similarityThreshold = 0.7 } = {}) {
  if (!Array.isArray(taggedFrames) || taggedFrames.length === 0) {
    return { kept: [], dropped: [], reasons: {} };
  }
  const reasons = {};
  // 0.8B 经常把人/物明显的帧也标成 isEmpty=true。所以策略是:
  //   isEmpty=true 只是参考,真正的删除门槛走 salience<=2;
  //   只有 (isEmpty=true && salience<=4) 时才删,避免把好画面也砍掉。
  let stage1 = [];
  for (const f of taggedFrames) {
    const tag = f.prefilterTag || {};
    const sal = Number(tag.salience) || 0;
    const dropEmpty = tag.isEmpty === true && sal <= 4;
    const dropLowInfo = sal <= 2;
    if (dropEmpty || dropLowInfo) {
      reasons[f.index] = `${dropEmpty ? "空镜" : "低信息"}(salience=${tag.salience ?? "?"})`;
      continue;
    }
    stage1.push(f);
  }
  // 兜底: 全被砍光时,保留原 salience top minKeep
  if (stage1.length < minKeep) {
    stage1 = [...taggedFrames]
      .sort((a, b) => (b.prefilterTag?.salience ?? 0) - (a.prefilterTag?.salience ?? 0))
      .slice(0, minKeep);
    for (const f of stage1) delete reasons[f.index];
  }

  // 第 2 步: signature 聚类 dedup(相邻 / 近距离帧之间比较)
  const stage2 = [];
  for (const f of stage1) {
    const sig = f.prefilterTag?.signature || "";
    let merged = false;
    for (let j = stage2.length - 1; j >= 0 && j >= stage2.length - 6; j--) {
      const ref = stage2[j];
      const refSig = ref.prefilterTag?.signature || "";
      if (signatureSimilarity(sig, refSig) >= similarityThreshold) {
        // 同簇: 留 salience 更高的
        if ((f.prefilterTag?.salience ?? 0) > (ref.prefilterTag?.salience ?? 0)) {
          reasons[ref.index] = `相似画面被 #${f.index + 1} 取代`;
          stage2[j] = f;
        } else {
          reasons[f.index] = `相似画面已选 #${ref.index + 1}`;
        }
        merged = true;
        break;
      }
    }
    if (!merged) stage2.push(f);
  }

  // 第 3 步: cap 到 maxKeep,按 salience 排
  let kept = stage2;
  if (stage2.length > maxKeep) {
    const sortedBySal = [...stage2].sort((a, b) => (b.prefilterTag?.salience ?? 0) - (a.prefilterTag?.salience ?? 0));
    const keepSet = new Set(sortedBySal.slice(0, maxKeep).map((f) => f.index));
    kept = stage2.filter((f) => {
      if (keepSet.has(f.index)) return true;
      reasons[f.index] = `超出帧数上限(${maxKeep})`;
      return false;
    });
  }

  // 恢复时间顺序
  kept.sort((a, b) => (a.midSec ?? 0) - (b.midSec ?? 0));

  const dropped = taggedFrames.filter((f) => !kept.some((k) => k.index === f.index));
  return { kept, dropped, reasons };
}

module.exports = {
  tagFrames,
  refineByTags,
  signatureSimilarity,
  SCENE_TYPES,
};
