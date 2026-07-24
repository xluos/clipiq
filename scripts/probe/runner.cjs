// 一次 LLM 调用 + 计时器 + JSON 解析。流式抓首字延迟和 timings。
//
// stream=true + stream_options.include_usage:
//   普通 chunk 携带 content delta, 最后一个 chunk choices=[] 携带 usage + (llama.cpp) timings
//
// llama.cpp 的 timings 字段:
//   prompt_n            prompt token 数
//   prompt_ms           prompt eval 总耗时
//   prompt_per_token_ms
//   predicted_n         generation token 数
//   predicted_ms        generation 总耗时
//   predicted_per_token_ms

async function streamChatCompletion({ baseUrl, model, systemText, userText, userContent, imageDataUrls = [], maxTokens, temperature = 0.2, responseFormat, signal }) {
  const messages = [
    { role: "system", content: systemText },
  ];
  if (userContent) {
    messages.push({ role: "user", content: userContent });
  } else {
    if (imageDataUrls.length === 0) {
      messages.push({ role: "user", content: userText });
    } else {
      messages.push({
        role: "user",
        content: [
          { type: "text", text: userText },
          ...imageDataUrls.map((url) => ({ type: "image_url", image_url: { url } })),
        ],
      });
    }
  }

  const body = {
    model,
    stream: true,
    stream_options: { include_usage: true },
    temperature,
    max_tokens: maxTokens,
    // Qwen3 默认开 thinking, 会吃光 budget。透传给 chat template 关掉。
    chat_template_kwargs: { enable_thinking: false },
    messages,
    ...(responseFormat ? { response_format: responseFormat } : {}),
    // llama.cpp 把 timings 直接放最后一个 chunk; 没有显式 opt-in
  };

  const t0 = Date.now();
  let firstTokenAt = null;
  let text = "";
  let usage = null;
  let timings = null;
  let finishReason = null;

  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status}: ${detail.slice(0, 400)}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let evt;
      try { evt = JSON.parse(payload); } catch { continue; }
      const delta = evt?.choices?.[0]?.delta?.content;
      if (typeof delta === "string" && delta.length > 0) {
        if (firstTokenAt == null) firstTokenAt = Date.now();
        text += delta;
      }
      const fr = evt?.choices?.[0]?.finish_reason;
      if (fr) finishReason = fr;
      if (evt?.usage) usage = evt.usage;
      if (evt?.timings) timings = evt.timings;
    }
  }
  const t1 = Date.now();

  return {
    text,
    usage,
    timings,
    finishReason,
    timings_self: {
      totalMs: t1 - t0,
      firstTokenMs: firstTokenAt != null ? firstTokenAt - t0 : null,
      generationMs: firstTokenAt != null ? t1 - firstTokenAt : null,
    },
  };
}

function tryParseJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { /* try below */ }
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]); } catch { /* ignore */ }
  }
  return null;
}

// 一次完整测试: 跑 N 个 replicates, 返回各次原始 + 中位 / 最小 / 最大汇总
async function runCase({ baseUrl, model, label, prompt, maxTokens, responseFormat, replicates = 2, signal }) {
  const samples = [];
  for (let i = 0; i < replicates; i++) {
    const r = await streamChatCompletion({
      baseUrl,
      model,
      systemText: prompt.system || prompt.systemText,
      userText: prompt.user || prompt.userText,
      userContent: prompt.userContent,
      imageDataUrls: prompt.imageDataUrls || [],
      maxTokens,
      responseFormat,
      signal,
    });
    const parsed = tryParseJson(r.text);
    samples.push({
      rep: i,
      totalMs: r.timings_self.totalMs,
      firstTokenMs: r.timings_self.firstTokenMs,
      generationMs: r.timings_self.generationMs,
      promptTokens: r.usage?.prompt_tokens ?? null,
      completionTokens: r.usage?.completion_tokens ?? null,
      promptMs: r.timings?.prompt_ms ?? null,
      predictedMs: r.timings?.predicted_ms ?? null,
      tokensPerSec: r.timings?.predicted_n && r.timings?.predicted_ms
        ? (r.timings.predicted_n / r.timings.predicted_ms * 1000).toFixed(1)
        : null,
      finishReason: r.finishReason,
      jsonValid: parsed != null,
      outputCharCount: r.text.length,
      // 截断诊断: finish=length 表示触顶 max_tokens
      truncated: r.finishReason === "length",
      // 输出片段 (后面看模型实际输出形态)
      sampleOutput: r.text.slice(0, 200),
    });
  }

  // 取中位 (replicates 少时直接用 sorted[mid])
  const sorted = [...samples].sort((a, b) => a.totalMs - b.totalMs);
  const median = sorted[Math.floor(sorted.length / 2)];
  return {
    label,
    maxTokens,
    median,
    samples,
    allJsonValid: samples.every((s) => s.jsonValid),
    anyTruncated: samples.some((s) => s.truncated),
  };
}

module.exports = { streamChatCompletion, runCase, tryParseJson };
