"""
Cross-check: does the phone app's TypeScript simulator behave exactly like
the Python one (the reference, with the unit tests)?

Both are run on every scenario with sensor noise switched off, so they see
identical water levels. Their event lists (pump starts/stops, alarms, state
changes) must match: same events, same order, same time (within 1 s, to allow
for the last-digit differences between Python's and JavaScript's maths).
It also checks that the app's "Lab model" uses the numbers in config/site.yaml.

Run from the repo root:   python tools/crosscheck.py
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "simulator"))

from scenarios import SCENARIOS  # noqa: E402
from sim import Device, Monitor, load_config  # noqa: E402

DURATION_S = 3600
TIME_TOLERANCE_S = 1.0


class Silent(Monitor):
    def note(self, *a): pass
    def event(self, *a): pass
    def telemetry(self, *a): pass


def python_events(cfg: dict, name: str) -> list:
    dev = Device(cfg, name, Silent(1e12), net=None, speed=1, seed=1)
    events = []
    dev._send_event = lambda ev: events.append([round(ev["ts"] - dev.real0, 1), ev["type"], ev["code"]])
    while dev.t < DURATION_S:
        dev.tick()
    return events


def main() -> int:
    cfg = load_config(ROOT / "config" / "site.yaml")
    for k in ("sensor_noise_cm", "sensor_dropout_prob", "sensor_glitch_prob"):
        cfg["simulator"][k] = 0.0
    names = list(SCENARIOS)

    out = subprocess.run(["node", str(ROOT / "dashboard" / "scripts" / "crosscheck.ts"), str(DURATION_S), *names],
                         capture_output=True, text=True, check=True).stdout
    ts = json.loads(out)
    ok = True

    # 1. The app's lab profile must match site.yaml.
    site = load_config(ROOT / "config" / "site.yaml")
    expected = {**site["geometry"], **site["simulator"]}
    for k, v in ts["lab_profile"]["plant"].items():
        if k in expected and float(expected[k]) != float(v):
            print(f"MISMATCH lab profile {k}: app {v} vs site.yaml {expected[k]}")
            ok = False
    for k, v in ts["lab_profile"]["setpoints"].items():
        if float(site["setpoints"][k]) != float(v):
            print(f"MISMATCH lab set-point {k}: app {v} vs site.yaml {site['setpoints'][k]}")
            ok = False

    # 2. Same events, same order, same times.
    for name in names:
        py, js = python_events(cfg, name), ts[name]
        same = len(py) == len(js) and all(
            a[1:] == b[1:] and abs(a[0] - b[0]) <= TIME_TOLERANCE_S for a, b in zip(py, js))
        print(f"{'OK  ' if same else 'DIFF'} {name:13s} {len(py):3d} events (Python) / {len(js):3d} (app)")
        if not same:
            ok = False
            for i, (a, b) in enumerate(zip(py + [None] * len(js), js + [None] * len(py))):
                if a != b and (a is None or b is None or a[1:] != b[1:] or abs(a[0] - b[0]) > TIME_TOLERANCE_S):
                    print(f"     first difference at #{i}: Python {a}  app {b}")
                    break
    print("\nAll scenarios match." if ok else "\nThe two simulators disagree!")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
