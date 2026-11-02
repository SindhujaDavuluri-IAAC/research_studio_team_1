"""Send pipeline results to the Roofscapes RePowered map (the website/ folder).

Usually you don't call this yourself: add --web to step 2 or step 4 and it runs.

    python -m step4.shade_yield "Carrer de Roger de Llúria 56, Barcelona" --laz-dir data\\lidar --out lluria56 --web
    python -m step4.batch roofs.csv --laz-dir data\\lidar --web
    python -m web.export lluria56          # send a roof you already ran, again

For each roof it writes website/data/roofs/<refcat>.json and refreshes
website/data/roofs/index.json (the list of roofs the map knows).

A roof file holds:
- from step 2: the usable roof area and the obstacles (always)
- from step 4: every panel with its yearly kWh and shade loss, the roof totals,
  the monthly kWh and a typical day for each month ("energy", only when step 4
  ran). The map then shows these numbers instead of its own quick estimate.
- the roof's block number and name, when step 4's batch ran it from the roof test set.

Coordinates are longitude/latitude with 7 decimals (about 1 cm). Each roof is
one small file that the map opens only when someone clicks that roof, so
adding roofs does not make the map slower to open.
"""
import argparse
import json
from pathlib import Path

from pyproj import Transformer
from shapely.geometry import shape

TO_LNGLAT = Transformer.from_crs("EPSG:25831", "EPSG:4326", always_xy=True)
WEB_DIR = Path(__file__).resolve().parents[2] / "website"   # research_studio_team_1/website
ROOFS = Path("data") / "roofs"
ENERGY_KEYS = ("panels", "kwp", "tilt_deg", "azimuth_deg", "yearly_kwh", "kwh_per_kwp", "mean_shade_loss",
               "monthly_kwh", "peak_hour_kw", "panels_left_out", "max_shade_loss")


def _ring(coords):
    """EPSG:25831 ring -> [[lng, lat], ...] without the repeated closing point."""
    ring = [[round(lng, 7), round(lat, 7)] for lng, lat in
            (TO_LNGLAT.transform(c[0], c[1]) for c in coords)]
    if len(ring) > 1 and ring[0] == ring[-1]:
        ring.pop()
    return ring


def _polygons(geom):
    """Shapely (Multi)Polygon in EPSG:25831 -> [[outer, hole, ...], ...] in lng/lat."""
    parts = getattr(geom, "geoms", [geom])
    return [[_ring(p.exterior.coords)] + [_ring(h.coords) for h in p.interiors] for p in parts]


def local_hour(month, utc_hour):
    """Barcelona clock hour: UTC+2 from April to October (summer time), else UTC+1."""
    return (utc_hour + (2 if 4 <= month <= 10 else 1)) % 24


def typical_days(times, hourly):
    """Average kWh in each local clock hour, for each month: 12 lists of 24 numbers.
    times: UTC timestamps (strings like 2023-06-15T11:30 or numpy datetime64)."""
    total = [[0.0] * 24 for _ in range(12)]
    count = [[0] * 24 for _ in range(12)]
    for t, v in zip(times, hourly):
        t = str(t)
        month, hour = int(t[5:7]), int(t[11:13])
        h = local_hour(month, hour)
        total[month - 1][h] += float(v)
        count[month - 1][h] += 1
    return [[round(total[m][h] / count[m][h], 2) if count[m][h] else 0.0 for h in range(24)] for m in range(12)]


def energy_block(summary, panel_rings, kwh, shade_loss, times=None, hourly=None):
    """Step 4 results -> the roof file's "energy" part.

    summary: the "yield" dict from step4.shade_yield; panel_rings: one list of (x, y) corners
    per kept panel (EPSG:25831); kwh and shade_loss: one number per kept panel; times and
    hourly (optional): the roof's hour-by-hour kWh, for the typical day of each month."""
    out = {k: summary.get(k) for k in ENERGY_KEYS}
    out["panel_list"] = [{"ring": _ring(r), "kwh": round(float(k), 1), "loss": round(float(s), 3)}
                         for r, k, s in zip(panel_rings, kwh, shade_loss)]
    if times is not None and hourly is not None and len(hourly):
        out["typical_day_kwh"] = typical_days(times, hourly)
    return out


def web_reading(result, usable_fc, energy=None, extra=None):
    """Step 2 result (+ step 4 energy) + usable GeoJSON (EPSG:25831) -> one roof file for the map."""
    usable = []
    for f in usable_fc.get("features", []):
        usable += _polygons(shape(f["geometry"]))
    obstacles = []
    for o in result["lidar"].get("obstacles", []):
        lng, lat = TO_LNGLAT.transform(o["x"], o["y"])
        obstacles.append({"lng": round(lng, 7), "lat": round(lat, 7),
                          "area_m2": o["area_m2"], "height_m": o["height_m"]})
    points = [p for poly in usable for p in poly[0]]
    if energy:
        points += [p for panel in energy["panel_list"] for p in panel["ring"]]
    b = result["building"]
    return {
        "source": "Pipeline step 2 (read the roof)" + (" + step 4 (shade and yield)" if energy else ""),
        "refcat": b["refcat"][:14],
        "address": b.get("address"),
        "roof": result["roof"],
        "roof_area_m2": result["lidar"].get("roof_area_m2"),
        "lidar_coverage": result["lidar"].get("lidar_coverage"),
        "usable": usable,
        "bbox": [min(p[0] for p in points), min(p[1] for p in points),
                 max(p[0] for p in points), max(p[1] for p in points)] if points else None,
        "obstacles": obstacles,
        "energy": energy,
        **{k: v for k, v in (extra or {}).items() if v not in (None, "")},
    }


def export(result, usable_fc, web_dir=WEB_DIR, energy=None, extra=None):
    """Write data/roofs/<refcat>.json and refresh data/roofs/index.json. Returns the file written.
    Running a roof again replaces its file. extra: e.g. {"block": 5, "block_name": "..."}."""
    reading = web_reading(result, usable_fc, energy, extra)
    roofs = Path(web_dir) / ROOFS
    roofs.mkdir(parents=True, exist_ok=True)
    path = roofs / f"{reading['refcat']}.json"
    path.write_text(json.dumps(reading, separators=(",", ":")), encoding="utf-8")

    index_path = roofs / "index.json"
    index = json.loads(index_path.read_text(encoding="utf-8")) if index_path.exists() else {"roofs": []}
    index["roofs"] = [r for r in index["roofs"] if r["refcat"] != reading["refcat"]]
    e = reading["energy"] or {}
    index["roofs"].append({"refcat": reading["refcat"], "address": reading["address"], "bbox": reading["bbox"],
                           "usable_area_m2": reading["roof"]["usable_area_m2"],
                           "confidence": reading["roof"]["confidence"],
                           "yearly_kwh": e.get("yearly_kwh"), "panels": e.get("panels"), "kwp": e.get("kwp"),
                           "block": reading.get("block"), "block_name": reading.get("block_name")})
    index["roofs"].sort(key=lambda r: r["refcat"])
    index_path.write_text(json.dumps(index, indent=1), encoding="utf-8")
    return path


def _load(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def _hourly(path):
    """time_utc, kwh columns of step 4's <name>_hourly.csv, or (None, None) if it is missing."""
    if not path.exists():
        return None, None
    import csv
    with open(path, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    return [r["time_utc"] for r in rows], [float(r["kwh"]) for r in rows]


def export_files(name, web_dir=WEB_DIR, extra=None):
    """Send a roof you already ran (the --out name you gave step 2 or step 4) to the map."""
    yield_path, panels_path = Path(f"{name}_yield.json"), Path(f"{name}_panels.geojson")
    energy = None
    if yield_path.exists():                 # step 4 ran: it also saved the step 2 numbers it used
        result = _load(yield_path)
        usable_fc = _load(result.get("usable_file") or f"{name}_usable.geojson")
        if panels_path.exists():
            feats = _load(panels_path)["features"]
            times, hourly = _hourly(Path(f"{name}_hourly.csv"))
            energy = energy_block(result["yield"], [f["geometry"]["coordinates"][0] for f in feats],
                                  [f["properties"]["kwh_year"] for f in feats],
                                  [f["properties"]["shade_loss"] for f in feats], times, hourly)
    elif Path(f"{name}.json").exists():     # only step 2 ran
        result = _load(f"{name}.json")
        usable_fc = _load(f"{name}_usable.geojson")
    else:
        raise SystemExit(f"No results called {name}: run step 2 or step 4 with --out {name} first.")
    return export(result, usable_fc, web_dir, energy, extra)


def main():
    ap = argparse.ArgumentParser(description="Send pipeline results to the Roofscapes RePowered map")
    ap.add_argument("names", nargs="+", help="the --out names you gave step 2 or step 4, e.g. lluria56")
    ap.add_argument("--web", default=str(WEB_DIR), help="the website folder (default: ../website)")
    args = ap.parse_args()
    for name in args.names:
        print("wrote", export_files(name, args.web))


if __name__ == "__main__":
    main()
