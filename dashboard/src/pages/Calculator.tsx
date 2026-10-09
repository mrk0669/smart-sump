// Sump calculator: from a few field numbers (sump size, pump, inflow) to the
// figures a mine planner needs, and then "Simulate this sump" to watch it run.

import { FlaskConical } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Banner, Button, Card, SeverityIcon } from "../components/ui";
import type { Severity } from "../lib/alarms";
import { calculate, MINE_INPUT, profileFromCalc } from "../sim/profiles";
import type { CalcInput } from "../sim/profiles";
import { useSimOptional } from "../virtual/VirtualProvider";

const KEY = "smartsump.calc";

const FIELDS: { group: string; key: keyof CalcInput; label: string; unit: string; step: number }[] = [
  { group: "Sump size", key: "length_m", label: "Length", unit: "m", step: 0.5 },
  { group: "Sump size", key: "width_m", label: "Width", unit: "m", step: 0.5 },
  { group: "Sump size", key: "depth_m", label: "Usable depth", unit: "m", step: 0.1 },
  { group: "Pump", key: "pump_gpm", label: "Pump capacity", unit: "US GPM", step: 50 },
  { group: "Pump", key: "motor_kw", label: "Motor rating", unit: "kW", step: 1 },
  { group: "Water", key: "normal_inflow_m3h", label: "Normal inflow (seepage)", unit: "m³/h", step: 10 },
  { group: "Water", key: "storm_inflow_m3h", label: "Peak storm inflow", unit: "m³/h", step: 50 },
  { group: "Control", key: "start_pct", label: "Start pump at", unit: "%", step: 1 },
  { group: "Control", key: "stop_pct", label: "Stop pump at", unit: "%", step: 1 },
  { group: "Control", key: "tariff_rs_per_kwh", label: "Power tariff", unit: "₹/kWh", step: 0.5 },
];

const hours = (h: number | null) => {
  if (h === null || !Number.isFinite(h)) return "—";
  if (h < 1) return `${Math.round(h * 60)} min`;
  const m = Math.round((h % 1) * 60);
  return m ? `${Math.floor(h)} h ${m} min` : `${Math.floor(h)} h`;
};
const n = (x: number | null, d = 0) => (x === null || !Number.isFinite(x) ? "—" : x.toLocaleString("en-IN", { maximumFractionDigits: d }));

function load(): Record<keyof CalcInput, string> {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved) return JSON.parse(saved);
  } catch {
    /* use defaults */
  }
  return Object.fromEntries(Object.entries(MINE_INPUT).map(([k, v]) => [k, String(v)])) as Record<keyof CalcInput, string>;
}

export function Calculator() {
  const sim = useSimOptional();
  const [form, setForm] = useState(load);
  const [done, setDone] = useState(false);
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(form));
    } catch {
      /* private mode */
    }
  }, [form]);

  const input = useMemo(() => Object.fromEntries(Object.entries(form).map(([k, v]) => [k, Number(v)])) as unknown as CalcInput, [form]);
  const error = useMemo(() => {
    for (const f of FIELDS) {
      const v = input[f.key];
      if (!Number.isFinite(v) || v < 0 || (v === 0 && f.key !== "tariff_rs_per_kwh" && f.key !== "stop_pct"))
        return `${f.label}: enter a positive number.`;
    }
    if (input.start_pct > 100) return "Start level can't be above 100 %.";
    if (input.start_pct - input.stop_pct < 20) return "Keep the start level at least 20 % above the stop level (avoids rapid on/off).";
    return null;
  }, [input]);
  const r = useMemo(() => (error ? null : calculate(input)), [input, error]);

  const startsLimit = input.motor_kw >= 50 ? 4 : 10;   // big motors overheat if started too often
  const groups = [...new Set(FIELDS.map((f) => f.group))];

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-bold">Sump calculator</h1>
        <Button onClick={() => setForm(Object.fromEntries(Object.entries(MINE_INPUT).map(([k, v]) => [k, String(v)])) as typeof form)}>
          Reset to project mine
        </Button>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Inputs" className="lg:col-span-1">
          <div className="space-y-4">
            {groups.map((g) => (
              <fieldset key={g}>
                <legend className="mb-1 text-sm font-semibold text-ink-2">{g}</legend>
                <div className="grid grid-cols-2 gap-x-3 gap-y-2">
                  {FIELDS.filter((f) => f.group === g).map((f) => (
                    <label key={f.key} className="block text-sm">
                      {f.label}
                      <span className="mt-0.5 flex items-center gap-1">
                        <input type="number" inputMode="decimal" min={0} step={f.step} value={form[f.key]}
                          onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
                          className="min-h-10 w-full min-w-0 rounded-lg border border-line bg-raised px-2 text-base font-semibold text-ink" />
                        <span className="shrink-0 text-xs text-ink-2">{f.unit}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
            ))}
          </div>
        </Card>

        <div className="space-y-4 lg:col-span-2">
          {error && <Banner severity="warning">{error}</Banner>}
          {r && (
            <>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
                <Result label="Sump volume" value={n(r.volume_m3)} unit="m³" sub={`${n(r.working_m3)} m³ between stop and start`} />
                <Result label="Pump capacity" value={n(r.pump_m3h)} unit="m³/h" sub={`${n(r.pump_m3h * 1000 / 60)} L/min`} />
                <Result label="Fill time" value={hours(r.fill_h)} sub="stop → start, normal inflow" />
                <Result label="Pump-down time" value={hours(r.pumpdown_h)}
                  sub={r.pumpdown_h === null ? "pump smaller than inflow!" : "start → stop"}
                  severity={r.pumpdown_h === null ? "critical" : undefined} />
                <Result label="Pump starts"
                  value={r.starts_per_h === null ? "—" : r.starts_per_h >= 1 ? n(r.starts_per_h, 1) : n(r.starts_per_h * 24, 1)}
                  unit={r.starts_per_h !== null && r.starts_per_h >= 1 ? "per hour" : "per day"}
                  severity={r.starts_per_h !== null && r.starts_per_h > startsLimit ? "warning" : undefined}
                  sub={r.starts_per_h !== null && r.starts_per_h > startsLimit
                    ? `over ${startsLimit}/h: widen the start/stop band` : `fine for a ${input.motor_kw} kW motor`} />
                <Result label="Pumping per day" value={hours(r.pump_h_per_day)} sub={`duty ${n(r.duty_pct)} %`} />
                <Result label="Energy per day" value={n(r.kwh_per_day)} unit="kWh" sub={`motor input ${n(r.input_kw)} kW`} />
                <Result label="Power cost" value={`₹${n(r.rs_per_day)}`} unit="/day" sub={`₹${n(r.rs_per_day === null ? null : r.rs_per_day * 30)} per month`} />
                <Result label="Motor current" value={n(r.run_current_a)} unit="A" sub={`set dry-run below ~${n(0.65 * r.run_current_a)} A`} />
              </div>

              <Card title="Storm check (DGMS)">
                <ul className="space-y-3">
                  <Check ok={r.storage_h_at_storm >= 2}>
                    The sump holds <b>{hours(r.storage_h_at_storm)}</b> of peak storm inflow.
                    {r.storage_h_at_storm >= 2 ? " Meets the 2–3 h guideline." : " Below the 2–3 h DGMS guideline: enlarge the sump or add pumping."}
                  </Check>
                  <Check ok={r.storm_overflow_h === null}>
                    {r.storm_overflow_h === null
                      ? <>The pump keeps up with the peak storm inflow.</>
                      : <>In the storm the pump falls behind by <b>{n(input.storm_inflow_m3h - r.pump_m3h)} m³/h</b>: the sump
                          overflows <b>{hours(r.storm_overflow_h)}</b> after reaching the start level. To keep up you'd need about{" "}
                          <b>{n(Math.ceil(r.pump_for_storm_gpm / 100) * 100)} GPM</b> of pumping.</>}
                  </Check>
                </ul>
              </Card>

              {sim ? (
                <Button tone="primary" className="w-full sm:w-auto" onClick={() => {
                  sim.setProfile(profileFromCalc(input, "My sump"));
                  sim.setScenario("heavy_rain");
                  setDone(true);
                  location.hash = "overview";
                }}>
                  <FlaskConical className="size-4" /> Simulate this sump in a storm
                </Button>
              ) : null}
              {done && <Banner severity="good">Loaded into the virtual sump as “My sump”.</Banner>}

              <details className="rounded-xl border border-line bg-surface p-4 text-sm text-ink-2">
                <summary className="cursor-pointer font-semibold text-ink">How these are worked out</summary>
                <ul className="mt-2 list-disc space-y-1 pl-5">
                  <li>Volume = length × width × usable depth. Working volume = volume × (start % − stop %).</li>
                  <li>Pump m³/h = GPM × 3.785 L/gal × 60 ÷ 1000.</li>
                  <li>Fill time = working volume ÷ normal inflow. Pump-down = working volume ÷ (pump − inflow).</li>
                  <li>Starts per hour = 1 ÷ (fill + pump-down). Duty = pump-down ÷ (fill + pump-down).</li>
                  <li>Energy/day = motor kW ÷ 0.9 efficiency × pumping hours. Current = input kW ÷ (√3 × 415 V × 0.85 pf).</li>
                  <li>Storm storage = volume ÷ peak inflow (DGMS pre-monsoon guidance: hold 2–3 h of peak inflow).</li>
                  <li>Storm overflow time = volume above the start level ÷ (storm inflow − pump).</li>
                </ul>
              </details>
            </>
          )}
        </div>
      </div>
    </>
  );
}

function Result({ label, value, unit, sub, severity }: {
  label: string;
  value: string;
  unit?: string;
  sub?: string;
  severity?: Severity;
}) {
  const tone = severity === "critical" ? "border-crit/60 bg-crit/10" : severity === "warning" ? "border-warn/70 bg-warn/10" : "border-line bg-surface";
  return (
    <div className={`rounded-xl border p-3 ${tone}`}>
      <div className="flex items-center gap-1.5 text-sm text-ink-2">
        {severity && <SeverityIcon severity={severity} />}
        {label}
      </div>
      <div className="mt-1 flex items-baseline gap-1">
        <span className="text-2xl font-bold tracking-tight">{value}</span>
        {unit && value !== "—" && <span className="text-sm text-ink-2">{unit}</span>}
      </div>
      {sub && <div className="mt-0.5 text-xs text-ink-2">{sub}</div>}
    </div>
  );
}

function Check({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <SeverityIcon severity={ok ? "good" : "critical"} className="mt-0.5 size-5" />
      <span>{children}</span>
    </li>
  );
}
