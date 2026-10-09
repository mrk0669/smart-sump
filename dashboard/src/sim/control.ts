// Smart Sump control logic: TypeScript mirror of simulator/control.py.
//
// The Python file is the reference (it has the tests); this copy runs the
// same rules inside the phone app's virtual sump. Keep the two in step: same
// rules, same order, same numbers. tools/crosscheck.py runs both on every
// scenario and checks they produce the same events.

import type { Setpoints } from "../lib/types.ts";

export const Mode = { AUTO: "AUTO", MANUAL: "MANUAL" } as const;

export const State = {
  IDLE: "IDLE",
  PUMPING: "PUMPING",
  LOCKOUT_DRY: "LOCKOUT_DRY",
  LOCKOUT_TANK: "LOCKOUT_TANK",
  MANUAL: "MANUAL",
  FAULT_SENSOR: "FAULT_SENSOR",
} as const;

export const Alarm = {
  TANK_FULL: "TANK_FULL",
  SENSOR_FAULT: "SENSOR_FAULT",
  DRY_RUN: "DRY_RUN",
  OVERFLOW_RISK: "OVERFLOW_RISK",
  INFLOW_EXCEEDS_PUMP: "INFLOW_EXCEEDS_PUMP",
} as const;

export const ALARM_SEVERITY: Record<string, string> = {
  TANK_FULL: "critical",
  DRY_RUN: "critical",
  OVERFLOW_RISK: "critical",
  SENSOR_FAULT: "warning",
  INFLOW_EXCEEDS_PUMP: "warning",
};

export const EventType = {
  PUMP_START: "PUMP_START",
  PUMP_STOP: "PUMP_STOP",
  ALARM: "ALARM",
  ALARM_CLEAR: "ALARM_CLEAR",
  MODE_CHANGE: "MODE_CHANGE",
  STATE_CHANGE: "STATE_CHANGE",
  CONFIG_CHANGE: "CONFIG_CHANGE",
  CMD_REJECTED: "CMD_REJECTED",
} as const;

export const TREND_SAMPLE_S = 2.0;
export const MIN_TREND_SPAN_S = 60.0;
export const RISING_EPS_PCT_PER_MIN = 0.1;
export const OVERFLOW_CLEAR_FACTOR = 1.2;
export const OVERFLOWING_PCT = 98.0;
export const OVERFLOWING_CLEAR_PCT = 95.0;
export const MIN_BAND_PCT = 20.0;

export const DEFAULT_SETPOINTS: Setpoints = {
  sump_start_pct: 80,
  sump_stop_pct: 20,
  tank_high_pct: 90,
  tank_clear_band_pct: 10,
  dry_run_current_a: 1.0,
  dry_run_flow_lpm: 5,
  dry_run_delay_s: 10,
  dry_run_retry_min: 10,
  min_off_time_s: 120,
  min_on_time_s: 30,
  overflow_warn_min: 30,
  sensor_fault_s: 10,
  tto_window_s: 180,
};

export const SETPOINT_LIMITS: Record<keyof Setpoints, [number, number]> = {
  sump_start_pct: [10, 100],
  sump_stop_pct: [0, 90],
  tank_high_pct: [50, 100],
  tank_clear_band_pct: [2, 40],
  dry_run_current_a: [0, 500],
  dry_run_flow_lpm: [0, 50000],
  dry_run_delay_s: [2, 120],
  dry_run_retry_min: [0, 1440],
  min_off_time_s: [0, 3600],
  min_on_time_s: [0, 3600],
  overflow_warn_min: [1, 600],
  sensor_fault_s: [2, 300],
  tto_window_s: [120, 300],
};

/** Python's "{:g}" for the numbers we print (80.0 -> "80", 1.8 -> "1.8"). */
export const g = (x: number) => String(Number(x.toPrecision(6)));

export function validateSetpoints(current: Setpoints, patch: unknown): [Setpoints | null, string[]] {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch) || Object.keys(patch).length === 0)
    return [null, ["expected a JSON object with at least one set-point"]];
  const errors: string[] = [];
  const merged: Setpoints = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in SETPOINT_LIMITS)) {
      errors.push(`unknown set-point '${key}'`);
      continue;
    }
    if (typeof value !== "number") {
      errors.push(`${key} must be a number`);
      continue;
    }
    const [lo, hi] = SETPOINT_LIMITS[key as keyof Setpoints];
    if (!(lo <= value && value <= hi)) {
      errors.push(`${key}=${value} is outside ${g(lo)}..${g(hi)}`);
      continue;
    }
    merged[key as keyof Setpoints] = value;
  }
  if (merged.sump_start_pct - merged.sump_stop_pct < MIN_BAND_PCT)
    errors.push(`sump_start_pct (${g(merged.sump_start_pct)}) must be at least ${g(MIN_BAND_PCT)} above sump_stop_pct (${g(merged.sump_stop_pct)})`);
  return errors.length ? [null, errors] : [merged, []];
}

/** Python's statistics.median (mean of the middle two for an even count). */
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

export function filterDistance(readings: (number | null)[], minCm: number, maxCm: number,
                               agreeCm = 2.0, minValid = 3): number | null {
  const valid = readings.filter((r): r is number => r !== null && minCm <= r && r <= maxCm);
  if (valid.length < minValid) return null;
  const m = median(valid);
  const close = valid.filter((r) => Math.abs(r - m) <= agreeCm);
  if (close.length < minValid) return null;
  return median(close);
}

export function distanceToPct(distanceCm: number, depthCm: number, offsetCm: number): number {
  const pct = (depthCm - (distanceCm - offsetCm)) / depthCm * 100.0;
  return Math.max(0.0, Math.min(100.0, pct));
}

export interface Inputs {
  sump_pct: number | null;
  tank_pct: number | null;
  sump_high_float: boolean;
  sump_low_float: boolean;
  tank_high_float: boolean;
  current_a: number;
  flow_lpm: number;
}

export interface CtrlEvent {
  ts: number;
  type: string;
  code: string | null;
  reason: string;
  severity?: string;
}

function slopePctPerMin(points: [number, number][]): number | null {
  const n = points.length;
  if (n < 2) return null;
  const t0 = points[0][0];
  let st = 0, sy = 0;
  for (const [t, y] of points) { st += t - t0; sy += y; }
  const meanT = st / n, meanY = sy / n;
  let num = 0, den = 0;
  for (const [t, y] of points) num += (t - t0 - meanT) * (y - meanY);
  for (const [t] of points) den += (t - t0 - meanT) ** 2;
  if (den === 0) return null;
  return num / den * 60.0;
}

type Decision = [boolean, string, string];

export class Controller {
  sp: Setpoints;
  mode: string = Mode.AUTO;
  state: string = State.IDLE;
  pumpOn = false;
  lastPumpChange: number;
  manualRequest = false;
  alarms = new Map<string, string>();
  sumpPct: number | null = null;
  tankPct: number | null = null;
  lastValidSump: number;
  lastValidTank: number;
  sumpFault = false;
  tankFault = false;
  drySince: number | null = null;
  dryTripTime: number | null = null;
  trend: [number, number][] = [];
  lastTrendSample: number | null = null;
  ratePctPerMin: number | null = null;
  ttoMin: number | null = null;
  private events: CtrlEvent[] = [];

  constructor(setpoints: Setpoints = DEFAULT_SETPOINTS, now = 0) {
    this.sp = { ...setpoints };
    this.lastPumpChange = now;   // boot counts as "pump just stopped"
    this.lastValidSump = now;
    this.lastValidTank = now;
  }

  step(now: number, inp: Inputs): CtrlEvent[] {
    this.readLevels(now, inp);
    this.updateTrend(now, inp);
    const [wantOn, newState, reason] = this.decide(now, inp);
    this.switchPump(now, wantOn, reason);
    if (newState !== this.state) {
      this.emit(now, EventType.STATE_CHANGE, newState, `${this.state} -> ${newState}: ${reason}`);
      this.state = newState;
    }
    return this.drainEvents();
  }

  private readLevels(now: number, inp: Inputs) {
    if (inp.sump_pct !== null) { this.sumpPct = inp.sump_pct; this.lastValidSump = now; }
    if (inp.tank_pct !== null) { this.tankPct = inp.tank_pct; this.lastValidTank = now; }
    this.sumpFault = now - this.lastValidSump >= this.sp.sensor_fault_s;
    this.tankFault = now - this.lastValidTank >= this.sp.sensor_fault_s;
    if (this.sumpFault || this.tankFault) {
      const which = ([["sump", this.sumpFault], ["tank", this.tankFault]] as const)
        .filter(([, bad]) => bad).map(([n]) => n).join(" and ");
      this.raise(now, Alarm.SENSOR_FAULT,
        `${which} ultrasonic: no valid reading for ${g(this.sp.sensor_fault_s)} s, using float switches`);
    } else {
      this.clear(now, Alarm.SENSOR_FAULT, "ultrasonic readings valid again");
    }
  }

  private updateTrend(now: number, inp: Inputs) {
    const sp = this.sp;
    if (this.sumpFault) {
      this.trend = [];
      this.lastTrendSample = null;
      this.ratePctPerMin = null;
      this.ttoMin = null;
      return;
    }
    const fresh = inp.sump_pct !== null;
    if (fresh && (this.lastTrendSample === null || now - this.lastTrendSample >= TREND_SAMPLE_S)) {
      this.trend.push([now, inp.sump_pct as number]);
      this.lastTrendSample = now;
    }
    while (this.trend.length && now - this.trend[0][0] > sp.tto_window_s) this.trend.shift();

    const span = this.trend.length ? this.trend[this.trend.length - 1][0] - this.trend[0][0] : 0;
    this.ratePctPerMin = span >= MIN_TREND_SPAN_S ? slopePctPerMin(this.trend) : null;
    const rate = this.ratePctPerMin;

    const level = this.sumpPct;
    const overflowing = level !== null && level >= OVERFLOWING_PCT;
    if (overflowing) this.ttoMin = 0.0;
    else if (rate !== null && rate > RISING_EPS_PCT_PER_MIN && level !== null) this.ttoMin = (100.0 - level) / rate;
    else this.ttoMin = null;

    const headingOver = this.ttoMin !== null && this.ttoMin < sp.overflow_warn_min;
    if (overflowing) {
      this.raise(now, Alarm.OVERFLOW_RISK, `sump at ${(level as number).toFixed(1)}%: overflowing`);
    } else if (headingOver && rate !== null) {
      this.raise(now, Alarm.OVERFLOW_RISK,
        `sump ${(level as number).toFixed(1)}% rising ${rate.toFixed(2)} %/min: ` +
        `overflow in ${(this.ttoMin as number).toFixed(1)} min (< ${g(sp.overflow_warn_min)})`);
    } else if (rate !== null && (level as number) < OVERFLOWING_CLEAR_PCT &&
               (this.ttoMin === null || this.ttoMin >= sp.overflow_warn_min * OVERFLOW_CLEAR_FACTOR)) {
      this.clear(now, Alarm.OVERFLOW_RISK, "level no longer heading for overflow");
    }

    if (this.pumpOn && rate !== null && (rate > RISING_EPS_PCT_PER_MIN || overflowing)) {
      const why = overflowing ? "sump overflowing" : `level still rising ${rate.toFixed(2)} %/min`;
      this.raise(now, Alarm.INFLOW_EXCEEDS_PUMP, `${why} with the pump ON`);
    } else if (!this.pumpOn) {
      this.clear(now, Alarm.INFLOW_EXCEEDS_PUMP, "pump stopped");
    } else if (rate !== null && rate < -RISING_EPS_PCT_PER_MIN && (level as number) < OVERFLOWING_CLEAR_PCT) {
      this.clear(now, Alarm.INFLOW_EXCEEDS_PUMP, "level now falling");
    }
  }

  private decide(now: number, inp: Inputs): Decision {
    const sp = this.sp;

    // Rule 1: TANK FULL (interlock).
    const tankByLevel = !this.tankFault && this.tankPct !== null && this.tankPct >= sp.tank_high_pct;
    if (tankByLevel || inp.tank_high_float) {
      const why = inp.tank_high_float ? "tank HIGH float tripped"
        : `tank ${(this.tankPct as number).toFixed(1)}% >= ${g(sp.tank_high_pct)}%`;
      this.raise(now, Alarm.TANK_FULL, why);
    } else if (this.alarms.has(Alarm.TANK_FULL)) {
      const clearAt = sp.tank_high_pct - sp.tank_clear_band_pct;
      if (this.tankFault || this.tankPct === null)
        this.clear(now, Alarm.TANK_FULL, "tank HIGH float reset (tank ultrasonic unavailable)");
      else if (this.tankPct <= clearAt)
        this.clear(now, Alarm.TANK_FULL, `tank ${this.tankPct.toFixed(1)}% <= ${g(clearAt)}%`);
    }
    if (this.alarms.has(Alarm.TANK_FULL)) {
      this.manualRequest = false;
      return [false, State.LOCKOUT_TANK, "TANK_FULL interlock"];
    }

    // Rule 3: DRY RUN / BLOCKAGE (interlock).
    if (this.alarms.has(Alarm.DRY_RUN)) {
      const retryS = sp.dry_run_retry_min * 60.0;
      if (retryS > 0 && now - (this.dryTripTime as number) >= retryS) {
        this.clear(now, Alarm.DRY_RUN, `auto-retry after ${g(sp.dry_run_retry_min)} min`);
        this.dryTripTime = null;
      } else {
        return [false, State.LOCKOUT_DRY, "DRY_RUN interlock"];
      }
    }
    if (this.pumpOn) {
      const lowCurrent = inp.current_a < sp.dry_run_current_a;
      const lowFlow = inp.flow_lpm < sp.dry_run_flow_lpm;
      if (lowCurrent || lowFlow) {
        if (this.drySince === null) {
          this.drySince = now;
        } else if (now - this.drySince > sp.dry_run_delay_s) {
          const why = lowCurrent
            ? `current ${inp.current_a.toFixed(1)}A < ${g(sp.dry_run_current_a)}A for ${g(sp.dry_run_delay_s)}s`
            : `flow ${inp.flow_lpm.toFixed(1)} L/min < ${g(sp.dry_run_flow_lpm)} L/min for ${g(sp.dry_run_delay_s)}s`;
          this.raise(now, Alarm.DRY_RUN, why);
          this.dryTripTime = now;
          this.drySince = null;
          this.manualRequest = false;
          return [false, State.LOCKOUT_DRY, "DRY_RUN interlock: " + why];
        }
      } else {
        this.drySince = null;
      }
    }

    // Rule 7: MANUAL.
    if (this.mode === Mode.MANUAL)
      return [this.manualRequest, State.MANUAL, "operator " + (this.manualRequest ? "start" : "stop")];

    // Rule 2: SENSOR FAULT -> floats only.
    if (this.sumpFault) {
      if (inp.sump_low_float) return [false, State.FAULT_SENSOR, "sump LOW float tripped (ultrasonic fault)"];
      if (inp.sump_high_float) return [true, State.FAULT_SENSOR, "sump HIGH float tripped (ultrasonic fault)"];
      return [this.pumpOn, State.FAULT_SENSOR, "ultrasonic fault: holding, floats only"];
    }

    // Rule 6: BACKUP FLOATS.
    if (inp.sump_low_float) return [false, State.IDLE, "sump LOW float tripped"];
    if (inp.sump_high_float) return [true, State.PUMPING, "sump HIGH float tripped"];

    const level = this.sumpPct;
    if (level === null) return [this.pumpOn, this.runState(), "waiting for the first level reading"];

    const elapsed = now - this.lastPumpChange;
    // Rule 4: START.
    if (!this.pumpOn && level >= sp.sump_start_pct && elapsed >= sp.min_off_time_s)
      return [true, State.PUMPING, `sump ${level.toFixed(1)}% >= start ${g(sp.sump_start_pct)}%`];
    // Rule 5: STOP.
    if (this.pumpOn && level <= sp.sump_stop_pct && elapsed >= sp.min_on_time_s)
      return [false, State.IDLE, `sump ${level.toFixed(1)}% <= stop ${g(sp.sump_stop_pct)}%`];
    return [this.pumpOn, this.runState(), "holding"];
  }

  private runState() {
    return this.pumpOn ? State.PUMPING : State.IDLE;
  }

  private switchPump(now: number, wantOn: boolean, reason: string) {
    if (wantOn === this.pumpOn) return;
    this.pumpOn = wantOn;
    this.lastPumpChange = now;
    this.drySince = null;
    this.trend = [];
    this.lastTrendSample = null;
    this.emit(now, wantOn ? EventType.PUMP_START : EventType.PUMP_STOP, null, reason);
  }

  // ---- dashboard commands ----

  setMode(mode: string, now: number): [boolean, string] {
    if (mode !== Mode.AUTO && mode !== Mode.MANUAL) return this.reject(now, "mode", `unknown mode '${mode}'`);
    if (mode === this.mode) return [true, `already in ${mode}`];
    if (mode === Mode.MANUAL) this.manualRequest = this.pumpOn;   // bumpless transfer
    const old = this.mode;
    this.mode = mode;
    this.emit(now, EventType.MODE_CHANGE, mode, `${old} -> ${mode}`);
    return [true, `mode set to ${mode}`];
  }

  pumpCommand(action: string, now: number): [boolean, string] {
    if (action !== "start" && action !== "stop") return this.reject(now, "pump", `unknown action '${action}'`);
    if (this.mode !== Mode.MANUAL) return this.reject(now, "pump", "pump start/stop is only obeyed in MANUAL mode");
    if (action === "start") {
      if (this.alarms.has(Alarm.TANK_FULL)) return this.reject(now, "pump", "TANK_FULL interlock is active: cannot start");
      if (this.alarms.has(Alarm.DRY_RUN)) return this.reject(now, "pump", "DRY_RUN lockout: reset the alarm first");
    }
    this.manualRequest = action === "start";
    return [true, `manual ${action} accepted`];
  }

  resetAlarm(code: string, now: number): [boolean, string] {
    if (code !== Alarm.DRY_RUN)
      return this.reject(now, "reset", `${code} cannot be reset by hand: it clears itself when the condition goes away`);
    if (!this.alarms.has(Alarm.DRY_RUN)) return this.reject(now, "reset", "DRY_RUN is not active");
    this.clear(now, Alarm.DRY_RUN, "operator reset");
    this.dryTripTime = null;
    return [true, "DRY_RUN reset"];
  }

  updateSetpoints(patch: unknown, now: number): [boolean, string[]] {
    const [next, errors] = validateSetpoints(this.sp, patch);
    if (!next) {
      this.reject(now, "config", errors.join("; "));
      return [false, errors];
    }
    const old = this.sp;
    const changes = (Object.keys(next) as (keyof Setpoints)[])
      .filter((k) => next[k] !== old[k]).map((k) => `${k} ${g(old[k])} -> ${g(next[k])}`);
    this.sp = next;
    if (changes.length) this.emit(now, EventType.CONFIG_CHANGE, null, changes.join(", "));
    return [true, []];
  }

  // ---- outputs ----

  snapshot() {
    const r = (x: number | null, nd = 1) => (x === null ? null : Math.round(x * 10 ** nd) / 10 ** nd);
    return {
      sump_pct: this.sumpFault ? null : r(this.sumpPct),
      tank_pct: this.tankFault ? null : r(this.tankPct),
      pump_on: this.pumpOn,
      rate_pct_per_min: r(this.ratePctPerMin, 2),
      tto_min: r(this.ttoMin),
      mode: this.mode as "AUTO" | "MANUAL",
      state: this.state,
      alarms: [...this.alarms.keys()].sort(),
    };
  }

  drainEvents(): CtrlEvent[] {
    const ev = this.events;
    this.events = [];
    return ev;
  }

  private emit(now: number, type: string, code: string | null, reason: string) {
    const ev: CtrlEvent = { ts: now, type, code, reason };
    if (type === EventType.ALARM || type === EventType.ALARM_CLEAR) ev.severity = ALARM_SEVERITY[code as string];
    this.events.push(ev);
  }

  private raise(now: number, code: string, reason: string) {
    if (!this.alarms.has(code)) {
      this.alarms.set(code, reason);
      this.emit(now, EventType.ALARM, code, reason);
    }
  }

  private clear(now: number, code: string, reason: string) {
    if (this.alarms.delete(code)) this.emit(now, EventType.ALARM_CLEAR, code, reason);
  }

  private reject(now: number, what: string, reason: string): [boolean, string] {
    this.emit(now, EventType.CMD_REJECTED, what.toUpperCase(), reason);
    return [false, reason];
  }
}
