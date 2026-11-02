"""Build the roof test set: every building plot in the 9 focus blocks, from Catastro.

    python -m step4.roof_test_set --out data\\roof_test_set

Focus area: the Eixample blocks between Passeig de Gràcia and Bruc, and between
Gran Via and Aragó (3 x 3 blocks). The script

1. downloads every cadastral plot around the area (Catastro INSPIRE parcels WFS),
2. groups touching plots into city blocks,
3. asks Catastro for the address of each plot (the same service step 1 uses),
4. keeps the blocks whose addresses sit on the streets of the focus area, and
   numbers them 1-9: row 1 is Gran Via-Diputació, row 3 Consell de Cent-Aragó,
   and inside each row the blocks run from Passeig de Gràcia towards Bruc.

Outputs in --out:
- roof_test_set.csv      address, block, block_name, refcat, lat, lon, plot_m2
                         (input for `python -m step4.batch` and `python -m step2.dataset`)
- roof_test_set.geojson  plot outlines with their block, EPSG:25831, opens in QGIS
- roof_test_set.png      map of the plots coloured by block, with the block numbers
- address_cache.json     Catastro answers, so a second run is fast

Check the PNG before using the CSV: there should be 9 blocks in a 3 x 3 grid.
"""
import argparse
import csv
import json
import time
import unicodedata
import xml.etree.ElementTree as ET
from pathlib import Path

import requests
from pyproj import Transformer
from shapely.geometry import Point, mapping
from shapely.ops import unary_union

from step1.catastro import CatastroError, _first_text, _local, _polygons, refcat_from_point
from step1.geocode import geocode

WFS_CP_URL = "https://ovc.catastro.meh.es/INSPIRE/wfsCP.aspx"
CENTER_ADDRESS = "Carrer de Roger de Llúria 56, Barcelona"   # inside the focus area
SEARCH_RADIUS_M = 420     # blocks whose centre is this close to CENTER are checked
TILE_M = 550              # half-size of the plot download window around CENTER
TIMEOUT = 60

to_utm = Transformer.from_crs("EPSG:4326", "EPSG:25831", always_xy=True).transform
to_wgs = Transformer.from_crs("EPSG:25831", "EPSG:4326", always_xy=True).transform

# Streets in grid order. Catastro writes them in capitals without accents.
COLUMN_STREETS = [("RAMBLA CATALUNYA", ("CATALUNYA",)),
                  ("PASSEIG DE GRACIA", ("GRACIA",)),
                  ("PAU CLARIS", ("PAU CLARIS",)),
                  ("ROGER DE LLURIA", ("LLURIA",)),
                  ("BRUC", ("BRUC",)),
                  ("GIRONA", ("GIRONA",))]
ROW_STREETS = [("CASP", ("CASP",)),
               ("GRAN VIA", ("CORTS CATALANES", "GRAN VIA")),
               ("DIPUTACIO", ("DIPUTACIO",)),
               ("CONSELL DE CENT", ("CONSELL DE CENT",)),
               ("ARAGO", ("ARAGO",)),
               ("VALENCIA", ("VALENCIA",))]
FOCUS_COLUMNS = (1, 2, 3)   # pairs (Gràcia, Pau Claris), (Pau Claris, Llúria), (Llúria, Bruc)
FOCUS_ROWS = (1, 2, 3)      # pairs (Gran Via, Diputació), (Diputació, Consell de Cent), (Consell de Cent, Aragó)
NICE = {"RAMBLA CATALUNYA": "Rambla de Catalunya", "PASSEIG DE GRACIA": "Pg. de Gràcia",
        "PAU CLARIS": "Pau Claris", "ROGER DE LLURIA": "Roger de Llúria", "BRUC": "Bruc",
        "GIRONA": "Girona", "CASP": "Casp", "GRAN VIA": "Gran Via", "DIPUTACIO": "Diputació",
        "CONSELL DE CENT": "Consell de Cent", "ARAGO": "Aragó", "VALENCIA": "València"}


# ---------- 1. plots from Catastro ----------

def parse_parcels(gml_text):
    """Parse a CadastralParcel WFS reply into [{refcat, area_m2, point, geometry}]."""
    root = ET.fromstring(gml_text)
    out = []
    for p in root.iter():
        if _local(p.tag) != "CadastralParcel":
            continue
        ref = _first_text(p, "nationalCadastralReference") or _first_text(p, "localId")
        geom_elem = next((e for e in p.iter() if _local(e.tag) == "geometry"), p)
        polys = _polygons(geom_elem)
        if not ref or not polys:
            continue
        geom = unary_union(polys)
        point = None
        for e in p.iter():
            if _local(e.tag) == "referencePoint":
                pos = _first_text(e, "pos")
                if pos:
                    x, y = (float(v) for v in pos.split()[:2])
                    point = Point(x, y)
        if point is None or not geom.contains(point):
            point = geom.representative_point()
        area = _first_text(p, "areaValue")
        out.append({"refcat": ref[:14], "area_m2": float(area) if area else round(geom.area, 1),
                    "point": point, "geometry": geom})
    return out


def download_parcels(cx, cy, half=TILE_M):
    """All plots in a square around (cx, cy), fetched as 4 tiles to stay under Catastro's limits."""
    found = {}
    for x0 in (cx - half, cx):
        for y0 in (cy - half, cy):
            params = {"service": "wfs", "version": "2.0.0", "request": "GetFeature",
                      "typeNames": "CP:CadastralParcel", "srsName": "EPSG::25831",
                      "bbox": f"{x0:.0f},{y0:.0f},{x0 + half:.0f},{y0 + half:.0f}"}
            r = requests.get(WFS_CP_URL, params=params, timeout=TIMEOUT)
            r.raise_for_status()
            if "ExceptionReport" in r.text[:2000]:
                raise CatastroError(f"Catastro parcels WFS error: {r.text[:300]}")
            for p in parse_parcels(r.text):
                found.setdefault(p["refcat"], p)
    return list(found.values())


# ---------- 2. plots -> city blocks ----------

BLOCK_GAP_M = 14.0   # passages inside a block (Permanyer, Méndez Vigo) are narrower; streets are 20 m


def group_blocks(parcels, gap_m=BLOCK_GAP_M):
    """Plots closer than gap_m form one block. Eixample streets are 20 m wide, so they
    separate blocks, while the narrow passatges that cut some blocks in two do not."""
    merged = unary_union([p["geometry"].buffer(gap_m / 2) for p in parcels])
    shapes = list(getattr(merged, "geoms", [merged]))
    blocks = [{"shape": s, "parcels": []} for s in shapes]
    for p in parcels:
        for b in blocks:
            if b["shape"].contains(p["point"]):
                b["parcels"].append(p)
                break
    return [b for b in blocks if b["parcels"]]


# ---------- 3. which streets does a block face? ----------

def normalise(text):
    text = unicodedata.normalize("NFKD", text or "").encode("ascii", "ignore").decode()
    return " ".join(text.upper().replace("'", " ").split())


def street_index(address, streets):
    a = normalise(address)
    for i, (_, keys) in enumerate(streets):
        if any(k in a for k in keys):
            return i
    return None


def best_pair(addresses, streets):
    """The pair of neighbouring streets (i, i+1) that most addresses of a block sit on.
    Returns (i, votes, runner_up_votes)."""
    hits = [0] * len(streets)
    for a in addresses:
        i = street_index(a, streets)
        if i is not None:
            hits[i] += 1
    scores = sorted(((hits[i] + hits[i + 1], i) for i in range(len(streets) - 1)), reverse=True)
    (best, i), (second, _) = scores[0], scores[1]
    return i, best, second


def classify_block(addresses):
    """Block number 1-9 and name if the block is in the focus area, else None."""
    col, cv, cv2 = best_pair(addresses, COLUMN_STREETS)
    row, rv, rv2 = best_pair(addresses, ROW_STREETS)
    if cv == 0 or rv == 0 or cv == cv2 or rv == rv2:
        return None   # no clear streets: not one of ours (or too few plots to tell)
    if col not in FOCUS_COLUMNS or row not in FOCUS_ROWS:
        return None
    number = (row - FOCUS_ROWS[0]) * 3 + (col - FOCUS_COLUMNS[0]) + 1
    return number, block_name(number)


def block_name(number):
    col = FOCUS_COLUMNS[0] + (number - 1) % 3
    row = FOCUS_ROWS[0] + (number - 1) // 3
    return (f"{NICE[COLUMN_STREETS[col][0]]}-{NICE[COLUMN_STREETS[col + 1][0]]} / "
            f"{NICE[ROW_STREETS[row][0]]}-{NICE[ROW_STREETS[row + 1][0]]}")


def place_by_grid(kept, unsure, tolerance=0.35):
    """Place the pieces the streets could not decide (for example half a block cut by a
    passatge) using the Cerdà grid: fit centre = origin + col*u + row*v to the blocks we
    are sure of, then read col and row for each unsure piece. A piece is placed only if
    it falls inside the 3 x 3 grid, near a block centre, and has at least one address on
    a focus-area street."""
    import numpy as np
    if len({n for (n, _), _ in kept}) < 3:
        return []
    A, X = [], []
    for (n, _), b in kept:
        c = b["shape"].centroid
        A.append([1, (n - 1) % 3, (n - 1) // 3])
        X.append([c.x, c.y])
    coef, *_ = np.linalg.lstsq(np.array(A, float), np.array(X, float), rcond=None)
    origin, u, v = coef
    M = np.column_stack([u, v])
    if abs(np.linalg.det(M)) < 1e-6:
        return []
    placed = []
    for b in unsure:
        c = b["shape"].centroid
        col, row = np.linalg.solve(M, np.array([c.x, c.y]) - origin)
        ci, ri = int(round(col)), int(round(row))
        if not (0 <= ci <= 2 and 0 <= ri <= 2):
            continue
        if abs(col - ci) > tolerance or abs(row - ri) > tolerance:
            continue
        on_ours = any(street_index(a, COLUMN_STREETS) in (FOCUS_COLUMNS[0] + ci, FOCUS_COLUMNS[0] + ci + 1)
                      or street_index(a, ROW_STREETS) in (FOCUS_ROWS[0] + ri, FOCUS_ROWS[0] + ri + 1)
                      for a in b.get("addresses", []))
        if on_ours:
            placed.append((ri * 3 + ci + 1, b))
    return placed


def clean_address(ldt):
    """'CL ROGER DE LLURIA 56 BARCELONA (BARCELONA)' -> 'CL ROGER DE LLURIA 56, Barcelona'."""
    a = " ".join((ldt or "").split())
    for tail in (" BARCELONA (BARCELONA)", " (BARCELONA)"):
        if a.upper().endswith(tail):
            a = a[: -len(tail)]
    return f"{a}, Barcelona" if a else ""


# ---------- 4. the whole run ----------

def lookup_address(parcel, cache, pause=0.15):
    ref = parcel["refcat"]
    if ref in cache:
        return cache[ref]
    lon, lat = to_wgs(parcel["point"].x, parcel["point"].y)
    try:
        hit = refcat_from_point(lat, lon)
        cache[ref] = {"address": hit.get("address") or "", "refcat_at_point": hit["refcat"]}
    except (CatastroError, requests.RequestException, ValueError) as e:
        cache[ref] = {"address": "", "error": str(e)[:150]}
    time.sleep(pause)
    return cache[ref]


def build(out_dir, center_address=CENTER_ADDRESS, radius=SEARCH_RADIUS_M):
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    cache_path = out_dir / "address_cache.json"
    cache = json.loads(cache_path.read_text(encoding="utf-8")) if cache_path.exists() else {}

    c = geocode(center_address)
    cx, cy = to_utm(c["lon"], c["lat"])
    parcels = download_parcels(cx, cy)
    print(f"{len(parcels)} plots downloaded around {center_address}")
    blocks = [b for b in group_blocks(parcels)
              if b["shape"].centroid.distance(Point(cx, cy)) <= radius]
    print(f"{len(blocks)} blocks within {radius} m; looking up addresses "
          f"({sum(len(b['parcels']) for b in blocks)} plots, cached ones are instant)")

    rows, features, kept = [], [], []
    for k, b in enumerate(blocks, 1):
        addrs = []
        for p in b["parcels"]:
            p["catastro"] = lookup_address(p, cache)
            addrs.append(p["catastro"]["address"])
        cache_path.write_text(json.dumps(cache, indent=1), encoding="utf-8")
        cls = classify_block(addrs)
        b["addresses"] = addrs
        print(f"  block {k}/{len(blocks)}: {len(addrs)} plots -> "
              f"{'block %d, %s' % cls if cls else 'not sure from the streets alone'}")
        if cls:
            kept.append((cls, b))
    unsure = [b for b in blocks if all(b is not kb for _, kb in kept)]
    for number, b in place_by_grid(kept, unsure):
        cls = (number, block_name(number))
        kept.append((cls, b))
        print(f"  + {len(b['parcels'])} plots placed in block {number} by their position in the grid "
              f"(a block cut in two by a passatge)")
    numbers = [cls[0] for cls, _ in kept]

    for (number, name), b in sorted(kept, key=lambda t: t[0][0]):
        for p in sorted(b["parcels"], key=lambda q: q["refcat"]):
            lon, lat = to_wgs(p["point"].x, p["point"].y)
            row = {"address": clean_address(p["catastro"]["address"]) or p["refcat"],
                   "block": number, "block_name": name, "refcat": p["refcat"],
                   "lat": round(lat, 7), "lon": round(lon, 7), "plot_m2": round(p["area_m2"])}
            rows.append(row)
            features.append({"type": "Feature", "geometry": mapping(p["geometry"]), "properties": row})

    with open(out_dir / "roof_test_set.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["address", "block", "block_name", "refcat", "lat", "lon", "plot_m2"])
        w.writeheader()
        w.writerows(rows)
    (out_dir / "roof_test_set.geojson").write_text(json.dumps(
        {"type": "FeatureCollection",
         "crs": {"type": "name", "properties": {"name": "urn:ogc:def:crs:EPSG::25831"}},
         "features": features}), encoding="utf-8")
    draw_map([(n, b) for (n, _), b in kept], [b for b in blocks if all(b is not kb for _, kb in kept)],
             out_dir / "roof_test_set.png")

    found = sorted(set(numbers))
    print(f"\n{len(rows)} plots in {len(found)} blocks -> {out_dir / 'roof_test_set.csv'}")
    for (number, name), b in sorted(kept, key=lambda t: t[0][0]):
        print(f"  block {number}: {name} ({len(b['parcels'])} plots)")
    missing = [n for n in range(1, 10) if n not in found]
    if missing:
        print(f"WARNING: blocks {missing} not found. Check roof_test_set.png "
              f"(grey = checked but left out) and paste this printout to Claude.")
    return rows


def draw_map(kept, others, path, px_per_m=1.2):
    from PIL import Image, ImageDraw
    shapes = [b["shape"] for _, b in kept] + [b["shape"] for b in others]
    if not shapes:
        return
    minx, miny, maxx, maxy = unary_union(shapes).bounds
    W, H = int((maxx - minx) * px_per_m) + 20, int((maxy - miny) * px_per_m) + 20

    def T(coords):
        return [((x - minx) * px_per_m + 10, (maxy - y) * px_per_m + 10) for x, y in coords]

    img = Image.new("RGB", (W, H), (240, 238, 232))
    d = ImageDraw.Draw(img)
    for b in others:
        for p in b["parcels"]:
            for g in getattr(p["geometry"], "geoms", [p["geometry"]]):
                d.polygon(T(g.exterior.coords), fill=(215, 215, 215), outline=(255, 255, 255))
    palette = [(31, 119, 180), (255, 127, 14), (44, 160, 44), (214, 39, 40), (148, 103, 189),
               (140, 86, 75), (227, 119, 194), (127, 127, 127), (188, 189, 34)]
    for n, b in kept:
        for p in b["parcels"]:
            for g in getattr(p["geometry"], "geoms", [p["geometry"]]):
                d.polygon(T(g.exterior.coords), fill=palette[(n - 1) % 9], outline=(255, 255, 255))
        cx, cy = T([b["shape"].centroid.coords[0]])[0]
        d.rectangle([cx - 9, cy - 8, cx + 9, cy + 8], fill=(255, 255, 255))
        d.text((cx - 3, cy - 6), str(n), fill=(0, 0, 0))
    d.text((10, H - 16), "grey = checked, outside the focus area", fill=(60, 60, 60))
    img.save(path)


def main():
    ap = argparse.ArgumentParser(description="Every plot in the 9 focus blocks, from Catastro")
    ap.add_argument("--out", default="data/roof_test_set")
    ap.add_argument("--center", default=CENTER_ADDRESS, help="an address inside the focus area")
    ap.add_argument("--radius", type=float, default=SEARCH_RADIUS_M)
    args = ap.parse_args()
    build(args.out, args.center, args.radius)


if __name__ == "__main__":
    main()
