// OpenAI-compatible 客户端封装。
//
// 关键责任: 按 provider.endpointType 分流 chat/completions (legacy) vs responses (新),
// 流式 SSE 拼出 text, 再 tryParseJsonFromText 解 JSON。
//
// 为什么必须按 endpointType 分流:
// 一些代理 (e.g. sub2api) 在 chat/completions 路径下对 GPT-5 reasoning 模型
// 不正确返回 content (content 字段空, 但 usage.completion_tokens 已计费), 必须走
// /v1/responses + SSE 才能从 response.output_text.delta 拼出实际产出。
//
// shot-merger / summarizer / detectGenreLightweight / callOpenAICompatible 全部
// 通过本模块的 callJsonCompletion 入口, 避免重复实现 + 漏配 endpointType 路径。
//
// 返回结构:
//   { parsed, raw, usage, model } —— parsed 是 JSON.parse 后的对象 (失败为 null),
//   raw 是原始拼接文本, usage 是统一归一化后的 token 计数 { promptTokens, completionTokens, totalTokens },
//   model 是 server 实际返回的 model (代理可能改写, 用它做账单更准)。
//   无 usage 时 (老式 server / 拒绝 include_usage) 字段为 null, 不要假设一定有值。

// 本地 llama 适配器: main.cjs 在 app ready 时调 setLocalProviderAdapter 注入。
// adapter 签名: (modelKey, { signal }) => Promise<{ baseUrl, apiKey, model, contextSize, release }>。
// 当 provider.source === "local_llama" 时, openai-client 在请求前自动 acquire,
// 完成后 (含异常) release。业务方零改动复用本地 server。
let localProviderAdapter = null;
function setLocalProviderAdapter(fn) {
  localProviderAdapter = typeof fn === "function" ? fn : null;
}

async function maybeAcquireLocalSlot(provider, signal) {
  if (!localProviderAdapter) return null;
  if (provider?.source !== "local_llama") return null;
  if (!provider?.model) return null;
  // 调用方已经手动 acquire 过 (例如主分析为了拿 ctx 做预算), 不再二次 acquire。
  if (provider?._preacquired) return null;
  const slot = await localProviderAdapter(provider.model, { signal });
  return slot;
}

function tryParseJsonFromText(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

// chat/completions 的 usage 字段: { prompt_tokens, completion_tokens, total_tokens }
// responses API 的 usage 字段:    { input_tokens, output_tokens, total_tokens }
// 归一化成统一的 { promptTokens, completionTokens, totalTokens }, 数字化失败一律 0
function normalizeUsage(raw) {
  if (!raw || typeof raw !== "object") return null;
  const prompt = Number(raw.prompt_tokens ?? raw.input_tokens ?? 0) || 0;
  const completion = Number(raw.completion_tokens ?? raw.output_tokens ?? 0) || 0;
  const total = Number(raw.total_tokens ?? prompt + completion) || prompt + completion;
  if (prompt === 0 && completion === 0 && total === 0) return null;
  return { promptTokens: prompt, completionTokens: completion, totalTokens: total };
}

async function streamSSE(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        onEvent(JSON.parse(payload));
      } catch {
        // skip malformed chunk
      }
    }
  }
}

/**
 * @param {object} provider  effective provider, 必须含 baseUrl / apiKeyRef / model / endpointType
 * @param {object} opts
 *   systemText: string
 *   userText: string
 *   imageDataUrls?: string[]
 *   temperature?: number
 *   maxTokens?: number       // 仅 chat/completions
 *   maxOutputTokens?: number // 仅 responses
 *   signal?: AbortSignal
 * @returns {Promise<{ text: string, usage: ?object, model: ?string }>}
 */
async function callOpenAIChatCompletionsRaw(provider, opts) {
  const {
    systemText,
    userText,
    imageDataUrls = [],
    temperature,
    maxTokens,
    responseFormat,
    signal,
  } = opts;
  const slot = await maybeAcquireLocalSlot(provider, signal);
  try {
    const baseUrl = slot ? slot.baseUrl : provider.baseUrl;
    const apiKey = slot ? slot.apiKey : provider.apiKeyRef;
    const endpoint = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const body = {
      model: provider.model,
      stream: true,
      // include_usage 让服务端在 [DONE] 前发一个 choices=[] 但带 usage 的 chunk。
      // 非 OpenAI 兼容服务端可能忽略此字段, 但不会因此报错。
      stream_options: { include_usage: true },
      temperature: temperature ?? provider.temperature ?? 0.2,
      // 默认 2500 = probe 实测 chunk-pass 8 帧中位 1671 tok ×1.5 buffer。
      // 调用方需要更大 budget (例如 audit 走超长 nodes 列表) 在 opts.maxTokens 显式传。
      max_tokens: maxTokens ?? provider.maxOutputTokens ?? 2500,
      messages: [
        { role: "system", content: systemText },
        {
          role: "user",
          content:
            imageDataUrls.length > 0
              ? [
                  { type: "text", text: userText },
                  ...imageDataUrls.map((url) => ({ type: "image_url", image_url: { url } })),
                ]
              : userText,
        },
      ],
      ...(responseFormat ? { response_format: responseFormat } : {}),
    };
    const response = await fetch(endpoint, {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
        accept: "text/event-stream",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`模型请求失败 ${response.status}: ${detail.slice(0, 500)}`);
    }
    let text = "";
    let usageRaw = null;
    let modelEcho = null;
    await streamSSE(response, (event) => {
      const delta = event?.choices?.[0]?.delta?.content;
      if (typeof delta === "string") text += delta;
      // 服务端可能在 chunk 上重复带 model; 用最后一次为准 (代理会改写成上游真实模型)
      if (typeof event?.model === "string" && event.model) modelEcho = event.model;
      // include_usage 命中的 chunk: choices=[] 但带 usage
      if (event?.usage && typeof event.usage === "object") usageRaw = event.usage;
    });
    return { text, usage: normalizeUsage(usageRaw), model: modelEcho };
  } finally {
    slot?.release();
  }
}

async function callOpenAIResponsesRaw(provider, opts) {
  const {
    systemText,
    userText,
    imageDataUrls = [],
    temperature,
    maxOutputTokens,
    responseFormat,
    signal,
  } = opts;
  const slot = await maybeAcquireLocalSlot(provider, signal);
  try {
    const baseUrl = slot ? slot.baseUrl : provider.baseUrl;
    const apiKey = slot ? slot.apiKey : provider.apiKeyRef;
    const endpoint = `${baseUrl.replace(/\/+$/, "")}/responses`;
    const userContent = [
      { type: "input_text", text: userText },
      ...imageDataUrls.map((url) => ({ type: "input_image", image_url: url })),
    ];
    const body = {
      model: provider.model,
      stream: true,
      temperature: temperature ?? provider.temperature ?? 0.2,
      // 同 chat/completions: 默认 2500 实测 chunk-pass 中位 ×1.5 buffer
      max_output_tokens: maxOutputTokens ?? provider.maxOutputTokens ?? 2500,
      input: [
        { role: "system", content: [{ type: "input_text", text: systemText }] },
        { role: "user", content: userContent },
      ],
      // /responses endpoint 的 schema 约束字段叫 text.format, 跟 chat/completions 的
      // response_format 形态不同 (本期没主分析跑 reasoning 模型场景, 暂不映射)。
      // 调用方传 responseFormat 时这里忽略, 避免在不支持的端点发生错误。
    };
    void responseFormat;
    const response = await fetch(endpoint, {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
        accept: "text/event-stream",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`模型请求失败 ${response.status}: ${detail.slice(0, 500)}`);
    }
    let text = "";
    let usageRaw = null;
    let modelEcho = null;
    await streamSSE(response, (event) => {
      if (event?.type === "response.output_text.delta" && typeof event.delta === "string") {
        text += event.delta;
      }
      if (event?.type === "response.completed" && event?.response) {
        if (typeof event.response.model === "string") modelEcho = event.response.model;
        if (event.response.usage) usageRaw = event.response.usage;
        if (!text && Array.isArray(event.response.output)) {
          for (const item of event.response.output) {
            if (item?.type === "message" && Array.isArray(item.content)) {
              for (const block of item.content) {
                if ((block?.type === "output_text" || block?.type === "text") && typeof block.text === "string") {
                  text += block.text;
                }
              }
            }
          }
        }
      }
    });
    return { text, usage: normalizeUsage(usageRaw), model: modelEcho };
  } finally {
    slot?.release();
  }
}

// 统一入口: 按 endpointType 自动分流, 返回 { parsed, raw, usage, model }
async function callJsonCompletion(provider, opts) {
  const useResponses = provider.endpointType === "openai_responses";
  const result = useResponses
    ? await callOpenAIResponsesRaw(provider, opts)
    : await callOpenAIChatCompletionsRaw(provider, opts);
  return {
    parsed: tryParseJsonFromText(result.text),
    raw: result.text,
    usage: result.usage,
    model: result.model,
  };
}

// 兼容旧调用: 主分析 callOpenAICompatible 用的形态。返回 { parsed, usage, model }
// 兼容签名 (5 个位置参数 + 可选 options): options 支持 { responseFormat, maxTokens, maxOutputTokens }。
// 不传 options 行为完全兼容老调用; runChunkPass / runAuditPass 想要 JSON 模式时
// 传 { responseFormat: { type: "json_object" } } 让小模型不漂出 JSON 包装。
async function callOpenAIChatCompletions(provider, systemText, userText, imageDataUrls, handle, options) {
  const result = await callOpenAIChatCompletionsRaw(provider, {
    systemText,
    userText,
    imageDataUrls,
    maxTokens: options?.maxTokens,
    responseFormat: options?.responseFormat,
    signal: handle?.abortController?.signal,
  });
  return { parsed: tryParseJsonFromText(result.text), usage: result.usage, model: result.model };
}

async function callOpenAIResponses(provider, systemText, userText, imageDataUrls, handle, options) {
  const result = await callOpenAIResponsesRaw(provider, {
    systemText,
    userText,
    imageDataUrls,
    maxOutputTokens: options?.maxOutputTokens ?? options?.maxTokens,
    responseFormat: options?.responseFormat,
    signal: handle?.abortController?.signal,
  });
  return { parsed: tryParseJsonFromText(result.text), usage: result.usage, model: result.model };
}

module.exports = {
  tryParseJsonFromText,
  normalizeUsage,
  streamSSE,
  callOpenAIChatCompletionsRaw,
  callOpenAIResponsesRaw,
  callOpenAIChatCompletions,
  callOpenAIResponses,
  callJsonCompletion,
  setLocalProviderAdapter,
};
