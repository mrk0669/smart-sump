// The phone app's home page: play with the virtual sump.

import { CloudRain, RotateCcw, Sun } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Badge, Button, Card, Segmented, SeverityIcon } from "../components/ui";
import { alarmInfo, type Severity } from "../lib/alarms";
import { useSump } from "../lib/sump";
import type { Mode, Setpoints, SumpEvent, Telemetry } from "../lib/types";
import type { Profile } from "../sim/virtual";
import { inflowToIntensity, intensityToInflow, PitScene, PUMP, VIEW } from "./PitScene";
import { useSim } from "./VirtualProvider";
import type { Live } from "./VirtualProvider";

const HINT_KEY = "smartsump.pitHintSeen";
const RAIN_FACTOR = 1.25;   // inflow above 1.25 x normal seepage counts as rain (seepage wobbles +-15 %)
const TOAST_TYPES = new Set(["PUMP_START", "PUMP_STOP", "ALARM", "ALARM_CLEAR", "CMD_REJECTED", "MODE_CHANGE"]);
const QUICK = [
  { name: "normal", label: "Normal" },
  { name: "heavy_rain", label: "Heavy rain" },
  { name: "dry_run", label: "Dry run" },
  { name: "tank_full", label: "Tank full" },
];

type Pop = "auto" | "start" | "stop" | "dry" | "tank" | null;
interface Toast { id: number; severity: Severity; title: string; text: string; until: number }

function flowFmt(profile: Profile) {
  const big = profile.plant.pump_rated_flow_lpm > 1000;
  return (lpm: number) => (big ? `${Math.round((lpm * 60) / 1000)} m³/h` : `${lpm.toFixed(lpm < 10 ? 1 : 0)} L/min`);
}

function toastFor(e: SumpEvent): Omit<Toast, "id" | "until"> {
  switch (e.type) {
    case "PUMP_START": return { severity: "good", title: "Pump started", text: e.reason };
    case "PUMP_STOP": return { severity: "info", title: "Pump stopped", text: e.reason };
    case "ALARM": {
      const a = alarmInfo(e.code ?? "");
      return { severity: (e.severity as Severity) ?? a.severity, title: a.label, text: e.reason };
    }
    case "ALARM_CLEAR": return { severity: "good", title: `Cleared: ${alarmInfo(e.code ?? "").label}`, text: e.reason };
    case "MODE_CHANGE": return { severity: "info", title: `Mode: ${e.code}`, text: e.code === "MANUAL" ? "Tap the pump to start or stop it." : "The controller is back in charge." };
    default: return { severity: "warning", title: "Command refused", text: e.reason };
  }
}

/** Plain-words explanation of what the controller is doing, and why. */
function explain(t: Telemetry | undefined, live: Live | null, cfg: Setpoints | undefined, p: Profile): string {
  if (!t || !live || !cfg) return "Starting the virtual sump…";
  const f = flowFmt(p);
  const cap = p.plant.pump_rated_flow_lpm;
  const rain = live.inflowLpm > p.baseInflowLpm * RAIN_FACTOR ? `the rain (${f(live.inflowLpm)})` : `seepage (${f(live.inflowLpm)})`;
  switch (t.state) {
    case "LOCKOUT_DRY":
      return "The pump was spinning but no water was moving (choked suction), so the controller stopped it to save the impeller and seals. Tap the pump to reset.";
    case "LOCKOUT_TANK":
      return `The sedimentation tank is full, so the pump is locked off until the tank drains below ${cfg.tank_high_pct - cfg.tank_clear_band_pct}%. Meanwhile the sump keeps filling.`;
    case "FAULT_SENSOR":
      return "The level sensor stopped answering, so the controller is working from the float switches alone.";
  }
  if (live.sumpPct >= 98)
    return `Overflowing! ${rain[0].toUpperCase() + rain.slice(1)} is more than the pump's ${f(cap)}: water is spilling onto the pit floor.`;
  if (t.alarms.includes("OVERFLOW_RISK") && t.tto_min)
    return `The sump is filling faster than it can be emptied: at this rate it overflows in about ${t.tto_min.toFixed(t.tto_min < 10 ? 1 : 0)} min.`;
  if (t.mode === "MANUAL")
    return t.pump_on
      ? "MANUAL: you're running the pump. Tank-full and dry-run protection still watch over it."
      : "MANUAL: the pump only starts when you tap it. Keep an eye on the level!";
  if (t.pump_on)
    return live.inflowLpm > cap
      ? `Pumping flat out (${f(cap)}), but ${rain} is stronger, so the level is still rising.`
      : `Pumping ${f(live.flowLpm)}: the sump drops to ${cfg.sump_stop_pct}%, then the pump stops by itself.`;
  if (live.sumpPct >= cfg.sump_start_pct)
    return `The sump is above ${cfg.sump_start_pct}%: the pump starts as soon as its rest time is over (that protects the motor).`;
  return `Pump resting while ${rain} fills the sump. It starts by itself at ${cfg.sump_start_pct}%.`;
}

export function PitPage() {
  const sim = useSim();
  const { device, send } = useSump();
  const t = device?.telemetry;
  const cfg = device?.config;
  const p = sim.profile;
  const f = flowFmt(p);
  const base = p.baseInflowLpm, max = p.maxInflowLpm, cap = p.plant.pump_rated_flow_lpm;
  const live = sim.live;
  const inflow = live?.inflowLpm ?? base;
  const intensity = sim.scenario === "custom" ? inflowToIntensity(sim.inflow, base, max) : inflowToIntensity(inflow, base, max);

  const [pop, setPop] = useState<Pop>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [hint, setHint] = useState(() => {
    try { return !localStorage.getItem(HINT_KEY); } catch { return true; }
  });
  const lastSeen = useRef<number | null>(null);

  // Toasts for new pump/alarm/command events.
  useEffect(() => {
    const events = device?.events ?? [];
    const newest = events[0]?.id ?? 0;
    if (lastSeen.current === null || newest < lastSeen.current) {   // first render or restart
      lastSeen.current = newest;
      return;
    }
    const fresh = events.filter((e) => (e.id ?? 0) > (lastSeen.current as number) && TOAST_TYPES.has(e.type));
    lastSeen.current = newest;
    if (!fresh.length) return;
    const now = Date.now();
    setToasts((ts) => [...fresh.reverse().map((e) => ({ ...toastFor(e), id: e.id ?? now, until: now + 3500 })), ...ts]
      .filter((x) => x.until > now).slice(0, 2));
  }, [device?.events]);
  useEffect(() => {
    if (!toasts.length) return;
    const id = setTimeout(() => setToasts((ts) => ts.filter((x) => x.until > Date.now())), 500);
    return () => clearTimeout(id);
  }, [toasts]);

  const seenHint = () => {
    if (!hint) return;
    setHint(false);
    try { localStorage.setItem(HINT_KEY, "1"); } catch { /* ignore */ }
  };

  const onPumpTap = () => {
    seenHint();
    if (!t) return;
    if (t.state === "LOCKOUT_DRY") setPop("dry");
    else if (t.state === "LOCKOUT_TANK") setPop("tank");
    else if (t.mode === "AUTO") setPop("auto");
    else setPop(t.pump_on ? "stop" : "start");
  };

  const sumpPct = live?.sumpPct ?? 0;
  const tto = t?.tto_min ?? null;
  const warn = cfg?.overflow_warn_min ?? 30;
  const ttoSev: Severity | null = t?.alarms.includes("OVERFLOW_RISK") || (tto !== null && tto < warn) ? "critical"
    : tto !== null && tto < warn * 2 ? "warning" : null;
  const lastEvent = device?.events.find((e) => TOAST_TYPES.has(e.type));

  return (
    <>
      {/* big readouts */}
      <div className="grid grid-cols-3 gap-2">
        <div className="rounded-xl border border-line bg-surface p-2.5">
          <div className="text-xs text-ink-2">Sump</div>
          <div className="text-3xl font-bold tracking-tight">{sumpPct.toFixed(0)}<span className="text-base text-ink-2">%</span></div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-grid">
            <div className="h-full bg-sump transition-all" style={{ width: `${Math.min(100, sumpPct)}%` }} />
          </div>
        </div>
        <div className={`rounded-xl border p-2.5 ${ttoSev === "critical" ? "border-crit/60 bg-crit/10" : ttoSev === "warning" ? "border-warn/70 bg-warn/10" : "border-line bg-surface"}`}>
          <div className="flex items-center gap-1 text-xs text-ink-2">{ttoSev && <SeverityIcon severity={ttoSev} className="size-3.5" />}Overflow in</div>
          <div className="text-3xl font-bold tracking-tight">
            {tto === null ? "—" : tto === 0 ? "now" : tto >= 600 ? ">10h" : tto.toFixed(tto < 10 ? 1 : 0)}
            {tto !== null && tto > 0 && tto < 600 && <span className="text-base text-ink-2"> min</span>}
          </div>
        </div>
        <div className="rounded-xl border border-line bg-surface p-2.5">
          <div className="text-xs text-ink-2">Pump</div>
          <div className="text-3xl font-bold tracking-tight">{t?.pump_on ? "ON" : "OFF"}</div>
          <div className="truncate text-xs text-ink-2">{t?.pump_on ? f(live?.flowLpm ?? 0) : t?.mode ?? ""}</div>
        </div>
      </div>

      {/* the scene */}
      <div className="relative overflow-hidden rounded-xl border border-line bg-surface">
        {live && (
          <PitScene live={live} t={t} config={cfg} intensity={intensity}
            onIntensity={(i) => { seenHint(); sim.setInflow(intensityToInflow(i, base, max)); }}
            onPumpTap={onPumpTap}
            rainLabel={inflow > base * RAIN_FACTOR ? `Rain ${f(inflow)}` : `No rain · seepage ${f(inflow)}`}
            pumpCapLabel={f(cap)} inflowRatio={inflow / cap} pumpCapLpm={cap} />
        )}

        {hint && (
          <div className="pointer-events-none absolute inset-x-6 top-[38%] rounded-lg bg-ink/85 px-3 py-2 text-center text-sm font-medium text-page">
            👆 Drag the cloud down for a storm · tap the pump to drive it
          </div>
        )}

        {/* toasts */}
        <div className="pointer-events-none absolute inset-x-2 top-2 space-y-1.5">
          {toasts.map((x) => (
            <div key={x.id} className="toast-in flex items-start gap-2 rounded-lg border border-line bg-raised/95 px-3 py-1.5 text-sm shadow-md">
              <SeverityIcon severity={x.severity} className="mt-0.5 size-4" />
              <div className="min-w-0">
                <div className="font-semibold">{x.title}</div>
                <div className="truncate text-xs text-ink-2">{x.text}</div>
              </div>
            </div>
          ))}
        </div>

        {/* pump pop-up */}
        {pop && (
          <div className="absolute z-10 w-56 rounded-xl border border-line bg-raised p-3 text-sm shadow-xl"
            style={{ left: `calc(${(PUMP.x / VIEW.w) * 100}% - 190px)`, top: `calc(${(PUMP.y / VIEW.h) * 100}% - 130px)` }}>
            {pop === "auto" && (
              <>
                <p><b>AUTO is in charge.</b> Switch to MANUAL to drive the pump yourself.</p>
                <div className="mt-2 flex gap-2">
                  <Button tone="primary" className="min-h-9 flex-1 px-2 text-sm" onClick={() => { send("mode", { mode: "MANUAL" }); setPop(null); }}>Switch to MANUAL</Button>
                  <Button className="min-h-9 px-3 text-sm" onClick={() => setPop(null)}>Close</Button>
                </div>
              </>
            )}
            {(pop === "start" || pop === "stop") && (
              <>
                <p><b>{pop === "start" ? "Start" : "Stop"} the pump?</b></p>
                <div className="mt-2 flex gap-2">
                  <Button tone={pop === "stop" ? "danger" : "primary"} className="min-h-9 flex-1 px-2 text-sm"
                    onClick={() => { send("pump", { action: pop }); setPop(null); }}>{pop === "start" ? "Start" : "Stop"}</Button>
                  <Button className="min-h-9 px-3 text-sm" onClick={() => setPop(null)}>Cancel</Button>
                </div>
              </>
            )}
            {pop === "dry" && (
              <>
                <p><b>Dry-run lockout.</b> The pump ran without water. Reset once the strainer is clear; if it's still choked it trips again.</p>
                <div className="mt-2 flex gap-2">
                  <Button tone="primary" className="min-h-9 flex-1 px-2 text-sm" onClick={() => { send("reset", { alarm: "DRY_RUN" }); setPop(null); }}>Reset</Button>
                  <Button className="min-h-9 px-3 text-sm" onClick={() => setPop(null)}>Close</Button>
                </div>
              </>
            )}
            {pop === "tank" && (
              <>
                <p><b>Tank full.</b> The pump stays locked off until the tank drains below {cfg ? cfg.tank_high_pct - cfg.tank_clear_band_pct : 80}%. Nobody can override that from the app.</p>
                <Button className="mt-2 min-h-9 w-full text-sm" onClick={() => setPop(null)}>OK</Button>
              </>
            )}
          </div>
        )}
      </div>

      {/* what's happening, in plain words */}
      <Card>
        <p className="text-base leading-snug">{explain(t, live, cfg, p)}</p>
        {lastEvent && (
          <p className="mt-2 text-sm text-ink-2">
            Last: <b className="text-ink">{toastFor(lastEvent).title}</b>: {lastEvent.reason}
          </p>
        )}
        {t && t.alarms.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {t.alarms.map((a) => <Badge key={a} severity={alarmInfo(a).severity}>{alarmInfo(a).label}</Badge>)}
          </div>
        )}
      </Card>

      {/* controls */}
      <Card>
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Segmented<Mode> label="Control mode" value={t?.mode ?? "AUTO"}
              options={[{ value: "AUTO", label: "AUTO" }, { value: "MANUAL", label: "MANUAL" }]}
              onChange={(mode) => send("mode", { mode })} />
            <Button onClick={() => sim.setInflow(base)} className="min-h-10"><Sun className="size-4" /> Stop rain</Button>
            <Button onClick={() => sim.setInflow(Math.min(max, cap * 1.2))} className="min-h-10"><CloudRain className="size-4" /> Storm</Button>
          </div>

          <div>
            <div className="mb-1 text-sm text-ink-2">Scenario (restarts the sump)</div>
            <div className="flex flex-wrap gap-1.5">
              {QUICK.map((q) => (
                <button key={q.name} onClick={() => sim.setScenario(q.name)}
                  className={`min-h-9 rounded-full border px-3 text-sm font-semibold ${sim.scenario === q.name ? "border-ink bg-ink text-page" : "border-line bg-raised text-ink-2"}`}>
                  {q.label}
                </button>
              ))}
              {sim.scenario === "custom" && <span className="self-center text-sm text-ink-2">· you control the rain</span>}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Segmented<string> label="Speed" value={String(sim.speed)}
              options={[1, 10, 60, 300].map((s) => ({ value: String(s), label: `${s}×` }))}
              onChange={(v) => sim.setSpeed(Number(v))} />
            <Button onClick={sim.restart} className="min-h-10"><RotateCcw className="size-4" /> Restart</Button>
          </div>

          <Segmented label="Site" value={p.id}
            options={sim.profiles.map((x) => ({ value: x.id, label: x.label }))}
            onChange={(id) => sim.setProfile(sim.profiles.find((x) => x.id === id)!)} />
          <p className="text-xs text-ink-2">{p.description}. Speed {sim.speed}× = {sim.speed} simulated seconds per real second.</p>
        </div>
      </Card>
    </>
  );
}
