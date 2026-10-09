export const pct = (v: number | null | undefined, digits = 0) =>
  v == null ? "—" : `${v.toFixed(digits)}`;

export const num = (v: number | null | undefined, digits = 1) =>
  v == null ? "—" : v.toFixed(digits);

export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  return `${Math.floor(s / 3600)} h ago`;
}

export const clock = (ts: number) =>
  new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export const dateTime = (ts: number) =>
  new Date(ts * 1000).toLocaleString([], {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

/** WiFi signal strength in bars (0-4) from RSSI in dBm. */
export function rssiBars(rssi?: number): number {
  if (rssi == null) return 0;
  if (rssi >= -55) return 4;
  if (rssi >= -65) return 3;
  if (rssi >= -75) return 2;
  if (rssi >= -85) return 1;
  return 0;
}
