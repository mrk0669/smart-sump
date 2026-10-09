import type { Setpoints } from "./types";

// Same limits as SETPOINT_LIMITS in simulator/control.py. The device checks
// them again (it never trusts the dashboard), but checking here gives the
// operator instant feedback.

export interface Field {
  key: keyof Setpoints;
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  help: string;
}

export const GROUPS: { title: string; fields: Field[] }[] = [
  {
    title: "Level set-points",
    fields: [
      { key: "sump_start_pct", label: "Start pump at", unit: "%", min: 10, max: 100, step: 1, help: "AUTO starts the pump at or above this sump level." },
      { key: "sump_stop_pct", label: "Stop pump at", unit: "%", min: 0, max: 90, step: 1, help: "AUTO stops the pump at or below this level. Keep it at least 20 % below the start level." },
      { key: "tank_high_pct", label: "Tank full at", unit: "%", min: 50, max: 100, step: 1, help: "Pump is locked off when the sedimentation tank reaches this level." },
      { key: "tank_clear_band_pct", label: "Tank must drop by", unit: "%", min: 2, max: 40, step: 1, help: "…below the tank-full level before the pump may run again." },
    ],
  },
  {
    title: "Dry-run protection",
    fields: [
      { key: "dry_run_current_a", label: "Low current below", unit: "A", min: 0, max: 500, step: 0.1, help: "Pump current below this means it is running dry. 0 switches the check off." },
      { key: "dry_run_flow_lpm", label: "Low flow below", unit: "L/min", min: 0, max: 50000, step: 1, help: "Delivery flow below this means dry or blocked. 0 switches the check off." },
      { key: "dry_run_delay_s", label: "For longer than", unit: "s", min: 2, max: 120, step: 1, help: "Rides through the first seconds after a start while the pipe fills." },
      { key: "dry_run_retry_min", label: "Auto-retry after", unit: "min", min: 0, max: 1440, step: 1, help: "0 means only an operator reset clears a dry-run trip." },
    ],
  },
  {
    title: "Motor protection",
    fields: [
      { key: "min_off_time_s", label: "Minimum off time", unit: "s", min: 0, max: 3600, step: 1, help: "Rest time between stops and starts, to protect the motor." },
      { key: "min_on_time_s", label: "Minimum run time", unit: "s", min: 0, max: 3600, step: 1, help: "Shortest normal run before an AUTO stop." },
    ],
  },
  {
    title: "Warnings",
    fields: [
      { key: "overflow_warn_min", label: "Overflow warning", unit: "min", min: 1, max: 600, step: 1, help: "Alarm when the predicted time to overflow is shorter than this." },
      { key: "sensor_fault_s", label: "Sensor fault after", unit: "s", min: 2, max: 300, step: 1, help: "No valid ultrasonic reading for this long switches to the float switches." },
      { key: "tto_window_s", label: "Trend window", unit: "s", min: 120, max: 300, step: 10, help: "How much recent level history the overflow prediction uses." },
    ],
  },
];

export const ALL_FIELDS = GROUPS.flatMap((g) => g.fields);
export const MIN_BAND_PCT = 20;

/** Returns an error message per field (empty object = all valid). */
export function validate(values: Record<string, string>): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const f of ALL_FIELDS) {
    const raw = values[f.key];
    const v = Number(raw);
    if (raw === "" || raw == null || !Number.isFinite(v)) errors[f.key] = "Enter a number";
    else if (v < f.min || v > f.max) errors[f.key] = `Must be ${f.min} to ${f.max}`;
  }
  const start = Number(values.sump_start_pct);
  const stop = Number(values.sump_stop_pct);
  if (!errors.sump_start_pct && !errors.sump_stop_pct && start - stop < MIN_BAND_PCT)
    errors.sump_start_pct = `Must be at least ${MIN_BAND_PCT} % above the stop level (${stop} %)`;
  return errors;
}
