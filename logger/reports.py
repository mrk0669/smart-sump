"""Daily figures: pump hours, volume pumped, start cycles, energy, cost, alarms.

All of these are worked out from the stored telemetry by adding up small
time slices: for each pair of consecutive readings, the pump state, flow and
current of the first one are assumed to hold until the second.
"""

from __future__ import annotations

import math
import sqlite3
from datetime import datetime, timedelta, timezone

# A gap longer than this (device offline, logger down) is not counted, so an
# outage doesn't get booked as hours of pumping.
MAX_GAP_S = 10.0


def power_w(current_a: float, voltage_v: float, phases: int, power_factor: float) -> float:
    """Electrical input power. Three-phase: P = sqrt(3) x V(line) x I x pf."""
    k = math.sqrt(3) if phases == 3 else 1.0
    return k * voltage_v * current_a * power_factor


def day_bounds(day: datetime) -> tuple[float, float]:
    start = day.replace(hour=0, minute=0, second=0, microsecond=0)
    return start.timestamp(), (start + timedelta(days=1)).timestamp()


def daily_report(conn: sqlite3.Connection, site: str, device: str, day: datetime,
                 voltage_v: float, phases: int, power_factor: float, tariff: float) -> dict:
    t0, t1 = day_bounds(day)
    rows = conn.execute(
        "SELECT ts, pump_on, current_a, flow_lpm FROM telemetry "
        "WHERE site=? AND device=? AND ts>=? AND ts<? ORDER BY ts",
        (site, device, t0, t1)).fetchall()

    pump_s = volume_l = energy_wh = 0.0
    for a, b in zip(rows, rows[1:]):
        dt = b["ts"] - a["ts"]
        if dt <= 0 or dt > MAX_GAP_S or not a["pump_on"]:
            continue
        pump_s += dt
        volume_l += (a["flow_lpm"] or 0.0) * dt / 60.0
        energy_wh += power_w(a["current_a"] or 0.0, voltage_v, phases, power_factor) * dt / 3600.0

    cycles = conn.execute(
        "SELECT COUNT(*) FROM events WHERE site=? AND device=? AND ts>=? AND ts<? AND type='PUMP_START'",
        (site, device, t0, t1)).fetchone()[0]
    alarms = {r["code"]: r["n"] for r in conn.execute(
        "SELECT code, COUNT(*) AS n FROM events WHERE site=? AND device=? AND ts>=? AND ts<? "
        "AND type='ALARM' GROUP BY code ORDER BY code", (site, device, t0, t1))}

    kwh = energy_wh / 1000.0
    return {
        "date": day.strftime("%Y-%m-%d"),
        "pump_hours": round(pump_s / 3600.0, 3),
        "volume_m3": round(volume_l / 1000.0, 3),
        "cycles": cycles,
        "energy_kwh": round(kwh, 3),
        "cost_rs": round(kwh * tariff, 2),
        "alarms": alarms,
        "samples": len(rows),
    }


def recent_days(utc_offset_min: int, days: int) -> list[datetime]:
    """Today and the previous days, in site local time, newest first."""
    tz = timezone(timedelta(minutes=utc_offset_min))
    today = datetime.now(tz)
    return [today - timedelta(days=i) for i in range(days)]
