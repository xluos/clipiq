// 镜头级合并 (金字塔管线第二层):
//
// 把 detectScenes 切出的 shot, 加上 shot 内抽到的 frame captions, 加上落在 shot
// 区间内的字幕, 用 medium_text 槽位的模型合并成"这个镜头讲了什么" + 代表帧。
//
// 设计要点:
// - **batched**: 一次 LLM 调用合并多个 shot, 减少 round-trip; 30 个 shot 按 6/批
//   要 5 次调用而不是 30 次。json_schema strict + structured output 保证每批返回完整。
// - 没有图传上去, 输入全是文本 (frame caption + 字幕), 因为 medium_text 槽位
//   不要求 vision capability。tokens 主要由 prompt 长度决定。
// - 失败的 shot 给 fallback shotDescription (字幕 + 第一帧 caption 拼一下), 不阻断。
// - 不并发: 单序串行, 失败仅影响该 batch, 总耗时是 batches × 平均单次。
//   未来如果用本地 medium 模型 (llama-server) 同样保单实例避免争资源。

const ALLOWED_BATCH_SIZE = { min: 1, max: 12, default: 6 };

function clampBatchSize(n) {
  if (!Number.isFinite(n)) return ALLOWED_BATCH_SIZE.default;
  return Math.max(ALLOWED_BATCH_SIZE.min, Math.min(ALLOWED_BATCH_SIZE.max, Math.round(n)));
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

// 用 provider 的 baseUrl + apiKey + model 调一次 chat/completions, 返回 parsed JSON。
// medium_text 槽位的 provider 已经被 shapeEffectiveProvider 处理过 baseUrl/apiKeyRef/model。
async function callMediumText(provider, systemText, userText, signal) {
  if (!provider?.baseUrl || !provider?.apiKeyRef || !provider?.model) {
    throw new Error("medium_text provider 配置不全 (baseUrl/apiKeyRef/model 缺失)");
  }
  const endpoint = `${provider.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  // json_object 比 json_schema strict 兼容性好得多 (用户自搭的代理 / 老版本 vLLM /
  // DashScope 都未必支持 strict schema)。schema 通过 prompt 里的明确字段说明 + 后续
  // sanitize 兜底。
  const body = {
    model: provider.model,
    messages: [
      { role: "system", content: systemText },
      { role: "user", content: userText },
    ],
    temperature: 0.2,
    // reasoning 模型 (GPT-5 / R1 / Qwen-Thinking) 会先烧 1k-2k token thinking,
    // 剩下才轮到 content。这里给足 budget, 让简单任务也能挤出 content。
    max_tokens: provider.maxOutputTokens ?? 8000,
    response_format: { type: "json_object" },
  };
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${provider.apiKeyRef}`,
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`medium_text HTTP ${res.status}: ${detail.slice(0, 300)}`);
  }
  const data = await res.json();
  const choice = data?.choices?.[0]?.message || {};
  // 只在 message.content / reasoning_content 里找 JSON; 不要把整段 raw response 当 candidate
  for (const candidate of [choice.content, choice.reasoning_content].filter(Boolean)) {
    try {
      return JSON.parse(candidate);
    } catch {
      const m = String(candidate).match(/\{[\s\S]*\}/);
      if (m) {
        try { return JSON.parse(m[0]); } catch { /* keep trying */ }
      }
    }
  }
  const finishReason = data?.choices?.[0]?.finish_reason;
  throw new Error(
    `medium_text content 为空 (finish_reason=${finishReason})。可能是 reasoning 模型把 budget 全花在 thinking 上。`,
  );
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

async function mergeShots({ shots, provider, batchSize, handle, onProgress }) {
  const size = clampBatchSize(batchSize);
  const result = new Array(shots.length);
  let batchIndex = 0;
  let consecutiveFail = 0;
  let givenUp = false; // 连续失败 N 次 → 视为 provider 不可用, 余下 batch 直接 fallback (节省长视频几分钟空转)
  for (let i = 0; i < shots.length; i += size) {
    if (handle?.cancelled) throw new Error("cancelled");
    batchIndex += 1;
    const batch = shots.slice(i, i + size);
    if (givenUp) {
      fillBatchWithFallback(batch, result, i);
      if (onProgress) onProgress({ done: Math.min(i + size, shots.length), total: shots.length, batchIndex, mode: "fallback-shortcut" });
      continue;
    }
    const { system, user } = buildMergePrompt(batch);
    try {
      const parsed = await callMediumText(provider, system, user, handle?.abortController?.signal);
      const out = Array.isArray(parsed?.shots) ? parsed.shots : [];
      if (out.length === 0) {
        // parsed 拿到了 JSON 但没 shots 字段, 视为本批次失败
        throw new Error("parsed JSON 缺少 shots 字段");
      }
      consecutiveFail = 0;
      for (let j = 0; j < batch.length; j++) {
        const local = batch[j];
        const match = out.find((s) => Number(s.shotIndex) === j) || out[j];
        const frameCount = Array.isArray(local.frames) ? local.frames.length : 0;
        const rawIdxs = Array.isArray(match?.representativeFrameIndex)
          ? match.representativeFrameIndex
          : [];
        const repIdxs = rawIdxs
          .map((n) => Math.floor(Number(n)))
          .filter((n) => Number.isFinite(n) && n >= 0 && n < frameCount);
        const desc =
          typeof match?.shotDescription === "string" && match.shotDescription.trim()
            ? match.shotDescription.trim().slice(0, 240)
            : fallbackShotDescription(local);
        result[i + j] = {
          shotDescription: desc,
          representativeFrameIndex: repIdxs.length > 0 ? repIdxs : frameCount > 0 ? [0] : [],
        };
      }
    } catch (error) {
      if (handle?.cancelled) throw error;
      consecutiveFail += 1;
      // eslint-disable-next-line no-console
      console.warn(`[shot-merger] batch ${batchIndex} 失败 (#${consecutiveFail} 连续), 走 fallback:`, error?.message || error);
      fillBatchWithFallback(batch, result, i);
      if (consecutiveFail >= GIVE_UP_AFTER_CONSECUTIVE_FAIL) {
        givenUp = true;
        // eslint-disable-next-line no-console
        console.warn(`[shot-merger] 连续 ${consecutiveFail} 个 batch 失败, 放弃 LLM 路径, 后续 batch 直接走 fallback (medium_text 模型可能是 reasoning 类型导致 content 为空)`);
      }
    }
    if (onProgress) {
      onProgress({
        done: Math.min(i + size, shots.length),
        total: shots.length,
        batchIndex,
        mode: givenUp ? "fallback-after-give-up" : consecutiveFail > 0 ? "fallback-batch" : "ok",
      });
    }
  }
  return result;
}

module.exports = { mergeShots };
