"""Step 5b: group buildings so roofs with spare midday sun supply their neighbours.

    python -m step5.sharing --roofs data\\roof_test_set\\roof_test_set.csv --yield-dir data\\yield_all --out data\\sharing

For every building in the roof test set:
1. its own panels first cover its own use, hour by hour (step 4 hourly kWh vs step 5a demand),
2. what is left over (surplus) can go to other buildings in a sharing group, and
3. what still has no taker goes to the grid.

Shared self-consumption (RD 244/2019, art. 3.g) allows sharing between buildings on the
same low-voltage transformer, the same cadastral plot, or within a set distance: 500 m in
the original decree, 5 km today for solar up to 5 MW (RDL 7/2026). We use 500 m by
default, the strictest rule, so every group found is legal under all of them.
Since 2021 the shares (beta coefficients) can change hour by hour, so each hour the
group's surplus is split in proportion to what each member still needs.

Groups are built greedily: take the building with the most surplus, then keep adding the
building (within the distance) that would absorb the most of the group's remaining surplus,
until adding one more takes up less than --min-gain kWh a year or the group reaches
--max-members. Then repeat with the next building with surplus. A building is in one group.

Outputs in --out:
- buildings.csv  every building: predicted use, own solar, self-consumed, received, exported, % covered
- groups.csv     every group: members, solar, shared kWh, exported kWh, % of the group's use covered
- buildings_demand_cache.json  Catastro answers (dwellings, floors), so reruns are fast
"""
import argparse
import csv
import math
from pathlib import Path

import numpy as np

from step4.batch import slug

from . import demand as dm

MAX_DISTANCE_M = 500.0
MAX_MEMBERS = 12
MIN_GAIN_KWH = 200.0


def read_hourly(path):
    times, kwh = [], []
    with open(path, newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            times.append(r["time_utc"])
            kwh.append(float(r["kwh"]))
    return np.array(times, dtype="datetime64[m]"), np.array(kwh)


def distance_m(a, b):
    lat1, lon1, lat2, lon2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 2 * 6371000 * math.asin(math.sqrt(h))


def split_surplus(surplus, needs):
    """Share each hour's surplus among members in proportion to their need.
    Returns (received per member: list of arrays, exported array)."""
    total_need = np.sum(needs, axis=0) if needs else np.zeros_like(surplus)
    given = np.minimum(surplus, total_need)
    with np.errstate(invalid="ignore", divide="ignore"):
        share = np.where(total_need > 0, given / total_need, 0.0)
    return [n * share for n in needs], surplus - given


def form_groups(buildings, max_distance=MAX_DISTANCE_M, max_members=MAX_MEMBERS, min_gain=MIN_GAIN_KWH):
    """buildings: dict refcat -> {surplus, need, latlon} (8760-hour arrays).
    Returns a list of groups (lists of refcats); the first member started the group."""
    free = set(buildings)
    groups = []
    for start in sorted(buildings, key=lambda r: -buildings[r]["surplus"].sum()):
        if start not in free or buildings[start]["surplus"].sum() < min_gain:
            continue
        free.discard(start)
        members = [start]
        pool = buildings[start]["surplus"].copy()      # all surplus in the group, per hour
        need = buildings[start]["need"].copy()         # all remaining need in the group, per hour
        shared = np.minimum(pool, need).sum()
        while len(members) < max_members:
            best, best_gain = None, min_gain
            for cand in free:
                b = buildings[cand]
                if any(distance_m(b["latlon"], buildings[m]["latlon"]) > max_distance for m in members):
                    continue
                gain = np.minimum(pool + b["surplus"], need + b["need"]).sum() - shared
                if gain > best_gain:
                    best, best_gain = cand, gain
            if best is None:
                break
            members.append(best)
            free.discard(best)
            pool = pool + buildings[best]["surplus"]
            need = need + buildings[best]["need"]
            shared += best_gain
        groups.append(members)
    return groups


def evaluate_group(members, buildings):
    surplus = sum(buildings[m]["surplus"] for m in members)
    needs = [buildings[m]["need"] for m in members]
    received, exported = split_surplus(surplus, needs)
    return dict(zip(members, received)), exported


def run(roofs_csv, yield_dir, out_dir, max_distance=MAX_DISTANCE_M, max_members=MAX_MEMBERS,
        min_gain=MIN_GAIN_KWH, lookup=dm.building_from_catastro):
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    yield_dir = Path(yield_dir)
    cache_path = out_dir / "buildings_demand_cache.json"
    cache = dm.load_cache(cache_path)
    with open(roofs_csv, newline="", encoding="utf-8") as f:
        roofs = list(csv.DictReader(f))

    times, shapes, buildings, info, skipped = None, None, {}, {}, []
    for i, r in enumerate(roofs, 1):
        ref = r["refcat"]
        try:
            c = lookup(ref, cache)
        except Exception as e:            # no building on the plot, Catastro down...
            skipped.append((r["address"], str(e)[:120]))
            continue
        if i % 20 == 0:
            dm.save_cache(cache, cache_path)
            print(f"  {i}/{len(roofs)} buildings looked up", flush=True)
        hourly_path = yield_dir / f"{slug(ref)}_hourly.csv"
        if hourly_path.exists():
            t, gen = read_hourly(hourly_path)
            if times is None:
                times, shapes = t, dm.hourly_shapes(t)
        else:
            gen = None                     # no roof result: consumer only
        b = dm.predict_yearly(ref, c["dwellings"], c["floors"] or round(float(r.get("height_m") or 0) / dm.FLOOR_HEIGHT_M) or 1,
                              c["footprint_m2"], c["current_use"], c["year_built"])
        info[ref] = {"row": r, "building": b, "gen": gen}
    dm.save_cache(cache, cache_path)
    if times is None:
        raise SystemExit(f"No *_hourly.csv files in {yield_dir}. Run python -m step4.batch first.")

    for ref, x in info.items():
        use = dm.hourly_demand(x["building"], shapes)
        gen = x["gen"] if x["gen"] is not None else np.zeros_like(use)
        own = np.minimum(gen, use)
        buildings[ref] = {"use": use, "gen": gen, "own": own, "surplus": gen - own, "need": use - own,
                          "latlon": (float(x["row"]["lat"]), float(x["row"]["lon"]))}

    groups = form_groups(buildings, max_distance, max_members, min_gain)
    group_of, received, exported_by_group = {}, {}, {}
    for g, members in enumerate(groups, 1):
        rec, exp = evaluate_group(members, buildings)
        received.update(rec)
        exported_by_group[g] = exp
        for m in members:
            group_of[m] = g

    rows = []
    for ref, b in buildings.items():
        x = info[ref]
        use, gen, own = b["use"].sum(), b["gen"].sum(), b["own"].sum()
        rec = received.get(ref, np.zeros(1)).sum()
        exported = b["surplus"].sum() if ref not in group_of else None
        rows.append({"address": x["row"]["address"], "block": x["row"].get("block", ""), "refcat": ref,
                     "group": group_of.get(ref, ""), "dwellings": x["building"].dwellings,
                     "floors": x["building"].floors, "predicted_use_kwh": round(use),
                     "solar_kwh": round(gen), "self_consumed_kwh": round(own), "received_kwh": round(rec),
                     "surplus_kwh": round(b["surplus"].sum()),
                     "covered_pct": round(100 * (own + rec) / use, 1) if use else "",
                     "exported_kwh_if_alone": round(exported) if exported is not None else ""})
    rows.sort(key=lambda r: (r["group"] == "", r["group"] or 0, -r["solar_kwh"]))
    _write(out_dir / "buildings.csv", rows)

    grows = []
    for g, members in enumerate(groups, 1):
        use = sum(buildings[m]["use"].sum() for m in members)
        gen = sum(buildings[m]["gen"].sum() for m in members)
        own = sum(buildings[m]["own"].sum() for m in members)
        shared = sum(received[m].sum() for m in members)
        grows.append({"group": g, "members": len(members),
                      "started_by": info[members[0]]["row"]["address"],
                      "addresses": " | ".join(info[m]["row"]["address"] for m in members),
                      "solar_kwh": round(gen), "self_consumed_kwh": round(own), "shared_kwh": round(shared),
                      "exported_kwh": round(exported_by_group[g].sum()), "use_kwh": round(use),
                      "covered_pct": round(100 * (own + shared) / use, 1) if use else ""})
    _write(out_dir / "groups.csv", grows)

    tot_use = sum(b["use"].sum() for b in buildings.values())
    tot_gen = sum(b["gen"].sum() for b in buildings.values())
    tot_own = sum(b["own"].sum() for b in buildings.values())
    tot_shared = sum(v.sum() for v in received.values())
    print(f"\n{len(buildings)} buildings, {len(groups)} sharing groups"
          f"{f', {len(skipped)} plots skipped (no building)' if skipped else ''}")
    print(f"predicted use {tot_use / 1000:,.0f} MWh/yr, solar {tot_gen / 1000:,.0f} MWh/yr")
    print(f"used in its own building {tot_own / 1000:,.0f} MWh, shared with neighbours {tot_shared / 1000:,.0f} MWh, "
          f"to the grid {(tot_gen - tot_own - tot_shared) / 1000:,.0f} MWh")
    print(f"solar covers {100 * (tot_own + tot_shared) / tot_use:.1f}% of the use "
          f"({100 * tot_own / tot_use:.1f}% without sharing) -> {out_dir}")
    return rows, grows


def _write(path, rows):
    with open(path, "w", newline="", encoding="utf-8") as f:
        if not rows:
            f.write("")
            return
        w = csv.DictWriter(f, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)


def main():
    ap = argparse.ArgumentParser(description="Step 5: predict demand and form sharing groups")
    ap.add_argument("--roofs", default="data/roof_test_set/roof_test_set.csv")
    ap.add_argument("--yield-dir", default="data/yield_all", help="folder written by python -m step4.batch")
    ap.add_argument("--out", default="data/sharing")
    ap.add_argument("--max-distance", type=float, default=MAX_DISTANCE_M, help="metres (500 default; 5000 under RDL 7/2026)")
    ap.add_argument("--max-members", type=int, default=MAX_MEMBERS)
    ap.add_argument("--min-gain", type=float, default=MIN_GAIN_KWH)
    ap.add_argument("--block", type=int, nargs="+", help="only these blocks, e.g. --block 6")
    args = ap.parse_args()
    roofs = args.roofs
    if args.block:
        tmp = Path(args.out) / "roofs_selected.csv"
        Path(args.out).mkdir(parents=True, exist_ok=True)
        with open(args.roofs, newline="", encoding="utf-8") as f:
            rd = csv.DictReader(f)
            keep = [r for r in rd if str(r.get("block", "")).strip() in {str(b) for b in args.block}]
            fields = rd.fieldnames
        with open(tmp, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=fields)
            w.writeheader()
            w.writerows(keep)
        roofs = tmp
    run(roofs, args.yield_dir, args.out, args.max_distance, args.max_members, args.min_gain)


if __name__ == "__main__":
    main()
