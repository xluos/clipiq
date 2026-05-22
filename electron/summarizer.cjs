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

const { callJsonCompletion } = require("./openai-client.cjs");

async function callMediumText(provider, systemText, userText, schema, signal) {
  if (!provider?.baseUrl || !provider?.apiKeyRef || !provider?.model) {
    throw new Error("medium_text provider 配置不全");
  }
  // 走 openai-client 统一入口, 自动按 endpointType 分流 chat/completions vs responses
  // 返回 { parsed, usage, model }, 上游需要 usage 做 token 记账。
  // max_tokens 走 openai-client deriveDefaultMaxTokens (ctx*0.25 clamp [1500,16000]),
  // 不再 hardcode 6000。settings 里 ctx slider 调大自动跟着大。
  const result = await callJsonCompletion(provider, {
    systemText,
    userText,
    temperature: 0.3,
    signal,
  });
  if (!result.parsed) {
    throw new Error(
      `summarizer 解析失败 (raw text 为空或不是合法 JSON; endpoint=${provider.endpointType})`,
    );
  }
  return result;
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
    const callResult = await callMediumText(
      provider,
      systemText,
      userText,
      schema,
      handle?.abortController?.signal,
    );
    const parsed = callResult.parsed;
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
      usage: callResult.usage,
      echoedModel: callResult.model,
    };
  } catch (error) {
    if (handle?.cancelled) throw error;
    // eslint-disable-next-line no-console
    console.warn("[summarizer] 全局聚合失败:", error?.message || error);
    return null;
  }
}

module.exports = { summarizeVideo };
