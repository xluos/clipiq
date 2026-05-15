// 本地模型清单 (manifest) — 后期加新模型只需要编辑这个文件。
//
// 字段说明:
//   key: 内部唯一 id (snake_case)
//   family: 模型家族名 (Qwen3.5 / Phi-4 / Gemma 3 ...)
//   params: 参数规模 (0.8B / 2B / 4B / 9B / 27B / 35B-A3B ...)
//   primaryCapabilities: 主能力,决定任务槽位过滤 ("vision"/"audio"/"text")
//     - vision 槽位的 model 必须包含 "vision"
//     - audio 槽位的 model 必须包含 "audio"
//     - text 槽位的 model 包含 "text" (含 vision 也行,VLM 可以跑 text)
//   secondaryTags: 副能力,只做 hint 不参与过滤
//     ("chinese"/"english"/"code"/"reasoning"/"video"/"long_context"/"fast"/"moe")
//   contextSize: 上下文窗口 (token)
//   quantizations: 该模型支持的量化档列表。第一个为默认档。
//     {
//       key: 内部量化 id
//       label: 展示标签 (Q4_K_M / UD-Q4_K_XL ...)
//       repo: HuggingFace repo (用于拼下载 URL)
//       llmFile: 主权重文件名
//       mmprojFile: 视觉编码器文件名 (vision 模型必填)
//       sizeBytes: 总大小 (llm + mmproj) 估算,用于 fit 计算
//     }
//
// 当前清单:
//   Qwen3.5 (0.8B / 2B / 4B / 9B / 27B / 35B-A3B): unsloth dynamic 2.0 量化
//   Qwen3.6 (27B / 35B-A3B): 3.5 的增量更新, 原生 256k context, 架构沿用 qwen3_5 loader
// 整个 Qwen3.5/3.6 系列原生多模态, 所有尺寸都带 mmproj。

const PRESETS = {
  qwen3_5_0_8b_q4km: {
    key: "qwen3_5_0_8b_q4km",
    family: "Qwen3.5",
    params: "0.8B",
    name: "Qwen3.5 0.8B",
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
        sizeBytes: 740 * 1024 * 1024,
      },
    ],
  },
  qwen3_5_2b_q4km: {
    key: "qwen3_5_2b_q4km",
    family: "Qwen3.5",
    params: "2B",
    name: "Qwen3.5 2B",
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
    family: "Qwen3.5",
    params: "4B",
    name: "Qwen3.5 4B",
    description: "质量更稳,16 GB 机器主力档",
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
  qwen3_5_9b_q4km: {
    key: "qwen3_5_9b_q4km",
    family: "Qwen3.5",
    params: "9B",
    name: "Qwen3.5 9B",
    description: "更高保真度,需 24 GB+ 机器",
    primaryCapabilities: ["vision", "text"],
    secondaryTags: ["chinese", "reasoning"],
    available: true,
    contextSize: 8192,
    quantizations: [
      {
        key: "q4_k_m",
        label: "Q4_K_M",
        repo: "unsloth/Qwen3.5-9B-GGUF",
        llmFile: "Qwen3.5-9B-Q4_K_M.gguf",
        mmprojFile: "mmproj-F16.gguf",
        sizeBytes: 5.8 * 1024 * 1024 * 1024,
      },
    ],
  },
  qwen3_5_27b_q4km: {
    key: "qwen3_5_27b_q4km",
    family: "Qwen3.5",
    params: "27B",
    name: "Qwen3.5 27B",
    description: "高质量档,需 32 GB+ 机器",
    primaryCapabilities: ["vision", "text"],
    secondaryTags: ["chinese", "reasoning"],
    available: true,
    contextSize: 8192,
    quantizations: [
      {
        key: "q4_k_m",
        label: "Q4_K_M",
        repo: "unsloth/Qwen3.5-27B-GGUF",
        llmFile: "Qwen3.5-27B-Q4_K_M.gguf",
        mmprojFile: "mmproj-F16.gguf",
        sizeBytes: 17 * 1024 * 1024 * 1024,
      },
    ],
  },
  qwen3_5_35b_a3b_udq4xl: {
    key: "qwen3_5_35b_a3b_udq4xl",
    family: "Qwen3.5",
    params: "35B-A3B",
    name: "Qwen3.5 35B-A3B",
    description: "MoE 激活 3B,跑速接近 4B,需 32 GB+ 机器",
    primaryCapabilities: ["vision", "text"],
    secondaryTags: ["chinese", "reasoning", "moe"],
    available: true,
    contextSize: 8192,
    quantizations: [
      {
        key: "ud_q4_k_xl",
        label: "UD-Q4_K_XL",
        repo: "unsloth/Qwen3.5-35B-A3B-GGUF",
        llmFile: "Qwen3.5-35B-A3B-UD-Q4_K_XL.gguf",
        mmprojFile: "mmproj-F16.gguf",
        sizeBytes: 21 * 1024 * 1024 * 1024,
      },
    ],
  },
  qwen3_6_27b_q4km: {
    key: "qwen3_6_27b_q4km",
    family: "Qwen3.6",
    params: "27B",
    name: "Qwen3.6 27B",
    description: "27B 升级版,256k 原生上下文,需 32 GB+ 机器",
    primaryCapabilities: ["vision", "text"],
    secondaryTags: ["chinese", "reasoning", "long_context"],
    available: true,
    contextSize: 8192,
    quantizations: [
      {
        key: "q4_k_m",
        label: "Q4_K_M",
        repo: "unsloth/Qwen3.6-27B-GGUF",
        llmFile: "Qwen3.6-27B-Q4_K_M.gguf",
        mmprojFile: "mmproj-F16.gguf",
        sizeBytes: 17 * 1024 * 1024 * 1024,
      },
    ],
  },
  qwen3_6_35b_a3b_udq4xl: {
    key: "qwen3_6_35b_a3b_udq4xl",
    family: "Qwen3.6",
    params: "35B-A3B",
    name: "Qwen3.6 35B-A3B",
    description: "MoE 激活 3B,256k 原生上下文,需 32 GB+ 机器",
    primaryCapabilities: ["vision", "text"],
    secondaryTags: ["chinese", "reasoning", "moe", "long_context"],
    available: true,
    contextSize: 8192,
    quantizations: [
      {
        key: "ud_q4_k_xl",
        label: "UD-Q4_K_XL",
        repo: "unsloth/Qwen3.6-35B-A3B-GGUF",
        llmFile: "Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf",
        mmprojFile: "mmproj-F16.gguf",
        sizeBytes: 21 * 1024 * 1024 * 1024,
      },
    ],
  },
};

module.exports = { PRESETS };
