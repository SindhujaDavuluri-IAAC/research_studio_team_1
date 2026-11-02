"""Save the study area's buildings for the 3D map, once.

    python -m web.buildings                   # our 9 blocks and 350 m around them
    python -m web.buildings --radius 500      # a bigger area

Writes website/data/buildings.json: every building within --radius of the centre of the
9 blocks, plus --margin around that (outline, height, roof form, use, cadastral reference),
from the city's 3D model (Ajuntament de Barcelona, BCN_3DtoFeat). The map reads this one
file instead of asking the city server for about a thousand buildings on every click.
Outside the area the map still asks the city server, as before.

The list of roofs to run (steps 2 and 4) is a separate thing: `python -m step4.roof_test_set`.

Only needs `requests` (no LiDAR, no key).
"""
import argparse
import json
import math
from datetime import date
from pathlib import Path

import requests

WEB_DIR = Path(__file__).resolve().parents[2] / "website"   # research_studio_team_1/website
BUILDINGS_URL = "https://geo.bcn.cat/agisserver/rest/services/Hosted/BCN_3DtoFeat/FeatureServer/22"
# The same fields the map uses (website/app.js, F = {...}).
FIELDS = ["objectid", "edificacio_ajbcn_z_min_vol", "edificacio_ajbcn_z_max_vol", "bldgheight", "baseelev",
          "roofform", "uso_desc", "edificacio_ajbcn_addspatialj_15", "edificacio_ajbcn_addspatialjo_2",
          "edificacio_ajbcn_addspatialjo_3", "edificacio_ajbcn_addspatialjo_9", "edificacio_ajbcn_barri",
          "edificacio_ajbcn_districte"]
FOCUS_LAT, FOCUS_LON = 41.3928, 2.1684    # centre of our 9 blocks (same as the map and step 4)
RADIUS_M = 350.0                          # the 9 blocks fit in this circle
MARGIN_M = 350.0                          # neighbours around it (shade and energy sharing)
PAGE = 2000
OUT_JSON = WEB_DIR / "data" / "buildings.json"
R = 6378137.0
DEG = math.pi / 180


def _post(params):
    r = requests.post(BUILDINGS_URL + "/query", data=params, timeout=180)
    r.raise_for_status()
    j = r.json()
    if j.get("error"):
        raise RuntimeError("city building data: " + str(j["error"].get("message", j["error"])))
    return j


def _params(env, **extra):
    return {"f": "json", "where": "1=1", "outFields": ",".join(FIELDS), "returnGeometry": "true",
            "multipatchOption": "xyFootprint", "inSR": "4326", "outSR": "4326",
            "geometry": json.dumps({**env, "spatialReference": {"wkid": 4326}}),
            "geometryType": "esriGeometryEnvelope", "spatialRel": "esriSpatialRelIntersects", **extra}


def _download_box(env, depth=0):
    """All features in the envelope: page by page, or (if the server can't page) by splitting the box."""
    try:
        features, offset = [], 0
        while True:
            j = _post(_params(env, resultOffset=str(offset), resultRecordCount=str(PAGE), orderByFields="objectid"))
            got = j.get("features") or []
            features += got
            print(f"  {len(features)} buildings")
            if not j.get("exceededTransferLimit") or not got:
                return features
            offset += len(got)
    except RuntimeError as e:
        if "pagin" not in str(e).lower():
            raise
    j = _post(_params(env))                       # server without paging
    if not j.get("exceededTransferLimit") or depth >= 6:
        return j.get("features") or []
    xm, ym = (env["xmin"] + env["xmax"]) / 2, (env["ymin"] + env["ymax"]) / 2
    quarters = [dict(xmin=a, xmax=b, ymin=c, ymax=d) for a, b in ((env["xmin"], xm), (xm, env["xmax"]))
                for c, d in ((env["ymin"], ym), (ym, env["ymax"]))]
    return [f for q in quarters for f in _download_box(q, depth + 1)]


def download(lat, lon, half_size_m):
    """City buildings in a square of +/- half_size_m around (lat, lon), each once."""
    d_lat = half_size_m / (R * DEG)
    d_lon = half_size_m / (R * DEG * math.cos(lat * DEG))
    env = {"xmin": lon - d_lon, "ymin": lat - d_lat, "xmax": lon + d_lon, "ymax": lat + d_lat}
    seen, out = set(), []
    for f in _download_box(env):
        oid = (f.get("attributes") or {}).get("objectid")
        if oid in seen or not (f.get("geometry") or {}).get("rings"):
            continue
        seen.add(oid)
        out.append(f)
    return out


def compact(features, lat, lon, radius, margin):
    """City features -> the small buildings.json the map reads (6 decimals = about 10 cm)."""
    rows = []
    for f in features:
        a = f["attributes"]
        rings = [[[round(x, 6), round(y, 6)] for x, y, *_ in ring] for ring in f["geometry"]["rings"]]
        rows.append([a.get(k) for k in FIELDS] + [rings])
    return {"source": "Ajuntament de Barcelona, 3D model BCN_3DtoFeat (FeatureServer 22)",
            "made": date.today().isoformat(), "center": [lon, lat],
            "cover_radius_m": radius, "margin_m": margin, "fields": FIELDS, "buildings": rows}


def main():
    ap = argparse.ArgumentParser(description="Save the study area's buildings for the 3D map")
    ap.add_argument("--lat", type=float, default=FOCUS_LAT)
    ap.add_argument("--lon", type=float, default=FOCUS_LON)
    ap.add_argument("--radius", type=float, default=RADIUS_M, help="study area radius in metres (default 350)")
    ap.add_argument("--margin", type=float, default=MARGIN_M, help="neighbours around it in metres (default 350)")
    ap.add_argument("--out", default=str(OUT_JSON), help="buildings file for the map")
    args = ap.parse_args()

    print("Downloading buildings from the city's 3D model...")
    features = download(args.lat, args.lon, args.radius + args.margin)
    data = compact(features, args.lat, args.lon, args.radius, args.margin)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
    print(f"wrote {out}: {len(features)} buildings, {out.stat().st_size / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
