// Number / size / time formatting. Digits are always Latin (0-9), as is usual in Libya.

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(gb >= 10 ? 1 : 2)} GB`;
  const mb = bytes / 1024 ** 2;
  return `${mb.toFixed(mb >= 100 ? 0 : 1)} MB`;
}

export function formatGB(gb: number): string {
  if (!Number.isFinite(gb)) return '—';
  return Number.isInteger(gb) ? String(gb) : gb.toFixed(1);
}

export function formatSpeed(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '—';
  const mb = bytesPerSecond / 1024 ** 2;
  if (mb >= 1) return `${mb.toFixed(mb >= 10 ? 0 : 1)} MB/s`;
  return `${Math.max(1, Math.round(bytesPerSecond / 1024))} KB/s`;
}

/** "h:mm:ss" / "m:ss" style ETA. Returns null while the speed is unknown. */
export function formatEta(remainingBytes: number, bytesPerSecond: number): string | null {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond < 1024 || remainingBytes <= 0) return null;
  const total = Math.round(remainingBytes / bytesPerSecond);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function formatContext(tokens: number): string {
  if (tokens >= 1000) return `${Math.round(tokens / 1024)}K`;
  return String(tokens);
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** Calendar-day bucket used to group the chat list. */
export type DayBucket = 'today' | 'yesterday' | 'week' | 'older';

export function dayBucket(timestamp: number, now = Date.now()): DayBucket {
  const startOfDay = (t: number) => {
    const d = new Date(t);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const diffDays = Math.round((startOfDay(now) - startOfDay(timestamp)) / 86_400_000);
  if (diffDays <= 0) return 'today';
  if (diffDays === 1) return 'yesterday';
  if (diffDays < 7) return 'week';
  return 'older';
}
