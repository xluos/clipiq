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

// 从 provider.contextSize 派生默认 max_tokens, 替代各调用点的 hardcode 数字。
// 公式: ctx × 0.25, 下限 1500。
// **不设上限** — settings 里 ctx slider 反映的就是模型实际支持的 ctx, 用户调多大就给多大。
// 在线大模型 (Claude 200K / Gemini 1M / Qwen3.5 256K) 和本地大 ctx 模型都按比例伸缩。
// 1500 下限: 兜底小 ctx 模型 (6K-8K) 至少保留够写一段完整 JSON。
// 调用方需要严格限制时仍可显式传 maxTokens override (例如 prefilter 单帧用 280)。
function deriveDefaultMaxTokens(provider) {
  const ctx = Number(provider?.contextSize);
  if (!Number.isFinite(ctx) || ctx <= 0) return 2500;
  return Math.max(1500, Math.floor(ctx * 0.25));
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

// Layer 3 兜底: 当 content 里 parse 不出 JSON 时, 尝试从 reasoning_content 末尾扫一个 JSON 块。
//
// 适用场景: thinking 模型 (Qwen3 / DeepSeek-R1 / Kimi-K1.5 / 内部 / 远程 ...) 把内容塞到
// delta.reasoning_content 而不是 delta.content, 且 server 不支持 chat_template_kwargs.enable_thinking
// 关掉 thinking (例如部分线上 API)。reasoning 末尾通常就是 final answer JSON 草稿。
//
// 策略: 从 reasoning 末尾向前找最后一个 { 到末尾的 } 配对块, 尝试 parse。比 tryParseJsonFromText
// 的贪婪 regex 更可靠 (regex 在 reasoning 含多个 JSON 草稿时会匹到第一个 { 到最后一个 })。
function tryRescueJsonFromReasoning(reasoning) {
  if (!reasoning) return null;
  // 优先找带闭合的最后一个 JSON 对象: 从尾部找 }, 再回找配对的 {
  const lastClose = reasoning.lastIndexOf("}");
  if (lastClose < 0) return null;
  // 从 lastClose 向前找配对 { (栈算法处理嵌套 JSON)
  let depth = 0;
  for (let i = lastClose; i >= 0; i--) {
    const c = reasoning[i];
    if (c === "}") depth += 1;
    else if (c === "{") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(reasoning.slice(i, lastClose + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
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
    enableThinking,
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
      // 默认走 deriveDefaultMaxTokens(provider) 从 ctx 派生 (settings 里 ctx slider 调大,
      // output budget 自动跟着大)。调用方需要更严格的限制时仍可显式传 maxTokens override
      // (例如 prefilter 单帧用 280)。原来 hardcode 2500 对 thinking 模型不够 → 删除。
      max_tokens: maxTokens ?? provider.maxOutputTokens ?? deriveDefaultMaxTokens(provider),
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
      // Qwen3 / DeepSeek-R1 等 thinking 模型默认 enable_thinking=true → 内容塞 delta.reasoning_content
      // 不走 delta.content, 上层会看到 content 为空。本项目业务都要 JSON 不要 thinking, 默认关掉。
      // 来源优先级 opts.enableThinking > provider.enableThinking > false。前者是调用方显式覆盖,
      // 后者是 shapeEffectiveProvider 从 slot.enableThinking 透传过来 (任务分配维度的运行时开关)。
      // chat_template_kwargs 是 llama.cpp 扩展字段, DashScope / 火山方舟 / DeepSeek 等多数 OpenAI-兼容
      // API 也支持; 不支持的 server 会忽略 (Layer 3 reasoning fallback 兜底)。
      chat_template_kwargs: { enable_thinking: (enableThinking ?? provider.enableThinking) === true },
    };
    // 诊断: 把请求关键字段打到 stdout, 用户报"thinking 没关掉"时拿来对账
    // (rawLen=0 reasoningLen>0 应该意味着 body 里没 chat_template_kwargs, 或者 server 不接受)
    console.log(
      `[openai-client] POST ${endpoint} | model=${body.model} max_tokens=${body.max_tokens} ` +
      `temp=${body.temperature} response_format=${body.response_format?.type || "none"} ` +
      `enable_thinking=${body.chat_template_kwargs?.enable_thinking} ` +
      `(enableThinkingOpt=${enableThinking} providerEnableThinking=${provider.enableThinking})`,
    );
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
    let reasoning = "";
    let usageRaw = null;
    let modelEcho = null;
    await streamSSE(response, (event) => {
      const delta = event?.choices?.[0]?.delta?.content;
      if (typeof delta === "string") text += delta;
      // Qwen3 / DeepSeek-R1 等 reasoning 模型: thinking 内容走 delta.reasoning_content,
      // 不进 text(text 必须保持只装最终 JSON), 但单独累积以便诊断 + 在 content 为空时给上层提示。
      const reasoningDelta = event?.choices?.[0]?.delta?.reasoning_content;
      if (typeof reasoningDelta === "string") reasoning += reasoningDelta;
      // 服务端可能在 chunk 上重复带 model; 用最后一次为准 (代理会改写成上游真实模型)
      if (typeof event?.model === "string" && event.model) modelEcho = event.model;
      // include_usage 命中的 chunk: choices=[] 但带 usage
      if (event?.usage && typeof event.usage === "object") usageRaw = event.usage;
    });
    return { text, reasoning, usage: normalizeUsage(usageRaw), model: modelEcho };
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
      // 同 chat/completions: 默认从 ctx 派生 (deriveDefaultMaxTokens)
      max_output_tokens: maxOutputTokens ?? provider.maxOutputTokens ?? deriveDefaultMaxTokens(provider),
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

// 统一入口: 按 endpointType 自动分流, 返回 { parsed, raw, reasoning, parsedSource, usage, model }
// 走 finalizeCallResult 同款 Layer 3 reasoning fallback, shot-merger / summarizer / danmaku-emotion
// 之后任何 thinking 模型也都自动兜底, 不需要分散改。
async function callJsonCompletion(provider, opts) {
  const useResponses = provider.endpointType === "openai_responses";
  const result = useResponses
    ? await callOpenAIResponsesRaw(provider, opts)
    : await callOpenAIChatCompletionsRaw(provider, opts);
  return finalizeCallResult(result);
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
    enableThinking: options?.enableThinking,
    signal: handle?.abortController?.signal,
  });
  return finalizeCallResult(result);
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
  return finalizeCallResult(result);
}

// 统一出口处理 raw → parsed, 含 Layer 3 reasoning fallback。
//
// 返回:
//   parsed: 解析出的 JSON 对象, 或 null
//   raw: chat content stream 累积的原始文本
//   reasoning: reasoning_content stream 累积 (thinking 模型才会非空)
//   parsedSource: "content" | "reasoning" | "none" — content 解出走 "content";
//                 content 解不出但从 reasoning 末尾兜底走 "reasoning"; 都失败走 "none"
//   usage / model: SSE chunk 里 server 返回的统计 / model echo
function finalizeCallResult(result) {
  const text = result.text || "";
  const reasoning = result.reasoning || "";
  const fromContent = tryParseJsonFromText(text);
  if (fromContent) {
    return { parsed: fromContent, raw: text, reasoning, parsedSource: "content", usage: result.usage, model: result.model };
  }
  // Layer 3: content 没解出 → reasoning 末尾兜底。任何 reasoning 模型都受益,
  // 即便 server 不支持 chat_template_kwargs 关 thinking。
  const fromReasoning = tryRescueJsonFromReasoning(reasoning);
  if (fromReasoning) {
    return { parsed: fromReasoning, raw: text, reasoning, parsedSource: "reasoning", usage: result.usage, model: result.model };
  }
  return { parsed: null, raw: text, reasoning, parsedSource: "none", usage: result.usage, model: result.model };
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
