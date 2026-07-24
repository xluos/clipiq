import { spawn } from "node:child_process";
import type { AudioBeatAnalysis } from "../../src/types";
import { detectAudioBeats } from "./audio-beat-analysis";

const SAMPLE_RATE = 16_000;
const BYTES_PER_SAMPLE = Float32Array.BYTES_PER_ELEMENT;
const US_PER_SECOND = 1_000_000;

export type AudioBeatRuntimeOptions = {
  ffmpegPath: string;
  sourcePath: string;
  maximumDurationUs: number;
  signal?: AbortSignal;
  registerChild?: (child: { kill: (signal?: string) => void }) => void;
  onProgress?: (progress: {
    progress: number;
    stage: string;
    message?: string;
  }) => void;
};

function abortError(): Error {
  const error = new Error("节拍分析已取消");
  error.name = "AbortError";
  return error;
}

export function buildAudioBeatDecodeArgs(
  sourcePath: string,
  maximumDurationUs: number,
): string[] {
  if (!sourcePath) throw new Error("节拍分析缺少音频路径");
  if (!Number.isSafeInteger(maximumDurationUs) || maximumDurationUs <= 0) {
    throw new Error("节拍分析时长无效");
  }
  return [
    "-nostdin",
    "-v", "error",
    "-i", sourcePath,
    "-vn",
    "-t", (maximumDurationUs / US_PER_SECOND).toFixed(6),
    "-ac", "1",
    "-ar", String(SAMPLE_RATE),
    "-c:a", "pcm_f32le",
    "-f", "f32le",
    "pipe:1",
  ];
}

export function decodeFloat32Le(buffer: Buffer): Float32Array {
  const usableBytes = buffer.byteLength - (buffer.byteLength % BYTES_PER_SAMPLE);
  if (usableBytes <= 0) return new Float32Array();
  const copy = Buffer.from(buffer.subarray(0, usableBytes));
  return new Float32Array(
    copy.buffer,
    copy.byteOffset,
    copy.byteLength / BYTES_PER_SAMPLE,
  ).slice();
}

async function decodeAudio(
  options: AudioBeatRuntimeOptions,
): Promise<Float32Array> {
  if (options.signal?.aborted) throw abortError();
  const args = buildAudioBeatDecodeArgs(
    options.sourcePath,
    options.maximumDurationUs,
  );
  const maximumBytes = Math.ceil(
    options.maximumDurationUs / US_PER_SECOND * SAMPLE_RATE * BYTES_PER_SAMPLE,
  ) + 4_096;

  return await new Promise<Float32Array>((resolve, reject) => {
    const child = spawn(options.ffmpegPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    options.registerChild?.({
      kill: (signal) => {
        child.kill(signal as NodeJS.Signals | number | undefined);
      },
    });
    const chunks: Buffer[] = [];
    const errorChunks: Buffer[] = [];
    let receivedBytes = 0;
    let settled = false;

    const finishReject = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const onAbort = () => {
      try { child.kill("SIGTERM"); } catch { /* 已结束。 */ }
      finishReject(abortError());
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      receivedBytes += chunk.byteLength;
      if (receivedBytes > maximumBytes) {
        try { child.kill("SIGTERM"); } catch { /* 已结束。 */ }
        finishReject(new Error("节拍分析解码数据超出预期范围"));
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (errorChunks.reduce((sum, item) => sum + item.byteLength, 0) < 64 * 1024) {
        errorChunks.push(chunk);
      }
    });
    child.on("error", (error) => finishReject(error));
    child.on("close", (code) => {
      options.signal?.removeEventListener("abort", onAbort);
      if (settled) return;
      if (code !== 0) {
        finishReject(new Error(
          Buffer.concat(errorChunks).toString("utf8").trim()
          || `FFmpeg 音频解码失败 (${code ?? "unknown"})`,
        ));
        return;
      }
      settled = true;
      resolve(decodeFloat32Le(Buffer.concat(chunks)));
    });
  });
}

export async function analyzeAudioBeatSource(
  options: AudioBeatRuntimeOptions,
): Promise<AudioBeatAnalysis> {
  options.onProgress?.({
    progress: 10,
    stage: "解码音频",
    message: "16 kHz 单声道",
  });
  const pcm = await decodeAudio(options);
  if (options.signal?.aborted) throw abortError();
  options.onProgress?.({
    progress: 80,
    stage: "检测节拍",
    message: `${(pcm.length / SAMPLE_RATE).toFixed(1)}s`,
  });
  const analysis = detectAudioBeats(pcm, SAMPLE_RATE);
  options.onProgress?.({
    progress: 95,
    stage: "写入节拍",
    message: analysis.status === "usable"
      ? `${analysis.bpm?.toFixed(1)} BPM`
      : "未形成稳定节拍网格",
  });
  return analysis;
}
