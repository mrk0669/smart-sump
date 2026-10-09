"""
Smart Sump: a simple physical model of the lab rig (or a mine sump).

It stands in for the real water, pump and sensors until the hardware is wired.
It is deliberately simple, a water balance updated every time step:

    sump:  dV/dt = inflow - pump flow          (rain + seepage in, pump out)
    tank:  dV/dt = pump flow - outlet flow     (pump in, gravity outlet out)

    outlet flow = Q_full x sqrt(head above the outlet)  (Torricelli: a gravity
                  outlet runs faster when the tank is fuller)

The controller never sees these volumes directly. It only gets what the real
ESP32 would get: noisy ultrasonic pings, float contacts, a current and a flow
reading. That way the simulator exercises the same filtering and fault paths
as the firmware.
"""

from __future__ import annotations

import math
import random
from dataclasses import dataclass
from typing import Optional

PUMP_RAMP_TAU_S = 2.0   # flow takes a couple of seconds to build (pipe filling)


@dataclass
class PlantParams:
    """Physical constants of the rig. Built from config/site.yaml."""
    sump_depth_cm: float
    tank_depth_cm: float
    sump_area_m2: float
    tank_area_m2: float
    sensor_offset_cm: float
    tank_sensor_offset_cm: float
    pump_rated_flow_lpm: float
    pump_run_current_a: float
    pump_dry_current_a: float
    pump_intake_pct: float
    tank_outlet_lpm_at_full: float
    tank_outlet_pct: float
    sump_high_float_pct: float
    sump_low_float_pct: float
    tank_high_float_pct: float
    sensor_noise_cm: float
    sensor_dropout_prob: float
    sensor_glitch_prob: float
    ultrasonic_min_cm: float
    ultrasonic_max_cm: float

    @classmethod
    def from_config(cls, cfg: dict) -> "PlantParams":
        merged = {**cfg["geometry"], **cfg["simulator"]}
        names = cls.__dataclass_fields__.keys()
        return cls(**{k: float(merged[k]) for k in names})

    @property
    def sump_capacity_l(self) -> float:
        return self.sump_area_m2 * self.sump_depth_cm / 100.0 * 1000.0

    @property
    def tank_capacity_l(self) -> float:
        return self.tank_area_m2 * self.tank_depth_cm / 100.0 * 1000.0


class Plant:
    """The physical world: sump -> pump -> sedimentation tank -> filling point."""

    def __init__(self, p: PlantParams, sump_pct: float, tank_pct: float, rng: random.Random):
        self.p = p
        self.rng = rng
        self.sump_l = p.sump_capacity_l * sump_pct / 100.0
        self.tank_l = p.tank_capacity_l * tank_pct / 100.0
        self.flow_lpm = 0.0          # actual pump delivery flow
        self.current_a = 0.0
        # Running totals, for the end-of-run summary.
        self.pumped_l = 0.0
        self.sump_spill_l = 0.0      # water lost over the sump edge (flooded bench)
        self.tank_spill_l = 0.0
        self.dry_running_s = 0.0     # seconds the pump ran with no water: damage!

    # ---- true state (what a perfect sensor would read) ----

    @property
    def sump_pct(self) -> float:
        return self.sump_l / self.p.sump_capacity_l * 100.0

    @property
    def tank_pct(self) -> float:
        return self.tank_l / self.p.tank_capacity_l * 100.0

    # ---- physics ----

    def advance(self, dt: float, pump_on: bool, inflow_lpm: float,
                suction_blocked: bool = False, outlet_blocked: bool = False) -> None:
        p = self.p
        # The pump only moves water if its intake is under water and not choked.
        has_water = self.sump_pct > p.pump_intake_pct and not suction_blocked
        target = p.pump_rated_flow_lpm if (pump_on and has_water) else 0.0
        # First-order ramp: flow builds over ~2 s after a start, decays after a stop.
        self.flow_lpm += (target - self.flow_lpm) * min(1.0, dt / PUMP_RAMP_TAU_S)
        if self.flow_lpm < 0.01:
            self.flow_lpm = 0.0

        # Centrifugal pump: motor current rises with the water it moves.
        # Running dry it only draws the no-load current.
        if pump_on:
            load = self.flow_lpm / p.pump_rated_flow_lpm
            self.current_a = p.pump_dry_current_a + (p.pump_run_current_a - p.pump_dry_current_a) * load
            if not has_water:
                self.dry_running_s += dt
        else:
            self.current_a = 0.0

        minutes = dt / 60.0
        pumped = min(self.flow_lpm * minutes, self.sump_l)   # can't pump water that isn't there
        self.pumped_l += pumped

        # Sump water balance.
        self.sump_l += inflow_lpm * minutes - pumped
        if self.sump_l > p.sump_capacity_l:
            self.sump_spill_l += self.sump_l - p.sump_capacity_l
            self.sump_l = p.sump_capacity_l
        self.sump_l = max(0.0, self.sump_l)

        # Tank water balance, with a gravity outlet to the filling point. The
        # outlet pipe sits above the floor, so the water below it stays put
        # (that still water is where the mud settles out). Outflow grows with
        # the head of water above the outlet.
        out = p.tank_outlet_pct / 100.0
        head = max(0.0, (self.tank_l / p.tank_capacity_l - out) / (1.0 - out))
        outlet = 0.0 if outlet_blocked else p.tank_outlet_lpm_at_full * math.sqrt(head)
        self.tank_l += pumped - min(outlet * minutes, self.tank_l)
        if self.tank_l > p.tank_capacity_l:
            self.tank_spill_l += self.tank_l - p.tank_capacity_l
            self.tank_l = p.tank_capacity_l

    # ---- sensors (what the ESP32 actually sees) ----

    def ultrasonic_burst(self, which: str, n: int = 5, dead: bool = False) -> list[Optional[float]]:
        """`n` raw JSN-SR04T pings, in cm from the sensor face to the water.

        Each ping can be noisy, missing (None = echo timeout) or a wild echo
        off the sump wall. `dead=True` simulates a failed or disconnected
        sensor: every ping times out.
        """
        p = self.p
        if which == "sump":
            depth, offset, pct = p.sump_depth_cm, p.sensor_offset_cm, self.sump_pct
        else:
            depth, offset, pct = p.tank_depth_cm, p.tank_sensor_offset_cm, self.tank_pct
        true_cm = offset + depth * (1.0 - pct / 100.0)

        pings: list[Optional[float]] = []
        for _ in range(n):
            if dead or self.rng.random() < p.sensor_dropout_prob:
                pings.append(None)
            elif self.rng.random() < p.sensor_glitch_prob:
                pings.append(self.rng.uniform(p.ultrasonic_min_cm, p.ultrasonic_max_cm))
            else:
                pings.append(true_cm + self.rng.gauss(0.0, p.sensor_noise_cm))
        return pings

    def floats(self) -> tuple[bool, bool, bool]:
        """(sump HIGH tripped, sump LOW tripped, tank HIGH tripped)."""
        p = self.p
        return (self.sump_pct >= p.sump_high_float_pct,
                self.sump_pct <= p.sump_low_float_pct,
                self.tank_pct >= p.tank_high_float_pct)

    def current_reading(self) -> float:
        """SCT-013 clamp reading: true current plus a little noise."""
        if self.current_a == 0.0:
            return 0.0
        return max(0.0, self.current_a + self.rng.gauss(0.0, 0.05))

    def flow_reading(self) -> float:
        """YF-S201 pulse-counter reading in L/min."""
        if self.flow_lpm == 0.0:
            return 0.0
        return max(0.0, self.flow_lpm * (1.0 + self.rng.gauss(0.0, 0.02)))

    def turbidity_reading(self, inflow_lpm: float) -> float:
        """Illustrative only: storm water carries more mud, so turbidity
        at the tank outlet rises with inflow."""
        return max(0.0, 40.0 + 4.0 * inflow_lpm + self.rng.gauss(0.0, 3.0))
