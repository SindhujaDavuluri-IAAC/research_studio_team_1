"""Send step 5c's co-investment communities to the 3D map (the Groups tab).

    python -m step5.communities          # Breno's step: writes data/communities
    python -m web.communities            # -> ../website/data/communities.json

Reads communities.csv and members.csv from step 5c's --out folder and writes one small
file the map reads: every group (its host roof, panels, kWh, cost...) with its member
buildings (flats joining, offices or schools, share of the output...). Until this file
exists, the map shows preview groups made in the browser with the same rules.

If you ran step 5c with other settings, say so here too, so the map explains them:
    python -m web.communities --max-distance 5000 --participation 0.3

Only needs the standard library.
"""
import argparse
import csv
import json
from datetime import date
from pathlib import Path

WEB_DIR = Path(__file__).resolve().parents[2] / "website"   # research_studio_team_1/website
OUT = WEB_DIR / "data" / "communities.json"
GROUP_NUMBERS = ("panels", "kwp", "yearly_kwh", "kwh_per_kwp", "buildings", "flats_joining", "offices_schools_joining",
                 "cost_eur", "used_on_the_spot_pct", "saving_eur_per_year", "payback_years", "farthest_member_m")
MEMBER_NUMBERS = ("distance_m", "dwellings", "flats_joining", "beta_pct", "investment_eur", "kwh_per_year",
                  "kwh_used_on_the_spot", "covers_pct_of_their_use", "saving_eur_per_year", "per_flat_investment_eur",
                  "per_flat_kwh", "per_flat_saving_eur", "payback_years", "payback_with_incentives_years", "participants")


def _rows(path):
    with open(path, newline="", encoding="utf-8-sig") as f:
        return list(csv.DictReader(f))


def _num(v):
    """'12' -> 12, '1.5' -> 1.5, '' or 'inf' -> None."""
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    if x != x or x in (float("inf"), float("-inf")):
        return None
    return int(x) if x.is_integer() else x


def _ref(v):
    return (v or "").strip()[:14].upper()


def build(community_rows, member_rows, max_distance=500, participation=0.4):
    """Step 5c's CSV rows -> the map's communities.json (as a dict)."""
    groups = []
    for c in community_rows:
        gid = int(c["community"])
        members = []
        for m in member_rows:
            if int(m["community"]) != gid:
                continue
            members.append({"refcat": _ref(m["refcat"]), "role": m.get("role") or "guest", "address": m.get("address"),
                            "type": m.get("type") or "", "nonhome_joining": m.get("nonhome_joining") or "",
                            **{k: _num(m.get(k)) for k in MEMBER_NUMBERS}})
        members.sort(key=lambda m: (m["role"] != "host", m["distance_m"] or 0))
        groups.append({"id": gid, "host": _ref(c["host_refcat"]), "host_address": c.get("host_address"),
                       "block": _num(c.get("block")),
                       "flags": [f for f in (c.get("flags") or "").split("; ") if f],
                       **{k: _num(c.get(k)) for k in GROUP_NUMBERS}, "members": members})
    groups.sort(key=lambda g: g["id"])
    total = lambda k: sum(g[k] or 0 for g in groups)
    totals = {"groups": len(groups), "roofs": len(groups), "panels": total("panels"), "kwp": round(total("kwp"), 2),
              "yearly_kwh": total("yearly_kwh"), "buildings": total("buildings"), "flats_joining": total("flats_joining"),
              "offices_schools_joining": total("offices_schools_joining"), "cost_eur": total("cost_eur"),
              "saving_eur_per_year": total("saving_eur_per_year")}
    return {"source": "Pipeline step 5c (co-investment communities)", "made": date.today().isoformat(),
            "max_distance_m": max_distance, "participation": participation, "totals": totals, "groups": groups}


def export(folder="data/communities", out=OUT, max_distance=500, participation=0.4):
    folder = Path(folder)
    missing = [n for n in ("communities.csv", "members.csv") if not (folder / n).exists()]
    if missing:
        raise SystemExit(f"No {' or '.join(missing)} in {folder}. Run python -m step5.communities first.")
    data = build(_rows(folder / "communities.csv"), _rows(folder / "members.csv"), max_distance, participation)
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(data, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    return out, data["totals"]


def main():
    ap = argparse.ArgumentParser(description="Send step 5c's communities to the 3D map")
    ap.add_argument("--communities", default="data/communities", help="step 5c's --out folder")
    ap.add_argument("--max-distance", type=float, default=500, help="the --max-distance step 5c used, in metres")
    ap.add_argument("--participation", type=float, default=0.4, help="the --participation step 5c used")
    ap.add_argument("--out", default=str(OUT))
    args = ap.parse_args()
    out, t = export(args.communities, args.out, args.max_distance, args.participation)
    print(f"wrote {out}: {t['groups']} groups, {t['panels']} panels, {t['yearly_kwh']:,} kWh a year, "
          f"{t['buildings']} buildings, {t['flats_joining']} flats")


if __name__ == "__main__":
    main()
