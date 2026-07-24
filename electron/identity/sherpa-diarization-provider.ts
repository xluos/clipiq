import { existsSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import type {
  SpeakerDiarizationProvider,
  SpeakerDiarizationProviderDescriptor,
  SpeakerDiarizationSegment,
} from "./speaker-diarization-provider";

const runtimeRequire = createRequire(__filename);

export type SherpaDiarizationProviderOptions = {
  segmentationModelPath: string;
  embeddingModelPath: string;
  threshold?: number;
  numClusters?: number;
  minDurationOn?: number;
  minDurationOff?: number;
  workerPath?: string;
};

type WorkerResult =
  | { ok: true; segments: SpeakerDiarizationSegment[] }
  | { ok: false; error: string };

export const SHERPA_DIARIZATION_DESCRIPTOR: SpeakerDiarizationProviderDescriptor = {
  id: "sherpa-onnx-speaker-diarization",
  version: "1.0.0",
  runtime: {
    id: "sherpa-onnx-wasm",
    version: "1.13.4",
    licenseName: "Apache-2.0",
  },
  models: [
    {
      id: "pyannote-segmentation-3.0-int8",
      role: "segmentation",
      version: "3.0",
      sourceUrl: "https://huggingface.co/csukuangfj/sherpa-onnx-pyannote-segmentation-3-0",
      licenseName: "MIT",
      productionUse: "allowed",
    },
    {
      id: "3dspeaker-eres2net-base-zh-16k",
      role: "embedding",
      sourceUrl: "https://github.com/modelscope/3D-Speaker",
      licenseName: "Apache-2.0",
      productionUse: "allowed",
    },
  ],
};

function abortError(): Error {
  const error = new Error("说话人识别已取消");
  error.name = "AbortError";
  return error;
}

export function createSherpaDiarizationProvider(
  options: SherpaDiarizationProviderOptions,
): SpeakerDiarizationProvider {
  const workerPath = options.workerPath
    || path.join(__dirname, "..", "speaker-diarization-worker.cjs");

  return {
    descriptor: SHERPA_DIARIZATION_DESCRIPTOR,

    async getReadiness() {
      if (!existsSync(options.segmentationModelPath)) {
        return { ready: false as const, reason: "缺少 Pyannote 说话人分段模型" };
      }
      if (!existsSync(options.embeddingModelPath)) {
        return { ready: false as const, reason: "缺少 3D-Speaker 声纹模型" };
      }
      if (!existsSync(workerPath)) {
        return { ready: false as const, reason: "缺少说话人识别 Worker" };
      }
      try {
        runtimeRequire.resolve("sherpa-onnx");
      } catch {
        return { ready: false as const, reason: "缺少 sherpa-onnx 离线运行时" };
      }
      return { ready: true as const };
    },

    async diarize(wavPath, runOptions) {
      if (runOptions?.signal?.aborted) throw abortError();
      const worker = new Worker(workerPath, {
        workerData: {
          wavPath,
          segmentationModelPath: options.segmentationModelPath,
          embeddingModelPath: options.embeddingModelPath,
          threshold: options.threshold ?? 0.5,
          numClusters: options.numClusters ?? -1,
          minDurationOn: options.minDurationOn ?? 0.2,
          minDurationOff: options.minDurationOff ?? 0.5,
        },
      });

      return await new Promise<SpeakerDiarizationSegment[]>((resolve, reject) => {
        let settled = false;
        const finish = (callback: () => void) => {
          if (settled) return;
          settled = true;
          runOptions?.signal?.removeEventListener("abort", onAbort);
          callback();
        };
        const onAbort = () => {
          void worker.terminate();
          finish(() => reject(abortError()));
        };
        runOptions?.signal?.addEventListener("abort", onAbort, { once: true });
        worker.once("message", (result: WorkerResult) => {
          finish(() => {
            if (!result?.ok) {
              const message = result && "error" in result
                ? result.error
                : "说话人识别 Worker 返回无效结果";
              reject(new Error(message));
            }
            else resolve(result.segments);
          });
        });
        worker.once("error", (error) => finish(() => reject(error)));
        worker.once("exit", (code) => {
          if (code !== 0) {
            finish(() => reject(new Error(`说话人识别 Worker 异常退出: ${code}`)));
          }
        });
      });
    },
  };
}
