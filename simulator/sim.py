"""
Smart Sump simulator: pretends to be the ESP32 *and* the pit.

Every 0.5 s (simulated) it:
  1. moves the water (physics.py) according to the scenario (scenarios.py),
  2. reads the "sensors" the way the firmware will: 5 ultrasonic pings ->
     median filter -> level %, plus floats, current and flow,
  3. runs the SAME control logic the firmware will run (control.py),
  4. publishes telemetry every 2 s and events as they happen, over MQTT
     exactly like the real device (topics in README section 3),
  5. obeys dashboard commands (cmd/mode, cmd/pump, cmd/reset, cmd/config).

Usage (from the repo root, with a broker running):
  python simulator/sim.py --scenario heavy_rain                   # real time
  python simulator/sim.py --scenario heavy_rain --speed 10        # 10x faster
  python simulator/sim.py --scenario normal --no-mqtt --speed 0   # console only, max speed

  --speed N     N x real time (default 1). 0 = as fast as possible (only with --no-mqtt).
  --duration S  stop after S simulated seconds (default: run until Ctrl+C).
"""

from __future__ import annotations

import argparse
import json
import os
import queue
import random
import sys
import time
from collections import deque
from pathlib import Path

import yaml
from dotenv import load_dotenv

from control import Controller, EventType, Inputs, Setpoints, distance_to_pct, filter_distance
from physics import Plant, PlantParams
from scenarios import SCENARIOS, Conditions

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CONFIG = REPO_ROOT / "config" / "site.yaml"

# Events that happen while the network is down are queued and sent on
# reconnect, so the log has no holes. Telemetry is NOT queued: only the latest
# reading matters. The firmware does the same with a small ring buffer.
EVENT_QUEUE_MAX = 100


def load_config(path: Path) -> dict:
    with open(path, encoding="utf-8") as f:
        return yaml.safe_load(f)


def load_env() -> None:
    """MQTT login etc. from .env (or .env.example if .env doesn't exist yet).
    Real environment variables win, so Docker can override them."""
    env_file = REPO_ROOT / ".env"
    if not env_file.exists():
        env_file = REPO_ROOT / ".env.example"
    load_dotenv(env_file)


def fmt_clock(t: float) -> str:
    """Simulated time as h:mm:ss."""
    t = int(t)
    return f"{t // 3600}:{t % 3600 // 60:02d}:{t % 60:02d}"


class Monitor:
    """What you'd see on the ESP32's serial monitor: every event the moment it
    happens, plus a status line every `print_every` simulated seconds. It
    always prints, whether or not the network is up."""

    def __init__(self, print_every: float):
        self.print_every = print_every
        self.last_print = -1e9

    def note(self, sim_t: float, text: str) -> None:
        print(f"[{fmt_clock(sim_t)}] {text}")

    def event(self, sim_t: float, ev: dict) -> None:
        sev = f" ({ev['severity']})" if "severity" in ev else ""
        code = f" {ev['code']}" if ev.get("code") else ""
        self.note(sim_t, f"EVENT   {ev['type']}{code}{sev}: {ev['reason']}")

    def telemetry(self, sim_t: float, tm: dict, online: bool) -> None:
        if sim_t - self.last_print < self.print_every - 1e-9:
            return
        self.last_print = sim_t
        pct = lambda v: "  ?? " if v is None else f"{v:5.1f}"   # None = sensor fault
        pump = f"ON  {tm['current_a']:4.1f}A {tm['flow_lpm']:5.1f} L/min" if tm["pump_on"] else "off" + " " * 19
        rate = "  --  " if tm["rate_pct_per_min"] is None else f"{tm['rate_pct_per_min']:+6.2f}"
        tto = "  -- " if tm["tto_min"] is None else f"{tm['tto_min']:5.1f}"
        alarms = ",".join(tm["alarms"]) or "-"
        net = "" if online else "  [offline]"
        self.note(sim_t, f"sump {pct(tm['sump_pct'])}%  tank {pct(tm['tank_pct'])}%  pump {pump}  "
                         f"rate {rate} %/min  tto {tto} min  {tm['mode']}/{tm['state']}  alarms: {alarms}{net}")


class MQTTLink:
    """The device's network side: publishes to the broker and collects
    commands. Same topics and QoS the ESP32 firmware will use.

    paho runs its network loop in a background thread. Commands it receives
    are only *queued* here; the main loop applies them between control
    cycles, so the controller is never touched from two threads at once.
    """

    def __init__(self, host: str, port: int, username: str, password: str,
                 prefix: str, keepalive: int, client_id: str):
        import paho.mqtt.client as mqtt   # imported here so --no-mqtt runs without a broker library
        self.mqtt = mqtt
        self.host, self.port, self.keepalive = host, port, keepalive
        self.prefix = prefix
        self.commands: queue.Queue = queue.Queue()
        self.connected = False
        self._config_state: dict | None = None

        c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=client_id)
        c.username_pw_set(username, password)
        # Last Will: if we vanish without saying goodbye (WiFi lost, power cut),
        # the broker publishes "offline" for us after ~1.5 x keepalive.
        c.will_set(prefix + "status", "offline", qos=1, retain=True)
        c.reconnect_delay_set(min_delay=1, max_delay=10)
        c.on_connect = self._on_connect
        c.on_disconnect = self._on_disconnect
        c.on_message = self._on_message
        self.client = c

    def start(self) -> None:
        # connect_async + loop_start: connecting and reconnecting happen in the
        # background, so a missing broker never blocks the control loop.
        self.client.connect_async(self.host, self.port, self.keepalive)
        self.client.loop_start()

    def stop(self) -> None:
        # A clean goodbye: publish "offline" ourselves, then disconnect.
        if self.connected:
            self.client.publish(self.prefix + "status", "offline", qos=1, retain=True).wait_for_publish(2)
        self.client.disconnect()
        self.client.loop_stop()

    def drop(self) -> None:
        """Simulate losing WiFi: stop talking WITHOUT saying goodbye. No more
        keepalive pings, so the broker times us out and sends our Last Will.
        (`connected` is left alone: if WiFi comes back before the broker gives
        up on us, the old connection simply carries on.)"""
        self.client.loop_stop()

    def restore(self) -> None:
        """WiFi is back: resume the network loop; paho reconnects by itself."""
        self.client.loop_start()

    # -- paho callbacks (run in paho's thread) --

    def _on_connect(self, client, userdata, flags, reason_code, properties=None) -> None:
        if reason_code.is_failure:
            print(f"MQTT connect refused: {reason_code} (check MQTT_USERNAME / MQTT_PASSWORD in .env)")
            return
        self.connected = True
        client.publish(self.prefix + "status", "online", qos=1, retain=True)
        if self._config_state is not None:
            client.publish(self.prefix + "config/state", json.dumps(self._config_state), qos=1, retain=True)
        client.subscribe(self.prefix + "cmd/#", qos=1)

    def _on_disconnect(self, client, userdata, flags, reason_code, properties=None) -> None:
        self.connected = False

    def _on_message(self, client, userdata, msg) -> None:
        # Only accept our own command topics. (The dev broker was caught
        # delivering a retained `status` message to the cmd/# subscription;
        # a device should never trust the broker to filter for it.)
        if msg.topic.startswith(self.prefix + "cmd/"):
            self.commands.put((msg.topic[len(self.prefix):], msg.payload))

    # -- publishing (called from the main loop) --

    def config_state(self, setpoints: dict) -> None:
        self._config_state = setpoints
        if self.connected:
            self.client.publish(self.prefix + "config/state", json.dumps(setpoints), qos=1, retain=True)

    def event(self, ev: dict) -> None:
        self.client.publish(self.prefix + "event", json.dumps(ev), qos=1)

    def telemetry(self, tm: dict) -> None:
        self.client.publish(self.prefix + "telemetry", json.dumps(tm), qos=0)


class Device:
    """The simulated ESP32: sensors in, control logic, messages out."""

    def __init__(self, cfg: dict, scenario_name: str, monitor: Monitor,
                 net: MQTTLink | None = None, speed: float = 1.0, seed: int | None = None):
        self.cfg = cfg
        self.scenario = SCENARIOS[scenario_name]
        self.params = PlantParams.from_config(cfg)
        self.geo = cfg["geometry"]
        self.base_inflow = float(cfg["simulator"]["base_inflow_lpm"])
        self.dt = cfg["timing"]["sample_interval_ms"] / 1000.0
        self.publish_every = float(cfg["timing"]["publish_interval_s"])
        self.speed = speed

        self.t = 0.0                     # simulated seconds since start
        self.real0 = time.time()         # wall-clock start, for published timestamps
        self.plant = Plant(self.params, self.scenario.initial_sump_pct,
                           self.scenario.initial_tank_pct, random.Random(seed))
        self.ctrl = Controller(Setpoints.from_dict(cfg["setpoints"]), now=self.now)
        self.monitor = monitor
        self.net = net

        self.wifi_up = True
        self.event_queue: deque = deque(maxlen=EVENT_QUEUE_MAX)
        self.last_publish = -1e9
        self.last_conditions = Conditions(inflow_lpm=self.base_inflow)

        # Stats for the end-of-run summary.
        self.pump_starts = 0
        self.pump_on_s = 0.0
        self.alarm_counts: dict[str, int] = {}

        if net:
            net.config_state(self.ctrl.sp.to_dict())

    @property
    def now(self) -> float:
        """The controller's clock: simulated seconds, offset to look like Unix time."""
        return self.real0 + self.t

    def wall_ts(self, sim_t: float) -> int:
        """Timestamp to publish. At --speed 10, 10 simulated seconds map onto
        1 real second, so the dashboard and logger see real clock times."""
        return int(self.real0 + (sim_t / self.speed if self.speed > 0 else sim_t))

    @property
    def online(self) -> bool:
        return self.net is not None and self.wifi_up and self.net.connected

    # -- sensors --

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

    # -- main cycle --

    def tick(self) -> None:
        """One control cycle (0.5 s of simulated time)."""
        self._apply_commands()
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
            self._send_event(ev)

        self._simulate_wifi(cond.wifi_down)
        if self.online:
            while self.event_queue:   # catch up on anything missed while offline
                self.net.event(self.event_queue.popleft())

        if self.t - self.last_publish >= self.publish_every - 1e-9:
            self.last_publish = self.t
            tm = self.telemetry()
            self.monitor.telemetry(self.t, tm, self.online or self.net is None)
            if self.online:
                self.net.telemetry(tm)

    def _send_event(self, ev: dict) -> None:
        sim_t = ev["ts"] - self.real0
        self.monitor.event(sim_t, ev)
        ev = {**ev, "ts": self.wall_ts(sim_t)}
        if self.online:
            self.net.event(ev)
        elif self.net is not None:
            self.event_queue.append(ev)

    def _simulate_wifi(self, wifi_down: bool) -> None:
        """Control above has already run either way: the pump never waits for
        the network."""
        if wifi_down and self.wifi_up:
            self.wifi_up = False
            self.monitor.note(self.t, "-- WiFi lost: control keeps running, telemetry paused, events queued --")
            if self.net:
                self.net.drop()
        elif not wifi_down and not self.wifi_up:
            self.wifi_up = True
            self.monitor.note(self.t, f"-- WiFi back: {len(self.event_queue)} queued event(s) to send --")
            if self.net:
                self.net.restore()

    # -- dashboard commands --

    def _apply_commands(self) -> None:
        """Apply commands received since the last cycle. They only change
        requests; the next ctrl.step() makes the actual pump decision."""
        if self.net is None:
            return
        while True:
            try:
                suffix, raw = self.net.commands.get_nowait()
            except queue.Empty:
                return
            if suffix not in ("cmd/mode", "cmd/pump", "cmd/reset", "cmd/config"):
                continue   # unknown command topic: ignore
            now = self.now
            try:
                payload = json.loads(raw)
                if not isinstance(payload, dict):
                    raise ValueError("payload must be a JSON object")
            except ValueError as e:
                self._send_event({"ts": now, "type": EventType.CMD_REJECTED, "code": "JSON",
                                  "reason": f"{suffix}: bad JSON ({e})"})
                continue

            if suffix == "cmd/mode":
                ok, msg = self.ctrl.set_mode(str(payload.get("mode")), now)
            elif suffix == "cmd/pump":
                ok, msg = self.ctrl.pump_command(str(payload.get("action")), now)
            elif suffix == "cmd/reset":
                ok, msg = self.ctrl.reset_alarm(str(payload.get("alarm")), now)
            else:  # cmd/config
                ok, errors = self.ctrl.update_setpoints(payload, now)
                msg = "; ".join(errors) or "set-points updated"
                # Publish the set-points the device is ACTUALLY using; the
                # dashboard reads this back to confirm the change.
                self.net.config_state(self.ctrl.sp.to_dict())
            self.monitor.note(self.t, f"CMD     {suffix} {payload} -> {'ok' if ok else 'rejected'}: {msg}")

    # -- outputs --

    def telemetry(self) -> dict:
        tm = {"ts": self.wall_ts(self.t), **self.ctrl.snapshot()}
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


def make_link(cfg: dict, args) -> MQTTLink:
    load_env()
    m = cfg["mqtt"]
    site, device = cfg["site"]["site_id"], cfg["site"]["device_id"]
    host = args.host or os.environ.get("MQTT_HOST") or m["host"]
    port = int(args.port or os.environ.get("MQTT_PORT") or m["port"])
    link = MQTTLink(host, port,
                    os.environ.get("MQTT_USERNAME", ""), os.environ.get("MQTT_PASSWORD", ""),
                    prefix=f"{m['base_topic']}/{site}/{device}/",
                    keepalive=int(m["keepalive_s"]),
                    client_id=f"sim-{site}-{device}")
    print(f"MQTT: {host}:{port}, topics {link.prefix}#")
    return link


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Smart Sump simulator (stands in for the ESP32 + pit)")
    ap.add_argument("--scenario", choices=sorted(SCENARIOS), default="normal")
    ap.add_argument("--speed", type=float, default=1.0, help="x real time; 0 = as fast as possible (--no-mqtt only)")
    ap.add_argument("--duration", type=float, default=None, help="simulated seconds to run (default: forever)")
    ap.add_argument("--print-every", type=float, default=30.0, help="console status line every N simulated s")
    ap.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    ap.add_argument("--seed", type=int, default=None, help="random seed, for repeatable runs")
    ap.add_argument("--no-mqtt", action="store_true", help="console only, no broker needed")
    ap.add_argument("--host", help="MQTT broker host (default: site.yaml / MQTT_HOST)")
    ap.add_argument("--port", type=int, help="MQTT broker port (default: site.yaml / MQTT_PORT)")
    args = ap.parse_args(argv)
    if args.speed < 0 or (args.speed == 0 and not args.no_mqtt):
        ap.error("--speed must be > 0 when publishing to MQTT (0 = max speed needs --no-mqtt)")

    cfg = load_config(args.config)
    scen = SCENARIOS[args.scenario]
    print(f"Smart Sump simulator: scenario '{scen.name}' ({scen.description})")
    print(f"speed {'max' if args.speed == 0 else f'{args.speed:g}x'}, "
          f"duration {'until Ctrl+C' if args.duration is None else fmt_clock(args.duration)}")

    net = None if args.no_mqtt else make_link(cfg, args)
    device = Device(cfg, args.scenario, Monitor(args.print_every), net, args.speed, args.seed)
    if net:
        net.start()
    print()

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
    finally:
        if net:
            net.stop()
    print(device.summary())
    return 0


if __name__ == "__main__":
    sys.exit(main())
