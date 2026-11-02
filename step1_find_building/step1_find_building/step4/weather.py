"""Hourly sunshine for Barcelona: a typical year (TMY) from PVGIS.

PVGIS (EU Joint Research Centre) is free and needs no key. One download covers
all 9 blocks: the weather does not change across a few hundred metres, so the
differences between roofs come from shade (step 4's horizon), not from here.

    python -m step4.weather          # downloads data/weather/barcelona_tmy.json

TMY = typical meteorological year: 8760 hours, each month taken from the most
typical real year in 2005-2023. Fields used: G(h) global horizontal, Gb(n)
direct normal, Gd(h) diffuse horizontal (all W/m2) and T2m air temperature.
"""
import argparse
import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import requests

PVGIS_URLS = ["https://re.jrc.ec.europa.eu/api/v5_3/tmy", "https://re.jrc.ec.europa.eu/api/v5_2/tmy"]
FOCUS_LAT, FOCUS_LON = 41.3928, 2.1684   # centre of our 9 blocks
DEFAULT_PATH = Path("data/weather/barcelona_tmy.json")
SUN_YEAR = 2023  # TMY months come from different years; sun angles are computed for one year


@dataclass
class Weather:
    times: np.ndarray   # UTC, datetime64[m], middle of each hour
    ghi: np.ndarray
    dni: np.ndarray
    dhi: np.ndarray
    temp: np.ndarray

    def __len__(self):
        return len(self.times)


def download_tmy(lat=FOCUS_LAT, lon=FOCUS_LON, path=DEFAULT_PATH):
    errors = []
    for url in PVGIS_URLS:
        try:
            r = requests.get(url, params={"lat": lat, "lon": lon, "outputformat": "json"}, timeout=60)
            r.raise_for_status()
            path = Path(path)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(r.text, encoding="utf-8")
            return path
        except requests.RequestException as e:
            errors.append(f"{url}: {e}")
    raise SystemExit("PVGIS download failed. " + "; ".join(errors))


def load_tmy(path=DEFAULT_PATH):
    rows = json.loads(Path(path).read_text(encoding="utf-8"))["outputs"]["tmy_hourly"]
    stamps = [r["time(UTC)"] for r in rows]  # "20070101:0000"
    times = np.array([f"{SUN_YEAR}-{s[4:6]}-{s[6:8]}T{s[9:11]}:30" for s in stamps], dtype="datetime64[m]")
    col = lambda k: np.array([r[k] for r in rows], dtype=float)
    return Weather(times, col("G(h)"), col("Gb(n)"), col("Gd(h)"), col("T2m"))


def main():
    ap = argparse.ArgumentParser(description="Download the PVGIS typical year for our blocks")
    ap.add_argument("--lat", type=float, default=FOCUS_LAT)
    ap.add_argument("--lon", type=float, default=FOCUS_LON)
    ap.add_argument("--out", default=str(DEFAULT_PATH))
    args = ap.parse_args()
    path = download_tmy(args.lat, args.lon, args.out)
    w = load_tmy(path)
    print(f"wrote {path}: {len(w)} hours, {w.ghi.sum() / 1000:.0f} kWh/m2 a year on flat ground")


if __name__ == "__main__":
    main()
