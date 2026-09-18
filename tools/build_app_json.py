#!/usr/bin/env python3
"""Generate app.json from the .homeycompose source files.

The Homey CLI v1/v2 composed app.json automatically during a build, but the
current CLI (v4) expects app.json to exist. This script performs the same merge
so the app can be installed with `homey app install`:

    .homeycompose/app.json            -> app level manifest
    .homeycompose/flow/<kind>/*.json  -> app level flow cards
    drivers/<id>/driver.compose.json  -> drivers[].*
    drivers/<id>/driver.flow.compose.json -> drivers[].flow.*

Usage:
    python tools/build_app_json.py
"""

from __future__ import annotations

import json
import os
import sys

APP_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

FLOW_KINDS = ("actions", "conditions", "triggers")


def load_json(path: str):
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def build() -> dict:
    app = load_json(os.path.join(APP_ROOT, ".homeycompose", "app.json"))

    # App level flow cards
    flow = {}
    for kind in FLOW_KINDS:
        directory = os.path.join(APP_ROOT, ".homeycompose", "flow", kind)
        if not os.path.isdir(directory):
            continue
        cards = []
        for name in sorted(os.listdir(directory)):
            if name.endswith(".json"):
                cards.append(load_json(os.path.join(directory, name)))
        if cards:
            flow[kind] = cards
    if flow:
        app["flow"] = flow

    # Drivers (as an array, with their own flow cards)
    drivers = []
    drivers_root = os.path.join(APP_ROOT, "drivers")
    if os.path.isdir(drivers_root):
        for name in sorted(os.listdir(drivers_root)):
            driver_dir = os.path.join(drivers_root, name)
            compose_path = os.path.join(driver_dir, "driver.compose.json")
            if not os.path.isfile(compose_path):
                continue

            manifest = load_json(compose_path)
            manifest.setdefault("id", name)

            flow_path = os.path.join(driver_dir, "driver.flow.compose.json")
            if os.path.isfile(flow_path):
                manifest["flow"] = load_json(flow_path)

            drivers.append(manifest)

    if drivers:
        app["drivers"] = drivers

    return app


def main() -> int:
    app = build()
    destination = os.path.join(APP_ROOT, "app.json")
    with open(destination, "w", encoding="utf-8") as handle:
        json.dump(app, handle, indent=2, ensure_ascii=False)
        handle.write("\n")

    print(f"app.json geschreven: {len(app.get('drivers', []))} driver(s), "
          f"{sum(len(v) for v in app.get('flow', {}).values())} app-flowkaart(en)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
