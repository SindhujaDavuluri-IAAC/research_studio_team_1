"""Run steps 3 and 4 for many roofs and rank them.

    python -m step4.batch roofs.csv --laz-dir data\\lidar --out data\\yield

roofs.csv has the columns address,block (the same file step 2 uses for chips).
Each roof gets its own outputs in --out, and ranking.csv lists every roof from
the most to the least yearly kWh. A roof that fails is listed with its error
instead of stopping the run.
"""
import argparse
import csv
import re
import time
from pathlib import Path

from .shade_yield import shade_yield
from .weather import DEFAULT_PATH

COLUMNS = ["rank", "address", "block", "refcat", "panels", "kwp", "yearly_kwh", "kwh_per_kwp",
           "mean_shade_loss", "usable_area_m2", "error"]


def slug(text):
    return re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")[:60]


def run_batch(csv_path, laz_dir, out_dir, weather_path=DEFAULT_PATH):
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    with open(csv_path, newline="", encoding="utf-8") as f:
        roofs = list(csv.DictReader(f))
    rows = []
    t0 = time.time()
    for i, r in enumerate(roofs, 1):
        row = {"address": r["address"], "block": r.get("block", "")}
        try:
            res = shade_yield(laz_dir, r["address"], usable_path=None, weather_path=weather_path,
                              out=str(out_dir / slug(r["address"])))
            y = res["yield"]
            row.update(refcat=res["building"]["refcat"], usable_area_m2=res["usable_area_m2"],
                       **{k: y[k] for k in ("panels", "kwp", "yearly_kwh", "kwh_per_kwp", "mean_shade_loss")})
        except (Exception, SystemExit) as e:
            row["error"] = str(e)[:200]
        rows.append(row)
        print(f"[{i}/{len(roofs)}] {r['address']}: {row.get('yearly_kwh', row.get('error'))}")
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
    args = ap.parse_args()
    run_batch(args.roofs_csv, args.laz_dir, args.out, args.weather)


if __name__ == "__main__":
    main()
