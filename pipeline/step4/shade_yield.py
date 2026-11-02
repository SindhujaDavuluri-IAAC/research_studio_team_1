"""Pipeline steps 3 and 4: lay out panels, then shade and yield. Address in, hourly kWh out.

    python -m step4.shade_yield "Carrer de Roger de Llúria 56, Barcelona" --laz-dir data\\lidar --out lluria56
    python -m step4.shade_yield "..." --laz-dir data\\lidar --usable lluria56_usable.geojson --out lluria56
    python -m step4.shade_yield "..." --laz-dir data\\lidar --out lluria56 --web

Without --usable it reads the roof with step 2's LiDAR rules. With --usable it
uses a step 2 result you already have (for example one read with the AI model).

Writes <out>_yield.json (totals, monthly kWh, every panel), <out>_hourly.csv
(8760 hours of AC kWh for the whole roof, for step 5 and energy sharing),
<out>_panels.geojson (panel outlines, EPSG:25831) and <out>_panels.png. Without
--usable it also writes <out>_usable.geojson (the usable roof it found). With
--web it sends the roof, every panel and the totals to the 3D map, which then
shows these numbers instead of its own quick estimate.
"""
import argparse
import csv
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from shapely.geometry import mapping, shape
from shapely.ops import unary_union

from step1.find_building import find_building
from step2.lidar_roof import read_roof_from_tiles
from step2.read_roof import lidar_only
from step3.layout import Layout, lay_out
from web import export as web_export

from .energy import yield_for_layout
from .horizon import horizons, surface_model
from .weather import DEFAULT_PATH, load_tmy

MOUNT_HEIGHT_M = 0.4   # panel centre above the roof surface
MAX_SHADE_LOSS = 0.4   # drop panels that lose more than this share of their sun to shade


def panel_heights(lroof, centres):
    """Roof surface height under each panel centre, plus the mounting height."""
    row, col = lroof.grid.rowcol(centres[:, 0], centres[:, 1])
    row = row.clip(0, lroof.grid.height - 1)
    col = col.clip(0, lroof.grid.width - 1)
    z = lroof.dsm[row, col]
    fallback = np.nanmedian(lroof.dsm) if np.isfinite(lroof.dsm).any() else 0.0
    return np.where(np.isfinite(z), z, fallback) + MOUNT_HEIGHT_M


def load_usable(path):
    fc = json.loads(Path(path).read_text(encoding="utf-8"))
    geoms = [shape(f["geometry"]) for f in fc.get("features", [])]
    return unary_union(geoms) if geoms else None


def roof_summary(lroof, usable, usable_path):
    """Step 2 numbers for the map: from the step 2 run that made --usable (it may have used
    the AI model), otherwise from the LiDAR reading done here."""
    if usable_path:
        step2_json = Path(str(usable_path).replace("_usable.geojson", ".json"))
        if step2_json.exists() and step2_json != Path(usable_path):
            return json.loads(step2_json.read_text(encoding="utf-8"))["roof"]
        return {**lidar_only(lroof)[0], "method": "usable area given",
                "usable_area_m2": round(usable.area, 1) if usable is not None else 0.0}
    return lidar_only(lroof)[0]


def usable_geojson(usable):
    return {"type": "FeatureCollection",
            "crs": {"type": "name", "properties": {"name": "urn:ogc:def:crs:EPSG::25831"}},
            "features": [] if usable is None or usable.is_empty else
            [{"type": "Feature", "geometry": mapping(usable),
              "properties": {"usable_area_m2": round(usable.area, 1)}}]}


def analyse(lroof, footprint, laz_dir, weather, lat, lon, usable=None, max_shade_loss=MAX_SHADE_LOSS):
    """Steps 3 + 4 for one roof. Returns (kept layout, yearly kWh per kept panel,
    shade loss per kept panel, hourly kWh of the kept panels, dropped panels)."""
    if usable is None:
        usable = lroof.grid.cells_to_polygon(lroof.usable)
    layout = lay_out(usable, footprint)
    if not layout.count:
        return layout, np.zeros(0), np.zeros(0), np.zeros(len(weather)), []
    grid, dsm = surface_model(footprint, laz_dir)
    centres = layout.centres()
    horizon = horizons(grid, dsm, centres[:, 0], centres[:, 1], panel_heights(lroof, centres))
    kwh, loss, hourly, keep = yield_for_layout(layout, horizon, weather, lat, lon, max_shade_loss)
    dropped = [p for p, k in zip(layout.panels, keep) if not k]
    kept = Layout([p for p, k in zip(layout.panels, keep) if k], layout.azimuth_deg, layout.tilt_deg)
    return kept, kwh[keep], loss[keep], hourly, dropped


def summarise(layout, kwh, loss, hourly, weather):
    months = weather.times.astype("datetime64[M]").astype(int) % 12
    total = float(kwh.sum())
    return {
        "panels": layout.count,
        "kwp": round(layout.kwp, 2),
        "tilt_deg": layout.tilt_deg,
        "azimuth_deg": round(layout.azimuth_deg, 1),
        "yearly_kwh": round(total),
        "kwh_per_kwp": round(total / layout.kwp) if layout.count else None,
        "mean_shade_loss": round(float(loss.mean()), 3) if layout.count else None,
        "monthly_kwh": [round(float(hourly[months == m].sum())) for m in range(12)],
        "peak_hour_kw": round(float(hourly.max()), 2),
    }


def panels_png(footprint, usable, layout, kwh, path, dropped=(), px_per_m=10):
    minx, miny, maxx, maxy = footprint.buffer(2).bounds
    w, h = int((maxx - minx) * px_per_m), int((maxy - miny) * px_per_m)
    img = Image.new("RGB", (w, h), (235, 232, 226))
    d = ImageDraw.Draw(img)
    T = lambda xy: [((x - minx) * px_per_m, (maxy - y) * px_per_m) for x, y in xy]
    for g in getattr(usable, "geoms", [usable]) if usable is not None else []:
        d.polygon(T(g.exterior.coords), fill=(255, 240, 150))
        for hole in g.interiors:
            d.polygon(T(hole.coords), fill=(235, 232, 226))
    for g in getattr(footprint, "geoms", [footprint]):
        d.polygon(T(g.exterior.coords), outline=(60, 60, 60))
    for p in dropped:
        d.polygon(T(p.exterior.coords), fill=(200, 200, 200), outline=(150, 150, 150))
    lo, hi = (kwh.min(), kwh.max()) if len(kwh) else (0, 1)
    for p, k in zip(layout.panels, kwh):
        t = 0.0 if hi <= lo else (k - lo) / (hi - lo)   # dark blue = most shade, orange = best
        colour = tuple(int(a + (b - a) * t) for a, b in zip((40, 60, 120), (240, 140, 20)))
        d.polygon(T(p.exterior.coords), fill=colour, outline=(255, 255, 255))
    if len(kwh):
        d.rectangle([6, 6, 22, 18], fill=(40, 60, 120))
        d.text((28, 6), f"most shade ({lo:.0f} kWh/yr)", fill=(30, 30, 30))
        d.rectangle([6, 24, 22, 36], fill=(240, 140, 20))
        d.text((28, 24), f"least shade ({hi:.0f} kWh/yr)", fill=(30, 30, 30))
        d.rectangle([6, 42, 22, 54], fill=(255, 240, 150))
        d.text((28, 42), "usable roof (step 2)", fill=(30, 30, 30))
    if dropped:
        d.rectangle([6, 60, 22, 72], fill=(200, 200, 200))
        d.text((28, 60), f"left out: too much shade ({len(dropped)})", fill=(30, 30, 30))
    img.save(path)


def shade_yield(laz_dir, address=None, lat=None, lon=None, usable_path=None,
                weather_path=DEFAULT_PATH, out="roof", max_shade_loss=MAX_SHADE_LOSS, web_dir=None, web_extra=None):
    record, fp = find_building(address, lat, lon)
    lroof = read_roof_from_tiles(fp, laz_dir, refcat=record.refcat)
    if lroof is None:
        raise SystemExit("No LiDAR tile in --laz-dir covers this building. Download the tile first.")
    if not Path(weather_path).exists():
        raise SystemExit(f"No weather file at {weather_path}. Run: python -m step4.weather")
    weather = load_tmy(weather_path)
    usable = load_usable(usable_path) if usable_path else lroof.grid.cells_to_polygon(lroof.usable)
    layout, kwh, loss, hourly, dropped = analyse(lroof, fp, laz_dir, weather, record.lat, record.lon,
                                                 usable, max_shade_loss)

    usable_fc = usable_geojson(usable)
    if usable_path:
        usable_file = str(usable_path)
    else:
        usable_file = f"{out}_usable.geojson"
        Path(usable_file).write_text(json.dumps(usable_fc), encoding="utf-8")

    result = {
        "building": {"refcat": record.refcat, "address": record.catastro_address, "query": record.query},
        "yield": {**summarise(layout, kwh, loss, hourly, weather), "panels_left_out": len(dropped),
                  "max_shade_loss": max_shade_loss},
        "usable_area_m2": round(usable.area, 1) if usable is not None else 0.0,
        "usable_file": usable_file,
        "roof": roof_summary(lroof, usable, usable_path),   # step 2 numbers, for the map
        "lidar": lroof.summary,
        "panels": [{"x": round(p.centroid.x, 2), "y": round(p.centroid.y, 2),
                    "kwh_year": round(float(k), 1), "shade_loss": round(float(s), 3)}
                   for p, k, s in zip(layout.panels, kwh, loss)],
    }
    Path(f"{out}_yield.json").write_text(json.dumps(result, indent=2, default=str), encoding="utf-8")
    with open(f"{out}_hourly.csv", "w", newline="", encoding="utf-8") as f:
        wr = csv.writer(f)
        wr.writerow(["time_utc", "kwh"])
        wr.writerows((str(t), round(float(v), 4)) for t, v in zip(weather.times, hourly))
    fc = {"type": "FeatureCollection",
          "crs": {"type": "name", "properties": {"name": "urn:ogc:def:crs:EPSG::25831"}},
          "features": [{"type": "Feature", "geometry": mapping(p),
                        "properties": {"kwh_year": round(float(k), 1), "shade_loss": round(float(s), 3)}}
                       for p, k, s in zip(layout.panels, kwh, loss)]}
    Path(f"{out}_panels.geojson").write_text(json.dumps(fc), encoding="utf-8")
    panels_png(fp, usable, layout, kwh, f"{out}_panels.png", dropped)
    if web_dir:
        energy = web_export.energy_block(result["yield"], [list(p.exterior.coords) for p in layout.panels],
                                         kwh, loss, weather.times, hourly)
        result["web_file"] = str(web_export.export(result, usable_fc, web_dir, energy, web_extra))
    return result


def main():
    ap = argparse.ArgumentParser(description="Pipeline steps 3 and 4: panel layout, shade and yield")
    ap.add_argument("address", nargs="?")
    ap.add_argument("--lat", type=float)
    ap.add_argument("--lon", type=float)
    ap.add_argument("--laz-dir", required=True, help="folder with ICGC LAZ tiles")
    ap.add_argument("--usable", help="step 2 usable area (<name>_usable.geojson); leave out to read the roof with LiDAR")
    ap.add_argument("--weather", default=str(DEFAULT_PATH), help="PVGIS typical year (python -m step4.weather)")
    ap.add_argument("--max-shade", type=float, default=MAX_SHADE_LOSS,
                    help="leave out panels losing more than this share of their sun (default 0.4; 1 keeps all)")
    ap.add_argument("--out", default="roof", help="output name, without extension")
    ap.add_argument("--web", nargs="?", const=str(web_export.WEB_DIR),
                    help="also send the results to the 3D map (default folder: ../website)")
    args = ap.parse_args()
    if not args.address and (args.lat is None or args.lon is None):
        ap.error("give an address, or both --lat and --lon")
    result = shade_yield(args.laz_dir, args.address, args.lat, args.lon, args.usable, args.weather, args.out,
                         args.max_shade, args.web)
    print(json.dumps({k: result.get(k) for k in ("building", "yield", "usable_area_m2", "web_file")}, indent=2))


if __name__ == "__main__":
    main()
