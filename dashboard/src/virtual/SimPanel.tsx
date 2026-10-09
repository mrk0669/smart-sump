// The virtual sump's controls: which site, which scenario, how fast.

import { Pause, Play, RotateCcw } from "lucide-react";
import { Button, Card, Segmented } from "../components/ui";
import { SCENARIOS, scenarioByName } from "../sim/scenarios";
import { capacityL } from "../sim/physics";
import { SPEEDS, useSim } from "./VirtualProvider";

export function fmtDuration(s: number): string {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min ${Math.floor(s % 60)} s`;
}

export const m3h = (lpm: number) => (lpm * 60) / 1000;

export function SimPanel() {
  const sim = useSim();
  const p = sim.profile;
  const scen = scenarioByName(sim.scenario);
  const sumpM3 = capacityL(p.plant.sump_area_m2, p.plant.sump_depth_cm) / 1000;
  const big = p.plant.pump_rated_flow_lpm > 1000;
  const flow = (lpm: number) => (big ? `${m3h(lpm).toFixed(0)} m³/h` : `${lpm.toFixed(1)} L/min`);

  return (
    <Card title="Virtual sump" action={
      <span className="text-sm text-ink-2 tabular-nums">simulated {fmtDuration(sim.simSeconds)}</span>
    }>
      <div className="space-y-3">
        <Segmented
          label="Site"
          value={p.id}
          options={sim.profiles.map((x) => ({ value: x.id, label: x.label }))}
          onChange={(id) => sim.setProfile(sim.profiles.find((x) => x.id === id)!)}
        />
        <p className="text-sm text-ink-2">
          {p.description}. Pump {flow(p.plant.pump_rated_flow_lpm)}, normal inflow {flow(p.baseInflowLpm)}
          {sumpM3 >= 1 ? `, sump ${sumpM3.toFixed(0)} m³` : ""}.
        </p>

        <label className="block">
          <span className="text-sm font-medium">Scenario</span>
          <select value={sim.scenario} onChange={(e) => sim.setScenario(e.target.value)}
            className="mt-1 block min-h-11 w-full rounded-lg border border-line bg-raised px-3 text-ink">
            {SCENARIOS.map((s) => <option key={s.name} value={s.name}>{s.label}</option>)}
          </select>
          <span className="mt-1 block text-sm text-ink-2">{scen.description}</span>
        </label>

        {sim.scenario === "custom" && (
          <label className="block">
            <span className="flex justify-between text-sm font-medium">
              <span>Inflow</span>
              <span className="tabular-nums">{flow(sim.inflow)}</span>
            </span>
            <input type="range" min={0} max={p.maxInflowLpm} step={p.maxInflowLpm / 200} value={sim.inflow}
              onChange={(e) => sim.setInflow(Number(e.target.value))} className="mt-2 w-full accent-[var(--series-1)]"
              aria-label="Inflow" />
            <span className="text-sm text-ink-2">
              The pump moves {flow(p.plant.pump_rated_flow_lpm)}. Push the inflow past that and watch the alarms.
            </span>
          </label>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Segmented<string>
            label="Speed"
            value={String(sim.speed)}
            options={SPEEDS.map((s) => ({ value: String(s), label: `${s}×` }))}
            onChange={(v) => sim.setSpeed(Number(v))}
          />
          <Button onClick={() => sim.setRunning(!sim.running)} aria-label={sim.running ? "Pause" : "Run"}>
            {sim.running ? <Pause className="size-4" /> : <Play className="size-4" />}
            {sim.running ? "Pause" : "Run"}
          </Button>
          <Button onClick={sim.restart}><RotateCcw className="size-4" /> Restart</Button>
        </div>
      </div>
    </Card>
  );
}
