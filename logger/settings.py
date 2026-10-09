"""Logger settings: site.yaml for site numbers, environment / .env for secrets.

Environment variables win over files, so Docker can point the logger at the
`mosquitto` container and a `/data` volume without editing anything.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

import yaml
from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parent.parent


@dataclass
class Settings:
    db_path: Path
    mqtt_host: str
    mqtt_port: int
    mqtt_username: str
    mqtt_password: str
    base_topic: str
    telegram_token: str
    telegram_chat_id: str
    tariff_rs_per_kwh: float
    supply_voltage_v: float
    phases: int
    power_factor: float
    utc_offset_min: int          # site local time for daily reports (India: +330)
    dashboard_dir: Path          # built dashboard to serve at "/", if present


def load_settings() -> Settings:
    env_file = REPO_ROOT / ".env"
    load_dotenv(env_file if env_file.exists() else REPO_ROOT / ".env.example")
    cfg_path = Path(os.environ.get("SITE_CONFIG", REPO_ROOT / "config" / "site.yaml"))
    with open(cfg_path, encoding="utf-8") as f:
        cfg = yaml.safe_load(f)

    e = os.environ.get
    return Settings(
        db_path=Path(e("DB_PATH", REPO_ROOT / "data" / "smartsump.db")),
        mqtt_host=e("MQTT_HOST", cfg["mqtt"]["host"]),
        mqtt_port=int(e("MQTT_PORT", cfg["mqtt"]["port"])),
        mqtt_username=e("MQTT_USERNAME", ""),
        mqtt_password=e("MQTT_PASSWORD", ""),
        base_topic=cfg["mqtt"]["base_topic"],
        telegram_token=e("TELEGRAM_BOT_TOKEN", "").strip(),
        telegram_chat_id=e("TELEGRAM_CHAT_ID", "").strip(),
        tariff_rs_per_kwh=float(cfg["energy"]["tariff_rs_per_kwh"]),
        supply_voltage_v=float(cfg["energy"]["supply_voltage_v"]),
        phases=int(cfg["energy"]["phases"]),
        power_factor=float(cfg["energy"]["power_factor"]),
        utc_offset_min=int(cfg["site"].get("utc_offset_min", 330)),
        dashboard_dir=Path(e("DASHBOARD_DIR", REPO_ROOT / "dashboard" / "dist")),
    )
