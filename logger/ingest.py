"""MQTT -> SQLite. Subscribes to every Smart Sump device and stores what it says.

Topic layout: <base>/<site>/<device>/<what>, e.g. smartsump/vnit-lab/node01/telemetry
"""

from __future__ import annotations

import json
import sqlite3
import threading
import time

from . import db
from .alerts import TelegramAlerts
from .settings import Settings

# An ESP32 that hasn't synced its clock over NTP yet reports times in 1970.
# Anything before this (Sep 2020) is replaced by the time we received it.
MIN_PLAUSIBLE_TS = 1_600_000_000


class Ingest:
    def __init__(self, settings: Settings, alerts: TelegramAlerts):
        self.s = settings
        self.alerts = alerts
        self.conn: sqlite3.Connection = db.connect(settings.db_path)
        self.lock = threading.Lock()     # one writer at a time
        self.connected = False
        self.client = None

    # -- the part that does the work (called for every message; easy to test) --

    def handle(self, topic: str, payload: bytes, received: float | None = None) -> None:
        received = received or time.time()
        parts = topic.split("/", 3)
        if len(parts) < 4 or parts[0] != self.s.base_topic:
            return
        _, site, device, what = parts
        if what.startswith("cmd/"):
            return   # commands are recorded by the device as events, not here

        text = payload.decode("utf-8", "replace")
        with self.lock, self.conn:
            if what == "status":
                self._status(site, device, text.strip(), received)
                return
            try:
                data = json.loads(text)
            except ValueError:
                print(f"ignoring non-JSON message on {topic}")
                return
            if not isinstance(data, dict):
                return
            ts = data.get("ts")
            if not isinstance(ts, (int, float)) or ts < MIN_PLAUSIBLE_TS:
                ts = received
            if what == "telemetry":
                self._telemetry(site, device, ts, data)
            elif what == "event":
                self._event(site, device, ts, data)
            elif what == "config/state":
                self._touch(site, device, received, config=text)

    def _telemetry(self, site, device, ts, data) -> None:
        values = [data.get(f) for f in db.TELEMETRY_FIELDS]
        values[db.TELEMETRY_FIELDS.index("pump_on")] = 1 if data.get("pump_on") else 0
        cols = ", ".join(db.TELEMETRY_FIELDS)
        marks = ", ".join("?" * len(values))
        self.conn.execute(f"INSERT INTO telemetry (site, device, ts, {cols}) VALUES (?, ?, ?, {marks})",
                          [site, device, ts, *values])
        self._touch(site, device, ts)

    def _event(self, site, device, ts, data) -> None:
        self.conn.execute(
            "INSERT INTO events (site, device, ts, type, code, reason, severity) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (site, device, ts, data.get("type"), data.get("code"), data.get("reason"), data.get("severity")))
        self._touch(site, device, ts)
        self.alerts.on_event(site, device, {**data, "ts": ts})

    def _status(self, site, device, status, received) -> None:
        row = self.conn.execute("SELECT status FROM devices WHERE site=? AND device=?", (site, device)).fetchone()
        previous = row["status"] if row else None
        self._touch(site, device, received, status=status)
        # Record it as an event too, so it shows in the alarm/event history.
        if status != previous:
            self.conn.execute(
                "INSERT INTO events (site, device, ts, type, code, reason, severity) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (site, device, received, "STATUS", status.upper(), f"device {status}",
                 "warning" if status == "offline" else None))
        self.alerts.on_status(site, device, status, previous)

    def _touch(self, site, device, ts, status=None, config=None) -> None:
        self.conn.execute("INSERT OR IGNORE INTO devices (site, device) VALUES (?, ?)", (site, device))
        self.conn.execute("UPDATE devices SET last_seen = MAX(COALESCE(last_seen, 0), ?) WHERE site=? AND device=?",
                          (ts, site, device))
        if status is not None:
            self.conn.execute("UPDATE devices SET status=?, status_ts=? WHERE site=? AND device=?",
                              (status, ts, site, device))
        if config is not None:
            self.conn.execute("UPDATE devices SET config=? WHERE site=? AND device=?", (config, site, device))

    # -- the MQTT connection --

    def start(self) -> None:
        import paho.mqtt.client as mqtt
        c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f"logger-{int(time.time())}")
        c.username_pw_set(self.s.mqtt_username, self.s.mqtt_password)
        c.reconnect_delay_set(min_delay=1, max_delay=10)

        def on_connect(client, userdata, flags, reason_code, properties=None):
            if reason_code.is_failure:
                print(f"logger: MQTT connect refused: {reason_code}")
                return
            self.connected = True
            client.subscribe(f"{self.s.base_topic}/+/+/#", qos=1)
            print(f"logger: subscribed to {self.s.base_topic}/+/+/# on {self.s.mqtt_host}:{self.s.mqtt_port}")

        def on_disconnect(client, userdata, flags, reason_code, properties=None):
            self.connected = False

        def on_message(client, userdata, msg):
            try:
                self.handle(msg.topic, msg.payload)
            except Exception as e:   # one bad message must not stop the logger
                print(f"logger: failed to store {msg.topic}: {e!r}")

        c.on_connect, c.on_disconnect, c.on_message = on_connect, on_disconnect, on_message
        c.connect_async(self.s.mqtt_host, self.s.mqtt_port, keepalive=30)
        c.loop_start()
        self.client = c

    def stop(self) -> None:
        if self.client:
            self.client.disconnect()
            self.client.loop_stop()
