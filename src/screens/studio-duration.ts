export function formatStudioDuration(sec?: number): string | null {
  if (!sec) return null;
  if (sec <= 90) return `${sec} sec`;
  if (sec % 60 !== 0) return `${sec} sec`;
  const min = sec / 60;
  return min === 3 ? "3 min ± 0.5" : `${min} min ± 1`;
}

export function parseStudioDuration(value: string): number {
  const seconds = value.match(/(\d+)\s*sec/);
  if (seconds) return Number(seconds[1]);
  const minutes = value.match(/(\d+)\s*min/);
  return minutes ? Number(minutes[1]) * 60 : 600;
}
