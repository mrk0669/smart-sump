// Shapes of the MQTT messages (README section 3, "MQTT contract").

export type Mode = "AUTO" | "MANUAL";

export interface Telemetry {
  ts: number;
  sump_pct: number | null; // null = sensor fault
  sump_cm: number | null;
  tank_pct: number | null;
  pump_on: boolean;
  current_a: number;
  flow_lpm: number;
  turbidity_ntu?: number;
  rate_pct_per_min: number | null;
  tto_min: number | null; // time to overflow; null = not rising
  mode: Mode;
  state: string;
  alarms: string[];
  rssi?: number;
}

export interface SumpEvent {
  id?: number; // set when the event came from the logger's database
  ts: number;
  type: string;
  code: string | null;
  reason: string;
  severity?: string | null;
  acked_ts?: number | null;
}

export interface Setpoints {
  sump_start_pct: number;
  sump_stop_pct: number;
  tank_high_pct: number;
  tank_clear_band_pct: number;
  dry_run_current_a: number;
  dry_run_flow_lpm: number;
  dry_run_delay_s: number;
  dry_run_retry_min: number;
  min_off_time_s: number;
  min_on_time_s: number;
  overflow_warn_min: number;
  sensor_fault_s: number;
  tto_window_s: number;
}

export interface Device {
  key: string; // "site/device"
  site: string;
  device: string;
  status?: string; // "online" | "offline"
  telemetry?: Telemetry;
  lastMsgAt?: number; // when we last heard telemetry (browser clock, ms)
  config?: Setpoints;
  events: SumpEvent[]; // live events since the page opened, newest first
}
