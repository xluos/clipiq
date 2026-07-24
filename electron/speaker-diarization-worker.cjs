"use strict";

const { parentPort, workerData } = require("node:worker_threads");
const sherpa = require("sherpa-onnx");

function fail(error) {
  parentPort.postMessage({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
}

setTimeout(() => {
  let diarizer = null;
  try {
    const wave = sherpa.readWave(workerData.wavPath);
    if (wave.sampleRate !== 16000) {
      throw new Error(`说话人识别只接受 16 kHz WAV，当前为 ${wave.sampleRate} Hz`);
    }
    if (!(wave.samples instanceof Float32Array) || wave.samples.length === 0) {
      throw new Error("音频为空或 WAV 格式无效");
    }
    diarizer = sherpa.createOfflineSpeakerDiarization({
      segmentation: {
        pyannote: { model: workerData.segmentationModelPath },
        numThreads: 2,
        debug: 0,
        provider: "cpu",
      },
      embedding: {
        model: workerData.embeddingModelPath,
        numThreads: 2,
        debug: 0,
        provider: "cpu",
      },
      clustering: {
        numClusters: workerData.numClusters,
        threshold: workerData.threshold,
      },
      minDurationOn: workerData.minDurationOn,
      minDurationOff: workerData.minDurationOff,
    });
    const segments = diarizer.process(wave.samples).map((segment) => ({
      startSec: Number(segment.start),
      endSec: Number(segment.end),
      speakerIndex: Number(segment.speaker),
    }));
    diarizer.free();
    diarizer = null;
    parentPort.postMessage({ ok: true, segments });
  } catch (error) {
    try {
      diarizer?.free();
    } catch {
      // 保留原始错误。
    }
    fail(error);
  }
}, 100);
