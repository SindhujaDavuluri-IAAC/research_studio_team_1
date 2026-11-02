"""Run steps 3 and 4 for many roofs and rank them.

    python -m step4.batch roofs.csv --laz-dir data\\lidar --out data\\yield
    python -m step4.batch roofs.csv --laz-dir data\\lidar --out data\\yield_block5 --block 5
    python -m step4.batch roofs.csv --laz-dir data\\lidar --web       # and show every roof on the map

roofs.csv has the columns address,block (the same file step 2 uses for chips).
The roof test set from `python -m step4.roof_test_set` also works: when a row has
lat and lon, the roof is found from that point instead of geocoding the address.
Each roof gets its own outputs in --out, and ranking.csv lists every roof from
the most to the least yearly kWh. A roof that fails is listed with its error
instead of stopping the run.
"""
import argparse
import csv
import functools
import re
import time
from pathlib import Path

import laspy

from web.export import WEB_DIR

from .shade_yield import shade_yield
from .weather import DEFAULT_PATH

COLUMNS = ["rank", "address", "block", "block_name", "refcat", "panels", "kwp", "yearly_kwh", "kwh_per_kwp",
           "mean_shade_loss", "usable_area_m2", "error"]


def slug(text):
    return re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")[:60]


def _block(row):
    """The roof's block number (an int when it is one) and name, for the map."""
    block = str(row.get("block") or "").strip()
    return {"block": int(block) if block.isdigit() else block or None, "block_name": row.get("block_name") or None}


def keep_lidar_in_memory(maxsize=4):
    """Every roof reads the same LiDAR tiles 3 times (height, roof, shade). Reading a
    1 km tile is the slow part, so during a batch each tile is read from disk once and
    then kept in memory (about 1 GB per tile)."""
    if getattr(laspy.read, "_cached", False):
        return
    original = laspy.read

    @functools.lru_cache(maxsize=maxsize)
    def _read(path):
        return original(path)

    def read(source, *args, **kwargs):
        if args or kwargs or not isinstance(source, (str, Path)):
            return original(source, *args, **kwargs)
        return _read(str(Path(source).resolve()))

    read._cached = True
    laspy.read = read


def run_batch(csv_path, laz_dir, out_dir, weather_path=DEFAULT_PATH, blocks=None, web_dir=None):
    keep_lidar_in_memory()
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    with open(csv_path, newline="", encoding="utf-8-sig") as f:
        roofs = list(csv.DictReader(f))
    if blocks:
        roofs = [r for r in roofs if str(r.get("block", "")).strip() in {str(b) for b in blocks}]
        print(f"{len(roofs)} roofs in block(s) {', '.join(map(str, blocks))}")
    rows = []
    t0 = time.time()
    for i, r in enumerate(roofs, 1):
        row = {"address": r["address"], "block": r.get("block", ""), "block_name": r.get("block_name", "")}
        lat, lon = (float(r["lat"]), float(r["lon"])) if r.get("lat") and r.get("lon") else (None, None)
        try:
            res = shade_yield(laz_dir, None if lat is not None else r["address"], lat=lat, lon=lon,
                              usable_path=None, weather_path=weather_path,
                              out=str(out_dir / slug(r.get("refcat") or r["address"])), web_dir=web_dir,
                              web_extra=_block(r) if web_dir else None)
            y = res["yield"]
            row.update(refcat=res["building"]["refcat"], usable_area_m2=res["usable_area_m2"],
                       **{k: y[k] for k in ("panels", "kwp", "yearly_kwh", "kwh_per_kwp", "mean_shade_loss")})
        except (Exception, SystemExit) as e:
            row["error"] = str(e)[:200]
        rows.append(row)
        print(f"[{i}/{len(roofs)}] {r['address']}: {row.get('yearly_kwh', row.get('error'))}"
              f"  ({time.time() - t0:.0f} s so far)", flush=True)
    rows.sort(key=lambda x: -(x.get("yearly_kwh") or -1))
    for k, row in enumerate(rows, 1):
        row["rank"] = k if row.get("yearly_kwh") is not None else ""
    with open(out_dir / "ranking.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=COLUMNS)
        w.writeheader()
        w.writerows(rows)
    print(f"ranked {sum(1 for r in rows if r['rank'])} of {len(rows)} roofs in {time.time() - t0:.0f} s"
          f" -> {out_dir / 'ranking.csv'}")
    return rows


def main():
    ap = argparse.ArgumentParser(description="Steps 3 and 4 for a list of roofs, ranked by yearly kWh")
    ap.add_argument("roofs_csv")
    ap.add_argument("--laz-dir", required=True)
    ap.add_argument("--weather", default=str(DEFAULT_PATH))
    ap.add_argument("--out", default="data/yield")
    ap.add_argument("--block", type=int, nargs="+", help="only these block numbers, e.g. --block 5 or --block 5 6")
    ap.add_argument("--web", nargs="?", const=str(WEB_DIR),
                    help="also send every roof to the 3D map (default folder: ../website)")
    args = ap.parse_args()
    run_batch(args.roofs_csv, args.laz_dir, args.out, args.weather, args.block, args.web)


if __name__ == "__main__":
    main()
