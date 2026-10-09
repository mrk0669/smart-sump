"""Telegram alerts for alarms and the device going offline.

No token in .env -> alerts are switched off quietly (the rest of the logger
works the same). Messages are sent from a background thread, so a slow or
unreachable Telegram server never holds up data logging.
"""

from __future__ import annotations

import json
import queue
import threading
import time
import urllib.request
from datetime import datetime, timedelta, timezone

DEDUPE_S = 60   # don't repeat the same alert for the same device within a minute

ICON = {"critical": "🚨", "warning": "⚠️", "clear": "✅", "offline": "📴", "online": "📶"}


class TelegramAlerts:
    def __init__(self, token: str, chat_id: str, utc_offset_min: int = 330):
        self.token = token
        self.chat_id = chat_id
        self.enabled = bool(token and chat_id)
        self.tz = timezone(timedelta(minutes=utc_offset_min))
        self.sent: list[str] = []            # what we sent (handy for tests and debugging)
        self._last: dict[tuple, float] = {}
        self._queue: queue.Queue = queue.Queue()
        if self.enabled:
            threading.Thread(target=self._worker, daemon=True, name="telegram").start()
            print("Telegram alerts: ON")
        else:
            print("Telegram alerts: off (set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env to enable)")

    # -- what to alert on --

    def on_event(self, site: str, device: str, ev: dict) -> None:
        if ev.get("type") == "ALARM":
            icon = ICON.get(ev.get("severity"), ICON["warning"])
            head = f"{icon} ALARM {ev.get('code')} ({ev.get('severity')})"
        elif ev.get("type") == "ALARM_CLEAR":
            head = f"{ICON['clear']} Cleared: {ev.get('code')}"
        else:
            return
        self._send_once((site, device, ev.get("type"), ev.get("code")),
                        f"{head}\n{site}/{device}\n{ev.get('reason', '')}\n{self._time(ev.get('ts'))}")

    def on_status(self, site: str, device: str, status: str, previous: str | None) -> None:
        if previous is None or status == previous:
            return   # first sighting, or nothing changed
        if status == "offline":
            text = (f"{ICON['offline']} {site}/{device} went OFFLINE\n"
                    "The pump keeps running on local control; the dashboard can't see it.")
        else:
            text = f"{ICON['online']} {site}/{device} is back online"
        self._send_once((site, device, "STATUS", status), f"{text}\n{self._time(time.time())}")

    # -- plumbing --

    def _time(self, ts) -> str:
        ts = ts if isinstance(ts, (int, float)) else time.time()
        return datetime.fromtimestamp(ts, self.tz).strftime("%d %b %Y, %H:%M:%S")

    def _send_once(self, key: tuple, text: str) -> None:
        now = time.time()
        if now - self._last.get(key, 0) < DEDUPE_S:
            return
        self._last[key] = now
        self.sent.append(text)
        if self.enabled:
            self._queue.put(text)

    def _worker(self) -> None:
        url = f"https://api.telegram.org/bot{self.token}/sendMessage"
        while True:
            text = self._queue.get()
            body = json.dumps({"chat_id": self.chat_id, "text": text}).encode()
            req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
            try:
                urllib.request.urlopen(req, timeout=10).read()
            except Exception as e:   # never let an alert failure crash the logger
                print(f"Telegram send failed: {e}")
