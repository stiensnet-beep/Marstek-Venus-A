#!/usr/bin/env python3
"""Maak een deelbaar ZIP-pakket van deze Homey-app.

Het pakket bevat alles wat iemand anders nodig heeft om de app met
`homey app install` op zijn eigen Homey te zetten (inclusief de verborgen map
`.homeycompose`, de driver, de documentatie en de hulpscripts).

Gebruik:
    python tools/make_package.py

Resultaat:
    dist/marstek-venus-homey-<versie>.zip
"""

from __future__ import annotations

import json
import os
import zipfile

APP_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST_ROOT = os.path.join(os.path.dirname(APP_ROOT), "dist")

SKIP_DIRS = {"node_modules", ".homeybuild", ".git", "__pycache__", "dist"}
SKIP_FILES = {"app.json"}  # wordt door de Homey CLI zelf gegenereerd


def read_version() -> str:
    with open(os.path.join(APP_ROOT, "package.json"), encoding="utf-8") as handle:
        return json.load(handle).get("version", "0.0.0")


def main() -> int:
    version = read_version()
    os.makedirs(DIST_ROOT, exist_ok=True)
    destination = os.path.join(DIST_ROOT, f"marstek-venus-homey-{version}.zip")

    count = 0
    with zipfile.ZipFile(destination, "w", zipfile.ZIP_DEFLATED) as archive:
        for root, dirs, files in os.walk(APP_ROOT):
            dirs[:] = [name for name in dirs if name not in SKIP_DIRS]
            for name in files:
                if name in SKIP_FILES:
                    continue
                if name.endswith((".pyc", ".log")):
                    continue

                full = os.path.join(root, name)
                relative = os.path.relpath(full, os.path.dirname(APP_ROOT))
                archive.write(full, relative.replace("\\", "/"))
                count += 1

    size_kb = os.path.getsize(destination) / 1024
    print(f"Pakket gemaakt: dist/{os.path.basename(destination)}")
    print(f"  {count} bestanden, {size_kb:.0f} kB")
    print("  Delen met anderen: uitpakken en in die map `homey app install` uitvoeren.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
