// 全局聚合 (金字塔管线第三层):
//
// 输入: 所有 shotDescription + 完整字幕 + 节奏统计;
// 输出: { globalSummary, detectedGenre, genreConfidence, structureHint }。
//
// 跟旧的 detectGenreLightweight 不同 —— 信号更丰富 (shot 描述 + 整段字幕),
// 让 medium_text 模型在一次调用里就把"是什么视频 + 整体讲了什么 + 结构线索"都拿出来,
// 后续主分析直接用这个上下文做评审, 不用再从零看视频。
//
// 与 detectGenreLightweight 共存: 当 shotDescriptions 缺失 (e.g. medium_text 整体不可用),
// main.cjs 会回退到旧的 detectGenreLightweight 路径。

async function callMediumText(provider, systemText, userText, schema, signal) {
  if (!provider?.baseUrl || !provider?.apiKeyRef || !provider?.model) {
    throw new Error("medium_text provider 配置不全");
  }
  const endpoint = `${provider.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const body = {
    model: provider.model,
    messages: [
      { role: "system", content: systemText },
      { role: "user", content: userText },
    ],
    temperature: 0.3,
    // reasoning 模型会先烧 1-2k token thinking, 放开 budget 让 content 有空间
    max_tokens: provider.maxOutputTokens ?? 6000,
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
  // 只在真正的 content 字段里找 JSON; 不要把整段 raw response 当 candidate
  // (reasoning 模型 content 为空时, raw response 里只有 choices/usage 没有可解析的 model output)。
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
    `medium_text content 为空 (finish_reason=${finishReason})。可能是 reasoning 模型把 budget 全花在 thinking 上;
请换一个非 reasoning 的 medium_text 模型或调高 max_tokens。`,
  );
}

function buildSummarySchema(allowedGenres) {
  return {
    type: "object",
    properties: {
      globalSummary: { type: "string", maxLength: 600 },
      detectedGenre: { type: "string", enum: [...allowedGenres] },
      genreConfidence: { type: "number", minimum: 0, maximum: 1 },
      structureHint: {
        type: "object",
        properties: {
          hook: { type: "string", maxLength: 120 },
          climax: { type: "string", maxLength: 120 },
          ending: { type: "string", maxLength: 120 },
        },
        required: ["hook", "climax", "ending"],
        additionalProperties: false,
      },
    },
    required: ["globalSummary", "detectedGenre", "genreConfidence", "structureHint"],
    additionalProperties: false,
  };
}

function formatShotListText(shots) {
  return shots
    .map((s, i) =>
      `S${i + 1} [${s.startSec.toFixed(1)}-${s.endSec.toFixed(1)}s] ${s.shotDescription || ""}${s.subtitleText ? ` | 字幕: ${s.subtitleText}` : ""}`,
    )
    .join("\n");
}

/**
 * @param {{
 *   shotContexts: Array<{ shotIndex: number, startSec: number, endSec: number, shotDescription: string, subtitleText?: string }>,
 *   transcript?: { text?: string, language?: string, segments?: any[] } | null,
 *   shotStats: object,
 *   project: { videoName: string, durationSec: number, width: number, height: number, orientation: string },
 *   provider: object,
 *   genreCatalog: Record<string, string>,
 *   allowedGenres: string[],
 *   handle?: { abortController?: AbortController, cancelled?: boolean },
 * }} args
 */
async function summarizeVideo({
  shotContexts,
  transcript,
  shotStats,
  project,
  provider,
  genreCatalog,
  allowedGenres,
  handle,
}) {
  if (!Array.isArray(shotContexts) || shotContexts.length === 0) return null;
  const schema = buildSummarySchema(allowedGenres);
  const catalogLines = Object.entries(genreCatalog)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join("\n");

  const transcriptBlock = transcript?.text
    ? `# 完整字幕\n${transcript.text.slice(0, 4000)}`
    : "# 完整字幕\n(无音轨 / 未识别)";

  const statsBlock =
    shotStats && typeof shotStats === "object"
      ? `# 节奏统计\n${JSON.stringify(shotStats)}`
      : "";

  const systemText =
    "你是视频拉片助理, 善于从镜头列表 + 字幕 + 节奏统计推断视频整体内容、类型和结构。" +
    "请只返回严格 JSON, 不要 markdown 围栏, 不要思考过程。";

  const userText = [
    `视频《${project.videoName}》, 时长 ${Math.round(project.durationSec)}s, 画幅 ${project.width}x${project.height} (${project.orientation})。`,
    `共 ${shotContexts.length} 个镜头。`,
    "",
    "# 镜头列表 (已由小模型合并描述)",
    formatShotListText(shotContexts),
    "",
    statsBlock,
    "",
    transcriptBlock,
    "",
    "# 候选视频类型清单",
    catalogLines,
    "- other: 都不匹配",
    "",
    "请输出 JSON:",
    `{ "globalSummary": "用 80-200 汉字概括整段视频讲了什么、风格氛围、值得注意的剪辑特点", "detectedGenre": "vlog|review|...", "genreConfidence": 0.0-1.0, "structureHint": { "hook": "开场起什么作用的简述", "climax": "高潮 / 信息密度峰位置和内容", "ending": "结尾怎么收的" } }`,
  ].join("\n");

  try {
    const parsed = await callMediumText(
      provider,
      systemText,
      userText,
      schema,
      handle?.abortController?.signal,
    );
    // eslint-disable-next-line no-console
    console.log("[summarizer] LLM raw keys:", Object.keys(parsed || {}), "summaryLen:", String(parsed?.globalSummary || "").length, "genre:", parsed?.detectedGenre);
    // genre 不在 catalog 里 (用 json_object 没强约束 enum) → 兜底到 other,
    // 而不是整段 return null 让 globalSummary 也丢掉。
    const rawGenre = String(parsed?.detectedGenre || "").trim().toLowerCase();
    const genre = allowedGenres.includes(rawGenre) ? rawGenre : "other";
    const conf = Number(parsed?.genreConfidence);
    const globalSummary =
      typeof parsed?.globalSummary === "string" ? parsed.globalSummary.trim() : "";
    // 只要有 globalSummary 或 detectedGenre 就视作成功 (放宽: 不再强求 structureHint)
    if (!globalSummary && !rawGenre) {
      // eslint-disable-next-line no-console
      console.warn("[summarizer] parsed 看不出 globalSummary/detectedGenre:", JSON.stringify(parsed).slice(0, 300));
      return null;
    }
    return {
      globalSummary,
      detectedGenre: genre,
      genreConfidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0.5,
      structureHint: parsed.structureHint || null,
    };
  } catch (error) {
    if (handle?.cancelled) throw error;
    // eslint-disable-next-line no-console
    console.warn("[summarizer] 全局聚合失败:", error?.message || error);
    return null;
  }
}

module.exports = { summarizeVideo };
