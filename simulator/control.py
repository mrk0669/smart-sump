"""
Smart Sump: control logic (the "brain").

This is the ONE place on the Python side where pump decisions are made. The
simulator calls it, the tests call it, and the ESP32 firmware (Phase 2)
mirrors it line for line in firmware/src/control.cpp.

Why it is written this way
--------------------------
* No hardware, no MQTT, no clock inside. The caller passes in the time
  (`now`, seconds) and the sensor readings. That makes every rule testable in
  milliseconds (see tests/test_control.py) and easy to compare with the C++
  copy, where `now` will come from millis().
* Only `step()` ever switches the pump. Dashboard commands (mode, start/stop,
  reset, set-points) only change *requests*; the next `step()` decides. So the
  safety rules are checked in exactly one place.
* Rules are checked every cycle in priority order (project brief, section 4):
    1. Tank full          -> pump OFF, LOCKOUT_TANK   (safety interlock)
    2. Sensor fault       -> use float switches only, FAULT_SENSOR
    3. Dry run / blockage -> pump OFF, LOCKOUT_DRY    (safety interlock)
    4. Start (AUTO)       5. Stop (AUTO)
    6. Backup floats      7. MANUAL (rules 1 and 3 still apply)
  Rule 2 changes *how we read the level* (floats instead of ultrasonic); it
  does not switch off the dry-run interlock. So in the code the two
  interlocks (1 and 3) are checked first, then the level-control rules.
"""

from __future__ import annotations

from collections import deque
from dataclasses import asdict, dataclass, fields
from statistics import median
from typing import Optional


# --- Names used in MQTT payloads --------------------------------------------
# Plain strings (not Enums) so they go straight into JSON and map 1:1 onto
# `const char*` constants in the C++ firmware.

class Mode:
    AUTO = "AUTO"
    MANUAL = "MANUAL"


class State:
    IDLE = "IDLE"
    PUMPING = "PUMPING"
    LOCKOUT_DRY = "LOCKOUT_DRY"
    LOCKOUT_TANK = "LOCKOUT_TANK"
    MANUAL = "MANUAL"
    FAULT_SENSOR = "FAULT_SENSOR"


class Alarm:
    TANK_FULL = "TANK_FULL"
    SENSOR_FAULT = "SENSOR_FAULT"
    DRY_RUN = "DRY_RUN"
    OVERFLOW_RISK = "OVERFLOW_RISK"
    INFLOW_EXCEEDS_PUMP = "INFLOW_EXCEEDS_PUMP"


# Severity sets the alarm colour on the dashboard. "critical" means the pump is
# stopped or water is about to spill. "warning" means the system is degraded
# but still in control.
ALARM_SEVERITY = {
    Alarm.TANK_FULL: "critical",
    Alarm.DRY_RUN: "critical",
    Alarm.OVERFLOW_RISK: "critical",
    Alarm.SENSOR_FAULT: "warning",
    Alarm.INFLOW_EXCEEDS_PUMP: "warning",
}


class EventType:
    PUMP_START = "PUMP_START"
    PUMP_STOP = "PUMP_STOP"
    ALARM = "ALARM"
    ALARM_CLEAR = "ALARM_CLEAR"
    MODE_CHANGE = "MODE_CHANGE"
    STATE_CHANGE = "STATE_CHANGE"
    CONFIG_CHANGE = "CONFIG_CHANGE"
    CMD_REJECTED = "CMD_REJECTED"


# --- Fixed tuning constants (not site-specific, so not in site.yaml) --------

TREND_SAMPLE_S = 2.0          # keep one level point every 2 s for the trend fit
                              # (90 points over 3 min: small enough for the ESP32)
MIN_TREND_SPAN_S = 60.0       # need at least 1 min of points before trusting a slope
RISING_EPS_PCT_PER_MIN = 0.1  # slower than this counts as "flat" (sensor noise)
OVERFLOW_CLEAR_FACTOR = 1.2   # clear OVERFLOW_RISK only when tto > 1.2 x warn (hysteresis)
OVERFLOWING_PCT = 98.0        # at/above this the sump IS spilling: the level can't rise
                              # any further, so the trend goes flat and can't be trusted
OVERFLOWING_CLEAR_PCT = 95.0  # ...and it must drop below this before the alarm can clear
MIN_BAND_PCT = 20.0           # start set-point must be at least this far above stop


# --- Set-points -----------------------------------------------------------

@dataclass
class Setpoints:
    """Everything an operator may tune from the dashboard (cmd/config).

    Defaults are the project brief's numbers. Real values come from
    config/site.yaml (or NVS on the ESP32).
    """
    sump_start_pct: float = 80.0
    sump_stop_pct: float = 20.0
    tank_high_pct: float = 90.0
    tank_clear_band_pct: float = 10.0
    dry_run_current_a: float = 1.0
    dry_run_flow_lpm: float = 5.0
    dry_run_delay_s: float = 10.0
    dry_run_retry_min: float = 10.0
    min_off_time_s: float = 120.0
    min_on_time_s: float = 30.0
    overflow_warn_min: float = 30.0
    sensor_fault_s: float = 10.0
    tto_window_s: float = 180.0

    @classmethod
    def from_dict(cls, d: dict) -> "Setpoints":
        known = {f.name for f in fields(cls)}
        return cls(**{k: float(v) for k, v in d.items() if k in known})

    def to_dict(self) -> dict:
        return asdict(self)


# Allowed range for each set-point. The device rejects anything outside these,
# so a typo on the dashboard ("800" instead of "80") can never reach the pump.
SETPOINT_LIMITS = {
    "sump_start_pct": (10.0, 100.0),
    "sump_stop_pct": (0.0, 90.0),
    "tank_high_pct": (50.0, 100.0),
    "tank_clear_band_pct": (2.0, 40.0),
    "dry_run_current_a": (0.0, 500.0),     # 0 disables the current check
    "dry_run_flow_lpm": (0.0, 50000.0),    # 0 disables the flow check (no flow sensor)
    "dry_run_delay_s": (2.0, 120.0),
    "dry_run_retry_min": (0.0, 1440.0),    # 0 = no auto-retry, operator reset only
    "min_off_time_s": (0.0, 3600.0),
    "min_on_time_s": (0.0, 3600.0),
    "overflow_warn_min": (1.0, 600.0),
    "sensor_fault_s": (2.0, 300.0),
    "tto_window_s": (120.0, 300.0),        # brief: fit the last 2-5 minutes
}


def validate_setpoints(current: Setpoints, patch: dict) -> tuple[Optional[Setpoints], list[str]]:
    """Check a partial set-point update from the dashboard.

    Returns (new_setpoints, []) if everything is valid, otherwise
    (None, [error messages]). All-or-nothing: one bad value rejects the whole
    patch, so the pump never runs on a half-applied configuration.
    """
    if not isinstance(patch, dict) or not patch:
        return None, ["expected a JSON object with at least one set-point"]

    errors: list[str] = []
    merged = current.to_dict()
    for key, value in patch.items():
        if key not in SETPOINT_LIMITS:
            errors.append(f"unknown set-point '{key}'")
            continue
        # bool is a subclass of int in Python, so reject it explicitly.
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            errors.append(f"{key} must be a number")
            continue
        lo, hi = SETPOINT_LIMITS[key]
        if not lo <= value <= hi:          # also catches NaN (every comparison is False)
            errors.append(f"{key}={value} is outside {lo:g}..{hi:g}")
            continue
        merged[key] = float(value)

    # Cross-checks on the combined result. A wide start/stop band is what stops
    # the pump from chattering on and off.
    if merged["sump_start_pct"] - merged["sump_stop_pct"] < MIN_BAND_PCT:
        errors.append(
            f"sump_start_pct ({merged['sump_start_pct']:g}) must be at least "
            f"{MIN_BAND_PCT:g} above sump_stop_pct ({merged['sump_stop_pct']:g})"
        )

    if errors:
        return None, errors
    return Setpoints(**merged), []


# --- Sensor helpers (also mirrored in the firmware) ------------------------

def filter_distance(readings: list[Optional[float]], min_cm: float, max_cm: float,
                    agree_cm: float = 2.0, min_valid: int = 3) -> Optional[float]:
    """Filtered distance from a burst of ultrasonic pings (the firmware takes 5).

    Why the median and not the average: in a sump the JSN-SR04T sometimes
    returns a wild echo (off the wall, a ripple) or nothing at all. An average
    gets dragged by one bad ping; the median simply ignores it.

    Why the agreement check too: with one ping missing and two wild ones, the
    median of the remaining four is the average of a good and a bad value,
    which is garbage. (The simulator caught this: one such reading released
    the tank-full lockout.) So at least `min_valid` pings must lie within
    `agree_cm` of the median, or the burst counts as "no valid reading".
    """
    valid = [r for r in readings if r is not None and min_cm <= r <= max_cm]
    if len(valid) < min_valid:
        return None
    m = median(valid)
    close = [r for r in valid if abs(r - m) <= agree_cm]
    if len(close) < min_valid:
        return None
    return median(close)


def distance_to_pct(distance_cm: float, depth_cm: float, offset_cm: float) -> float:
    """Convert sensor-to-water distance into level %, clamped to 0-100.

    level % = (depth - (distance - offset)) / depth x 100
    `offset_cm` is the distance from the sensor face to the 100 % water line.
    """
    pct = (depth_cm - (distance_cm - offset_cm)) / depth_cm * 100.0
    return max(0.0, min(100.0, pct))


# --- One control cycle's inputs ------------------------------------------

@dataclass
class Inputs:
    sump_pct: Optional[float]       # None = no valid ultrasonic reading this cycle
    tank_pct: Optional[float]
    sump_high_float: bool = False   # True = water has reached the sump HIGH float
    sump_low_float: bool = False    # True = water has dropped below the sump LOW float
    tank_high_float: bool = False   # True = water has reached the tank HIGH float
    current_a: float = 0.0          # pump motor current (SCT-013)
    flow_lpm: float = 0.0           # delivery flow (YF-S201)


def _slope_pct_per_min(points: deque) -> Optional[float]:
    """Least-squares slope of (time s, level %) points, in % per minute."""
    n = len(points)
    if n < 2:
        return None
    t0 = points[0][0]  # subtract the first time to keep the numbers small (float32 on ESP32)
    mean_t = sum(t - t0 for t, _ in points) / n
    mean_y = sum(y for _, y in points) / n
    num = sum((t - t0 - mean_t) * (y - mean_y) for t, y in points)
    den = sum((t - t0 - mean_t) ** 2 for t, _ in points)
    if den == 0:
        return None
    return num / den * 60.0


# --- The controller -------------------------------------------------------

class Controller:
    """The pump state machine. Call `step()` every sample interval (0.5 s)."""

    def __init__(self, setpoints: Optional[Setpoints] = None, now: float = 0.0):
        self.sp = setpoints or Setpoints()
        self.mode = Mode.AUTO
        self.state = State.IDLE
        self.pump_on = False
        # Boot counts as "the pump just stopped". After a power blip the pump
        # waits min_off_time_s before restarting, so a flickering supply can't
        # hammer the contactor and motor with restarts.
        self.last_pump_change = now
        self.manual_request = False      # what the operator asked for in MANUAL

        self.alarms: dict[str, str] = {}  # active alarms: code -> reason

        # Last VALID level readings. Short dropouts (< sensor_fault_s) reuse these.
        self.sump_pct: Optional[float] = None
        self.tank_pct: Optional[float] = None
        self.last_valid_sump = now
        self.last_valid_tank = now
        self.sump_fault = False
        self.tank_fault = False

        self.dry_since: Optional[float] = None      # when low current/flow began
        self.dry_trip_time: Optional[float] = None  # when DRY_RUN tripped (for auto-retry)

        # Time-to-overflow trend: (time, level) points since the last pump switch.
        self.trend: deque = deque()
        self.last_trend_sample: Optional[float] = None
        self.rate_pct_per_min: Optional[float] = None
        self.tto_min: Optional[float] = None

        self._events: list[dict] = []

    # ---- main loop -------------------------------------------------------

    def step(self, now: float, inp: Inputs) -> list[dict]:
        """Run one control cycle. Returns the events it produced."""
        self._read_levels(now, inp)
        self._update_trend(now, inp)
        want_on, new_state, reason = self._decide(now, inp)
        self._switch_pump(now, want_on, reason)
        if new_state != self.state:
            self._emit(now, EventType.STATE_CHANGE, new_state, f"{self.state} -> {new_state}: {reason}")
            self.state = new_state
        return self.drain_events()

    def _read_levels(self, now: float, inp: Inputs) -> None:
        """Track sensor validity (rule 2's input) and the SENSOR_FAULT alarm."""
        if inp.sump_pct is not None:
            self.sump_pct = inp.sump_pct
            self.last_valid_sump = now
        if inp.tank_pct is not None:
            self.tank_pct = inp.tank_pct
            self.last_valid_tank = now

        self.sump_fault = now - self.last_valid_sump >= self.sp.sensor_fault_s
        self.tank_fault = now - self.last_valid_tank >= self.sp.sensor_fault_s

        if self.sump_fault or self.tank_fault:
            which = " and ".join(n for n, bad in (("sump", self.sump_fault), ("tank", self.tank_fault)) if bad)
            self._raise(now, Alarm.SENSOR_FAULT,
                        f"{which} ultrasonic: no valid reading for {self.sp.sensor_fault_s:g} s, using float switches")
        else:
            self._clear(now, Alarm.SENSOR_FAULT, "ultrasonic readings valid again")

    def _update_trend(self, now: float, inp: Inputs) -> None:
        """Rise rate (%/min), time-to-overflow, OVERFLOW_RISK and INFLOW_EXCEEDS_PUMP."""
        sp = self.sp
        if self.sump_fault:
            # No trustworthy level, so no prediction. Existing alarms are KEPT:
            # "we can't see" is not the same as "it's safe". SENSOR_FAULT is
            # already telling the operator why.
            self.trend.clear()
            self.last_trend_sample = None
            self.rate_pct_per_min = None
            self.tto_min = None
            return

        fresh = inp.sump_pct is not None
        if fresh and (self.last_trend_sample is None or now - self.last_trend_sample >= TREND_SAMPLE_S):
            self.trend.append((now, inp.sump_pct))
            self.last_trend_sample = now
        while self.trend and now - self.trend[0][0] > sp.tto_window_s:
            self.trend.popleft()

        span = self.trend[-1][0] - self.trend[0][0] if self.trend else 0.0
        self.rate_pct_per_min = _slope_pct_per_min(self.trend) if span >= MIN_TREND_SPAN_S else None
        rate = self.rate_pct_per_min

        level = self.sump_pct
        overflowing = level is not None and level >= OVERFLOWING_PCT
        if overflowing:
            self.tto_min = 0.0
        elif rate is not None and rate > RISING_EPS_PCT_PER_MIN and level is not None:
            self.tto_min = (100.0 - level) / rate
        else:
            self.tto_min = None

        # OVERFLOW_RISK. With too little data (rate is None, e.g. just after a
        # pump switch) we leave the alarm as it is rather than guess.
        heading_over = self.tto_min is not None and self.tto_min < sp.overflow_warn_min
        if overflowing:
            self._raise(now, Alarm.OVERFLOW_RISK, f"sump at {level:.1f}%: overflowing")
        elif heading_over and rate is not None:
            self._raise(now, Alarm.OVERFLOW_RISK,
                        f"sump {level:.1f}% rising {rate:.2f} %/min: "
                        f"overflow in {self.tto_min:.1f} min (< {sp.overflow_warn_min:g})")
        elif (rate is not None and level < OVERFLOWING_CLEAR_PCT
              and (self.tto_min is None or self.tto_min >= sp.overflow_warn_min * OVERFLOW_CLEAR_FACTOR)):
            self._clear(now, Alarm.OVERFLOW_RISK, "level no longer heading for overflow")

        # INFLOW_EXCEEDS_PUMP. The trend restarts at every pump switch, so if
        # the pump is ON and the trend still rises (or the sump is spilling
        # over), the pump is losing.
        if self.pump_on and rate is not None and (rate > RISING_EPS_PCT_PER_MIN or overflowing):
            why = "sump overflowing" if overflowing else f"level still rising {rate:.2f} %/min"
            self._raise(now, Alarm.INFLOW_EXCEEDS_PUMP, f"{why} with the pump ON")
        elif not self.pump_on:
            self._clear(now, Alarm.INFLOW_EXCEEDS_PUMP, "pump stopped")
        elif rate is not None and rate < -RISING_EPS_PCT_PER_MIN and level < OVERFLOWING_CLEAR_PCT:
            self._clear(now, Alarm.INFLOW_EXCEEDS_PUMP, "level now falling")

    def _decide(self, now: float, inp: Inputs) -> tuple[bool, str, str]:
        """Apply the rules in priority order. Returns (pump_on, state, reason)."""
        sp = self.sp

        # Rule 1: TANK FULL (interlock, applies in AUTO and MANUAL).
        tank_by_level = (not self.tank_fault and self.tank_pct is not None
                         and self.tank_pct >= sp.tank_high_pct)
        if tank_by_level or inp.tank_high_float:
            why = ("tank HIGH float tripped" if inp.tank_high_float
                   else f"tank {self.tank_pct:.1f}% >= {sp.tank_high_pct:g}%")
            self._raise(now, Alarm.TANK_FULL, why)
        elif Alarm.TANK_FULL in self.alarms:
            # Hysteresis: let go only when the tank is well below the limit,
            # otherwise the pump would flick on/off right at the threshold.
            clear_at = sp.tank_high_pct - sp.tank_clear_band_pct
            if self.tank_fault or self.tank_pct is None:
                self._clear(now, Alarm.TANK_FULL, "tank HIGH float reset (tank ultrasonic unavailable)")
            elif self.tank_pct <= clear_at:
                self._clear(now, Alarm.TANK_FULL, f"tank {self.tank_pct:.1f}% <= {clear_at:g}%")
        if Alarm.TANK_FULL in self.alarms:
            # Cancel any manual start so the pump never restarts by surprise
            # when the interlock lets go.
            self.manual_request = False
            return False, State.LOCKOUT_TANK, "TANK_FULL interlock"

        # Rule 3: DRY RUN / BLOCKAGE (interlock, applies in AUTO and MANUAL).
        if Alarm.DRY_RUN in self.alarms:
            retry_s = sp.dry_run_retry_min * 60.0
            if retry_s > 0 and now - self.dry_trip_time >= retry_s:
                self._clear(now, Alarm.DRY_RUN, f"auto-retry after {sp.dry_run_retry_min:g} min")
                self.dry_trip_time = None
            else:
                return False, State.LOCKOUT_DRY, "DRY_RUN interlock"
        if self.pump_on:
            low_current = inp.current_a < sp.dry_run_current_a
            low_flow = inp.flow_lpm < sp.dry_run_flow_lpm
            if low_current or low_flow:
                # The delay rides through the first seconds after a start,
                # while the pipe fills and the flow builds up.
                if self.dry_since is None:
                    self.dry_since = now
                elif now - self.dry_since > sp.dry_run_delay_s:
                    if low_current:
                        why = f"current {inp.current_a:.1f}A < {sp.dry_run_current_a:g}A for {sp.dry_run_delay_s:g}s"
                    else:
                        why = f"flow {inp.flow_lpm:.1f} L/min < {sp.dry_run_flow_lpm:g} L/min for {sp.dry_run_delay_s:g}s"
                    self._raise(now, Alarm.DRY_RUN, why)
                    self.dry_trip_time = now
                    self.dry_since = None
                    self.manual_request = False
                    return False, State.LOCKOUT_DRY, "DRY_RUN interlock: " + why
            else:
                self.dry_since = None

        # Rule 7: MANUAL. The operator decides; rules 1 and 3 above still apply.
        if self.mode == Mode.MANUAL:
            return self.manual_request, State.MANUAL, "operator " + ("start" if self.manual_request else "stop")

        # Rule 2: SENSOR FAULT. Without the ultrasonic, only the floats are left.
        if self.sump_fault:
            if inp.sump_low_float:
                return False, State.FAULT_SENSOR, "sump LOW float tripped (ultrasonic fault)"
            if inp.sump_high_float:
                return True, State.FAULT_SENSOR, "sump HIGH float tripped (ultrasonic fault)"
            return self.pump_on, State.FAULT_SENSOR, "ultrasonic fault: holding, floats only"

        # Rule 6: BACKUP FLOATS. These are emergency backups, so they ignore the
        # min on/off timers. LOW wins if both trip (impossible unless a float
        # has failed); stopping is the safer guess for the pump.
        if inp.sump_low_float:
            return False, State.IDLE, "sump LOW float tripped"
        if inp.sump_high_float:
            return True, State.PUMPING, "sump HIGH float tripped"

        level = self.sump_pct
        if level is None:  # just booted, no reading yet
            return self.pump_on, self._run_state(), "waiting for the first level reading"

        elapsed = now - self.last_pump_change
        # Rule 4: START.
        if not self.pump_on and level >= sp.sump_start_pct and elapsed >= sp.min_off_time_s:
            return True, State.PUMPING, f"sump {level:.1f}% >= start {sp.sump_start_pct:g}%"
        # Rule 5: STOP.
        if self.pump_on and level <= sp.sump_stop_pct and elapsed >= sp.min_on_time_s:
            return False, State.IDLE, f"sump {level:.1f}% <= stop {sp.sump_stop_pct:g}%"
        # Otherwise hold. Between 20 % and 80 % the pump keeps doing whatever it
        # was doing: that is the hysteresis band.
        return self.pump_on, self._run_state(), "holding"

    def _run_state(self) -> str:
        return State.PUMPING if self.pump_on else State.IDLE

    def _switch_pump(self, now: float, want_on: bool, reason: str) -> None:
        if want_on == self.pump_on:
            return
        self.pump_on = want_on
        self.last_pump_change = now
        self.dry_since = None
        # The rise rate before and after a switch belong to two different
        # situations, so start a fresh trend.
        self.trend.clear()
        self.last_trend_sample = None
        self._emit(now, EventType.PUMP_START if want_on else EventType.PUMP_STOP, None, reason)

    # ---- dashboard commands ---------------------------------------------
    # Each returns (accepted, message). None of them touches the pump directly.

    def set_mode(self, mode: str, now: float) -> tuple[bool, str]:
        if mode not in (Mode.AUTO, Mode.MANUAL):
            return self._reject(now, "mode", f"unknown mode '{mode}'")
        if mode == self.mode:
            return True, f"already in {mode}"
        if mode == Mode.MANUAL:
            # Bumpless transfer: the pump keeps doing what it was doing.
            self.manual_request = self.pump_on
        old, self.mode = self.mode, mode
        self._emit(now, EventType.MODE_CHANGE, mode, f"{old} -> {mode}")
        return True, f"mode set to {mode}"

    def pump_command(self, action: str, now: float) -> tuple[bool, str]:
        if action not in ("start", "stop"):
            return self._reject(now, "pump", f"unknown action '{action}'")
        if self.mode != Mode.MANUAL:
            return self._reject(now, "pump", "pump start/stop is only obeyed in MANUAL mode")
        if action == "start":
            if Alarm.TANK_FULL in self.alarms:
                return self._reject(now, "pump", "TANK_FULL interlock is active: cannot start")
            if Alarm.DRY_RUN in self.alarms:
                return self._reject(now, "pump", "DRY_RUN lockout: reset the alarm first")
        self.manual_request = action == "start"
        return True, f"manual {action} accepted"

    def reset_alarm(self, code: str, now: float) -> tuple[bool, str]:
        if code != Alarm.DRY_RUN:
            return self._reject(now, "reset", f"{code} cannot be reset by hand: it clears itself when the condition goes away")
        if Alarm.DRY_RUN not in self.alarms:
            return self._reject(now, "reset", "DRY_RUN is not active")
        self._clear(now, Alarm.DRY_RUN, "operator reset")
        self.dry_trip_time = None
        return True, "DRY_RUN reset"

    def update_setpoints(self, patch: dict, now: float) -> tuple[bool, list[str]]:
        new, errors = validate_setpoints(self.sp, patch)
        if errors:
            self._reject(now, "config", "; ".join(errors))
            return False, errors
        old = self.sp.to_dict()
        changes = [f"{k} {old[k]:g} -> {v:g}" for k, v in new.to_dict().items() if v != old[k]]
        self.sp = new
        if changes:
            self._emit(now, EventType.CONFIG_CHANGE, None, ", ".join(changes))
        return True, []

    # ---- outputs ---------------------------------------------------------

    def snapshot(self) -> dict:
        """Controller part of the telemetry message. The device adds the
        raw sensor values (current, flow, turbidity, rssi) itself."""
        def r(x, nd=1):
            return None if x is None else round(x, nd)
        return {
            # During a sensor fault the last value is stale: report "unknown"
            # (null) rather than show an old number as if it were live.
            "sump_pct": None if self.sump_fault else r(self.sump_pct),
            "tank_pct": None if self.tank_fault else r(self.tank_pct),
            "pump_on": self.pump_on,
            "rate_pct_per_min": r(self.rate_pct_per_min, 2),
            "tto_min": r(self.tto_min),
            "mode": self.mode,
            "state": self.state,
            "alarms": sorted(self.alarms),  # so a dashboard that just connected sees what's active
        }

    def drain_events(self) -> list[dict]:
        events, self._events = self._events, []
        return events

    # ---- helpers ---------------------------------------------------------

    def _emit(self, now: float, type_: str, code: Optional[str], reason: str) -> None:
        event = {"ts": now, "type": type_, "code": code, "reason": reason}
        if type_ in (EventType.ALARM, EventType.ALARM_CLEAR):
            event["severity"] = ALARM_SEVERITY[code]
        self._events.append(event)

    def _raise(self, now: float, code: str, reason: str) -> None:
        if code not in self.alarms:   # only the rising edge is an event
            self.alarms[code] = reason
            self._emit(now, EventType.ALARM, code, reason)

    def _clear(self, now: float, code: str, reason: str) -> None:
        if code in self.alarms:
            del self.alarms[code]
            self._emit(now, EventType.ALARM_CLEAR, code, reason)

    def _reject(self, now: float, what: str, reason: str) -> tuple[bool, str]:
        self._emit(now, EventType.CMD_REJECTED, what.upper(), reason)
        return False, reason
