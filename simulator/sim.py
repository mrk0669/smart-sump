"""
Smart Sump simulator: pretends to be the ESP32 *and* the pit.

Every 0.5 s (simulated) it:
  1. moves the water (physics.py) according to the scenario (scenarios.py),
  2. reads the "sensors" the way the firmware will: 5 ultrasonic pings ->
     median filter -> level %, plus floats, current and flow,
  3. runs the SAME control logic the firmware will run (control.py),
  4. reports telemetry every 2 s and events as they happen.

Usage (from the repo root):
  python simulator/sim.py --scenario normal --no-mqtt              # console only
  python simulator/sim.py --scenario heavy_rain --no-mqtt --speed 20
  python simulator/sim.py --scenario dry_run --no-mqtt --speed 0 --duration 3600

  --speed N     N x real time (default 1). 0 = as fast as the PC can go.
  --duration S  stop after S simulated seconds (default: run until Ctrl+C).
"""

from __future__ import annotations

import argparse
import random
import sys
import time
from collections import deque
from pathlib import Path

import yaml

from control import Controller, EventType, Inputs, Setpoints, distance_to_pct, filter_distance
from physics import Plant, PlantParams
from scenarios import SCENARIOS, Conditions

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CONFIG = REPO_ROOT / "config" / "site.yaml"

# Events that happen while WiFi is down are queued and sent on reconnect, so the
# log has no holes. Telemetry is NOT queued: only the latest reading matters.
# The firmware does the same with a small ring buffer.
EVENT_QUEUE_MAX = 100


def load_config(path: Path) -> dict:
    with open(path, encoding="utf-8") as f:
        return yaml.safe_load(f)


def fmt_clock(t: float) -> str:
    """Simulated time as h:mm:ss."""
    t = int(t)
    return f"{t // 3600}:{t % 3600 // 60:02d}:{t % 60:02d}"


class ConsoleLink:
    """Prints what the device would publish. MQTTLink (next step) will have
    the same four methods, so the device code does not care which it uses."""

    def __init__(self):
        self.clock = lambda: 0.0   # set by the Device so lines show sim time
        self.epoch0 = 0.0          # set by the Device: converts event ts back to sim time

    def status(self, value: str) -> None:
        print(f"[{fmt_clock(self.clock())}] STATUS  {value}")

    def config_state(self, setpoints: dict) -> None:
        print(f"[{fmt_clock(self.clock())}] CONFIG  " +
              ", ".join(f"{k}={v:g}" for k, v in setpoints.items()))

    def event(self, ev: dict) -> None:
        sev = f" ({ev['severity']})" if "severity" in ev else ""
        code = f" {ev['code']}" if ev.get("code") else ""
        # Use the event's own timestamp: queued events (WiFi drop) arrive late
        # but must show when they actually happened.
        print(f"[{fmt_clock(ev['ts'] - self.epoch0)}] EVENT   {ev['type']}{code}{sev}: {ev['reason']}")

    def telemetry(self, tm: dict) -> None:
        pump = f"ON  {tm['current_a']:4.1f}A {tm['flow_lpm']:5.1f} L/min" if tm["pump_on"] else "off" + " " * 19
        rate = "  --  " if tm["rate_pct_per_min"] is None else f"{tm['rate_pct_per_min']:+6.2f}"
        tto = "  -- " if tm["tto_min"] is None else f"{tm['tto_min']:5.1f}"
        pct = lambda v: "  ?? " if v is None else f"{v:5.1f}"   # None = sensor fault
        alarms = ",".join(tm["alarms"]) or "-"
        print(f"[{fmt_clock(self.clock())}] sump {pct(tm['sump_pct'])}%  tank {pct(tm['tank_pct'])}%  pump {pump}  "
              f"rate {rate} %/min  tto {tto} min  {tm['mode']}/{tm['state']}  alarms: {alarms}")


class Device:
    """The simulated ESP32: sensors in, control logic, messages out."""

    def __init__(self, cfg: dict, scenario_name: str, link, seed: int | None = None):
        self.cfg = cfg
        self.scenario = SCENARIOS[scenario_name]
        self.params = PlantParams.from_config(cfg)
        self.geo = cfg["geometry"]
        self.base_inflow = float(cfg["simulator"]["base_inflow_lpm"])
        self.dt = cfg["timing"]["sample_interval_ms"] / 1000.0
        self.publish_every = float(cfg["timing"]["publish_interval_s"])

        self.t = 0.0                     # simulated seconds since start
        self.epoch0 = time.time()        # so timestamps look like real Unix time
        self.plant = Plant(self.params, self.scenario.initial_sump_pct,
                           self.scenario.initial_tank_pct, random.Random(seed))
        self.ctrl = Controller(Setpoints.from_dict(cfg["setpoints"]), now=self.now)
        self.link = link
        link.clock = lambda: self.t
        link.epoch0 = int(self.epoch0)

        self.online = True
        self.event_queue: deque = deque(maxlen=EVENT_QUEUE_MAX)
        self.last_publish = -1e9
        self.last_conditions = Conditions(inflow_lpm=self.base_inflow)

        # Stats for the end-of-run summary.
        self.pump_starts = 0
        self.pump_on_s = 0.0
        self.alarm_counts: dict[str, int] = {}

        link.status("online")
        link.config_state(self.ctrl.sp.to_dict())

    @property
    def now(self) -> float:
        return self.epoch0 + self.t

    def read_inputs(self, cond: Conditions) -> Inputs:
        """Exactly what the firmware will do with the raw sensors."""
        g = self.geo
        limits = (g["ultrasonic_min_cm"], g["ultrasonic_max_cm"], g["ultrasonic_agree_cm"])
        sump_cm = filter_distance(self.plant.ultrasonic_burst("sump", dead=cond.sump_sensor_dead), *limits)
        tank_cm = filter_distance(self.plant.ultrasonic_burst("tank"), *limits)
        sump_hi, sump_lo, tank_hi = self.plant.floats()
        return Inputs(
            sump_pct=None if sump_cm is None else distance_to_pct(sump_cm, g["sump_depth_cm"], g["sensor_offset_cm"]),
            tank_pct=None if tank_cm is None else distance_to_pct(tank_cm, g["tank_depth_cm"], g["tank_sensor_offset_cm"]),
            sump_high_float=sump_hi,
            sump_low_float=sump_lo,
            tank_high_float=tank_hi,
            current_a=self.plant.current_reading(),
            flow_lpm=self.plant.flow_reading(),
        )

    def tick(self) -> None:
        """One control cycle (0.5 s of simulated time)."""
        self.t += self.dt
        cond = self.scenario.conditions(self.t, self.base_inflow)
        self.last_conditions = cond

        self.plant.advance(self.dt, self.ctrl.pump_on, cond.inflow_lpm,
                           cond.suction_blocked, cond.outlet_blocked)
        events = self.ctrl.step(self.now, self.read_inputs(cond))

        if self.ctrl.pump_on:
            self.pump_on_s += self.dt
        for ev in events:
            if ev["type"] == EventType.PUMP_START:
                self.pump_starts += 1
            if ev["type"] == EventType.ALARM:
                self.alarm_counts[ev["code"]] = self.alarm_counts.get(ev["code"], 0) + 1

        self._handle_link(cond.wifi_down)
        for ev in events:
            self.send_event(ev)
        if self.t - self.last_publish >= self.publish_every - 1e-9:
            self.last_publish = self.t
            if self.online:
                self.link.telemetry(self.telemetry())

    def _handle_link(self, wifi_down: bool) -> None:
        """Simulated WiFi. Control above has already run either way: the pump
        never waits for the network."""
        if wifi_down and self.online:
            self.online = False
            print(f"[{fmt_clock(self.t)}] -- WiFi lost: control keeps running, telemetry paused, events queued --")
        elif not wifi_down and not self.online:
            self.online = True
            print(f"[{fmt_clock(self.t)}] -- WiFi back: sending {len(self.event_queue)} queued event(s) --")
            self.link.status("online")
            while self.event_queue:
                self.link.event(self.event_queue.popleft())

    def send_event(self, ev: dict) -> None:
        ev = {**ev, "ts": int(ev["ts"])}
        if self.online:
            self.link.event(ev)
        else:
            self.event_queue.append(ev)

    def telemetry(self) -> dict:
        tm = {"ts": int(self.now), **self.ctrl.snapshot()}
        sump_pct = tm["sump_pct"]
        tm["sump_cm"] = None if sump_pct is None else round(sump_pct * self.geo["sump_depth_cm"] / 100.0, 1)
        tm["current_a"] = round(self.plant.current_reading(), 2)
        tm["flow_lpm"] = round(self.plant.flow_reading(), 1)
        tm["turbidity_ntu"] = round(self.plant.turbidity_reading(self.last_conditions.inflow_lpm))
        tm["rssi"] = -61   # a real ESP32 reports WiFi.RSSI(); fixed in the simulator
        return tm

    def summary(self) -> str:
        p = self.plant
        alarms = ", ".join(f"{k} x{v}" for k, v in sorted(self.alarm_counts.items())) or "none"
        return "\n".join([
            "",
            f"=== Summary: scenario '{self.scenario.name}', {fmt_clock(self.t)} simulated ===",
            f"  pump starts        : {self.pump_starts}",
            f"  pump running time  : {self.pump_on_s / 60:.1f} min",
            f"  water pumped       : {p.pumped_l:.0f} L",
            f"  sump overflow      : {p.sump_spill_l:.1f} L",
            f"  tank overflow      : {p.tank_spill_l:.1f} L",
            f"  dry running        : {p.dry_running_s:.0f} s (time the pump spun with no water)",
            f"  alarms raised      : {alarms}",
            f"  final state        : sump {p.sump_pct:.1f}%, tank {p.tank_pct:.1f}%, "
            f"{self.ctrl.mode}/{self.ctrl.state}",
        ])


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Smart Sump simulator (stands in for the ESP32 + pit)")
    ap.add_argument("--scenario", choices=sorted(SCENARIOS), default="normal")
    ap.add_argument("--speed", type=float, default=1.0, help="x real time; 0 = as fast as possible")
    ap.add_argument("--duration", type=float, default=None, help="simulated seconds to run (default: forever)")
    ap.add_argument("--print-every", type=float, default=30.0, help="console status line every N simulated s")
    ap.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    ap.add_argument("--seed", type=int, default=None, help="random seed, for repeatable runs")
    ap.add_argument("--no-mqtt", action="store_true", help="print to the console instead of publishing")
    args = ap.parse_args(argv)

    if not args.no_mqtt:
        print("MQTT publishing arrives in the next build step. For now, add --no-mqtt.")
        return 2

    cfg = load_config(args.config)
    link = ConsoleLink()
    # The console only shows a status line every --print-every seconds;
    # events always print.
    print_every = args.print_every
    last_print = [-1e9]
    real_telemetry = link.telemetry

    def throttled(tm: dict) -> None:
        if device.t - last_print[0] >= print_every - 1e-9:
            last_print[0] = device.t
            real_telemetry(tm)
    link.telemetry = throttled

    scen = SCENARIOS[args.scenario]
    print(f"Smart Sump simulator: scenario '{scen.name}' ({scen.description})")
    print(f"speed {'max' if args.speed == 0 else f'{args.speed:g}x'}, "
          f"duration {'until Ctrl+C' if args.duration is None else fmt_clock(args.duration)}\n")

    device = Device(cfg, args.scenario, link, seed=args.seed)
    next_real = time.monotonic()
    try:
        while args.duration is None or device.t < args.duration:
            device.tick()
            if args.speed > 0:
                # Pace the loop to the wall clock (scaled by --speed).
                next_real += device.dt / args.speed
                delay = next_real - time.monotonic()
                if delay > 0:
                    time.sleep(delay)
    except KeyboardInterrupt:
        pass
    print(device.summary())
    return 0


if __name__ == "__main__":
    sys.exit(main())
