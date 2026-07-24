import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import {
  mkdtemp,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { EditPlan, VideoClip } from "../src/types";
import {
  createTemplateOverlay,
  OVERLAY_TEMPLATE_KEYS,
} from "../electron/editing/overlay-templates";
import { renderEditPlanProxy } from "../electron/editing/proxy-renderer";
import { validateEditPlan } from "../electron/editing/edit-plan-validator";

const run = promisify(execFile);
const require = createRequire(import.meta.url);
const ffmpegPath = String(
  (require("@ffmpeg-installer/ffmpeg") as { path: string }).path,
);
const ffprobePath = String(
  (require("ffprobe-static") as { path: string }).path,
);

async function main(): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "clipiq-overlay-runtime-"));
  try {
    const sourcePath = path.join(root, "source.mp4");
    await run(ffmpegPath, [
      "-y",
      "-f", "lavfi",
      "-i", "color=c=black:s=720x1280:r=30:d=2",
      "-f", "lavfi",
      "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
      "-t", "2",
      "-shortest",
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      sourcePath,
    ], { maxBuffer: 10 * 1024 * 1024 });

    const clip: VideoClip = {
      id: "runtime-clip",
      candidateId: "runtime-shot::0-2000000",
      shotId: "runtime-shot",
      videoId: "runtime-video",
      sourcePath,
      sourceInUs: 0,
      sourceOutUs: 2_000_000,
      timelineInUs: 0,
      speed: 1,
      volume: 1,
      selectionReason: "运行时模板验证",
      confidence: 1,
    };
    const plan: EditPlan = {
      id: "runtime-overlay-plan",
      version: 1,
      revision: 1,
      sessionId: "runtime-session",
      status: "draft",
      canvas: { width: 1080, height: 1920, fps: 30 },
      targetDurationUs: 2_000_000,
      actualDurationUs: 2_000_000,
      tracks: [
        { id: "video-track", kind: "video", items: [clip] },
        {
          id: "overlay-track",
          kind: "overlay",
          items: [
            createTemplateOverlay({
              id: "runtime-flower",
              templateKey: OVERLAY_TEMPLATE_KEYS.punch,
              anchorClip: clip,
              text: "模板实测",
            }),
            createTemplateOverlay({
              id: "runtime-sticker",
              templateKey: OVERLAY_TEMPLATE_KEYS.spark,
              anchorClip: clip,
            }),
          ],
        },
      ],
      transitions: [],
      provenance: {
        goal: "验证花字和贴纸真实烧录",
        genre: "vlog",
        methodologyIds: [],
        generatedAt: Date.now(),
      },
      validation: { valid: false, warnings: [], errors: [] },
    };
    plan.validation = validateEditPlan(plan, {
      sourceExists: (source) => source === sourcePath,
    });
    if (!plan.validation.valid) {
      throw new Error(
        `运行时 EditPlan 无效: ${plan.validation.errors.map((issue) => issue.message).join("；")}`,
      );
    }
    plan.status = "validated";

    const preview = await renderEditPlanProxy(plan, {
      ffmpegPath,
      ffprobePath,
      outputRoot: path.join(root, "previews"),
      cacheRoot: path.join(root, "cache"),
      subtitleMode: "none",
    });
    const framePath = path.join(root, "frame.rgb");
    await run(ffmpegPath, [
      "-y",
      "-ss", "0.6",
      "-i", preview.outputPath,
      "-frames:v", "1",
      "-f", "rawvideo",
      "-pix_fmt", "rgb24",
      framePath,
    ], { maxBuffer: 10 * 1024 * 1024 });
    const frame = await readFile(framePath);
    const visibleChannelCount = frame.reduce(
      (count, value) => count + (value > 16 ? 1 : 0),
      0,
    );
    if (visibleChannelCount < 1_000) {
      throw new Error(
        `模板帧没有足够的非黑像素: ${visibleChannelCount}`,
      );
    }
    const output = await stat(preview.outputPath);
    process.stdout.write(`${JSON.stringify({
      valid: true,
      width: preview.width,
      height: preview.height,
      outputBytes: output.size,
      visibleChannelCount,
      warnings: preview.warnings || [],
    }, null, 2)}\n`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
