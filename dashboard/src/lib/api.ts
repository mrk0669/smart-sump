// Calls to the logger's REST API (history, events, reports). Live values come
// over MQTT instead; the logger is only needed for the past.

import { useCallback, useEffect, useRef, useState } from "react";

export function query(params: Record<string, string | number | undefined>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined) as [string, string | number][];
  return new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString();
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`/api${path}`, init);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json() as Promise<T>;
}

export const csvUrl = (name: string, params: Record<string, string | number | undefined>) =>
  `/api/export/${name}.csv?${query(params)}`;

export const nowS = () => Math.floor(Date.now() / 1000);

/** Fetch from the logger now, whenever `deps` change, and every `refreshMs`
 *  (0 = never). `path` may be a function so it is rebuilt on every refresh,
 *  e.g. to slide a "last hour" window forward. */
export function useApi<T>(path: string | (() => string) | null, deps: unknown[] = [], refreshMs = 0) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bump, setBump] = useState(0);
  const pathRef = useRef(path);
  pathRef.current = path;
  const key = typeof path === "string" ? path : path ? "fn" : null;

  useEffect(() => {
    if (!key) return;
    let alive = true;
    const load = () => {
      const p = pathRef.current;
      if (!p) return;
      api<T>(typeof p === "function" ? p() : p)
        .then((d) => {
          if (alive) {
            setData(d);
            setError(null);
          }
        })
        .catch((e: Error) => alive && setError(e.message));
    };
    load();
    const id = refreshMs ? setInterval(load, refreshMs) : undefined;
    return () => {
      alive = false;
      if (id) clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, refreshMs, bump, ...deps]);

  const reload = useCallback(() => setBump((n) => n + 1), []);
  return { data, error, reload };
}
