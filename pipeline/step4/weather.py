"""Hourly sunshine for Barcelona: a typical year (TMY) from PVGIS, or an EPW file.

PVGIS (EU Joint Research Centre) is free and needs no key. One download covers
all 9 blocks: the weather does not change across a few hundred metres, so the
differences between roofs come from shade (step 4's horizon), not from here.

    python -m step4.weather          # downloads data/weather/barcelona_tmy.json (the default)

EPW files (EnergyPlus weather, found with Ladybug EPW Map, hosted by
climate.onebuilding.org) work too. Give the .epw, or the .zip it came in, as
--weather to step4.shade_yield or step4.batch:

    python -m step4.batch data\\roof_test_set\\roof_test_set.csv --laz-dir data\\lidar ^
        --weather data\\weather\\ESP_CT_Barcelona.081800_TMYx.epw --out data\\yield_epw

PVGIS stays the default, so runs without --weather give the same numbers as before.
To see how the two typical years differ before running a batch:

    python -m step4.weather --compare data\\weather\\ESP_CT_Barcelona.081800_TMYx.epw

TMY = typical meteorological year: 8760 hours, each month taken from the most
typical real year in the record. Fields used: global horizontal, direct normal
and diffuse horizontal sun (all W/m2) and air temperature.
"""
import argparse
import io
import json
import zipfile
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
    source: str = "PVGIS"

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
    """Load a typical year. .epw and .zip files are read as EPW, anything else as PVGIS JSON."""
    suffix = Path(path).suffix.lower()
    if suffix in (".epw", ".zip"):
        return load_epw(path)
    rows = json.loads(Path(path).read_text(encoding="utf-8"))["outputs"]["tmy_hourly"]
    stamps = [r["time(UTC)"] for r in rows]  # "20070101:0000"
    times = np.array([f"{SUN_YEAR}-{s[4:6]}-{s[6:8]}T{s[9:11]}:30" for s in stamps], dtype="datetime64[m]")
    col = lambda k: np.array([r[k] for r in rows], dtype=float)
    return Weather(times, col("G(h)"), col("Gb(n)"), col("Gd(h)"), col("T2m"), "PVGIS")


def _epw_text(path):
    path = Path(path)
    if path.suffix.lower() == ".zip":
        with zipfile.ZipFile(path) as z:
            names = [n for n in z.namelist() if n.lower().endswith(".epw")]
            if not names:
                raise SystemExit(f"No .epw file inside {path}")
            return z.read(names[0]).decode("latin-1")
    return path.read_text(encoding="latin-1")


def load_epw(path):
    """Read an EnergyPlus weather file into the same hourly Weather as PVGIS.

    EPW rows are in local standard time and hour h covers the hour that ENDS at h,
    so the middle of the hour in UTC is h - 0.5 - time zone. Hours that fall into
    the previous year after the shift (the first hour or so of 1 January) wrap to
    the end of December, so the year stays 8760 hours in time order.
    """
    lines = _epw_text(path).splitlines()
    loc = lines[0].split(",")
    tz_hours = float(loc[8]) if len(loc) > 8 and loc[8].strip() else 1.0   # Barcelona: +1
    rows = [ln.split(",") for ln in lines[8:] if ln.strip()]
    rows = [r for r in rows if not (r[1].strip() == "2" and r[2].strip() == "29")]   # no leap day
    if len(rows) != 8760:
        raise SystemExit(f"{path}: expected 8760 hours, found {len(rows)}")
    month = np.array([int(r[1]) for r in rows])
    day = np.array([int(r[2]) for r in rows])
    hour = np.array([int(r[3]) for r in rows])
    dates = np.array([f"{SUN_YEAR}-{m:02d}-{d:02d}" for m, d in zip(month, day)], dtype="datetime64[m]")
    offset_min = np.round((hour - 0.5 - tz_hours) * 60).astype(int)
    times = dates + offset_min.astype("timedelta64[m]")
    year_start = np.datetime64(f"{SUN_YEAR}-01-01T00:00")
    year_end = np.datetime64(f"{SUN_YEAR + 1}-01-01T00:00")
    times = np.where(times < year_start, times + (year_end - year_start), times)
    times = np.where(times >= year_end, times - (year_end - year_start), times)

    def col(i, missing):
        v = np.array([float(r[i]) for r in rows])
        v[v >= missing] = np.nan
        return v

    temp, ghi, dni, dhi = col(6, 99.9), col(13, 9999), col(14, 9999), col(15, 9999)
    for name, v in (("temperature", temp), ("global", ghi), ("direct", dni), ("diffuse", dhi)):
        gaps = int(np.isnan(v).sum())
        if gaps > 24:
            raise SystemExit(f"{path}: {gaps} missing hours of {name} sun/temperature, too many to fill")
    order = np.argsort(times)
    fill = lambda v: np.nan_to_num(v, nan=float(np.nanmean(v)))[order]
    ghi, dni, dhi = (np.clip(fill(v), 0, None) for v in (ghi, dni, dhi))
    station = loc[1].strip() if len(loc) > 1 else Path(path).stem
    return Weather(times[order], ghi, dni, dhi, fill(temp), f"EPW {station}")


def monthly_sun(w):
    """kWh/m2 of global sun on flat ground for each month."""
    months = w.times.astype("datetime64[M]").astype(int) % 12
    return np.array([w.ghi[months == m].sum() / 1000 for m in range(12)])


def compare(epw_path, pvgis_path=DEFAULT_PATH):
    """Print monthly flat-ground sun and mean temperature for PVGIS next to the EPW."""
    a, b = load_tmy(pvgis_path), load_tmy(epw_path)
    sa, sb = monthly_sun(a), monthly_sun(b)
    ma = a.times.astype("datetime64[M]").astype(int) % 12
    mb = b.times.astype("datetime64[M]").astype(int) % 12
    names = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split()
    print(f"{'':4} {'PVGIS sun':>10} {'EPW sun':>9} {'diff':>6}   {'PVGIS C':>8} {'EPW C':>6}")
    for m in range(12):
        diff = (sb[m] - sa[m]) / sa[m] * 100 if sa[m] else 0
        print(f"{names[m]:4} {sa[m]:10.0f} {sb[m]:9.0f} {diff:+5.0f}%   "
              f"{a.temp[ma == m].mean():8.1f} {b.temp[mb == m].mean():6.1f}")
    total = (sb.sum() - sa.sum()) / sa.sum() * 100
    print(f"year {sa.sum():10.0f} {sb.sum():9.0f} {total:+5.0f}%   (kWh/m2 on flat ground; {b.source})")
    return sa, sb


def main():
    ap = argparse.ArgumentParser(description="Download the PVGIS typical year, or compare it with an EPW file")
    ap.add_argument("--lat", type=float, default=FOCUS_LAT)
    ap.add_argument("--lon", type=float, default=FOCUS_LON)
    ap.add_argument("--out", default=str(DEFAULT_PATH))
    ap.add_argument("--compare", metavar="EPW", help="an .epw (or .zip) to compare with the PVGIS year in --out")
    args = ap.parse_args()
    if args.compare:
        if not Path(args.out).exists():
            raise SystemExit(f"No PVGIS file at {args.out}. Run: python -m step4.weather")
        compare(args.compare, args.out)
        return
    path = download_tmy(args.lat, args.lon, args.out)
    w = load_tmy(path)
    print(f"wrote {path}: {len(w)} hours, {w.ghi.sum() / 1000:.0f} kWh/m2 a year on flat ground")


if __name__ == "__main__":
    main()
