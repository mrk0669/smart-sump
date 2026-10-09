// The virtual sump: the whole Smart Sump system running inside the app.
//
//   simulated pit (physics.ts) -> "ESP32" control loop (control.ts)
//   -> what the dashboard would receive over MQTT (telemetry, events, status)
//   -> what the logger would store (history, event log, daily report)
//
// Nothing here touches React or the network, so it also runs in Node for
// tools/crosscheck.py, which checks it against the Python simulator.

import type { Setpoints, SumpEvent, Telemetry } from "../lib/types.ts";
import { Controller, distanceToPct, EventType, filterDistance } from "./control.ts";
import type { CtrlEvent, Inputs } from "./control.ts";
import { makeRng, Plant } from "./physics.ts";
import type { PlantParams } from "./physics.ts";
import { scenarioByName } from "./scenarios.ts";
import type { Conditions, Scenario } from "./scenarios.ts";

export interface Energy {
  voltage_v: number;
  phases: number;
  power_factor: number;
  tariff_rs_per_kwh: number;
}

export interface Profile {
  id: string;
  label: string;
  description: string;
  plant: PlantParams;
  setpoints: Setpoints;
  baseInflowLpm: number;   // normal seepage
  maxInflowLpm: number;    // top of the custom-inflow slider
  timeScale: number;       // stretches scenario timings (1 = lab)
  stormFactor?: number;    // heavy-rain peak inflow / normal inflow (default 12)
  defaultSpeed: number;
  energy: Energy;
}

export interface DayStats {
  date: string;
  pump_s: number;
  volume_l: number;
  energy_wh: number;
  cycles: number;
  alarms: Record<string, number>;
}

const DT = 0.5;              // control cycle (s)
const PUBLISH_EVERY = 2.0;   // telemetry interval (s)
const OFFLINE_AFTER_S = 22.5; // broker notices a silent device after ~1.5 x keepalive
const MAX_HISTORY = 120_000; // telemetry points kept (~2.8 simulated days at 2 s)
const MAX_LOG = 3_000;       // logged events kept
const MAX_QUEUE = 100;       // events buffered while WiFi is down (same as the firmware)

const dateKey = (ts: number) => {
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export class VirtualDevice {
  readonly profile: Profile;
  readonly scenario: Scenario;
  readonly epoch0: number;    // virtual clock starts at "now"
  t = 0;                      // simulated seconds since start
  plant: Plant;
  ctrl: Controller;
  inflowOverride: number | null = null;   // custom scenario
  last: Conditions;

  // What the dashboard sees (as if over MQTT)
  telemetry: Telemetry | null = null;
  status: "online" | "offline" = "online";
  delivered: SumpEvent[] = [];            // new since the UI last took them
  configVersion = 0;

  // What the logger stores
  history: Telemetry[] = [];
  log: SumpEvent[] = [];
  days = new Map<string, DayStats>();

  /** Every event the controller produces, before any WiFi delay (for tests). */
  onRawEvent?: (simT: number, ev: CtrlEvent) => void;

  private wifiUp = true;
  private wifiDownSince = 0;
  private queue: SumpEvent[] = [];
  private lastPublish = -1e9;
  private nextId = 1;
  private pending: { cmd: string; payload: unknown }[] = [];

  constructor(profile: Profile, scenarioName: string, opts: { seed?: number; epoch0?: number } = {}) {
    this.profile = profile;
    this.scenario = scenarioByName(scenarioName);
    this.epoch0 = opts.epoch0 ?? Math.floor(Date.now() / 1000);
    this.plant = new Plant(profile.plant, this.scenario.initialSumpPct, this.scenario.initialTankPct, makeRng(opts.seed));
    this.ctrl = new Controller(profile.setpoints, this.now);
    this.last = this.conditions();
    this.logStatus("online");
  }

  get now() {
    return this.epoch0 + this.t;
  }

  private conditions(): Conditions {
    const base = this.inflowOverride ?? this.profile.baseInflowLpm;
    return this.scenario.conditions(this.t / this.profile.timeScale, base, this.profile.stormFactor ?? 12);
  }

  /** Queue a dashboard command; applied at the start of the next cycle,
   *  exactly like the real device. */
  command(cmd: string, payload: unknown) {
    this.pending.push({ cmd, payload });
  }

  /** Run `seconds` of simulated time. */
  advance(seconds: number) {
    const n = Math.max(1, Math.round(seconds / DT));
    for (let i = 0; i < n; i++) this.tick();
  }

  tick() {
    this.applyCommands();
    this.t += DT;
    const c = this.conditions();
    this.last = c;
    const p = this.plant;
    p.advance(DT, this.ctrl.pumpOn, c.inflow_lpm, c.suction_blocked, c.outlet_blocked);
    const events = this.ctrl.step(this.now, this.readInputs(c));
    this.accumulate(events);
    for (const ev of events) {
      this.onRawEvent?.(this.t, ev);
      this.send({ ...ev, ts: Math.floor(ev.ts) });
    }
    this.simulateWifi(c.wifi_down);
    if (this.t - this.lastPublish >= PUBLISH_EVERY - 1e-9) {
      this.lastPublish = this.t;
      if (this.wifiUp) this.publishTelemetry();
    }
  }

  readInputs(c: Conditions): Inputs {
    const p = this.plant.p;
    const limits = [p.ultrasonic_min_cm, p.ultrasonic_max_cm, 2.0] as const;
    const sumpCm = filterDistance(this.plant.ultrasonicBurst("sump", 5, c.sump_sensor_dead), ...limits);
    const tankCm = filterDistance(this.plant.ultrasonicBurst("tank"), ...limits);
    const [hi, lo, tankHi] = this.plant.floats();
    return {
      sump_pct: sumpCm === null ? null : distanceToPct(sumpCm, p.sump_depth_cm, p.sensor_offset_cm),
      tank_pct: tankCm === null ? null : distanceToPct(tankCm, p.tank_depth_cm, p.tank_sensor_offset_cm),
      sump_high_float: hi,
      sump_low_float: lo,
      tank_high_float: tankHi,
      current_a: this.plant.currentReading(),
      flow_lpm: this.plant.flowReading(),
    };
  }

  // -- delivery (WiFi) --

  private send(ev: SumpEvent) {
    if (this.wifiUp) this.deliver(ev);
    else {
      this.queue.push(ev);
      if (this.queue.length > MAX_QUEUE) this.queue.shift();
    }
  }

  private deliver(ev: SumpEvent) {
    const logged = { ...ev, id: this.nextId++, acked_ts: null };
    this.log.unshift(logged);
    if (this.log.length > MAX_LOG) this.log.pop();
    this.delivered.push(logged);
  }

  private simulateWifi(down: boolean) {
    if (down && this.wifiUp) {
      this.wifiUp = false;
      this.wifiDownSince = this.t;
    } else if (down && this.status === "online" && this.t - this.wifiDownSince >= OFFLINE_AFTER_S) {
      this.status = "offline";   // the broker's Last Will
      this.logStatus("offline");
    } else if (!down && !this.wifiUp) {
      this.wifiUp = true;
      if (this.status === "offline") {
        this.status = "online";
        this.logStatus("online");
      }
      for (const ev of this.queue.splice(0)) this.deliver(ev);
      this.publishTelemetry();
    }
  }

  private logStatus(status: string) {
    this.deliver({ ts: Math.floor(this.now), type: "STATUS", code: status.toUpperCase(), reason: `device ${status}`,
      severity: status === "offline" ? "warning" : null });
  }

  private publishTelemetry() {
    const p = this.plant;
    const snap = this.ctrl.snapshot();
    const depth = p.p.sump_depth_cm;
    const tm: Telemetry = {
      ts: Math.floor(this.now),
      ...snap,
      sump_cm: snap.sump_pct === null ? null : Math.round(snap.sump_pct * depth / 10) / 10,
      current_a: Math.round(p.currentReading() * 100) / 100,
      flow_lpm: Math.round(p.flowReading() * 10) / 10,
      turbidity_ntu: Math.round(p.turbidityReading(this.last.inflow_lpm)),
      rssi: -61,
    };
    this.telemetry = tm;
    this.history.push(tm);
    if (this.history.length > MAX_HISTORY) this.history.splice(0, this.history.length - MAX_HISTORY);
  }

  // -- commands --

  private applyCommands() {
    for (const { cmd, payload } of this.pending.splice(0)) {
      const now = this.now;
      const body = (payload ?? {}) as Record<string, unknown>;
      if (cmd === "mode") this.ctrl.setMode(String(body.mode), now);
      else if (cmd === "pump") this.ctrl.pumpCommand(String(body.action), now);
      else if (cmd === "reset") this.ctrl.resetAlarm(String(body.alarm), now);
      else if (cmd === "config") {
        this.ctrl.updateSetpoints(body, now);
        this.configVersion++;
      }
      // Events from commands go out with the next step(), as on the device.
    }
  }

  // -- the logger's daily figures, added up as we go --

  private accumulate(events: CtrlEvent[]) {
    const day = this.day(this.now);
    const p = this.plant;
    if (this.ctrl.pumpOn) {
      const e = this.profile.energy;
      const k = e.phases === 3 ? Math.sqrt(3) : 1;
      day.pump_s += DT;
      day.volume_l += p.flowLpm * DT / 60;
      day.energy_wh += k * e.voltage_v * p.currentA * e.power_factor * DT / 3600;
    }
    for (const ev of events) {
      if (ev.type === EventType.PUMP_START) day.cycles++;
      if (ev.type === EventType.ALARM && ev.code) day.alarms[ev.code] = (day.alarms[ev.code] ?? 0) + 1;
    }
  }

  private day(ts: number): DayStats {
    const key = dateKey(ts);
    let d = this.days.get(key);
    if (!d) {
      d = { date: key, pump_s: 0, volume_l: 0, energy_wh: 0, cycles: 0, alarms: {} };
      this.days.set(key, d);
    }
    return d;
  }

  takeDelivered(): SumpEvent[] {
    return this.delivered.splice(0);
  }
}

// ---------------------------------------------------------------------------
// The logger's REST API, answered locally (same paths and JSON as logger/main.py).

export function localApi(dev: VirtualDevice, path: string, init?: { method?: string }): unknown {
  const url = new URL(path, "http://local");
  const q = url.searchParams;
  const num = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d);

  const ack = url.pathname.match(/^\/events\/(\d+)\/ack$/);
  if (ack && init?.method === "POST") {
    const ev = dev.log.find((e) => e.id === Number(ack[1]));
    if (!ev) throw new Error("404 no such event");
    const changed = ev.acked_ts == null;
    if (changed) ev.acked_ts = Math.floor(dev.now);
    return { ...ev, changed };
  }

  switch (url.pathname) {
    case "/health":
      return { ok: true, mqtt_connected: true, telegram: false };

    case "/telemetry": {
      const until = num("until", dev.now);
      const since = num("since", until - 3600);
      const bucket = Math.max(2, (until - since) / num("max_points", 600));
      const groups = new Map<number, Telemetry[]>();
      for (const p of dev.history) {
        if (p.ts < since || p.ts > until) continue;
        const b = Math.floor((p.ts - since) / bucket);
        (groups.get(b) ?? groups.set(b, []).get(b)!).push(p);
      }
      const avg = (xs: Telemetry[], f: (p: Telemetry) => number | null | undefined) => {
        const v = xs.map(f).filter((x): x is number => x != null);
        return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 100) / 100 : null;
      };
      const points = [...groups.values()].map((xs) => ({
        ts: avg(xs, (p) => p.ts),
        sump_pct: avg(xs, (p) => p.sump_pct),
        tank_pct: avg(xs, (p) => p.tank_pct),
        pump_on: xs.some((p) => p.pump_on) ? 1 : 0,
        current_a: avg(xs, (p) => p.current_a),
        flow_lpm: avg(xs, (p) => p.flow_lpm),
        turbidity_ntu: avg(xs, (p) => p.turbidity_ntu),
        tto_min: xs.reduce<number | null>((m, p) => (p.tto_min == null ? m : m == null ? p.tto_min : Math.min(m, p.tto_min)), null),
      }));
      return { since, until, bucket_s: bucket, points };
    }

    case "/events": {
      const until = num("until", dev.now);
      const since = num("since", until - 7 * 86400);
      const type = q.get("type"), code = q.get("code");
      return dev.log
        .filter((e) => e.ts >= since && e.ts <= until && (!type || e.type === type) && (!code || e.code === code))
        .slice(0, num("limit", 200));
    }

    case "/report/daily": {
      const days = num("days", 7);
      const e = dev.profile.energy;
      const out = [];
      for (let i = 0; i < days; i++) {
        const key = dateKey(dev.now - i * 86400);
        const d = dev.days.get(key);
        const kwh = (d?.energy_wh ?? 0) / 1000;
        out.push({
          date: key,
          pump_hours: Math.round(((d?.pump_s ?? 0) / 3600) * 1000) / 1000,
          volume_m3: Math.round(((d?.volume_l ?? 0) / 1000) * 1000) / 1000,
          cycles: d?.cycles ?? 0,
          energy_kwh: Math.round(kwh * 1000) / 1000,
          cost_rs: Math.round(kwh * e.tariff_rs_per_kwh * 100) / 100,
          alarms: d?.alarms ?? {},
        });
      }
      return { tariff_rs_per_kwh: e.tariff_rs_per_kwh, days: out };
    }
  }
  throw new Error(`404 ${url.pathname}`);
}
