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
 * @returns {Promise<string>} 拼好的 raw text (未 JSON.parse)
 */
async function callOpenAIChatCompletionsRaw(provider, opts) {
  const {
    systemText,
    userText,
    imageDataUrls = [],
    temperature,
    maxTokens,
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
      temperature: temperature ?? provider.temperature ?? 0.2,
      max_tokens: maxTokens ?? provider.maxOutputTokens ?? 12000,
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
    await streamSSE(response, (event) => {
      const delta = event?.choices?.[0]?.delta?.content;
      if (typeof delta === "string") text += delta;
    });
    return text;
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
      max_output_tokens: maxOutputTokens ?? provider.maxOutputTokens ?? 12000,
      input: [
        { role: "system", content: [{ type: "input_text", text: systemText }] },
        { role: "user", content: userContent },
      ],
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
    await streamSSE(response, (event) => {
      if (event?.type === "response.output_text.delta" && typeof event.delta === "string") {
        text += event.delta;
      }
      if (event?.type === "response.completed" && Array.isArray(event?.response?.output)) {
        if (!text) {
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
    return text;
  } finally {
    slot?.release();
  }
}

// 统一入口: 按 endpointType 自动分流, 返回 parsed JSON (或 null)
async function callJsonCompletion(provider, opts) {
  const useResponses = provider.endpointType === "openai_responses";
  const text = useResponses
    ? await callOpenAIResponsesRaw(provider, opts)
    : await callOpenAIChatCompletionsRaw(provider, opts);
  return tryParseJsonFromText(text);
}

// 兼容旧调用: 主分析 callOpenAICompatible 用的形态 (返回 parsed JSON)
async function callOpenAIChatCompletions(provider, systemText, userText, imageDataUrls, handle) {
  const text = await callOpenAIChatCompletionsRaw(provider, {
    systemText,
    userText,
    imageDataUrls,
    signal: handle?.abortController?.signal,
  });
  return tryParseJsonFromText(text);
}

async function callOpenAIResponses(provider, systemText, userText, imageDataUrls, handle) {
  const text = await callOpenAIResponsesRaw(provider, {
    systemText,
    userText,
    imageDataUrls,
    signal: handle?.abortController?.signal,
  });
  return tryParseJsonFromText(text);
}

module.exports = {
  tryParseJsonFromText,
  streamSSE,
  callOpenAIChatCompletionsRaw,
  callOpenAIResponsesRaw,
  callOpenAIChatCompletions,
  callOpenAIResponses,
  callJsonCompletion,
  setLocalProviderAdapter,
};
