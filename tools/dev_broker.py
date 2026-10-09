"""
Development MQTT broker, for when Docker isn't available.

The real setup runs Mosquitto in Docker (docker-compose.yml). This script
starts a small pure-Python broker (amqtt) with the SAME ports and the SAME
login, so the simulator, logger and dashboard work unchanged:

    port 1883  plain MQTT    (simulator / ESP32 / logger)
    port 9001  MQTT over WebSocket (browser dashboard)

Usage (from the repo root, venv active):
    python tools/dev_broker.py          # this PC only
    python tools/dev_broker.py --lan    # also reachable from your phone on the same WiFi

The login comes from .env (MQTT_USERNAME / MQTT_PASSWORD), or from
.env.example if you haven't created .env yet.
"""

from __future__ import annotations

import argparse
import asyncio
import hmac
import logging
import os
from dataclasses import dataclass
from pathlib import Path

from amqtt.broker import Broker
from amqtt.mqtt.protocol.broker_handler import BrokerProtocolHandler
from amqtt.plugins.base import BaseAuthPlugin
from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parent.parent

# Extra grace on top of the client's keepalive before a silent client is cut
# off. MQTT says "1.5 x keepalive"; amqtt adds this many seconds instead.
KEEPALIVE_GRACE_S = 8


def _drop_silent_client(self: BrokerProtocolHandler) -> None:
    """Close a client that has gone quiet for longer than its keepalive.

    The MQTT standard (and Mosquitto) require this, and it is what makes the
    broker publish the client's Last Will: the device's "offline" status.
    amqtt 0.12 just keeps waiting, so a device that lost WiFi would look
    online forever. Closing the socket ends the read loop, and amqtt then
    sends the will as for any abnormal disconnect.
    """
    self.logger.info(f"{self.session.client_id}: keepalive expired, closing (Last Will will be sent)")
    if self.writer is not None:
        asyncio.ensure_future(self.writer.close())


BrokerProtocolHandler.handle_read_timeout = _drop_silent_client


class EnvPasswordAuth(BaseAuthPlugin):
    """Accept exactly one username/password pair (like Mosquitto's password_file)."""

    @dataclass
    class Config:
        username: str = ""
        password: str = ""

    async def authenticate(self, *, session) -> bool:
        def same(a, b: str) -> bool:
            if isinstance(a, bytes):
                a = a.decode("utf-8", "replace")
            # compare_digest takes the same time whether the guess is close or
            # not, so a password can't be guessed by timing the replies.
            return hmac.compare_digest((a or "").encode(), b.encode())
        return same(session.username, self.config.username) and same(session.password, self.config.password)


def load_credentials() -> tuple[str, str]:
    env_file = REPO_ROOT / ".env"
    if not env_file.exists():
        env_file = REPO_ROOT / ".env.example"
        print("note: no .env found, using the login from .env.example")
    load_dotenv(env_file)
    return os.environ.get("MQTT_USERNAME", "smartsump"), os.environ.get("MQTT_PASSWORD", "change-me")


async def run(host: str) -> None:
    user, password = load_credentials()
    broker = Broker({
        "listeners": {
            "default": {"type": "tcp", "bind": f"{host}:1883"},
            "ws": {"type": "ws", "bind": f"{host}:9001"},
        },
        # Referenced as __main__.EnvPasswordAuth because this file is run as a script.
        "plugins": {"__main__.EnvPasswordAuth": {"username": user, "password": password}},
        "timeout_disconnect_delay": KEEPALIVE_GRACE_S,
    })
    await broker.start()
    print(f"Dev MQTT broker running: mqtt://{host}:1883  ws://{host}:9001  (user '{user}')")
    print("Press Ctrl+C to stop.")
    try:
        await asyncio.Event().wait()   # run until Ctrl+C
    finally:
        await broker.shutdown()


def main() -> None:
    ap = argparse.ArgumentParser(description="Development MQTT broker (stand-in for Mosquitto)")
    ap.add_argument("--lan", action="store_true", help="listen on all interfaces (phone access)")
    args = ap.parse_args()
    logging.basicConfig(level=logging.WARNING, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    try:
        asyncio.run(run("0.0.0.0" if args.lan else "127.0.0.1"))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
