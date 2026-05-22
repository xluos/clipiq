// 机器规格检测 + 本地模型适配度计算 (llmfit 风格的 fit / TPS / memPercent)
//
// 核心假设:
//   - macOS Apple Silicon = unified memory,系统占用按总内存 20%(上限 6GB)估算
//   - macOS GPU 可用上限 ≈ totalMem × 67% (Metal 默认 wired limit, 可 sysctl 调高)
//   - 其他平台尚未做精细 GPU/VRAM 检测,保守按总内存 - 6GB 算可用
//   - 模型实际占用 = quantSize + ctx × kvBytesPerToken (KV cache 随 ctx 线性增长)
//   - 速度估算: TPS = K / params_B × 量化倍数 (Metal K=160, CUDA 220, ROCm 180, CPU 80)

const os = require("node:os");

// Qwen3 系列各尺寸的 KV cache per token (F16, 经验值)
// 公式 KV bytes/token = 2(K+V) × num_layers × num_kv_heads × head_dim × 2(F16)
// 数字来自 Qwen3-* / Qwen3.5-* 的 GGUF 元数据或论文 (GQA 4-8x), 容忍 ±30% 误差。
// 后续从 GGUF metadata 直接读 num_layers/num_kv_heads/head_dim 算精确值时,这表退化为 fallback。
const QWEN3_KV_BYTES_PER_TOKEN = {
  0.6: 12 * 1024,
  0.8: 14 * 1024,
  1.7: 28 * 1024,
  2: 30 * 1024,
  4: 60 * 1024,
  7: 130 * 1024,
  8: 140 * 1024,
  9: 144 * 1024,
  14: 180 * 1024,
  27: 220 * 1024,
  30: 230 * 1024, // 30B-A3B MoE: KV cache 按 dense 全 layer 算, 不分专家
  32: 240 * 1024,
  35: 280 * 1024, // 35B-A3B
};

// 估算每个 token 的 KV cache 字节数。
// 优先级: entry.kvBytesPerToken (manifest 显式) > Qwen3 lookup (按 params 近邻) > 公式 fallback
function estimateKvBytesPerToken(entry, paramsB) {
  if (entry?.kvBytesPerToken && Number(entry.kvBytesPerToken) > 0) {
    return Number(entry.kvBytesPerToken);
  }
  if (paramsB && paramsB > 0) {
    const keys = Object.keys(QWEN3_KV_BYTES_PER_TOKEN).map(Number).sort((a, b) => a - b);
    // 找最接近的 key (params 维度)
    let nearest = keys[0];
    let bestDiff = Math.abs(paramsB - nearest);
    for (const k of keys) {
      const d = Math.abs(paramsB - k);
      if (d < bestDiff) { bestDiff = d; nearest = k; }
    }
    return QWEN3_KV_BYTES_PER_TOKEN[nearest];
  }
  // 完全没信息时兜底 64 KB/token (大致 7B 量级)
  return 64 * 1024;
}

const BACKEND_K = {
  metal: 160,
  cuda: 220,
  rocm: 180,
  cpu: 80,
};

const QUANT_SPEED_MULT = {
  Q2_K: 1.25,
  Q3_K_M: 1.15,
  Q4_K_M: 1.0,
  Q5_K_M: 0.85,
  Q6_K: 0.75,
  Q8_0: 0.6,
};

function detectMachine() {
  const platform = process.platform;
  const arch = process.arch;
  const totalMemoryBytes = os.totalmem();
  const cpus = os.cpus();
  const cpuModel = (cpus && cpus[0] && cpus[0].model) || "Unknown CPU";
  const isAppleSilicon = platform === "darwin" && arch === "arm64";

  // 系统占用估算:Apple Silicon 上 20% (上限 6GB);其他平台直接减 6GB
  const systemReserved = isAppleSilicon
    ? Math.min(totalMemoryBytes * 0.2, 6 * 1024 * 1024 * 1024)
    : 6 * 1024 * 1024 * 1024;
  const availableMemoryBytes = Math.max(0, totalMemoryBytes - systemReserved);

  // Apple Silicon Metal 后端默认 wired memory limit ≈ totalMem × 67% (iogpu.wired_limit_mb).
  // 超过这个上限 llama.cpp 会 OOM 报错 (Metal 不会 swap), 所以模型 + KV cache 总占用必须 < 这条线。
  // 非 Apple Silicon 平台暂用 availableMemoryBytes 兜底 (后续做 nvidia-smi/rocm-smi 才能精确)。
  const gpuMemoryCapBytes = isAppleSilicon
    ? Math.floor(totalMemoryBytes * 0.67)
    : availableMemoryBytes;

  // 后端推断:Apple Silicon → Metal;其他暂为 CPU (后期 nvidia-smi/rocm-smi 检测时扩)
  const backend = isAppleSilicon ? "metal" : "cpu";
  const speedConstant = BACKEND_K[backend];

  // 推荐量化档:按可用内存粗分
  const availGB = availableMemoryBytes / (1024 * 1024 * 1024);
  let recommendedQuant = "Q4_K_M";
  if (availGB < 8) recommendedQuant = "Q3_K_M";
  else if (availGB < 16) recommendedQuant = "Q4_K_M";
  else if (availGB < 32) recommendedQuant = "Q5_K_M";
  else recommendedQuant = "Q6_K";

  return {
    platform,
    arch,
    totalMemoryBytes,
    availableMemoryBytes,
    gpuMemoryCapBytes,
    isAppleSilicon,
    cpuModel,
    backend,
    speedConstant,
    recommendedQuant,
  };
}

// 解析 "0.8B" / "2B" / "14B" 字符串为数字
function parseParams(paramsStr) {
  if (!paramsStr) return null;
  const m = String(paramsStr).match(/([\d.]+)\s*B/i);
  return m ? parseFloat(m[1]) : null;
}

// 计算单个量化档的 fit / TPS / memPercent / 总内存占用估算
// signature 变化: 新增 effectiveCtx 和 entry 参数, KV cache 跟 ctx 走不是常数。
//
// 参数:
//   quant: { sizeBytes, label } 量化档
//   machine: detectMachine() 输出
//   paramsB: 模型总参数 (数字, B 单位)
//   effectiveCtx: 当前 effective ctx (manifest 默认 或 用户在 settings slider 改的值)
//   entry: manifest entry (用来读 kvBytesPerToken override)
function computeQuantFit(quant, machine, paramsB, effectiveCtx, entry) {
  const ctx = Number(effectiveCtx) > 0 ? Number(effectiveCtx) : (entry?.contextSize || 8192);
  const kvPerToken = estimateKvBytesPerToken(entry, paramsB);
  const kvBytes = ctx * kvPerToken;
  // 总占用 = 模型权重 + KV cache + 推理 overhead (activation buffer 等, 估算 5%)
  const totalMemBytes = (quant.sizeBytes || 0) + kvBytes;
  const totalWithOverhead = Math.round(totalMemBytes * 1.05);

  // Apple Silicon: 看 GPU 内存上限 (Metal wired limit); 其他平台用 availableMemoryBytes
  const memCap = machine.gpuMemoryCapBytes || machine.availableMemoryBytes;
  const ratio = memCap > 0 ? totalWithOverhead / memCap : Infinity;

  let fit;
  if (ratio < 0.5) fit = "perfect";
  else if (ratio < 0.75) fit = "good";
  else if (ratio < 0.95) fit = "marginal";
  else fit = "tight";

  // Mem% 是 total (含 KV cache) 占可用内存的百分比, 用户直觉判断"够不够装"
  const memPercent = memCap > 0 ? Math.round((totalWithOverhead / memCap) * 100) : 0;

  const speedMult = QUANT_SPEED_MULT[quant.label] || 1.0;
  const tps = paramsB ? Math.round((machine.speedConstant / paramsB) * speedMult) : 0;

  return {
    fit,
    memPercent,
    tps,
    // 给 UI 显示具体数字用 (例如 "9B Q4_K_M @ 32K = 11 GB / 21 GB 上限")
    totalMemBytes: totalWithOverhead,
    weightBytes: quant.sizeBytes || 0,
    kvBytes,
    memCapBytes: memCap,
    effectiveCtx: ctx,
  };
}

// 为整个 manifest 计算每个模型的 fit (取第一档量化作为默认)
// ctxOverrides: { [modelKey]: ctxNumber } - settings 里用户调整过的 ctx, 没的话用 entry.contextSize
function annotateManifest(manifest, machine, ctxOverrides = {}) {
  const result = {};
  for (const [key, entry] of Object.entries(manifest)) {
    const paramsB = parseParams(entry.params);
    const defaultQuant = entry.quantizations && entry.quantizations[0];
    const effectiveCtx = Number(ctxOverrides[key]) > 0 ? Number(ctxOverrides[key]) : entry.contextSize;
    const metrics = defaultQuant
      ? computeQuantFit(defaultQuant, machine, paramsB, effectiveCtx, entry)
      : { fit: "tight", memPercent: 0, tps: 0 };
    result[key] = {
      ...entry,
      fit: metrics.fit,
      memPercent: metrics.memPercent,
      tps: metrics.tps,
    };
  }
  return result;
}

module.exports = {
  detectMachine,
  computeQuantFit,
  annotateManifest,
  parseParams,
  estimateKvBytesPerToken,
};
