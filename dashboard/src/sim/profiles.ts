// Site profiles for the virtual sump, and the sump calculator that turns a
// few field numbers into a full profile ("Simulate this sump").

import type { Profile } from "./virtual.ts";

/** The lab model: same numbers as config/site.yaml. */
export const LAB: Profile = {
  id: "lab",
  label: "Lab model",
  description: "80 L sump, 100 L tank, 0.5 HP pump (30 L/min)",
  plant: {
    sump_depth_cm: 50, tank_depth_cm: 50, sump_area_m2: 0.16, tank_area_m2: 0.2,
    sensor_offset_cm: 25, tank_sensor_offset_cm: 25,
    pump_rated_flow_lpm: 30, pump_run_current_a: 2.8, pump_dry_current_a: 1.3, pump_intake_pct: 5,
    tank_outlet_lpm_at_full: 40, tank_outlet_pct: 25,
    sump_high_float_pct: 95, sump_low_float_pct: 10, tank_high_float_pct: 95,
    sensor_noise_cm: 0.3, sensor_dropout_prob: 0.02, sensor_glitch_prob: 0.03,
    ultrasonic_min_cm: 20, ultrasonic_max_cm: 450,
  },
  setpoints: {
    sump_start_pct: 80, sump_stop_pct: 20, tank_high_pct: 90, tank_clear_band_pct: 10,
    dry_run_current_a: 1.8, dry_run_flow_lpm: 5, dry_run_delay_s: 10, dry_run_retry_min: 10,
    min_off_time_s: 120, min_on_time_s: 30, overflow_warn_min: 3, sensor_fault_s: 10, tto_window_s: 180,
  },
  baseInflowLpm: 3,
  maxInflowLpm: 60,
  timeScale: 1,
  defaultSpeed: 10,
  energy: { voltage_v: 230, phases: 1, power_factor: 0.8, tariff_rs_per_kwh: 8 },
};

export interface CalcInput {
  length_m: number;
  width_m: number;
  depth_m: number;
  pump_gpm: number;          // US gallons per minute
  motor_kw: number;
  normal_inflow_m3h: number;
  storm_inflow_m3h: number;
  start_pct: number;
  stop_pct: number;
  tariff_rs_per_kwh: number;
}

/** The project's target: an opencast sump with a 2500 GPM (~570 m³/h) pump.
 *  4800 m³ holds 2.2 h of the 2160 m³/h storm, inside the DGMS 2-3 h guideline. */
export const MINE_INPUT: CalcInput = {
  length_m: 40, width_m: 30, depth_m: 4,
  pump_gpm: 2500, motor_kw: 133,
  normal_inflow_m3h: 180, storm_inflow_m3h: 2160,
  start_pct: 80, stop_pct: 20,
  tariff_rs_per_kwh: 8,
};

const L_PER_US_GAL = 3.78541;
const VOLTS = 415, PF = 0.85, EFF = 0.9;   // typical mine LT motor
const LAB_FILL_MIN = 16;                    // lab: stop -> start at normal inflow

export interface CalcResult {
  volume_m3: number;
  working_m3: number;
  pump_m3h: number;
  fill_h: number;                 // stop -> start at normal inflow
  pumpdown_h: number | null;      // start -> stop (null: pump smaller than inflow)
  cycle_h: number | null;
  starts_per_h: number | null;
  duty_pct: number | null;
  pump_h_per_day: number | null;
  input_kw: number;
  kwh_per_day: number | null;
  rs_per_day: number | null;
  storage_h_at_storm: number;     // DGMS: hold 2-3 h of peak inflow
  storm_overflow_h: number | null; // start level -> overflow in the storm (null: pump copes)
  pump_for_storm_gpm: number;
  run_current_a: number;
}

export function calculate(c: CalcInput): CalcResult {
  const volume = c.length_m * c.width_m * c.depth_m;
  const working = volume * (c.start_pct - c.stop_pct) / 100;
  const pump = c.pump_gpm * L_PER_US_GAL * 60 / 1000;
  const fill = working / c.normal_inflow_m3h;
  const net = pump - c.normal_inflow_m3h;
  const pumpdown = net > 0 ? working / net : null;
  const cycle = pumpdown === null ? null : fill + pumpdown;
  const inputKw = c.motor_kw / EFF;
  const duty = cycle === null ? null : (pumpdown as number) / cycle;
  const pumpHours = duty === null ? null : 24 * duty;
  const stormNet = c.storm_inflow_m3h - pump;
  return {
    volume_m3: volume,
    working_m3: working,
    pump_m3h: pump,
    fill_h: fill,
    pumpdown_h: pumpdown,
    cycle_h: cycle,
    starts_per_h: cycle === null ? null : 1 / cycle,
    duty_pct: duty === null ? null : duty * 100,
    pump_h_per_day: pumpHours,
    input_kw: inputKw,
    kwh_per_day: pumpHours === null ? null : pumpHours * inputKw,
    rs_per_day: pumpHours === null ? null : pumpHours * inputKw * c.tariff_rs_per_kwh,
    storage_h_at_storm: volume / c.storm_inflow_m3h,
    storm_overflow_h: stormNet > 0 ? volume * (100 - c.start_pct) / 100 / stormNet : null,
    pump_for_storm_gpm: c.storm_inflow_m3h * 1000 / 60 / L_PER_US_GAL,
    run_current_a: inputKw * 1000 / (Math.sqrt(3) * VOLTS * PF),
  };
}

/** Turn calculator numbers into a virtual sump the simulator can run. */
export function profileFromCalc(c: CalcInput, label = "My sump"): Profile {
  const r = calculate(c);
  const pumpLpm = r.pump_m3h * 1000 / 60;
  const baseLpm = c.normal_inflow_m3h * 1000 / 60;
  const depthCm = c.depth_m * 100;
  const tankDepthCm = 300;
  const tankAreaM2 = r.pump_m3h / (tankDepthCm / 100);     // tank holds ~1 h of pumping
  const fillMin = r.fill_h * 60;
  const startToFullMin = (c.length_m * c.width_m * c.depth_m * (100 - c.start_pct) / 100) / c.normal_inflow_m3h * 60;
  const timeScale = Math.min(60, Math.max(1, fillMin / LAB_FILL_MIN));
  const big = r.pump_m3h > 100;
  return {
    id: "custom",
    label,
    description: `${c.length_m}×${c.width_m}×${c.depth_m} m sump, ${c.pump_gpm} GPM pump`,
    plant: {
      sump_depth_cm: depthCm, tank_depth_cm: tankDepthCm, sump_area_m2: c.length_m * c.width_m, tank_area_m2: tankAreaM2,
      sensor_offset_cm: 50, tank_sensor_offset_cm: 50,
      pump_rated_flow_lpm: pumpLpm, pump_run_current_a: r.run_current_a, pump_dry_current_a: 0.45 * r.run_current_a,
      pump_intake_pct: 5, tank_outlet_lpm_at_full: 1.3 * pumpLpm, tank_outlet_pct: 25,
      sump_high_float_pct: 95, sump_low_float_pct: Math.max(6, c.stop_pct - 10), tank_high_float_pct: 95,
      sensor_noise_cm: Math.max(0.3, depthCm / 400), sensor_dropout_prob: 0.02, sensor_glitch_prob: 0.03,
      ultrasonic_min_cm: 30, ultrasonic_max_cm: depthCm + 150,
    },
    setpoints: {
      sump_start_pct: c.start_pct, sump_stop_pct: c.stop_pct, tank_high_pct: 90, tank_clear_band_pct: 10,
      dry_run_current_a: Math.round(0.65 * r.run_current_a), dry_run_flow_lpm: Math.round(0.1 * pumpLpm),
      dry_run_delay_s: big ? 15 : 10, dry_run_retry_min: big ? 30 : 10,
      min_off_time_s: big ? 300 : 120, min_on_time_s: big ? 120 : 30,
      // Warn early, but not during a normal fill (see site.yaml's rule of thumb).
      overflow_warn_min: Math.round(Math.min(30, Math.max(3, startToFullMin / 2))),
      sensor_fault_s: 10, tto_window_s: big ? 300 : 180,
    },
    baseInflowLpm: baseLpm,
    maxInflowLpm: Math.max(c.storm_inflow_m3h, 2 * r.pump_m3h) * 1000 / 60,
    timeScale,
    stormFactor: c.storm_inflow_m3h / c.normal_inflow_m3h,
    defaultSpeed: timeScale <= 2 ? 10 : timeScale <= 20 ? 60 : 300,
    energy: { voltage_v: VOLTS, phases: 3, power_factor: PF, tariff_rs_per_kwh: c.tariff_rs_per_kwh },
  };
}

export const MINE: Profile = {
  ...profileFromCalc(MINE_INPUT, "Mine (2500 GPM)"),
  id: "mine",
  description: "40 × 30 × 4 m sump (4800 m³), 2500 GPM pump, 133 kW motor",
};

export const PROFILES = [LAB, MINE];
