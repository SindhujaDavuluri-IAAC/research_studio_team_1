"""Step 5c: co-investment solar communities around the best roofs.

    python -m step5.communities --yield-dir data\\yield_all_v2 --out data\\communities

The idea: a city agency puts panels only on the roofs that produce the most per panel
(highest kWh per kWp in step 4). Flats, offices and schools nearby co-invest in that
installation, and each gets a fixed share (beta) of its output under RD 244/2019
collective self-consumption with surplus. Panels do not have to cover a building's use.

1. Hosts: the --hosts roofs with the highest kWh/kWp, at least --min-kwp.
2. Each host forms one community, best host first. Participants join in this order:
   a. the host building's own flats (a share of them, PARTICIPATION),
   b. then neighbours ring by ring (NEAR_RING_M) outwards from the host. In each ring,
      offices and schools come first (complementarity: they use power in sunny hours,
      homes mostly in the morning and evening), up to MAX_NONHOME_TOTAL of the
      installation, then flats.
   Each participant brings its "sunny-hour use" (use weighted by how strong the sun is
   that hour). Participants are added until that adds up to the installation's output,
   so most of each share is used at the moment it is produced.
3. beta = participant's sunny-hour use / total; it is fixed for the whole year and each
   participant pays beta x the cost. Each hour a participant gets beta x output: what it
   uses then saves the full price, the rest is surplus credited on the bill.
4. A building belongs to one community only. Members must be within --max-distance of
   the host, minus a DISTANCE_MARGIN_M margin, because the law measures between meters and
   we only know plot centres.

Legal rules from the legal check (Legal check for the rooftop solar tool, 2026-11-03):
500 m default (5,000 m for solar up to 5 MW since 22 March 2026, --max-distance 5000);
fixed beta; surplus credited only if the installation is 100 kW or less; permits likely
needed above 15 kW; IBI bonus counted for host-building owners only.

Every price and rate below is an ASSUMPTION for a planning estimate, not a quote.

Outputs in --out:
- communities.csv  one row per community: host, kWp, kWh, members, cost, % used on the spot, payback
- members.csv      one row per member building: role, type, distance, participants, beta, cost, kWh, savings
- communities.png  map: members coloured by community, hosts outlined in black
- communities.geojson  the same plots with their community, for QGIS or the 3D map
"""
import argparse
import csv
import json
import math
from pathlib import Path

import numpy as np

from step4.batch import slug

from . import demand as dm
from .sharing import distance_m, read_hourly

# Who and where
HOSTS = 10
MIN_KWP = 5.0
MAX_DISTANCE_M = 500.0
DISTANCE_MARGIN_M = 50.0
NEAR_RING_M = 150.0      # guests are taken ring by ring outwards from the host
PARTICIPATION = 0.4      # ASSUMPTION: 40% of the flats in a building sign up
MAX_NONHOME_SHARE = 0.2  # ASSUMPTION: one office or school takes at most 20% of an installation
MAX_NONHOME_TOTAL = 0.4  # ...and all offices and schools together at most 40%, so flats keep most of it
# Money (ASSUMPTIONS, 2026 Spain; see the legal check doc)
COST_EUR_PER_KWP = 1400.0        # installed, VAT included (OCU 2026: 1,330-1,500)
PRICE_EUR_PER_KWH = 0.16         # what a kWh used on the spot saves on the bill
SURPLUS_EUR_PER_KWH = 0.05       # what a surplus kWh is credited
ICIO_RATE, ICIO_BONUS = 0.04, 0.95   # Barcelona ICIO 4% of cost, 95% bonus (ordinance 2026 art. 7.4)
IBI_EUR_PER_FLAT = 300.0         # ASSUMPTION: yearly IBI of an Eixample flat
IBI_BONUS, IBI_YEARS = 0.5, 3    # IBI ordinance 2025 art. 9.6, host-building owners only
COMPENSATION_MAX_KWP = 100.0     # RD 244/2019 art. 4.2.a
PERMIT_FREE_MAX_KWP = 15.0       # RD 244/2019 art. 7.1.b.ii
TYPES_PATH = "data/building_types.csv"   # optional: refcat,type (home, office, school, shop)


def read_ranking(yield_dir):
    path = Path(yield_dir) / "ranking.csv"
    if not path.exists():
        raise SystemExit(f"No ranking.csv in {yield_dir}. Run python -m step4.batch first.")
    with open(path, newline="", encoding="utf-8") as f:
        rows = [r for r in csv.DictReader(f) if not r.get("error")]
    for r in rows:
        for k in ("kwp", "yearly_kwh", "kwh_per_kwp"):
            r[k] = float(r.get(k) or 0)
        r["panels"] = int(float(r.get("panels") or 0))
    return rows


def pick_hosts(ranking, n=HOSTS, min_kwp=MIN_KWP):
    ok = [r for r in ranking if r["kwp"] >= min_kwp and r["yearly_kwh"] > 0]
    return sorted(ok, key=lambda r: -r["kwh_per_kwp"])[:n]


def load_types(path):
    path = Path(path)
    if not path.exists():
        return {}
    with open(path, newline="", encoding="utf-8") as f:
        return {r["refcat"].strip(): r["type"].strip().lower() for r in csv.DictReader(f) if r.get("refcat")}


def participants_of(building, shapes, participation=PARTICIPATION):
    """The units that can sign up in one building: a share of its flats (each with the
    average flat's hourly use) and, if it has offices or a school, that as one unit."""
    out = []
    if building.dwellings and building.home_kwh:
        n = max(1, round(building.dwellings * participation))
        out.append({"kind": "home", "count": n, "use": building.home_kwh / building.dwellings * shapes["home"]})
    if building.kind in ("office", "school") and building.shop_kwh:
        out.append({"kind": building.kind, "count": 1, "use": building.shop_kwh * shapes[building.kind]})
    return out


def sunny_use(use, gen):
    """Use weighted by how sunny each hour is (1 at the installation's best hour)."""
    peak = gen.max()
    return float((use * gen / peak).sum()) if peak > 0 else 0.0


def daytime_share(use, gen):
    """Share of a unit's use that falls in hours with sun on the panels."""
    return float(use[gen > 0].sum() / use.sum()) if use.sum() > 0 else 0.0


def form_community(host_ref, gen, candidates, max_nonhome_share=MAX_NONHOME_SHARE, max_nonhome_total=MAX_NONHOME_TOTAL):
    """candidates: list of (refcat, distance_m, [participant units]) with the host first.
    Returns a list of picked units with refcat, count, weight (sunny-hour use for all its count)."""
    target = gen.sum()
    picked, total, nonhome = [], 0.0, 0.0
    host_units = [(host_ref, d, u) for ref, d, units in candidates if ref == host_ref for u in units]
    others = [(ref, d, u) for ref, d, units in candidates if ref != host_ref for u in units]
    # nearby first (rings of NEAR_RING_M), and inside each ring offices and schools before flats
    others.sort(key=lambda t: (int(t[1] // NEAR_RING_M), t[2]["kind"] == "home", -daytime_share(t[2]["use"], gen), t[1]))
    for ref, d, u in host_units + others:
        if total >= target:
            break
        per_unit = sunny_use(u["use"], gen)
        if per_unit <= 0:
            continue
        if u["kind"] == "home":
            count = min(u["count"], math.ceil((target - total) / per_unit))
            w = per_unit * count
        else:
            count = 1
            w = min(per_unit, max_nonhome_share * target, max_nonhome_total * target - nonhome, target - total)
            if w <= 0:
                continue
            nonhome += w
        picked.append({"refcat": ref, "distance_m": d, "kind": u["kind"], "count": count,
                       "weight": w, "unit_use": u["use"]})
        total += w
    return picked


def settle(picked, gen, host_ref, kwp, panels):
    """Fixed beta per unit, hourly energy, money. Returns per-unit rows."""
    total_w = sum(p["weight"] for p in picked)
    cost = kwp * COST_EUR_PER_KWP
    icio_saved = cost * ICIO_RATE * ICIO_BONUS
    rows = []
    for p in picked:
        beta = p["weight"] / total_w                  # share of all units of this kind in this building
        beta_unit = beta / p["count"]
        got = beta_unit * gen                          # one unit's kWh each hour
        used = np.minimum(got, p["unit_use"]).sum()
        surplus = got.sum() - used
        pay = beta_unit * cost
        saving = used * PRICE_EUR_PER_KWH + surplus * SURPLUS_EUR_PER_KWH   # over 100 kW: sold, about the same
        ibi = 0.0
        if p["refcat"] == host_ref and p["kind"] == "home":
            ibi = min(IBI_YEARS * IBI_BONUS * IBI_EUR_PER_FLAT, pay)
        net = pay - beta_unit * icio_saved - ibi
        rows.append({**p, "beta": beta, "beta_unit": beta_unit, "kwh_unit": got.sum(), "used_unit": used,
                     "surplus_unit": surplus, "use_unit_year": p["unit_use"].sum(), "pay_unit": pay,
                     "saving_unit": saving, "ibi_unit": ibi, "icio_unit": beta_unit * icio_saved,
                     "payback": pay / saving if saving else float("inf"),
                     "payback_incentives": net / saving if saving else float("inf")})
    return rows


def run(roofs_csv, yield_dir, out_dir, cache_path, hosts=HOSTS, min_kwp=MIN_KWP, max_distance=MAX_DISTANCE_M,
        participation=PARTICIPATION, types_path=TYPES_PATH, geojson_path=None, lookup=dm.building_from_catastro):
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    yield_dir = Path(yield_dir)
    with open(roofs_csv, newline="", encoding="utf-8") as f:
        roofs = {r["refcat"]: r for r in csv.DictReader(f)}
    ranking = read_ranking(yield_dir)
    host_rows = pick_hosts(ranking, hosts, min_kwp)
    if not host_rows:
        raise SystemExit(f"No roof of at least {min_kwp} kWp in {yield_dir}/ranking.csv")

    cache = dm.load_cache(cache_path)
    types = load_types(types_path)
    times, buildings = None, {}
    for h in host_rows:                                  # any hourly file gives the time axis
        p = yield_dir / f"{slug(h['refcat'])}_hourly.csv"
        if p.exists():
            times, _ = read_hourly(p)
            break
    if times is None:
        raise SystemExit(f"No *_hourly.csv files in {yield_dir}. Run python -m step4.batch first.")
    shapes = dm.profile_shapes(times)
    for ref, r in roofs.items():
        try:
            c = lookup(ref, cache)
        except Exception:
            continue                                     # no building on the plot
        floors = c["floors"] or round(float(r.get("height_m") or 0) / dm.FLOOR_HEIGHT_M) or 1
        buildings[ref] = dm.predict_yearly(ref, c["dwellings"], floors, c["footprint_m2"],
                                           c["current_use"], c["year_built"], kind=types.get(ref))
    dm.save_cache(cache, cache_path)

    taken, communities, members = set(), [], []
    for h in host_rows:
        href = h["refcat"]
        if href in taken or href not in roofs:
            continue
        _, gen = read_hourly(yield_dir / f"{slug(href)}_hourly.csv")
        hll = (float(roofs[href]["lat"]), float(roofs[href]["lon"]))
        cands = []
        for ref, b in buildings.items():
            if ref in taken:
                continue
            d = 0.0 if ref == href else distance_m(hll, (float(roofs[ref]["lat"]), float(roofs[ref]["lon"])))
            if d <= max_distance - DISTANCE_MARGIN_M:
                cands.append((ref, d, participants_of(b, shapes, participation)))
        cands.sort(key=lambda t: t[0] != href)
        picked = form_community(href, gen, cands)
        if not picked:
            continue
        units = settle(picked, gen, href, h["kwp"], h["panels"])
        n = len(communities) + 1
        refs = []
        for u in units:
            if u["refcat"] not in refs:
                refs.append(u["refcat"])
        taken.update(refs)
        for ref in refs:
            us = [u for u in units if u["refcat"] == ref]
            b = buildings[ref]
            cnt = sum(u["count"] for u in us)
            got = sum(u["kwh_unit"] * u["count"] for u in us)
            used = sum(u["used_unit"] * u["count"] for u in us)
            pay = sum(u["pay_unit"] * u["count"] for u in us)
            save = sum(u["saving_unit"] * u["count"] for u in us)
            net = pay - sum((u["ibi_unit"] + u["icio_unit"]) * u["count"] for u in us)
            use_all = sum(u["use_unit_year"] * u["count"] for u in us)
            flat = next((u for u in us if u["kind"] == "home"), None)
            members.append({
                "community": n, "role": "host" if ref == href else "guest", "address": roofs[ref]["address"],
                "block": roofs[ref].get("block", ""), "refcat": ref,
                "type": "+".join(dict.fromkeys(u["kind"] for u in us)),
                "distance_m": round(us[0]["distance_m"]), "dwellings": b.dwellings,
                "flats_joining": sum(u["count"] for u in us if u["kind"] == "home"),
                "nonhome_joining": next((u["kind"] for u in us if u["kind"] != "home"), ""),
                "beta_pct": round(100 * sum(u["beta"] for u in us), 2),
                "investment_eur": round(pay), "kwh_per_year": round(got), "kwh_used_on_the_spot": round(used),
                "covers_pct_of_their_use": round(100 * used / use_all, 1) if use_all else "",
                "saving_eur_per_year": round(save),
                "per_flat_investment_eur": round(flat["pay_unit"]) if flat else "",
                "per_flat_kwh": round(flat["kwh_unit"]) if flat else "",
                "per_flat_saving_eur": round(flat["saving_unit"]) if flat else "",
                "payback_years": round(pay / save, 1) if save else "",
                "payback_with_incentives_years": round(net / save, 1) if save else "",
                "ibi_bonus_counted": "yes" if any(u["ibi_unit"] for u in us) else "no",
                "participants": cnt})
        kwp = h["kwp"]
        cost = kwp * COST_EUR_PER_KWP
        used_all = sum(u["used_unit"] * u["count"] for u in units)
        save_all = sum(u["saving_unit"] * u["count"] for u in units)
        flags = []
        if kwp > PERMIT_FREE_MAX_KWP:
            flags.append("grid permits likely needed (over 15 kW)")
        if kwp > COMPENSATION_MAX_KWP:
            flags.append("over 100 kW: no bill credit for surplus")
        if any(r != href for r in refs):
            flags.append("host owners must approve other buildings' shares")
        communities.append({
            "community": n, "host_address": roofs[href]["address"], "host_refcat": href,
            "block": roofs[href].get("block", ""), "panels": h["panels"], "kwp": round(kwp, 2),
            "yearly_kwh": round(gen.sum()), "kwh_per_kwp": round(h["kwh_per_kwp"]),
            "buildings": len(refs), "flats_joining": sum(u["count"] for u in units if u["kind"] == "home"),
            "offices_schools_joining": sum(1 for u in units if u["kind"] != "home"),
            "cost_eur": round(cost), "used_on_the_spot_pct": round(100 * used_all / gen.sum(), 1),
            "saving_eur_per_year": round(save_all), "payback_years": round(cost / save_all, 1) if save_all else "",
            "farthest_member_m": round(max(u["distance_m"] for u in units)),
            "flags": "; ".join(flags)})

    _write(out_dir / "communities.csv", communities)
    _write(out_dir / "members.csv", members)
    if geojson_path and Path(geojson_path).exists():
        draw(geojson_path, communities, members, out_dir)
    _print_summary(communities, members, max_distance, out_dir)
    return communities, members


def _print_summary(communities, members, max_distance, out_dir):
    print(f"\n{len(communities)} communities within {max_distance:.0f} m of their host roof")
    for c in communities:
        extra = f" + {c['offices_schools_joining']} office/school" if c["offices_schools_joining"] else ""
        print(f"  {c['community']:>2}. {c['host_address']:<32} {c['kwp']:>5} kWp {c['yearly_kwh']:>7,} kWh "
              f"({c['kwh_per_kwp']} kWh/kWp)  {c['buildings']} buildings, {c['flats_joining']} flats{extra}, "
              f"{c['used_on_the_spot_pct']}% used on the spot, payback {c['payback_years']} yrs")
    flats = [m for m in members if m["per_flat_investment_eur"] != ""]
    if flats:
        inv = [m["per_flat_investment_eur"] for m in flats]
        print(f"one flat invests {min(inv):,}-{max(inv):,} EUR (ASSUMPTION {COST_EUR_PER_KWP:.0f} EUR/kWp)")
    print(f"-> {out_dir}")


def _write(path, rows):
    with open(path, "w", newline="", encoding="utf-8") as f:
        if not rows:
            return
        w = csv.DictWriter(f, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)


PALETTE = [(31, 119, 180), (255, 127, 14), (44, 160, 44), (214, 39, 40), (148, 103, 189),
           (140, 86, 75), (227, 119, 194), (188, 189, 34), (23, 190, 207), (127, 127, 127)]


def _font(size):
    from PIL import ImageFont
    for name in ("arial.ttf", "DejaVuSans.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            pass
    try:
        return ImageFont.load_default(size=size)
    except TypeError:
        return ImageFont.load_default()


def draw(geojson_path, communities, members, out_dir, px_per_m=1.6):
    """communities.png and communities.geojson from the roof test set outlines (EPSG:25831)."""
    from PIL import Image, ImageDraw
    from shapely.geometry import mapping, shape
    gj = json.loads(Path(geojson_path).read_text(encoding="utf-8"))
    by_ref = {m["refcat"]: m for m in members}
    plots = [(f["properties"]["refcat"], shape(f["geometry"])) for f in gj["features"]]
    xs = [g.bounds for _, g in plots]
    minx, miny = min(b[0] for b in xs), min(b[1] for b in xs)
    maxx, maxy = max(b[2] for b in xs), max(b[3] for b in xs)
    legend_w = 520
    W, H = int((maxx - minx) * px_per_m) + 40 + legend_w, int((maxy - miny) * px_per_m) + 90

    def T(coords):
        return [((x - minx) * px_per_m + 20, (maxy - y) * px_per_m + 60) for x, y in coords]

    img = Image.new("RGB", (W, H), (246, 244, 239))
    d = ImageDraw.Draw(img)
    centre = {ref: T([g.centroid.coords[0]])[0] for ref, g in plots}
    for ref, g in plots:
        m = by_ref.get(ref)
        fill = (218, 216, 210) if m is None else PALETTE[(m["community"] - 1) % len(PALETTE)]
        if m is not None and m["role"] == "guest":
            fill = tuple(int(c + (255 - c) * 0.45) for c in fill)
        for part in getattr(g, "geoms", [g]):
            d.polygon(T(part.exterior.coords), fill=fill, outline=(255, 255, 255))
    for m in members:                                  # lines from each guest to its host
        if m["role"] == "guest" and m["refcat"] in centre:
            host = next(c["host_refcat"] for c in communities if c["community"] == m["community"])
            if host in centre:
                d.line([centre[m["refcat"]], centre[host]], fill=(60, 60, 60), width=1)
    f_small, f_big = _font(14), _font(20)
    for ref, g in plots:
        m = by_ref.get(ref)
        if m is not None and m["role"] == "host":
            for part in getattr(g, "geoms", [g]):
                d.line(T(part.exterior.coords), fill=(0, 0, 0), width=4)
            x, y = centre[ref]
            d.ellipse([x - 10, y - 10, x + 10, y + 10], fill=(255, 255, 255), outline=(0, 0, 0), width=2)
            label = str(m["community"])
            d.text((x - 4 * len(label), y - 8), label, fill=(0, 0, 0), font=f_small)
    d.text((20, 15), "Solar co-investment communities: panels on the best roofs, shares for the neighbours",
           fill=(20, 20, 20), font=f_big)
    lx, ly = W - legend_w + 10, 60
    d.text((lx, ly), "Host roof (black outline) = where the panels go", fill=(20, 20, 20), font=f_small)
    d.text((lx, ly + 20), "Pale colour = guest building that co-invests", fill=(20, 20, 20), font=f_small)
    ly += 56
    for c in communities:
        col = PALETTE[(c["community"] - 1) % len(PALETTE)]
        d.rectangle([lx, ly + 2, lx + 16, ly + 18], fill=col)
        extra = f" + {c['offices_schools_joining']} office/school" if c["offices_schools_joining"] else ""
        d.text((lx + 24, ly), f"{c['community']}. {c['host_address']}", fill=(20, 20, 20), font=f_small)
        d.text((lx + 24, ly + 18), f"{c['kwp']} kWp, {c['yearly_kwh']:,} kWh/yr, {c['buildings']} buildings, "
               f"{c['flats_joining']} flats{extra}", fill=(70, 70, 70), font=f_small)
        ly += 44
    d.text((lx, H - 40), "Planning estimate. Distances within 500 m of the host.", fill=(90, 90, 90), font=f_small)
    img.save(out_dir / "communities.png")

    feats = []
    for f in gj["features"]:
        props = dict(f["properties"])
        m = by_ref.get(props["refcat"])
        if m:
            props.update({k: m[k] for k in ("community", "role", "type", "beta_pct", "flats_joining",
                                             "investment_eur", "kwh_per_year")})
        feats.append({"type": "Feature", "geometry": f["geometry"], "properties": props})
    out = {"type": "FeatureCollection", "features": feats}
    if "crs" in gj:
        out["crs"] = gj["crs"]
    (out_dir / "communities.geojson").write_text(json.dumps(out), encoding="utf-8")


def main():
    ap = argparse.ArgumentParser(description="Step 5c: co-investment communities around the best roofs")
    ap.add_argument("--roofs", default="data/roof_test_set/roof_test_set.csv")
    ap.add_argument("--geojson", default="data/roof_test_set/roof_test_set.geojson", help="plot outlines for the map")
    ap.add_argument("--yield-dir", default="data/yield_all_v2", help="folder written by python -m step4.batch")
    ap.add_argument("--cache", default="data/sharing/buildings_demand_cache.json",
                    help="Catastro answers saved by step5.sharing (saves looking them up again)")
    ap.add_argument("--out", default="data/communities")
    ap.add_argument("--hosts", type=int, default=HOSTS, help="how many host roofs (best kWh/kWp first)")
    ap.add_argument("--min-kwp", type=float, default=MIN_KWP)
    ap.add_argument("--max-distance", type=float, default=MAX_DISTANCE_M, help="metres; 5000 under RDL 7/2026")
    ap.add_argument("--participation", type=float, default=PARTICIPATION, help="share of flats that sign up")
    args = ap.parse_args()
    run(args.roofs, args.yield_dir, args.out, args.cache, args.hosts, args.min_kwp, args.max_distance,
        args.participation, geojson_path=args.geojson)


if __name__ == "__main__":
    main()
