// MLX Whisper 后端 (Apple Silicon 增强档, Phase 2)。
//
// 计划: 通过本地 Python sidecar 调 mlx-whisper / mlx-lm,
// runtime/分发方案待评估 (PEX / pyinstaller / uv-installed venv 三选一)。
// 目前为占位实现, isAvailable 始终返回 false, 主管线会自动落回 whisper.cpp。

async function isAvailable() {
  return false;
}

async function ensureModel() {
  throw new Error("mlx_whisper 后端尚未实现 (Phase 2)");
}

async function warmup() {
  throw new Error("mlx_whisper 后端尚未实现 (Phase 2)");
}

async function transcribe() {
  throw new Error("mlx_whisper 后端尚未实现 (Phase 2)");
}

module.exports = { backend: "mlx_whisper", isAvailable, ensureModel, warmup, transcribe };
