"""`python -m logger` starts the logger (MQTT ingest + REST API)."""

import argparse

import uvicorn

from .main import create_app


def main() -> None:
    ap = argparse.ArgumentParser(description="Smart Sump logger")
    ap.add_argument("--host", default="127.0.0.1", help="0.0.0.0 to allow other devices (phone) on your WiFi")
    ap.add_argument("--port", type=int, default=8000)
    args = ap.parse_args()
    uvicorn.run(create_app(), host=args.host, port=args.port)


if __name__ == "__main__":
    main()
