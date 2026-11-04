"""Benchmark: the city's own solar potential for each roof (Barcelona Mapa d'Energia).

The Ajuntament's energy map (coneixement-eu.bcn.cat/mapaEnergia) shows solar PV,
solar thermal and mini-wind potential per roof. It was made around 2015 from
radiation, cartography and Catastro data (no LiDAR, no neighbour shade). We do
NOT use it to replace steps 2-4. We put its numbers next to ours, roof by roof.

How it works: the viewer keeps its data in CARTO, in a table called
"fotovoltaica". Its config.js names the CARTO SQL address and the public key the
viewer itself uses. This script reads config.js, then asks CARTO once for every
PV roof polygon around our blocks (data/energy_map/fotovoltaica.geojson) and
adds them up per Catastro plot. City fields (from the viewer's popup):

    radiacio    solar radiation on the roof        superficie  sunny roof area, m2
    superfici1  usable area, m2                    potencia_i  installable power, kW
    energia_ge  electricity generated, kWh/yr      est_emis_h  CO2 saved, kg/yr
    inversio_e  estimated investment, EUR          estalvi_ec  estimated saving, EUR/yr

    python -m step4.energy_map --discover            # show the CARTO address and the table's columns
    python -m step4.energy_map --address "Carrer del Bruc 59, Barcelona"
    python -m step4.energy_map data\\roof_test_set\\roof_test_set.csv --ranking data\\yield_all_v2\\ranking.csv --out data\\energy_map

With the roof test set, plot outlines are read from roof_test_set.geojson next to
the CSV, so every city polygon whose centre falls in a plot counts for that plot.
Without it, the roof's lat/lon point is used. Run again with --refresh to
download the city data again.
"""
import argparse
import csv
import json
import re
from pathlib import Path

import requests
from pyproj import Transformer
from shapely.geometry import Point, shape
from shapely.ops import transform
from shapely.strtree import STRtree

CONFIG_URL = "https://coneixement-eu.bcn.cat/mapaEnergia/js/config.js"
DEFAULT_OUT = Path("data/energy_map")
TABLE = "fotovoltaica"
SUM_FIELDS = ("superficie", "superfici1", "potencia_i", "energia_ge", "est_emis_h", "inversio_e", "cost_mante",
              "estalvi_ec")
HEADERS = {"User-Agent": "research-studio-solar-pipeline/1.0"}
TO_UTM = Transformer.from_crs("EPSG:4326", "EPSG:25831", always_xy=True)
MARGIN_DEG = 0.002   # about 200 m around the roofs


# ---------- where the data is ----------

def read_config(js_text):
    """SQL address, key and table names from the viewer's config.js."""
    def get(name):
        m = re.search(rf'var\s+{name}\s*=\s*"([^"]*)"', js_text)
        return m.group(1) if m else None
    sql_url = get("SQL_URL")
    if not sql_url:
        raise SystemExit("config.js has no SQL_URL: the viewer has changed. Paste config.js to Claude.")
    if sql_url.startswith("//"):
        sql_url = "https:" + sql_url
    return {"sql_url": sql_url, "api_key": get("API_KEY"),
            "tables": re.findall(r'TABLE_NAMES\[\d+\]\s*=\s*"([^"]+)"', js_text)}


def find_service(session=None, config_url=CONFIG_URL):
    s = session or requests.Session()
    r = s.get(config_url, headers=HEADERS, timeout=30)
    r.raise_for_status()
    return read_config(r.text)


def sql(svc, query, fmt="geojson", session=None):
    s = session or requests.Session()
    data = {"q": query, "format": fmt}
    if svc.get("api_key"):
        data["api_key"] = svc["api_key"]
    r = s.post(svc["sql_url"], data=data, headers=HEADERS, timeout=120)
    if not r.ok:
        raise SystemExit(f"CARTO said {r.status_code}: {r.text[:300]}")
    return r.json()


def sample(svc, table=TABLE, session=None):
    rows = sql(svc, f"SELECT * FROM {table} LIMIT 1", "json", session).get("rows", [])
    return {k: v for k, v in rows[0].items() if k not in ("the_geom", "the_geom_webmercator")} if rows else {}


def download_polygons(svc, bbox, path, table=TABLE, session=None):
    """Every city PV polygon in bbox (min_lon, min_lat, max_lon, max_lat), saved as GeoJSON."""
    x0, y0, x1, y1 = bbox
    q = (f"SELECT * FROM {table} WHERE the_geom && "
         f"ST_MakeEnvelope({x0:.6f}, {y0:.6f}, {x1:.6f}, {y1:.6f}, 4326)")
    fc = sql(svc, q, "geojson", session)
    for f in fc.get("features", []):
        f["properties"].pop("the_geom_webmercator", None)
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(fc, ensure_ascii=False), encoding="utf-8")
    return fc


# ---------- adding up per roof ----------

def _number(v):
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    t = str(v).strip().replace(" ", "")
    if "," in t and "." in t:
        t = t.replace(".", "").replace(",", ".")   # 12.345,6 -> 12345.6
    try:
        return float(t.replace(",", "."))
    except ValueError:
        return None


class CityRoofs:
    """The city's PV polygons in EPSG:25831, ready to be added up per plot."""

    def __init__(self, fc):
        self.items = []
        for f in fc.get("features", []):
            if not f.get("geometry"):
                continue
            g = transform(TO_UTM.transform, shape(f["geometry"]))
            self.items.append((g, g.representative_point(), f["properties"]))
        self.tree = STRtree([p for _, p, _ in self.items]) if self.items else None

    def in_area(self, area):
        """City polygons whose centre is inside `area` (a plot or building outline)."""
        if self.tree is None:
            return []
        return [self.items[i] for i in self.tree.query(area) if area.contains(self.items[i][1])]

    def at_point(self, pt, max_m=5.0):
        """Fallback without an outline: polygons containing the point (or within max_m)."""
        return [it for it in self.items if it[0].distance(pt) <= max_m]

    @staticmethod
    def total(items):
        out = {"city_polygons": len(items)}
        for k in SUM_FIELDS:
            vals = [v for v in (_number(p.get(k)) for _, _, p in items) if v is not None]
            out[k] = round(sum(vals), 1) if vals else None
        rad = [v for v in (_number(p.get("radiacio")) for _, _, p in items) if v is not None]
        out["radiacio"] = round(sum(rad) / len(rad), 1) if rad else None
        return out


def load_city(svc, out, bbox, refresh=False, session=None):
    path = Path(out) / f"{TABLE}.geojson"
    if path.exists() and not refresh:
        fc = json.loads(path.read_text(encoding="utf-8"))
    else:
        fc = download_polygons(svc, bbox, path, session=session)
        print(f"downloaded {len(fc.get('features', []))} city PV polygons -> {path}")
    return CityRoofs(fc)


def bbox_of(points_lonlat):
    lons, lats = zip(*points_lonlat)
    return min(lons) - MARGIN_DEG, min(lats) - MARGIN_DEG, max(lons) + MARGIN_DEG, max(lats) + MARGIN_DEG


# ---------- runs ----------

def lookup_address(address, svc, out=DEFAULT_OUT, refresh=False, session=None):
    from step1.find_building import find_building
    record, fp = find_building(address, None, None)
    city = load_city(svc, out, bbox_of([(record.lon, record.lat)]), refresh, session)
    t = CityRoofs.total(city.in_area(fp))
    return {"refcat": record.refcat, "address": record.catastro_address, "city_kwh": t["energia_ge"], **t}


def run_csv(roofs_csv, svc, out=DEFAULT_OUT, ranking=None, refresh=False, session=None):
    out = Path(out)
    with open(roofs_csv, newline="", encoding="utf-8") as f:
        roofs = list(csv.DictReader(f))
    city = load_city(svc, out, bbox_of([(float(r["lon"]), float(r["lat"])) for r in roofs]), refresh, session)
    plots = {}
    gj = Path(roofs_csv).with_suffix(".geojson")
    if gj.exists():
        for f in json.loads(gj.read_text(encoding="utf-8")).get("features", []):
            plots[f["properties"].get("refcat")] = shape(f["geometry"])
        print(f"using {len(plots)} plot outlines from {gj}")
    ours = {}
    if ranking:
        with open(ranking, newline="", encoding="utf-8") as f:
            ours = {r["refcat"]: r for r in csv.DictReader(f) if r.get("refcat")}
    rows = []
    for r in roofs:
        area = plots.get(r.get("refcat"))
        if area is not None:
            items = city.in_area(area)
        else:
            items = city.at_point(Point(*TO_UTM.transform(float(r["lon"]), float(r["lat"]))))
        t = CityRoofs.total(items)
        our = ours.get(r.get("refcat", ""), {})
        our_kwh = _number(our.get("yearly_kwh"))
        city_kwh = t["energia_ge"]
        rows.append({"address": r["address"], "block": r.get("block", ""), "refcat": r.get("refcat", ""),
                     "our_kwh": our_kwh, "city_kwh": city_kwh,
                     "ours_vs_city": round(our_kwh / city_kwh, 2) if our_kwh is not None and city_kwh else "",
                     "our_kwp": _number(our.get("kwp")), "city_kw": t["potencia_i"],
                     "our_usable_m2": _number(our.get("usable_area_m2")), "city_usable_m2": t["superfici1"],
                     "city_sunny_m2": t["superficie"], "city_radiation": t["radiacio"],
                     "city_investment_eur": t["inversio_e"], "city_saving_eur_yr": t["estalvi_ec"],
                     "city_polygons": t["city_polygons"]})
    out.mkdir(parents=True, exist_ok=True)
    with open(out / "energy_map.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]) if rows else ["address"])
        w.writeheader()
        w.writerows(rows)
    found = [r for r in rows if r["city_kwh"]]
    print(f"city kWh found for {len(found)} of {len(rows)} roofs -> {out / 'energy_map.csv'}")
    both = [r for r in found if r["our_kwh"]]
    if len(both) > 2:
        import numpy as np
        ours_sum, city_sum = sum(r["our_kwh"] for r in both), sum(r["city_kwh"] for r in both)
        a = np.argsort(np.argsort([r["our_kwh"] for r in both]))
        b = np.argsort(np.argsort([r["city_kwh"] for r in both]))
        print(f"on the {len(both)} roofs both have: ours {ours_sum / 1000:.0f} MWh/yr, city {city_sum / 1000:.0f}"
              f" MWh/yr (ours = {ours_sum / city_sum:.2f} x city)")
        print(f"rank agreement (Spearman): {np.corrcoef(a, b)[0, 1]:.2f}  (1 = same order, 0 = unrelated)")
    return rows


def main():
    ap = argparse.ArgumentParser(description="Barcelona energy map's PV potential per roof, next to ours")
    ap.add_argument("roofs_csv", nargs="?", help="roof test set CSV (address, block, refcat, lat, lon)")
    ap.add_argument("--address", help="one address instead of a CSV")
    ap.add_argument("--ranking", help="our step 4 ranking.csv, to compare with")
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    ap.add_argument("--discover", action="store_true", help="show the data address and one row of the table")
    ap.add_argument("--refresh", action="store_true", help="download the city data again")
    args = ap.parse_args()
    svc = find_service()
    if args.discover:
        print(f"CARTO SQL: {svc['sql_url']}   tables: {', '.join(svc['tables'])}")
        row = sample(svc)
        print(f"columns of {TABLE}: {', '.join(row) if row else '(no rows returned)'}")
        print("sample row: " + json.dumps(row, ensure_ascii=False, default=str)[:800])
        return
    if args.address:
        print(json.dumps(lookup_address(args.address, svc, args.out, args.refresh), indent=2, ensure_ascii=False))
    elif args.roofs_csv:
        run_csv(args.roofs_csv, svc, args.out, args.ranking, args.refresh)
    else:
        ap.error("give a roofs CSV, --address or --discover")


if __name__ == "__main__":
    main()
