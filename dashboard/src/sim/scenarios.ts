// Scenarios: TypeScript mirror of simulator/scenarios.py, plus "custom"
// (inflow set by a slider in the app).
//
// Times are written for the lab model. `timeScale` stretches them for bigger
// sumps (a mine storm lasts hours, not minutes); 1 = exactly the Python times.

export interface Conditions {
  inflow_lpm: number;
  suction_blocked: boolean;
  outlet_blocked: boolean;
  wifi_down: boolean;
  sump_sensor_dead: boolean;
}

export interface Scenario {
  name: string;
  label: string;
  description: string;
  initialSumpPct: number;
  initialTankPct: number;
  /** `storm` = peak inflow as a multiple of normal (heavy rain only; 12 in the Python sim). */
  conditions: (t: number, base: number, storm: number) => Conditions;
}

const cond = (inflow: number, extra: Partial<Conditions> = {}): Conditions => ({
  inflow_lpm: inflow, suction_blocked: false, outlet_blocked: false, wifi_down: false, sump_sensor_dead: false, ...extra,
});

const gentle = (t: number, base: number) => base * (1.0 + 0.15 * Math.sin(2 * Math.PI * t / 600.0));

function heavyRain(t: number, base: number, storm = 12.0): Conditions {
  const peak = storm * base;
  let q: number;
  if (t < 120) q = base;
  else if (t < 420) q = base + (peak - base) * (t - 120) / 300;
  else if (t < 1320) q = peak;
  else if (t < 1920) q = peak - (peak - base) * (t - 1320) / 600;
  else q = base;
  return cond(gentle(t, q));
}

export const SCENARIOS: Scenario[] = [
  { name: "normal", label: "Normal", description: "Steady seepage: the pump cycles between the start and stop levels.",
    initialSumpPct: 50, initialTankPct: 30, conditions: (t, b) => cond(gentle(t, b)) },
  { name: "heavy_rain", label: "Heavy rain", description: "A storm: inflow climbs far above normal, more than the pump can handle.",
    initialSumpPct: 60, initialTankPct: 30, conditions: heavyRain },
  { name: "dry_run", label: "Dry run", description: "The suction strainer is choked with mud for a while: the pump spins but moves no water.",
    initialSumpPct: 85, initialTankPct: 30, conditions: (t, b) => cond(gentle(t, b), { suction_blocked: t < 900 }) },
  { name: "tank_full", label: "Tank full", description: "The tank outlet to the filling point is closed for a while.",
    initialSumpPct: 75, initialTankPct: 70, conditions: (t, b) => cond(gentle(t, b), { outlet_blocked: t < 1200 }) },
  { name: "wifi_drop", label: "WiFi drop", description: "WiFi is lost just as the pump is due to start: control carries on, the dashboard catches up.",
    initialSumpPct: 79, initialTankPct: 30, conditions: (t, b) => cond(gentle(t, b), { wifi_down: 90 <= t && t < 150 }) },
  { name: "sensor_fault", label: "Sensor fault", description: "The sump ultrasonic fails for a while: the float switches take over.",
    initialSumpPct: 70, initialTankPct: 30, conditions: (t, b) => cond(gentle(t, b), { sump_sensor_dead: 180 <= t && t < 900 }) },
  { name: "custom", label: "Custom inflow", description: "You set the inflow with the slider.",
    initialSumpPct: 50, initialTankPct: 30, conditions: (_t, b) => cond(b) },
];

export const scenarioByName = (name: string) => SCENARIOS.find((s) => s.name === name) ?? SCENARIOS[0];
