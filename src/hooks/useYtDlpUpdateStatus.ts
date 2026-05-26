import { useEffect, useSyncExternalStore } from "react";
import type { YtDlpUpdateInfo } from "../electron-api";

type Listener = () => void;

let cached: YtDlpUpdateInfo | null = null;
let listeners: Listener[] = [];
let subscribed = false;

function subscribe(l: Listener) {
  listeners = [...listeners, l];
  return () => {
    listeners = listeners.filter((x) => x !== l);
  };
}

function getSnapshot() {
  return cached;
}

function set(info: YtDlpUpdateInfo | null) {
  cached = info;
  for (const l of listeners) l();
}

export function useYtDlpUpdateStatus() {
  useEffect(() => {
    if (subscribed || !window.videoAnalyzer) return;
    subscribed = true;
    window.videoAnalyzer.onYtDlpUpdateStatus(set);
    window.videoAnalyzer.checkYtDlpUpdate().then(set).catch(() => {});
  }, []);

  return useSyncExternalStore(subscribe, getSnapshot);
}

export function clearYtDlpUpdateStatus() {
  set(null);
}
