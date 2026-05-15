// 机器规格检测 + 本地模型适配度计算 (llmfit 风格的 fit / TPS / memPercent)
//
// 核心假设:
//   - macOS Apple Silicon = unified memory,系统占用按总内存 20%(上限 6GB)估算
//   - 其他平台尚未做精细 GPU/VRAM 检测,保守按总内存 - 6GB 算可用
//   - 模型实际占用 = quantSize × 1.3 (KV cache 系数)
//   - 速度估算: TPS = K / params_B × 量化倍数 (Metal K=160, CUDA 220, ROCm 180, CPU 80)

const os = require("node:os");

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

// 计算单个量化档的 fit / TPS / memPercent
function computeQuantFit(quant, machine, paramsB) {
  const KV_FACTOR = 1.3;
  const modelMemBytes = (quant.sizeBytes || 0) * KV_FACTOR;
  const ratio = machine.availableMemoryBytes > 0
    ? modelMemBytes / machine.availableMemoryBytes
    : Infinity;

  let fit;
  if (ratio < 0.5) fit = "perfect";
  else if (ratio < 0.75) fit = "good";
  else if (ratio < 0.95) fit = "marginal";
  else fit = "tight";

  // Mem% 是模型大小 (不含 KV cache) 占可用内存的百分比,用户更直觉
  const memPercent = machine.availableMemoryBytes > 0
    ? Math.round(((quant.sizeBytes || 0) / machine.availableMemoryBytes) * 100)
    : 0;

  const speedMult = QUANT_SPEED_MULT[quant.label] || 1.0;
  const tps = paramsB ? Math.round((machine.speedConstant / paramsB) * speedMult) : 0;

  return { fit, memPercent, tps };
}

// 为整个 manifest 计算每个模型的 fit (取第一档量化作为默认)
function annotateManifest(manifest, machine) {
  const result = {};
  for (const [key, entry] of Object.entries(manifest)) {
    const paramsB = parseParams(entry.params);
    const defaultQuant = entry.quantizations && entry.quantizations[0];
    const metrics = defaultQuant
      ? computeQuantFit(defaultQuant, machine, paramsB)
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
};
