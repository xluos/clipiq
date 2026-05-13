import { useEffect, useRef, useState } from "react";

export type VideoFrame = { time: number; dataUrl: string };

const FRAME_WIDTH = 160;

export function useVideoFrames(src: string | undefined, durationSec: number, count: number) {
  const [frames, setFrames] = useState<VideoFrame[]>([]);
  const cancelled = useRef(false);

  useEffect(() => {
    cancelled.current = false;
    setFrames([]);
    if (!src || !durationSec || count <= 0) return;

    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.preload = "auto";
    video.muted = true;
    video.playsInline = true;
    video.src = src;

    const canvas = document.createElement("canvas");
    const targets: number[] = [];
    for (let i = 0; i < count; i++) {
      const t = ((i + 0.5) / count) * durationSec;
      targets.push(Math.min(Math.max(t, 0.1), Math.max(durationSec - 0.1, 0)));
    }

    const collected: VideoFrame[] = [];

    const captureNext = async () => {
      if (cancelled.current) return;
      if (collected.length >= targets.length) {
        setFrames([...collected]);
        return;
      }
      const t = targets[collected.length];
      await seek(video, t);
      if (cancelled.current) return;
      const w = video.videoWidth;
      const h = video.videoHeight;
      if (!w || !h) {
        // skip frame if not ready
        collected.push({ time: t, dataUrl: "" });
        captureNext();
        return;
      }
      canvas.width = FRAME_WIDTH;
      canvas.height = Math.round((h / w) * FRAME_WIDTH);
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        try {
          const url = canvas.toDataURL("image/jpeg", 0.6);
          collected.push({ time: t, dataUrl: url });
        } catch {
          collected.push({ time: t, dataUrl: "" });
        }
      } else {
        collected.push({ time: t, dataUrl: "" });
      }
      // publish progressively
      setFrames([...collected]);
      captureNext();
    };

    const onLoaded = () => {
      captureNext();
    };

    video.addEventListener("loadeddata", onLoaded, { once: true });
    video.addEventListener("error", () => setFrames([]));

    return () => {
      cancelled.current = true;
      video.removeEventListener("loadeddata", onLoaded);
      video.src = "";
    };
  }, [src, durationSec, count]);

  return frames;
}

function seek(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve) => {
    const onSeeked = () => {
      video.removeEventListener("seeked", onSeeked);
      resolve();
    };
    video.addEventListener("seeked", onSeeked);
    try {
      video.currentTime = time;
    } catch {
      video.removeEventListener("seeked", onSeeked);
      resolve();
    }
  });
}
