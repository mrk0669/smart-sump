"""SQLite storage for telemetry, events and device status.

Why SQLite: one file, no server to install, and fast enough for this job
(one device publishing every 2 s is ~43,000 rows a day, a few MB). WAL mode
lets the API read while the MQTT thread writes.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS telemetry (
    id               INTEGER PRIMARY KEY,
    site             TEXT NOT NULL,
    device           TEXT NOT NULL,
    ts               REAL NOT NULL,      -- Unix seconds
    sump_pct         REAL,
    tank_pct         REAL,
    pump_on          INTEGER,
    current_a        REAL,
    flow_lpm         REAL,
    turbidity_ntu    REAL,
    rate_pct_per_min REAL,
    tto_min          REAL,
    mode             TEXT,
    state            TEXT,
    rssi             INTEGER
);
CREATE INDEX IF NOT EXISTS ix_telemetry ON telemetry (site, device, ts);

CREATE TABLE IF NOT EXISTS events (
    id        INTEGER PRIMARY KEY,
    site      TEXT NOT NULL,
    device    TEXT NOT NULL,
    ts        REAL NOT NULL,
    type      TEXT NOT NULL,
    code      TEXT,
    reason    TEXT,
    severity  TEXT,
    acked_ts  REAL                       -- when an operator acknowledged it
);
CREATE INDEX IF NOT EXISTS ix_events ON events (site, device, ts);

CREATE TABLE IF NOT EXISTS devices (
    site       TEXT NOT NULL,
    device     TEXT NOT NULL,
    status     TEXT,                     -- "online" / "offline"
    status_ts  REAL,
    last_seen  REAL,
    config     TEXT,                     -- latest config/state JSON
    PRIMARY KEY (site, device)
);
"""

TELEMETRY_FIELDS = ("sump_pct", "tank_pct", "pump_on", "current_a", "flow_lpm", "turbidity_ntu",
                    "rate_pct_per_min", "tto_min", "mode", "state", "rssi")


def connect(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, check_same_thread=False, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn


def init(path: Path) -> None:
    with connect(path) as conn:
        conn.executescript(SCHEMA)
