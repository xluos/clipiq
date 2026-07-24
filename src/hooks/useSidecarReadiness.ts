import { useEffect, useState } from "react";

export function useSidecarReadiness() {
  const [readyLocalIds, setReadyLocalIds] = useState<Set<string>>(new Set());
  const [readyWhisperIds, setReadyWhisperIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!window.videoAnalyzer?.llama) return;
    let cancelled = false;
    const refresh = async () => {
      const r = await window.videoAnalyzer!.llama.listManifest().catch(() => null);
      if (cancelled || !r) return;
      const ready = new Set(
        r.models.filter((m) => m.availability.state === "ready").map((m) => m.id),
      );
      setReadyLocalIds(ready);
    };
    refresh();
    const unsub = window.videoAnalyzer.llama.onProgress(() => refresh());
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  useEffect(() => {
    if (!window.videoAnalyzer?.whisperCpp) return;
    let cancelled = false;
    const refresh = async () => {
      const models = await window.videoAnalyzer!.whisperCpp.listModels().catch(() => null);
      if (cancelled || !models) return;
      const ready = new Set(
        models.filter((m) => m.availability.state === "ready").map((m) => m.id),
      );
      setReadyWhisperIds(ready);
    };
    refresh();
    const unsub = window.videoAnalyzer.whisperCpp.onProgress(() => refresh());
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  return { readyLocalIds, readyWhisperIds };
}
