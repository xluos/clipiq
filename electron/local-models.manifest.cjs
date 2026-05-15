// 本地模型清单 (manifest) — 后期加新模型只需要编辑这个文件。
//
// 字段说明:
//   key: 内部唯一 id (snake_case)
//   family: 模型家族名 (Qwen3.5-VL / Phi-4 / Gemma 3 ...)
//   params: 参数规模 (0.8B / 2B / 4B / 7B / 8B / 14B / 32B)
//   primaryCapabilities: 主能力,决定任务槽位过滤 ("vision"/"audio"/"text")
//     - vision 槽位的 model 必须包含 "vision"
//     - audio 槽位的 model 必须包含 "audio"
//     - text 槽位的 model 包含 "text" (含 vision 也行,VLM 可以跑 text)
//   secondaryTags: 副能力,只做 hint 不参与过滤
//     ("chinese"/"english"/"code"/"reasoning"/"video"/"long_context"/"fast")
//   available: 是否真实可下载/可启动。false = 路线图占位 (UI 上灰按钮)
//   contextSize: 上下文窗口 (token)
//   quantizations: 该模型支持的量化档列表。第一个为默认档。
//     {
//       key: 内部量化 id
//       label: 展示标签 (Q4_K_M / Q5_K_M ...)
//       repo: HuggingFace repo (用于拼下载 URL)
//       llmFile: 主权重文件名
//       mmprojFile: 视觉编码器文件名 (vision 模型必填)
//       sizeBytes: 总大小 (llm + mmproj) 估算,用于 fit 计算
//     }

const PRESETS = {
  // ============ 视觉 · 多模态 ============
  qwen3_5_0_8b_q4km: {
    key: "qwen3_5_0_8b_q4km",
    family: "Qwen3.5-VL",
    params: "0.8B",
    name: "Qwen3.5-VL 0.8B",
    description: "极速档,适合海量画面初筛",
    primaryCapabilities: ["vision", "text"],
    secondaryTags: ["fast"],
    available: true,
    contextSize: 8192,
    quantizations: [
      {
        key: "q4_k_m",
        label: "Q4_K_M",
        repo: "unsloth/Qwen3.5-0.8B-GGUF",
        llmFile: "Qwen3.5-0.8B-Q4_K_M.gguf",
        mmprojFile: "mmproj-F16.gguf",
        sizeBytes: 1180 * 1024 * 1024,
      },
    ],
  },
  qwen3_5_2b_q4km: {
    key: "qwen3_5_2b_q4km",
    family: "Qwen3.5-VL",
    params: "2B",
    name: "Qwen3.5-VL 2B",
    description: "中文识别和叙事更稳,推荐档",
    primaryCapabilities: ["vision", "text"],
    secondaryTags: ["chinese"],
    available: true,
    contextSize: 8192,
    quantizations: [
      {
        key: "q4_k_m",
        label: "Q4_K_M",
        repo: "unsloth/Qwen3.5-2B-GGUF",
        llmFile: "Qwen3.5-2B-Q4_K_M.gguf",
        mmprojFile: "mmproj-F16.gguf",
        sizeBytes: 1860 * 1024 * 1024,
      },
    ],
  },
  qwen3_5_4b_q4km: {
    key: "qwen3_5_4b_q4km",
    family: "Qwen3.5-VL",
    params: "4B",
    name: "Qwen3.5-VL 4B",
    description: "准确度最高,适合大内存机器",
    primaryCapabilities: ["vision", "text"],
    secondaryTags: ["chinese"],
    available: true,
    contextSize: 8192,
    quantizations: [
      {
        key: "q4_k_m",
        label: "Q4_K_M",
        repo: "unsloth/Qwen3.5-4B-GGUF",
        llmFile: "Qwen3.5-4B-Q4_K_M.gguf",
        mmprojFile: "mmproj-F16.gguf",
        sizeBytes: 3250 * 1024 * 1024,
      },
    ],
  },

  // ============ Roadmap: 视觉 · 多模态 (UI 显示, 暂未实装) ============
  qwen3_vl_4b: {
    key: "qwen3_vl_4b",
    family: "Qwen3-VL",
    params: "4B",
    name: "Qwen3-VL 4B",
    description: "支持视频帧理解",
    primaryCapabilities: ["vision", "text"],
    secondaryTags: ["video"],
    available: false,
    contextSize: 128000,
    quantizations: [
      { key: "q4_k_m", label: "Q4_K_M", sizeBytes: 2.5 * 1024 * 1024 * 1024 },
    ],
  },
  qwen25_vl_7b: {
    key: "qwen25_vl_7b",
    family: "Qwen2.5-VL",
    params: "7B",
    name: "Qwen2.5-VL 7B",
    description: "成熟,GGUF 生态完整",
    primaryCapabilities: ["vision", "text"],
    secondaryTags: [],
    available: false,
    contextSize: 128000,
    quantizations: [
      { key: "q4_k_m", label: "Q4_K_M", sizeBytes: 4.4 * 1024 * 1024 * 1024 },
    ],
  },
  minicpm_v_26: {
    key: "minicpm_v_26",
    family: "MiniCPM-V",
    params: "8B",
    name: "MiniCPM-V 2.6",
    description: "基于 Qwen2-7B,小体积单图最强",
    primaryCapabilities: ["vision", "text"],
    secondaryTags: ["long_context"],
    available: false,
    contextSize: 32000,
    quantizations: [
      { key: "q4_k_m", label: "Q4_K_M", sizeBytes: 5.5 * 1024 * 1024 * 1024 },
    ],
  },
  qwen25_omni_7b: {
    key: "qwen25_omni_7b",
    family: "Qwen2.5-Omni",
    params: "7B",
    name: "Qwen2.5-Omni 7B",
    description: "视觉 + 音频,可替代 whisper",
    primaryCapabilities: ["vision", "audio", "text"],
    secondaryTags: [],
    available: false,
    contextSize: 32000,
    quantizations: [
      { key: "q4_k_m", label: "Q4_K_M", sizeBytes: 4.4 * 1024 * 1024 * 1024 },
    ],
  },
  qwen25_vl_32b: {
    key: "qwen25_vl_32b",
    family: "Qwen2.5-VL",
    params: "32B",
    name: "Qwen2.5-VL 32B",
    description: "需要 32 GB+ 机器",
    primaryCapabilities: ["vision", "text"],
    secondaryTags: ["reasoning"],
    available: false,
    contextSize: 128000,
    quantizations: [
      { key: "q4_k_m", label: "Q4_K_M", sizeBytes: 18.5 * 1024 * 1024 * 1024 },
    ],
  },

  // ============ Roadmap: 纯文本 (UI 显示, 暂未实装) ============
  qwen3_1_7b: {
    key: "qwen3_1_7b",
    family: "Qwen3",
    params: "1.7B",
    name: "Qwen3 1.7B",
    description: "字幕推断 / 中文标题",
    primaryCapabilities: ["text"],
    secondaryTags: ["chinese", "fast"],
    available: false,
    contextSize: 128000,
    quantizations: [
      { key: "q4_k_m", label: "Q4_K_M", sizeBytes: 1.1 * 1024 * 1024 * 1024 },
    ],
  },
  phi4_mini: {
    key: "phi4_mini",
    family: "Phi-4-mini",
    params: "3.8B",
    name: "Phi-4-mini 3.8B",
    description: "STEM / reasoning 高密度",
    primaryCapabilities: ["text"],
    secondaryTags: ["reasoning"],
    available: false,
    contextSize: 16000,
    quantizations: [
      { key: "q4_k_m", label: "Q4_K_M", sizeBytes: 2.4 * 1024 * 1024 * 1024 },
    ],
  },
  gemma3_4b: {
    key: "gemma3_4b",
    family: "Gemma 3",
    params: "4B",
    name: "Gemma 3 4B",
    description: "128k 长上下文",
    primaryCapabilities: ["text"],
    secondaryTags: ["long_context"],
    available: false,
    contextSize: 128000,
    quantizations: [
      { key: "q4_k_m", label: "Q4_K_M", sizeBytes: 2.5 * 1024 * 1024 * 1024 },
    ],
  },
  qwen3_4b: {
    key: "qwen3_4b",
    family: "Qwen3",
    params: "4B",
    name: "Qwen3 4B",
    description: "中文叙事主力",
    primaryCapabilities: ["text"],
    secondaryTags: ["chinese", "reasoning"],
    available: false,
    contextSize: 128000,
    quantizations: [
      { key: "q4_k_m", label: "Q4_K_M", sizeBytes: 2.5 * 1024 * 1024 * 1024 },
    ],
  },
  mistral_small3_7b: {
    key: "mistral_small3_7b",
    family: "Mistral Small 3",
    params: "7B",
    name: "Mistral Small 3 7B",
    description: "英文吞吐,~50 tps",
    primaryCapabilities: ["text"],
    secondaryTags: ["english"],
    available: false,
    contextSize: 32000,
    quantizations: [
      { key: "q4_k_m", label: "Q4_K_M", sizeBytes: 4.4 * 1024 * 1024 * 1024 },
    ],
  },
  qwen3_8b: {
    key: "qwen3_8b",
    family: "Qwen3",
    params: "8B",
    name: "Qwen3 8B",
    description: "HumanEval 76,中文 / 代码",
    primaryCapabilities: ["text"],
    secondaryTags: ["chinese", "code", "reasoning"],
    available: false,
    contextSize: 128000,
    quantizations: [
      { key: "q4_k_m", label: "Q4_K_M", sizeBytes: 5 * 1024 * 1024 * 1024 },
    ],
  },
  gemma3_9b: {
    key: "gemma3_9b",
    family: "Gemma 3",
    params: "9B",
    name: "Gemma 3 9B",
    description: "长上下文复杂叙事",
    primaryCapabilities: ["text"],
    secondaryTags: ["long_context"],
    available: false,
    contextSize: 128000,
    quantizations: [
      { key: "q4_k_m", label: "Q4_K_M", sizeBytes: 5.7 * 1024 * 1024 * 1024 },
    ],
  },
  phi4_14b: {
    key: "phi4_14b",
    family: "Phi-4",
    params: "14B",
    name: "Phi-4 14B",
    description: "14B 档质量天花板",
    primaryCapabilities: ["text"],
    secondaryTags: ["reasoning"],
    available: false,
    contextSize: 16000,
    quantizations: [
      { key: "q3_k_m", label: "Q3_K_M", sizeBytes: 8.5 * 1024 * 1024 * 1024 },
    ],
  },
};

module.exports = { PRESETS };
