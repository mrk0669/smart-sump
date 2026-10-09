// History charts from the logger. Levels share one chart (both are % of
// depth, same scale). Flow and current have different units, so each gets its
// own small chart rather than a confusing two-axis chart.

import { useMemo, useState } from "react";
import { Area, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Banner, Card, Empty, Segmented } from "../components/ui";
import { nowS, query, useApi } from "../lib/api";
import { num } from "../lib/format";
import { useSump } from "../lib/sump";

type Range = "1h" | "24h" | "7d";
const RANGE_S: Record<Range, number> = { "1h": 3600, "24h": 86400, "7d": 7 * 86400 };

interface Point {
  ts: number;
  sump_pct: number | null;
  tank_pct: number | null;
  pump_on: number;
  current_a: number | null;
  flow_lpm: number | null;
}

const AXIS = { stroke: "var(--axis)", tick: { fill: "var(--muted)", fontSize: 12 }, tickLine: false };

export function Trends() {
  const { device } = useSump();
  const [range, setRange] = useState<Range>("1h");
  const cfg = device?.config;

  // The path is rebuilt on every refresh, so the window slides forward with time.
  const { data, error } = useApi<{ since: number; until: number; points: Point[] }>(
    device ? () => `/telemetry?${query({ site: device.site, device: device.device,
      since: nowS() - RANGE_S[range], max_points: 600 })}` : null,
    [range, device?.key],
    range === "1h" ? 10_000 : 60_000,
  );

  const points = useMemo(() => (data?.points ?? []).map((p) => ({ ...p, pumpBand: p.pump_on ? 100 : 0 })), [data]);
  const fmtTime = (ts: number) =>
    new Date(ts * 1000).toLocaleString([], range === "7d"
      ? { day: "2-digit", month: "short" }
      : { hour: "2-digit", minute: "2-digit" });
  const last = points.at(-1);
  // Always show the whole selected window (e.g. the full last hour), even if
  // data only covers part of it, so the time axis means what it says.
  const domain: [number, number] | ["dataMin", "dataMax"] = data ? [data.since, data.until] : ["dataMin", "dataMax"];

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-bold">Trends</h1>
        <Segmented<Range> label="Time range" value={range} onChange={setRange}
          options={[{ value: "1h", label: "1 h" }, { value: "24h", label: "24 h" }, { value: "7d", label: "7 d" }]} />
      </div>

      {error && (
        <Banner severity="warning">
          History comes from the logger, which isn't answering ({error}). Start it with <code>python -m logger</code>.
        </Banner>
      )}

      <Card title="Water level (%)" action={
        <Legend items={[
          { label: "Sump", cls: "bg-sump" },
          { label: "Tank", cls: "bg-tank" },
          { label: "Pump running", cls: "bg-muted/30" },
        ]} />
      }>
        {points.length === 0 ? <Empty>{error ? "No history available." : "No readings in this time range yet."}</Empty> : (
          <ResponsiveContainer width="100%" height={300}>
            <ComposedChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
              <CartesianGrid vertical={false} stroke="var(--grid)" />
              <XAxis dataKey="ts" type="number" domain={domain} allowDataOverflow tickFormatter={fmtTime} {...AXIS} minTickGap={40} />
              <YAxis domain={[0, 100]} ticks={[0, 20, 40, 60, 80, 100]} {...AXIS} />
              <Tooltip content={<Tip fmt={fmtTime} />} cursor={{ stroke: "var(--muted)", strokeWidth: 1 }} />
              {/* pump-running periods as a soft grey band behind the lines */}
              <Area dataKey="pumpBand" type="stepAfter" stroke="none" fill="var(--muted)" fillOpacity={0.18}
                isAnimationActive={false} name="Pump running" activeDot={false} />
              {cfg && (
                <>
                  <ReferenceLine y={cfg.sump_start_pct} stroke="var(--ink-2)" strokeDasharray="5 4"
                    label={{ value: `start ${cfg.sump_start_pct}%`, position: "insideTopLeft", fill: "var(--ink-2)", fontSize: 12 }} />
                  <ReferenceLine y={cfg.sump_stop_pct} stroke="var(--ink-2)" strokeDasharray="5 4"
                    label={{ value: `stop ${cfg.sump_stop_pct}%`, position: "insideBottomLeft", fill: "var(--ink-2)", fontSize: 12 }} />
                  <ReferenceLine y={cfg.tank_high_pct} stroke="var(--muted)" strokeDasharray="2 4"
                    label={{ value: `tank full ${cfg.tank_high_pct}%`, position: "insideTopRight", fill: "var(--muted)", fontSize: 12 }} />
                </>
              )}
              <Line dataKey="sump_pct" name="Sump" stroke="var(--series-1)" strokeWidth={2} dot={false} isAnimationActive={false} connectNulls={false} />
              <Line dataKey="tank_pct" name="Tank" stroke="var(--series-2)" strokeWidth={2} dot={false} isAnimationActive={false} connectNulls={false} />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <SmallChart title="Flow" unit="L/min" dataKey="flow_lpm" color="var(--series-3)" swatch="bg-flow"
          points={points} fmt={fmtTime} latest={last?.flow_lpm} domain={domain} />
        <SmallChart title="Pump current" unit="A" dataKey="current_a" color="var(--series-4)" swatch="bg-amps"
          points={points} fmt={fmtTime} latest={last?.current_a} domain={domain}
          threshold={cfg ? { y: cfg.dry_run_current_a, label: `dry-run below ${cfg.dry_run_current_a} A` } : undefined} />
      </div>
    </>
  );
}

function SmallChart({ title, unit, dataKey, color, swatch, points, fmt, latest, threshold, domain }: {
  title: string;
  unit: string;
  dataKey: keyof Point;
  color: string;
  swatch: string;
  points: Point[];
  fmt: (ts: number) => string;
  latest: number | null | undefined;
  threshold?: { y: number; label: string };
  domain: [number, number] | ["dataMin", "dataMax"];
}) {
  return (
    <Card title={<span className="inline-flex items-center gap-1.5"><span className={`size-2.5 rounded-sm ${swatch}`} />{title} ({unit})</span>}
      action={<span className="text-sm text-ink-2">latest <b className="text-ink">{num(latest, 1)}</b> {unit}</span>}>
      {points.length === 0 ? <Empty>No data.</Empty> : (
        <ResponsiveContainer width="100%" height={180}>
          <ComposedChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
            <CartesianGrid vertical={false} stroke="var(--grid)" />
            <XAxis dataKey="ts" type="number" domain={domain} allowDataOverflow tickFormatter={fmt} {...AXIS} minTickGap={40} />
            <YAxis {...AXIS} />
            <Tooltip content={<Tip fmt={fmt} />} cursor={{ stroke: "var(--muted)", strokeWidth: 1 }} />
            {threshold && (
              <ReferenceLine y={threshold.y} stroke="var(--muted)" strokeDasharray="2 4"
                label={{ value: threshold.label, position: "insideTopRight", fill: "var(--muted)", fontSize: 12 }} />
            )}
            <Line dataKey={dataKey} name={title} unit={` ${unit}`} stroke={color} strokeWidth={2} dot={false} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      )}
    </Card>
  );
}

function Legend({ items }: { items: { label: string; cls: string }[] }) {
  return (
    <div className="flex flex-wrap gap-3 text-sm text-ink-2">
      {items.map((i) => (
        <span key={i.label} className="inline-flex items-center gap-1.5">
          <span className={`h-2.5 w-4 rounded-sm ${i.cls}`} aria-hidden />
          {i.label}
        </span>
      ))}
    </div>
  );
}

// Tooltip: text in normal ink, a small colour swatch carries the identity.
function Tip({ active, payload, label, fmt }: {
  active?: boolean;
  payload?: { name?: string; value?: number; color?: string; dataKey?: string; unit?: string }[];
  label?: number;
  fmt: (ts: number) => string;
}) {
  if (!active || !payload?.length || label == null) return null;
  const rows = payload.filter((p) => p.dataKey !== "pumpBand");
  const pumpOn = payload.some((p) => p.dataKey === "pumpBand" && p.value);
  return (
    <div className="rounded-lg border border-line bg-raised px-3 py-2 text-sm text-ink shadow-lg">
      <div className="mb-1 font-semibold">{new Date(label * 1000).toLocaleString([], { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" })}</div>
      {rows.map((p) => (
        <div key={p.dataKey} className="flex items-center gap-2">
          <span className="size-2.5 rounded-sm" style={{ background: p.color }} />
          {p.name}: <b>{p.value == null ? "—" : p.value.toFixed(1)}</b>{p.unit ?? (String(p.dataKey).endsWith("pct") ? " %" : "")}
        </div>
      ))}
      {payload.some((p) => p.dataKey === "pumpBand") && <div className="text-ink-2">Pump {pumpOn ? "running" : "off"}</div>}
      <span className="sr-only">{fmt(label)}</span>
    </div>
  );
}
