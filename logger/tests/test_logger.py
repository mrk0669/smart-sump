"""
Tests for the logger: messages in (as if from MQTT) -> SQLite -> REST API out.
No broker needed: we call Ingest.handle() directly with topic + payload.
"""

import json
import time
from dataclasses import replace

import pytest
from fastapi.testclient import TestClient

from logger.main import create_app
from logger.reports import power_w
from logger.settings import load_settings

P = "smartsump/vnit-lab/node01/"
Q = {"site": "vnit-lab", "device": "node01"}


@pytest.fixture
def rig(tmp_path):
    s = replace(load_settings(), db_path=tmp_path / "test.db", telegram_token="", telegram_chat_id="",
                dashboard_dir=tmp_path / "no-dashboard", supply_voltage_v=230, phases=1,
                power_factor=0.8, tariff_rs_per_kwh=8.0)
    app = create_app(s, start_mqtt=False)
    client = TestClient(app)
    ingest = app.state.ingest

    def send(what, payload, received=None):
        body = payload if isinstance(payload, str) else json.dumps(payload)
        ingest.handle(P + what, body.encode(), received)

    return client, send, app


def telemetry(ts, pump_on, sump=50.0, current=3.0, flow=30.0):
    return {"ts": ts, "sump_pct": sump, "tank_pct": 40.0, "pump_on": pump_on,
            "current_a": current if pump_on else 0.0, "flow_lpm": flow if pump_on else 0.0,
            "mode": "AUTO", "state": "PUMPING" if pump_on else "IDLE", "rssi": -60}


def test_telemetry_is_stored_and_downsampled(rig):
    client, send, _ = rig
    now = time.time()
    for i in range(600):                        # 20 min of readings every 2 s
        send("telemetry", telemetry(now - 1200 + i * 2, pump_on=200 <= i < 300, sump=i / 6))
    r = client.get("/api/telemetry", params={**Q, "since": now - 1200, "until": now, "max_points": 60}).json()
    assert 55 <= len(r["points"]) <= 61         # 600 rows squeezed into ~60 buckets
    assert sum(p["pump_on"] for p in r["points"]) == 10   # pump ran for 1/6 of the time


def test_events_and_acknowledge(rig):
    client, send, _ = rig
    now = time.time()
    send("event", {"ts": now - 5, "type": "PUMP_START", "code": None, "reason": "sump 80% >= start 80%"})
    send("event", {"ts": now, "type": "ALARM", "code": "DRY_RUN", "severity": "critical",
                   "reason": "current 0.4A < 1A for 10s"})
    events = client.get("/api/events", params=Q).json()
    assert [e["type"] for e in events] == ["ALARM", "PUMP_START"]     # newest first
    alarm_id = events[0]["id"]
    assert client.post(f"/api/events/{alarm_id}/ack").json()["changed"] is True
    assert client.post(f"/api/events/{alarm_id}/ack").json()["changed"] is False   # already acked
    only_alarms = client.get("/api/events", params={**Q, "type": "ALARM"}).json()
    assert len(only_alarms) == 1 and only_alarms[0]["acked_ts"] is not None
    assert client.post("/api/events/99999/ack").status_code == 404


def test_status_changes_are_tracked_and_alerted(rig):
    client, send, app = rig
    send("status", "online")
    send("status", "offline")
    send("status", "offline")                   # repeat: no new event
    devs = client.get("/api/devices").json()
    assert devs[0]["status"] == "offline"
    statuses = client.get("/api/events", params={**Q, "type": "STATUS"}).json()
    assert [e["code"] for e in statuses] == ["OFFLINE", "ONLINE"]
    alerts = app.state.alerts.sent              # recorded even with Telegram switched off
    assert any("OFFLINE" in a for a in alerts)


def test_alarm_events_produce_alerts(rig):
    _, send, app = rig
    send("event", {"ts": time.time(), "type": "ALARM", "code": "TANK_FULL", "severity": "critical",
                   "reason": "tank 90.3% >= 90%"})
    send("event", {"ts": time.time(), "type": "PUMP_START", "reason": "x"})   # not an alert
    sent = app.state.alerts.sent
    assert len(sent) == 1 and "TANK_FULL" in sent[0] and "vnit-lab/node01" in sent[0]


def test_bad_messages_are_ignored_and_1970_timestamps_fixed(rig):
    client, send, _ = rig
    send("telemetry", "not json")
    send("event", "[1, 2, 3]")
    send("cmd/pump", {"action": "start"})        # commands are not logged here
    send("telemetry", telemetry(5, pump_on=False), received=time.time())   # ESP32 before NTP sync
    r = client.get("/api/telemetry", params=Q).json()
    assert len(r["points"]) == 1 and r["points"][0]["ts"] > 1_600_000_000


def test_daily_report_pump_hours_volume_energy_cost(rig):
    client, send, _ = rig
    # Today, local time: pump ON for 30 min (900 readings x 2 s) at 30 L/min and 3 A.
    start = time.time() - 3600
    for i in range(901):
        send("telemetry", telemetry(start + i * 2, pump_on=i < 900))
    send("event", {"ts": start, "type": "PUMP_START", "reason": "x"})
    send("event", {"ts": start + 10, "type": "ALARM", "code": "OVERFLOW_RISK", "severity": "critical", "reason": "x"})

    today = client.get("/api/report/daily", params={**Q, "days": 1}).json()["days"][0]
    if today["samples"] < 901:
        pytest.skip("test ran across local midnight")
    assert today["pump_hours"] == pytest.approx(0.5, abs=0.001)
    assert today["volume_m3"] == pytest.approx(0.9, abs=0.001)             # 30 L/min x 30 min
    kwh = power_w(3.0, 230, 1, 0.8) * 0.5 / 1000                             # 552 W for 0.5 h
    assert today["energy_kwh"] == pytest.approx(kwh, abs=0.001)
    assert today["cost_rs"] == pytest.approx(kwh * 8.0, abs=0.01)
    assert today["cycles"] == 1 and today["alarms"] == {"OVERFLOW_RISK": 1}


def test_gaps_are_not_counted_as_pumping(rig):
    client, send, _ = rig
    start = time.time() - 3000
    send("telemetry", telemetry(start, pump_on=True))
    send("telemetry", telemetry(start + 1800, pump_on=True))   # 30 min silence (device offline)
    today = client.get("/api/report/daily", params={**Q, "days": 1}).json()["days"][0]
    assert today["pump_hours"] == 0


def test_three_phase_power_formula():
    # 415 V line, 230 A, pf 0.85 -> about 140 kW (the size of the real 2500 GPM pump)
    assert power_w(230, 415, 3, 0.85) == pytest.approx(140_525, rel=0.001)


def test_csv_exports(rig):
    client, send, _ = rig
    now = time.time()
    send("telemetry", telemetry(now - 10, pump_on=True))
    send("event", {"ts": now - 5, "type": "ALARM", "code": "DRY_RUN", "severity": "critical", "reason": "x"})
    tel = client.get("/api/export/telemetry.csv", params=Q)
    assert tel.headers["content-type"].startswith("text/csv")
    assert tel.text.splitlines()[0].startswith("time,ts,sump_pct")
    assert len(tel.text.strip().splitlines()) == 2
    ev = client.get("/api/export/events.csv", params=Q).text.splitlines()
    assert ev[0] == "time,type,code,severity,reason,acknowledged" and "DRY_RUN" in ev[1]
    rep = client.get("/api/export/report.csv", params={**Q, "days": 3}).text.splitlines()
    assert len(rep) == 4 and rep[0].startswith("date,pump_hours")
