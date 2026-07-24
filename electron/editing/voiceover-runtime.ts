import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const MAX_DIAGNOSTIC_BYTES = 64 * 1024;

export type SystemVoice = {
  name: string;
  locale: string;
};

export type VoiceoverSynthesisOptions = {
  sayPath: string;
  ffprobePath: string;
  text: string;
  outputPath: string | ((identity: {
    voice?: string;
    rateWpm: number;
    textDigest: string;
  }) => string);
  maximumDurationUs: number;
  voice?: string;
  rateWpm?: number;
  signal?: AbortSignal;
  registerChild?: (child: { kill: (signal?: string) => void }) => void;
  onProgress?: (progress: {
    progress: number;
    stage: string;
    message?: string;
  }) => void;
};

export type VoiceoverSynthesisResult = {
  outputPath: string;
  durationUs: number;
  voice?: string;
  rateWpm: number;
  textDigest: string;
  cacheHit: boolean;
};

function abortError(): Error {
  const error = new Error("旁白合成已取消");
  error.name = "AbortError";
  return error;
}

function ensureNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

export function voiceoverTextDigest(
  text: string,
  voice: string | undefined,
  rateWpm: number,
): string {
  return createHash("sha256").update(JSON.stringify({
    version: 1,
    text: text.trim(),
    voice: voice || null,
    rateWpm,
  })).digest("hex");
}

export function parseSystemVoices(output: string): SystemVoice[] {
  return output.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^(.+?)\s{2,}([a-z]{2}_[A-Z]{2})\s+#/);
    if (!match) return [];
    return [{ name: match[1].trim(), locale: match[2] }];
  });
}

export function selectChineseSystemVoice(voices: SystemVoice[]): string | undefined {
  return voices.find((voice) => voice.name === "Tingting")?.name
    || voices.find((voice) => voice.locale === "zh_CN")?.name;
}

export function buildSaySynthesisArgs(input: {
  text: string;
  outputPath: string;
  voice?: string;
  rateWpm: number;
}): string[] {
  return [
    ...(input.voice ? ["-v", input.voice] : []),
    "-r", String(input.rateWpm),
    "-o", input.outputPath,
    "--file-format=WAVE",
    "--data-format=LEI16@48000",
    input.text,
  ];
}

export function buildVoiceoverProbeArgs(sourcePath: string): string[] {
  return [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "json",
    sourcePath,
  ];
}

export function parseVoiceoverDurationUs(output: string): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("无法读取旁白音频时长");
  }
  const seconds = Number((parsed as { format?: { duration?: unknown } })?.format?.duration);
  const durationUs = Math.round(seconds * 1_000_000);
  if (!Number.isSafeInteger(durationUs) || durationUs <= 0) {
    throw new Error("旁白音频没有有效时长");
  }
  return durationUs;
}

async function runProcess(
  binaryPath: string,
  args: string[],
  options: {
    signal?: AbortSignal;
    registerChild?: VoiceoverSynthesisOptions["registerChild"];
  } = {},
): Promise<{ stdout: string; stderr: string }> {
  ensureNotAborted(options.signal);
  return await new Promise((resolve, reject) => {
    const child = spawn(binaryPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    options.registerChild?.({
      kill: (signal) => child.kill(signal as NodeJS.Signals | number | undefined),
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
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
      if (stdoutBytes >= MAX_DIAGNOSTIC_BYTES) return;
      stdout.push(chunk);
      stdoutBytes += chunk.byteLength;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBytes >= MAX_DIAGNOSTIC_BYTES) return;
      stderr.push(chunk);
      stderrBytes += chunk.byteLength;
    });
    child.on("error", (error) => finishReject(error));
    child.on("close", (code) => {
      options.signal?.removeEventListener("abort", onAbort);
      if (settled) return;
      const output = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (code !== 0) {
        finishReject(new Error(
          output.stderr.trim()
          || output.stdout.trim()
          || `旁白合成命令失败 (${code ?? "unknown"})`,
        ));
        return;
      }
      settled = true;
      resolve(output);
    });
  });
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).size > 0;
  } catch {
    return false;
  }
}

async function probeDurationUs(
  ffprobePath: string,
  sourcePath: string,
  options: Pick<VoiceoverSynthesisOptions, "signal" | "registerChild">,
): Promise<number> {
  const result = await runProcess(
    ffprobePath,
    buildVoiceoverProbeArgs(sourcePath),
    options,
  );
  return parseVoiceoverDurationUs(result.stdout);
}

export async function synthesizeSystemVoiceover(
  options: VoiceoverSynthesisOptions,
): Promise<VoiceoverSynthesisResult> {
  const text = options.text.trim();
  if (!text) throw new Error("旁白文本不能为空");
  if (text.length > 500) throw new Error("单段旁白不能超过 500 个字符");
  if (
    !Number.isSafeInteger(options.maximumDurationUs)
    || options.maximumDurationUs < 300_000
  ) {
    throw new Error("旁白可用时长不足 0.3 秒");
  }
  const rateWpm = Math.max(80, Math.min(360, Math.round(options.rateWpm || 190)));
  let voice = options.voice?.trim() || undefined;
  if (!voice) {
    const listed = await runProcess(options.sayPath, ["-v", "?"], options);
    voice = selectChineseSystemVoice(parseSystemVoices(listed.stdout));
  }
  const textDigest = voiceoverTextDigest(text, voice, rateWpm);
  const outputPath = typeof options.outputPath === "function"
    ? options.outputPath({ voice, rateWpm, textDigest })
    : options.outputPath;
  if (!path.isAbsolute(outputPath)) {
    throw new Error("旁白输出路径必须是绝对路径");
  }
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  if (await fileExists(outputPath)) {
    const durationUs = await probeDurationUs(
      options.ffprobePath,
      outputPath,
      options,
    );
    if (durationUs <= options.maximumDurationUs + 50_000) {
      options.onProgress?.({ progress: 100, stage: "完成", message: "复用已合成旁白" });
      return {
        outputPath,
        durationUs,
        voice,
        rateWpm,
        textDigest,
        cacheHit: true,
      };
    }
  }

  const temporaryPath = `${outputPath}.tmp-${process.pid}-${Date.now()}.wav`;
  options.onProgress?.({
    progress: 15,
    stage: "合成旁白",
    message: voice || "系统音色",
  });
  try {
    await runProcess(
      options.sayPath,
      buildSaySynthesisArgs({
        text,
        outputPath: temporaryPath,
        voice,
        rateWpm,
      }),
      options,
    );
    ensureNotAborted(options.signal);
    options.onProgress?.({ progress: 85, stage: "校验旁白时长" });
    const durationUs = await probeDurationUs(
      options.ffprobePath,
      temporaryPath,
      options,
    );
    if (durationUs > options.maximumDurationUs + 50_000) {
      throw new Error(
        `旁白时长 ${(durationUs / 1_000_000).toFixed(1)}s 超过当前镜头可用的 ${(options.maximumDurationUs / 1_000_000).toFixed(1)}s`,
      );
    }
    await fs.rm(outputPath, { force: true });
    await fs.rename(temporaryPath, outputPath);
    options.onProgress?.({ progress: 100, stage: "完成" });
    return {
      outputPath,
      durationUs,
      voice,
      rateWpm,
      textDigest,
      cacheHit: false,
    };
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
}
