"""Smart Sump logger: the REST API.

Run it:   python -m logger            (API on http://localhost:8000/api/...)
API docs: http://localhost:8000/docs  (FastAPI writes these automatically)

If the dashboard has been built (dashboard/dist), it is served at "/" too, so
one process gives you the whole web side without Docker.
"""

from __future__ import annotations

import csv
import io
import json
import sqlite3
import time
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles

from . import db
from .alerts import TelegramAlerts
from .ingest import Ingest
from .reports import daily_report, recent_days
from .settings import Settings, load_settings


def create_app(settings: Settings | None = None, start_mqtt: bool = True) -> FastAPI:
    s = settings or load_settings()
    db.init(s.db_path)
    alerts = TelegramAlerts(s.telegram_token, s.telegram_chat_id, s.utc_offset_min)
    ingest = Ingest(s, alerts)
    tz = timezone(timedelta(minutes=s.utc_offset_min))

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        if start_mqtt:
            ingest.start()
        yield
        ingest.stop()

    app = FastAPI(title="Smart Sump logger", lifespan=lifespan)
    app.state.settings, app.state.ingest, app.state.alerts = s, ingest, alerts
    # The dashboard may be served from another port during development.
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

    def get_conn():
        conn = db.connect(s.db_path)
        try:
            yield conn
        finally:
            conn.close()

    def time_range(since: float | None, until: float | None, default_s: float) -> tuple[float, float]:
        until = until or time.time()
        return (since or until - default_s), until

    def local_iso(ts: float) -> str:
        return datetime.fromtimestamp(ts, tz).strftime("%Y-%m-%d %H:%M:%S")

    def csv_response(filename: str, header: list[str], rows: list[list]) -> Response:
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(header)
        w.writerows(rows)
        return Response(buf.getvalue(), media_type="text/csv",
                        headers={"Content-Disposition": f'attachment; filename="{filename}"'})

    # ---------------------------------------------------------------- status

    @app.get("/api/health")
    def health():
        return {"ok": True, "mqtt_connected": ingest.connected, "telegram": alerts.enabled}

    @app.get("/api/devices")
    def devices(conn: sqlite3.Connection = Depends(get_conn)):
        out = []
        for r in conn.execute("SELECT * FROM devices ORDER BY site, device"):
            d = dict(r)
            d["config"] = json.loads(d["config"]) if d["config"] else None
            out.append(d)
        return out

    # ---------------------------------------------------------------- history

    @app.get("/api/telemetry")
    def telemetry(site: str, device: str, since: float | None = None, until: float | None = None,
                  max_points: int = Query(600, ge=10, le=5000),
                  conn: sqlite3.Connection = Depends(get_conn)):
        """Readings between `since` and `until` (Unix s; default: the last hour),
        averaged into at most `max_points` buckets so a 7-day chart stays light.
        `pump_on` is 1 if the pump ran at any time in the bucket."""
        since, until = time_range(since, until, 3600)
        bucket = max(2.0, (until - since) / max_points)
        rows = conn.execute(
            """SELECT CAST((ts - ?) / ? AS INTEGER) AS b,
                      AVG(ts) AS ts, AVG(sump_pct) AS sump_pct, AVG(tank_pct) AS tank_pct,
                      MAX(pump_on) AS pump_on, AVG(current_a) AS current_a, AVG(flow_lpm) AS flow_lpm,
                      AVG(turbidity_ntu) AS turbidity_ntu, MIN(tto_min) AS tto_min
               FROM telemetry WHERE site=? AND device=? AND ts>=? AND ts<=?
               GROUP BY b ORDER BY b""",
            (since, bucket, site, device, since, until)).fetchall()
        points = [{k: (round(v, 2) if isinstance(v, float) else v) for k, v in dict(r).items() if k != "b"}
                  for r in rows]
        return {"since": since, "until": until, "bucket_s": bucket, "points": points}

    @app.get("/api/events")
    def events(site: str, device: str, since: float | None = None, until: float | None = None,
               type: str | None = None, code: str | None = None,
               limit: int = Query(200, ge=1, le=5000), conn: sqlite3.Connection = Depends(get_conn)):
        """Events, newest first (default: the last 7 days)."""
        since, until = time_range(since, until, 7 * 86400)
        sql = "SELECT * FROM events WHERE site=? AND device=? AND ts>=? AND ts<=?"
        args: list = [site, device, since, until]
        if type:
            sql += " AND type=?"
            args.append(type)
        if code:
            sql += " AND code=?"
            args.append(code)
        sql += " ORDER BY ts DESC, id DESC LIMIT ?"
        args.append(limit)
        return [dict(r) for r in conn.execute(sql, args)]

    @app.post("/api/events/{event_id}/ack")
    def acknowledge(event_id: int, conn: sqlite3.Connection = Depends(get_conn)):
        """Operator acknowledges an alarm ("I've seen it"). This is a record for
        the log only: it does NOT reset anything on the device."""
        with conn:
            cur = conn.execute("UPDATE events SET acked_ts=? WHERE id=? AND acked_ts IS NULL",
                               (time.time(), event_id))
        row = conn.execute("SELECT * FROM events WHERE id=?", (event_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "no such event")
        return {**dict(row), "changed": cur.rowcount == 1}

    # ---------------------------------------------------------------- reports

    def build_reports(conn, site: str, device: str, days: int) -> list[dict]:
        return [daily_report(conn, site, device, d, s.supply_voltage_v, s.phases, s.power_factor,
                             s.tariff_rs_per_kwh) for d in recent_days(s.utc_offset_min, days)]

    @app.get("/api/report/daily")
    def report_daily(site: str, device: str, days: int = Query(7, ge=1, le=90),
                     conn: sqlite3.Connection = Depends(get_conn)):
        return {"tariff_rs_per_kwh": s.tariff_rs_per_kwh, "days": build_reports(conn, site, device, days)}

    # ---------------------------------------------------------------- CSV export

    @app.get("/api/export/telemetry.csv")
    def export_telemetry(site: str, device: str, since: float | None = None, until: float | None = None,
                         conn: sqlite3.Connection = Depends(get_conn)):
        since, until = time_range(since, until, 86400)
        rows = conn.execute(f"SELECT ts, {', '.join(db.TELEMETRY_FIELDS)} FROM telemetry "
                            "WHERE site=? AND device=? AND ts>=? AND ts<=? ORDER BY ts",
                            (site, device, since, until)).fetchall()
        return csv_response(f"{site}_{device}_telemetry.csv", ["time", "ts", *db.TELEMETRY_FIELDS],
                            [[local_iso(r["ts"]), *list(r)] for r in rows])

    @app.get("/api/export/events.csv")
    def export_events(site: str, device: str, since: float | None = None, until: float | None = None,
                      conn: sqlite3.Connection = Depends(get_conn)):
        since, until = time_range(since, until, 30 * 86400)
        rows = conn.execute("SELECT ts, type, code, severity, reason, acked_ts FROM events "
                            "WHERE site=? AND device=? AND ts>=? AND ts<=? ORDER BY ts",
                            (site, device, since, until)).fetchall()
        return csv_response(f"{site}_{device}_events.csv",
                            ["time", "type", "code", "severity", "reason", "acknowledged"],
                            [[local_iso(r["ts"]), r["type"], r["code"], r["severity"], r["reason"],
                              local_iso(r["acked_ts"]) if r["acked_ts"] else ""] for r in rows])

    @app.get("/api/export/report.csv")
    def export_report(site: str, device: str, days: int = Query(30, ge=1, le=366),
                      conn: sqlite3.Connection = Depends(get_conn)):
        reports = build_reports(conn, site, device, days)
        return csv_response(
            f"{site}_{device}_daily_report.csv",
            ["date", "pump_hours", "volume_m3", "cycles", "energy_kwh", "cost_rs", "alarms"],
            [[r["date"], r["pump_hours"], r["volume_m3"], r["cycles"], r["energy_kwh"], r["cost_rs"],
              "; ".join(f"{k} x{v}" for k, v in r["alarms"].items())] for r in reports])

    # ---------------------------------------------------------------- dashboard

    index = s.dashboard_dir / "index.html"
    if index.exists():
        app.mount("/", StaticFiles(directory=s.dashboard_dir, html=True), name="dashboard")
    else:
        @app.get("/")
        def root(request: Request):
            return {"service": "Smart Sump logger", "docs": str(request.url_for("swagger_ui_html")),
                    "dashboard": "not built yet (cd dashboard && npm run build)"}

    return app
