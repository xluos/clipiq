// 音频转录后端的抽象层。
//
// 目标: Phase 1 用 whisper.cpp 落地;Phase 2 在 Apple Silicon 上叠加 MLX Whisper。
// 主管线只调 getTranscriber(backend).transcribe(...),不依赖具体后端。
//
// 后端契约:
//   isAvailable(): Promise<boolean>  当前环境能否拉起这个后端 (binary/模型/平台前置)
//   ensureModel(modelId, onProgress): Promise<{ok}>      首次拿模型 (允许下载)
//   warmup(modelId): Promise<void>                       提前加载 (settings 里的"测试连接")
//   transcribe({ wavPath, modelId, language, onProgress, handle }): Promise<Transcript>
//
// Transcript = {
//   schemaVersion: "v2",
//   language: string | null,
//   text: string,
//   segments: Array<{
//     start: number,
//     end: number,
//     text: string,
//     words?: Array<{ text: string, start: number, end: number, confidence?: number }>
//   }>,
//   duration: number,
// }

const whisperCppBackend = require("./whisper-cpp.cjs");
const mlxBackend = require("./mlx.cjs");

const BACKENDS = {
  whisper_cpp: whisperCppBackend,
  mlx_whisper: mlxBackend,
};

function getTranscriber(backend = "whisper_cpp") {
  const impl = BACKENDS[backend];
  if (!impl) throw new Error(`未知 transcriber backend: ${backend}`);
  return impl;
}

async function listAvailableBackends() {
  const out = [];
  for (const [name, impl] of Object.entries(BACKENDS)) {
    const ok = await impl.isAvailable().catch(() => false);
    if (ok) out.push(name);
  }
  return out;
}

module.exports = { getTranscriber, listAvailableBackends, BACKENDS };
