"""Send step 5's sharing groups to the 3D map.

    python -m step5.sharing                       # writes data/sharing (500 m rule)
    python -m web.sharing                         # -> ../website/data/sharing.json

    python -m step5.sharing --max-distance 2000 --out data/sharing_2km
    python -m web.sharing --sharing data/sharing_2km --rule 2000   # adds the 2 km rule

Reads step 5's buildings.csv and groups.csv and the roof test set (for each building's
point), and writes website/data/sharing.json: the totals for the whole area (with and
without sharing), every group with its members, and every building's use and coverage.
Each --rule is kept beside the others, so the map can switch between 500 m, 2 km and 5 km.

Only needs the standard library.
"""
import argparse
import csv
import json
from datetime import date
from pathlib import Path

WEB_DIR = Path(__file__).resolve().parents[2] / "website"   # research_studio_team_1/website
OUT = WEB_DIR / "data" / "sharing.json"


def _rows(path):
    with open(path, newline="", encoding="utf-8-sig") as f:
        return list(csv.DictReader(f))


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _ref(v):
    return (v or "").strip()[:14].upper()


def sharing_rule(buildings_rows, groups_rows, roofs_rows):
    """Step 5's CSV rows -> one rule's part of sharing.json."""
    points = {_ref(r.get("refcat")): (_num(r.get("lat")), _num(r.get("lon"))) for r in roofs_rows}
    buildings = {}
    for r in buildings_rows:
        ref = _ref(r["refcat"])
        lat, lon = points.get(ref, (None, None))
        buildings[ref] = {"address": r.get("address"), "block": int(r["block"]) if str(r.get("block", "")).isdigit() else None,
                          "group": int(r["group"]) if str(r.get("group", "")).isdigit() else None,
                          "lat": lat, "lon": lon,
                          "use_kwh": _num(r.get("predicted_use_kwh")), "solar_kwh": _num(r.get("solar_kwh")),
                          "self_kwh": _num(r.get("self_consumed_kwh")), "received_kwh": _num(r.get("received_kwh")),
                          "surplus_kwh": _num(r.get("surplus_kwh")), "covered_pct": _num(r.get("covered_pct"))}
    groups = []
    for g in groups_rows:
        gid = int(g["group"])
        members = [ref for ref, b in buildings.items() if b["group"] == gid]
        by_address = {buildings[m]["address"]: m for m in members}
        starter = by_address.get(g.get("started_by")) or max(members, key=lambda m: buildings[m]["surplus_kwh"] or 0, default=None)
        groups.append({"id": gid, "starter": starter, "started_by": g.get("started_by"),
                       "members": [starter] + [m for m in members if m != starter] if starter else members,
                       "solar_kwh": _num(g.get("solar_kwh")), "self_kwh": _num(g.get("self_consumed_kwh")),
                       "shared_kwh": _num(g.get("shared_kwh")), "grid_kwh": _num(g.get("exported_kwh")),
                       "use_kwh": _num(g.get("use_kwh")), "covered_pct": _num(g.get("covered_pct"))})
    total = lambda k: sum(b[k] or 0 for b in buildings.values())
    use, solar, own, received = total("use_kwh"), total("solar_kwh"), total("self_kwh"), total("received_kwh")
    totals = {"buildings": len(buildings), "groups": len(groups), "use_kwh": round(use), "solar_kwh": round(solar),
              "self_kwh": round(own), "shared_kwh": round(received), "grid_kwh": round(solar - own - received),
              "covered_pct": round(100 * (own + received) / use, 1) if use else None,
              "covered_alone_pct": round(100 * own / use, 1) if use else None}
    return {"totals": totals, "groups": groups, "buildings": buildings}


def export(sharing_dir, roofs_csv, rule_m=500, out=OUT):
    sharing_dir = Path(sharing_dir)
    part = sharing_rule(_rows(sharing_dir / "buildings.csv"), _rows(sharing_dir / "groups.csv"), _rows(roofs_csv))
    out = Path(out)
    data = json.loads(out.read_text(encoding="utf-8")) if out.exists() else {"rules": {}}
    data["rules"][str(int(rule_m))] = {**part, "made": date.today().isoformat()}
    data["source"] = "Pipeline step 5 (use and sharing groups)"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
    return out, part["totals"]


def main():
    ap = argparse.ArgumentParser(description="Send step 5's sharing groups to the 3D map")
    ap.add_argument("--sharing", default="data/sharing", help="step 5's --out folder")
    ap.add_argument("--roofs", default="data/roof_test_set/roof_test_set.csv")
    ap.add_argument("--rule", type=float, default=500, help="the --max-distance step 5 used, in metres")
    ap.add_argument("--out", default=str(OUT))
    args = ap.parse_args()
    out, t = export(args.sharing, args.roofs, args.rule, args.out)
    print(f"wrote {out}: {t['groups']} groups, {t['buildings']} buildings, solar covers {t['covered_pct']}% "
          f"of the use ({t['covered_alone_pct']}% without sharing)")


if __name__ == "__main__":
    main()
