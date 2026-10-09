"""
Tests for simulator/control.py: one or more per rule in the brief (section 4),
plus hysteresis (no on/off chattering), commands and set-point validation.

Run from the repo root:   python -m pytest
"""

import math

import pytest

from control import (
    Alarm, Controller, EventType, Inputs, Mode, Setpoints, State,
    distance_to_pct, filter_distance, validate_setpoints,
)

DT = 0.5  # control cycle, seconds (sample_interval_ms = 500)


class Rig:
    """A tiny test bench: a Controller plus inputs we can script over time.

    `healthy=True` makes the fake pump draw normal current and flow whenever
    the controller has it ON. Set it False to simulate a dry/blocked pump.
    """

    def __init__(self, sp: Setpoints | None = None, sump=50.0, tank=30.0):
        self.t = 0.0
        self.c = Controller(sp or Setpoints(), now=0.0)
        self.inp = Inputs(sump_pct=sump, tank_pct=tank)
        self.healthy = True
        self.events: list[dict] = []

    def run(self, seconds: float, level=None, **changes):
        """Advance `seconds` of time. `level` may be a number or f(t) -> pct."""
        for key, value in changes.items():
            setattr(self.inp, key, value)
        for _ in range(int(round(seconds / DT))):
            self.t += DT
            if callable(level):
                self.inp.sump_pct = level(self.t)
            elif level is not None:
                self.inp.sump_pct = level
            if self.c.pump_on:
                self.inp.current_a, self.inp.flow_lpm = (3.0, 30.0) if self.healthy else (0.4, 0.0)
            else:
                self.inp.current_a, self.inp.flow_lpm = 0.0, 0.0
            self.events += self.c.step(self.t, self.inp)
        return self

    def count(self, type_, code=None):
        return sum(1 for e in self.events if e["type"] == type_ and (code is None or e["code"] == code))

    def start_pumping(self):
        """Get the pump running in AUTO (boot delay is min_off_time_s = 120 s)."""
        self.run(121, level=85.0)
        assert self.c.pump_on
        return self


# --- sensor helpers --------------------------------------------------------

def test_distance_to_pct_matches_brief_formula():
    # depth 50 cm, sensor 25 cm above the 100 % line
    assert distance_to_pct(25, 50, 25) == 100.0   # water right at the full line
    assert distance_to_pct(75, 50, 25) == 0.0     # water at the bottom
    assert distance_to_pct(50, 50, 25) == 50.0
    assert distance_to_pct(10, 50, 25) == 100.0   # clamped (closer than full)
    assert distance_to_pct(90, 50, 25) == 0.0     # clamped (below empty)


def test_median_filter_ignores_wild_echoes_and_needs_three_good_pings():
    assert filter_distance([40.0, 40.2, 400.0, 39.9, 40.1], 20, 450) == pytest.approx(40.1)
    assert filter_distance([40.0, None, 0.0, 5.0, 40.2], 20, 450) is None   # only 2 in range
    assert filter_distance([40.0, None, 41.0, 600.0, 40.5], 20, 450) == pytest.approx(40.5)


# --- rule 4 / 5: start and stop --------------------------------------------

def test_waits_min_off_time_after_boot_before_starting():
    rig = Rig().run(119, level=85.0)
    assert not rig.c.pump_on            # power blip protection
    rig.run(1.5)
    assert rig.c.pump_on and rig.c.state == State.PUMPING


def test_starts_at_start_setpoint_not_below():
    rig = Rig().run(200, level=79.9)
    assert not rig.c.pump_on
    rig.run(0.5, level=80.0)
    assert rig.c.pump_on
    start = [e for e in rig.events if e["type"] == EventType.PUMP_START][0]
    assert "start 80" in start["reason"]


def test_stops_at_stop_setpoint_but_only_after_min_on_time():
    rig = Rig().start_pumping()                 # started at t = 120
    rig.run(20, level=15.0)                     # t = 141: on for 21 s < 30 s
    assert rig.c.pump_on
    rig.run(10)                                 # t = 151: on for 31 s
    assert not rig.c.pump_on and rig.c.state == State.IDLE


def test_hysteresis_no_chatter_with_noisy_level():
    """Level jitters +-0.5 % around each set-point: exactly one start, one stop."""
    noise = lambda base: (lambda t: base + 0.5 * math.sin(t * 7.0))
    rig = Rig()
    rig.run(300, level=noise(80.0))    # around START: one start, no stops
    rig.run(300, level=noise(50.0))    # mid band: keeps running
    rig.run(120, level=noise(20.0))    # around STOP: one stop
    rig.run(600, level=noise(20.0))    # stays off; never restarts
    assert rig.count(EventType.PUMP_START) == 1
    assert rig.count(EventType.PUMP_STOP) == 1


# --- rule 1: tank full -----------------------------------------------------

def test_tank_full_by_level_locks_out_and_clears_with_hysteresis():
    rig = Rig().start_pumping()
    rig.run(1, tank_pct=90.0)
    assert not rig.c.pump_on and rig.c.state == State.LOCKOUT_TANK
    assert Alarm.TANK_FULL in rig.c.alarms
    rig.run(60, tank_pct=85.0)                  # below 90 but not 10 % below
    assert rig.c.state == State.LOCKOUT_TANK
    rig.run(1, tank_pct=80.0)                   # 10 % below: clears
    assert Alarm.TANK_FULL not in rig.c.alarms
    assert rig.count(EventType.ALARM_CLEAR, Alarm.TANK_FULL) == 1
    rig.run(130, level=85.0)                    # sump still high -> restarts after min_off
    assert rig.c.pump_on


def test_tank_full_by_float_even_if_ultrasonic_reads_low():
    rig = Rig().start_pumping()
    rig.run(1, tank_high_float=True)
    assert not rig.c.pump_on and rig.c.state == State.LOCKOUT_TANK
    assert "float" in rig.c.alarms[Alarm.TANK_FULL]


def test_tank_full_applies_in_manual_and_blocks_manual_start():
    rig = Rig()
    rig.c.set_mode(Mode.MANUAL, rig.t)
    rig.c.pump_command("start", rig.t)
    rig.run(1)
    assert rig.c.pump_on
    rig.run(1, tank_pct=95.0)
    assert not rig.c.pump_on and rig.c.state == State.LOCKOUT_TANK
    ok, _ = rig.c.pump_command("start", rig.t)
    assert not ok
    rig.run(1, tank_pct=50.0)                   # interlock clears...
    assert not rig.c.pump_on                    # ...but the pump does NOT restart by surprise


# --- rule 2: sensor fault --------------------------------------------------

def test_short_dropout_keeps_last_level_no_fault():
    rig = Rig().run(5, level=60.0)
    rig.run(9.5, sump_pct=None)
    assert Alarm.SENSOR_FAULT not in rig.c.alarms
    assert rig.c.sump_pct == 60.0


def test_sensor_fault_after_10s_falls_back_to_floats():
    rig = Rig().run(130, level=50.0)            # past the boot delay
    rig.run(10, sump_pct=None)
    assert Alarm.SENSOR_FAULT in rig.c.alarms
    assert rig.c.state == State.FAULT_SENSOR and not rig.c.pump_on
    rig.run(1, sump_high_float=True)            # floats only: HIGH float starts
    assert rig.c.pump_on
    rig.run(60, sump_high_float=False)          # float drops: keep pumping (hold)
    assert rig.c.pump_on
    rig.run(1, sump_low_float=True)             # LOW float stops
    assert not rig.c.pump_on
    rig.run(1, sump_low_float=False, level=30.0)  # ultrasonic back
    assert Alarm.SENSOR_FAULT not in rig.c.alarms
    assert rig.c.state == State.IDLE


# --- rule 3: dry run / blockage --------------------------------------------

def test_dry_run_trips_after_delay_on_low_current():
    rig = Rig().start_pumping()
    rig.healthy = False
    rig.run(10)                                 # exactly 10 s low: not yet "more than"
    assert rig.c.pump_on
    rig.run(1.5)
    assert not rig.c.pump_on and rig.c.state == State.LOCKOUT_DRY
    assert "current 0.4A < 1A" in rig.c.alarms[Alarm.DRY_RUN]


def test_dry_run_trips_on_low_flow_with_normal_current():
    sp = Setpoints(dry_run_current_a=0.0)       # current check disabled
    rig = Rig(sp).start_pumping()
    rig.healthy = False
    rig.run(12)
    assert Alarm.DRY_RUN in rig.c.alarms and "flow" in rig.c.alarms[Alarm.DRY_RUN]


def test_short_low_current_blip_does_not_trip():
    rig = Rig().start_pumping()
    rig.healthy = False
    rig.run(5)
    rig.healthy = True
    rig.run(30)
    assert rig.c.pump_on and Alarm.DRY_RUN not in rig.c.alarms


def test_dry_run_stays_locked_until_operator_reset():
    rig = Rig().start_pumping()
    rig.healthy = False
    rig.run(12)
    rig.healthy = True
    rig.run(300, level=90.0)                    # sump high, but locked out
    assert not rig.c.pump_on and rig.c.state == State.LOCKOUT_DRY
    ok, _ = rig.c.reset_alarm(Alarm.DRY_RUN, rig.t)
    assert ok
    rig.run(1)
    assert rig.c.pump_on                        # off > min_off, so starts at once


def test_dry_run_auto_retries_after_retry_time():
    rig = Rig().start_pumping()
    rig.healthy = False
    rig.run(12)
    rig.healthy = True
    rig.run(9 * 60, level=90.0)
    assert not rig.c.pump_on
    rig.run(70)
    assert rig.c.pump_on
    assert rig.count(EventType.ALARM_CLEAR, Alarm.DRY_RUN) == 1


def test_dry_run_in_manual_cancels_the_start_request():
    rig = Rig()
    rig.c.set_mode(Mode.MANUAL, rig.t)
    rig.c.pump_command("start", rig.t)
    rig.healthy = False
    rig.run(12)
    assert not rig.c.pump_on and rig.c.state == State.LOCKOUT_DRY
    rig.c.reset_alarm(Alarm.DRY_RUN, rig.t)
    rig.healthy = True
    rig.run(5)
    assert not rig.c.pump_on and rig.c.state == State.MANUAL


# --- rule 6: backup floats -------------------------------------------------

def test_high_float_forces_start_even_during_boot_delay():
    rig = Rig().run(5, sump_high_float=True)
    assert rig.c.pump_on


def test_low_float_forces_stop_even_before_min_on():
    rig = Rig().start_pumping()
    rig.run(2, sump_low_float=True)
    assert not rig.c.pump_on


def test_high_float_cannot_override_tank_full():
    rig = Rig().run(130, tank_pct=95.0, sump_high_float=True)
    assert not rig.c.pump_on and rig.c.state == State.LOCKOUT_TANK


# --- rule 7: MANUAL --------------------------------------------------------

def test_pump_commands_ignored_in_auto():
    rig = Rig()
    ok, msg = rig.c.pump_command("start", rig.t)
    rig.run(1)
    assert not ok and "MANUAL" in msg and not rig.c.pump_on
    assert rig.count(EventType.CMD_REJECTED) == 1


def test_manual_start_and_stop_ignore_level_setpoints():
    rig = Rig(sump=10.0)                        # far below the stop set-point
    rig.c.set_mode(Mode.MANUAL, rig.t)
    rig.c.pump_command("start", rig.t)
    rig.run(1)
    assert rig.c.pump_on and rig.c.state == State.MANUAL
    rig.c.pump_command("stop", rig.t)
    rig.run(1)
    assert not rig.c.pump_on


def test_mode_switch_is_bumpless():
    rig = Rig().start_pumping()
    rig.c.set_mode(Mode.MANUAL, rig.t)
    rig.run(5)
    assert rig.c.pump_on                        # kept running through the switch
    rig.c.set_mode(Mode.AUTO, rig.t)
    rig.run(5, level=50.0)
    assert rig.c.pump_on                        # mid band in AUTO: holds
    assert rig.count(EventType.MODE_CHANGE) == 2


# --- set-points ------------------------------------------------------------

def test_setpoint_validation():
    sp = Setpoints()
    assert validate_setpoints(sp, {"sump_start_pct": 35})[0] is None   # 35 - 20 < 20
    assert validate_setpoints(sp, {"bogus": 1})[0] is None
    assert validate_setpoints(sp, {"sump_start_pct": 800})[0] is None
    assert validate_setpoints(sp, {"min_on_time_s": True})[0] is None
    assert validate_setpoints(sp, {"min_on_time_s": "30"})[0] is None
    assert validate_setpoints(sp, {"sump_start_pct": float("nan")})[0] is None
    new, errors = validate_setpoints(sp, {"sump_start_pct": 75, "sump_stop_pct": 25})
    assert errors == [] and new.sump_start_pct == 75 and new.sump_stop_pct == 25


def test_update_setpoints_is_all_or_nothing_and_logged():
    rig = Rig()
    ok, errors = rig.c.update_setpoints({"sump_start_pct": 70, "tank_high_pct": 5}, rig.t)
    assert not ok and rig.c.sp.sump_start_pct == 80    # nothing applied
    ok, _ = rig.c.update_setpoints({"sump_start_pct": 70}, rig.t)
    assert ok and rig.c.sp.sump_start_pct == 70
    events = rig.c.drain_events()
    assert [e["type"] for e in events] == [EventType.CMD_REJECTED, EventType.CONFIG_CHANGE]
    assert "sump_start_pct 80 -> 70" in events[1]["reason"]


# --- time-to-overflow ------------------------------------------------------

def test_time_to_overflow_and_overflow_risk_alarm():
    # Start set-point at 100 % so the pump stays off and the level just rises.
    sp = Setpoints(sump_start_pct=100, overflow_warn_min=30)
    rise = lambda t: 60.0 + t / 60.0            # +1 % per minute
    rig = Rig(sp).run(90, level=rise)
    assert rig.c.rate_pct_per_min == pytest.approx(1.0, abs=0.01)
    assert rig.c.tto_min == pytest.approx((100 - rise(rig.t)) / 1.0, abs=0.1)
    assert Alarm.OVERFLOW_RISK not in rig.c.alarms     # ~38 min left
    rig.run(600, level=rise)                    # level ~71.5 % -> ~28.5 min left
    assert Alarm.OVERFLOW_RISK in rig.c.alarms
    rig.run(240, level=rig.inp.sump_pct)        # level goes flat
    assert rig.c.tto_min is None and Alarm.OVERFLOW_RISK not in rig.c.alarms


def test_inflow_exceeds_pump_when_level_rises_while_pumping():
    rig = Rig().start_pumping()
    t0 = rig.t
    rig.run(90, level=lambda t: 85.0 + (t - t0) / 60.0)
    assert Alarm.INFLOW_EXCEEDS_PUMP in rig.c.alarms
    rig.run(35, level=15.0)                     # pump stops at the stop set-point
    assert Alarm.INFLOW_EXCEEDS_PUMP not in rig.c.alarms


# --- events ----------------------------------------------------------------

def test_every_state_change_and_alarm_is_an_event():
    rig = Rig().start_pumping()
    rig.run(1, tank_pct=95.0)
    changes = [e["code"] for e in rig.events if e["type"] == EventType.STATE_CHANGE]
    assert changes == [State.PUMPING, State.LOCKOUT_TANK]
    alarm = [e for e in rig.events if e["type"] == EventType.ALARM][0]
    assert alarm["code"] == Alarm.TANK_FULL and alarm["severity"] == "critical"
    assert all({"ts", "type", "code", "reason"} <= e.keys() for e in rig.events)


def test_only_dry_run_can_be_reset_by_hand():
    rig = Rig().start_pumping()
    rig.run(1, tank_pct=95.0)
    ok, msg = rig.c.reset_alarm(Alarm.TANK_FULL, rig.t)
    assert not ok and "clears itself" in msg
