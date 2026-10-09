"""
Smart Sump: test scenarios for the simulator.

Each scenario is a script of "what the world does" over time: how much water
flows in, whether the suction is choked, whether the tank outlet is blocked,
whether WiFi is up. The controller is NOT told which scenario is running. It
has to notice from its sensors, exactly as it would in the pit.

All times are simulated seconds since the start of the run.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Callable


@dataclass
class Conditions:
    inflow_lpm: float
    suction_blocked: bool = False    # choked foot valve / strainer: pump runs dry
    outlet_blocked: bool = False     # tank outlet to the filling point closed
    wifi_down: bool = False          # device can't reach the broker
    sump_sensor_dead: bool = False   # sump ultrasonic cable cut / sensor failed


@dataclass
class Scenario:
    name: str
    description: str
    initial_sump_pct: float
    initial_tank_pct: float
    conditions: Callable[[float, float], Conditions]   # (t_s, base_inflow_lpm) -> Conditions


def _gentle(t: float, base: float) -> float:
    """Normal seepage with a slow +-15 % wobble, so the level isn't a perfect ramp."""
    return base * (1.0 + 0.15 * math.sin(2 * math.pi * t / 600.0))


def _normal(t: float, base: float) -> Conditions:
    return Conditions(inflow_lpm=_gentle(t, base))


def _heavy_rain(t: float, base: float) -> Conditions:
    # Storm: inflow ramps to 12x normal over 5 min, holds 15 min, eases off over 10 min.
    # At the lab scale 12 x 3 = 36 L/min, more than the 30 L/min pump can handle.
    peak = 12.0 * base
    if t < 120:
        q = base
    elif t < 420:
        q = base + (peak - base) * (t - 120) / 300
    elif t < 1320:
        q = peak
    elif t < 1920:
        q = peak - (peak - base) * (t - 1320) / 600
    else:
        q = base
    return Conditions(inflow_lpm=_gentle(t, q))


def _dry_run(t: float, base: float) -> Conditions:
    # The suction strainer is choked with mud for the first 15 min: the pump
    # spins but moves no water. Someone clears it at t = 15 min.
    return Conditions(inflow_lpm=_gentle(t, base), suction_blocked=t < 900)


def _tank_full(t: float, base: float) -> Conditions:
    # The tank outlet to the filling point is closed for the first 20 min.
    return Conditions(inflow_lpm=_gentle(t, base), outlet_blocked=t < 1200)


def _wifi_drop(t: float, base: float) -> Conditions:
    # WiFi is lost from t = 90 s to t = 150 s. The pump is due to start at
    # t = 120 s (end of the boot delay), so it starts while the device is
    # offline: the dashboard should catch up from the queued events.
    return Conditions(inflow_lpm=_gentle(t, base), wifi_down=90 <= t < 150)


def _sensor_fault(t: float, base: float) -> Conditions:
    # The sump ultrasonic dies from t = 3 min to t = 15 min; only floats are left.
    return Conditions(inflow_lpm=_gentle(t, base), sump_sensor_dead=180 <= t < 900)


SCENARIOS: dict[str, Scenario] = {
    s.name: s for s in [
        Scenario("normal", "steady seepage, pump cycles between 80 % and 20 %", 50, 30, _normal),
        Scenario("heavy_rain", "storm inflow beats the pump: overflow warning, inflow alarm", 60, 30, _heavy_rain),
        Scenario("dry_run", "choked suction: pump trips on low current/flow, retries", 85, 30, _dry_run),
        Scenario("tank_full", "tank outlet blocked: pump locked out until the tank drains", 75, 70, _tank_full),
        Scenario("wifi_drop", "60 s WiFi loss: control keeps running, events catch up", 79, 30, _wifi_drop),
        Scenario("sensor_fault", "sump ultrasonic fails: float switches take over", 70, 30, _sensor_fault),
    ]
}
