"""Learn real usage patterns from Open Data BCN (Datadis meter data, MWh per day).

    python -m step5.bcn_data                  # latest full year, our postal codes
    python -m step5.bcn_data --year 2023 --postal 08007 08009 08010

Dataset "consum-electricitat-bcn": daily electricity use per postal code, economic sector
and time band (00-06, 06-12, 12-18, 18-24 h). From it we learn, separately for homes and
for services (shops, offices):
- how use splits across the 4 time bands of the day,
- the month-by-month pattern,
- weekend versus weekday.

They are saved to data/weather/bcn_usage_profile.json. step5.demand uses this file,
when it exists, instead of its built-in guesses. It also prints the yearly MWh for homes
and services in our postal codes, which is the target for the trained demand model.
"""
import argparse
import csv
import io
import json
import re
from collections import defaultdict
from datetime import date
from pathlib import Path

import requests

CKAN = "https://opendata-ajuntament.barcelona.cat/data/api/3/action/package_show"
DATASET = "consum-electricitat-bcn"
FOCUS_POSTAL = ("08007", "08009", "08010")
PROFILE_PATH = Path("data/weather/bcn_usage_profile.json")
TIMEOUT = 120


def sector_kind(name):
    n = (name or "").lower()
    if "resid" in n:
        return "home"
    if any(k in n for k in ("serv", "comer", "terc")):
        return "shop"
    return None


def band_of(text):
    """'00:00:00 - 05:59:59' or 'De 06:00:00 a 11:59:59' -> 0..3."""
    m = re.search(r"(\d{1,2}):\d{2}", text or "")
    return min(int(m.group(1)) // 6, 3) if m else None


def _clean(header):
    return re.sub(r"^\d+\.", "", header.strip().lstrip("﻿")).lower()


def read_rows(text):
    rd = csv.reader(io.StringIO(text))
    head = [_clean(h) for h in next(rd)]
    col = {k: next(i for i, h in enumerate(head) if k in h)
           for k in ("data", "codi_postal", "sector", "tram", "valor")}
    for r in rd:
        if len(r) < len(head):
            continue
        yield {k: r[i].strip() for k, i in col.items()}


def learn(rows, postal=FOCUS_POSTAL):
    """Profile from rows: per kind, band shares (weekday/weekend), month factors, yearly MWh."""
    postal = {p.zfill(5) for p in postal}
    band = {k: {"weekday": [0.0] * 4, "weekend": [0.0] * 4} for k in ("home", "shop")}
    month = {k: [0.0] * 12 for k in ("home", "shop")}
    days = {k: {"weekday": set(), "weekend": set()} for k in ("home", "shop")}
    total = defaultdict(float)
    for r in rows:
        kind = sector_kind(r["sector"])
        b = band_of(r["tram"])
        if kind is None or b is None or r["codi_postal"].zfill(5) not in postal:
            continue
        try:
            d = date.fromisoformat(r["data"][:10])
            v = float(r["valor"].replace(",", "."))
        except ValueError:
            continue
        wk = "weekend" if d.weekday() >= 5 else "weekday"
        band[kind][wk][b] += v
        days[kind][wk].add(d)
        month[kind][d.month - 1] += v
        total[kind] += v
    out = {"postal_codes": sorted(postal), "yearly_mwh": {k: round(v, 1) for k, v in total.items()}}
    for k in ("home", "shop"):
        if not total[k]:
            continue
        per_day = {wk: sum(band[k][wk]) / max(len(days[k][wk]), 1) for wk in band[k]}
        mean_m = sum(month[k]) / 12
        out[k] = {"band_share": {wk: [round(x / sum(v), 4) if sum(v) else 0.25 for x in v]
                                 for wk, v in band[k].items()},
                  "weekend_vs_weekday": round(per_day["weekend"] / per_day["weekday"], 3) if per_day["weekday"] else 1.0,
                  "month_factor": [round(m / mean_m, 3) for m in month[k]]}
    return out


def resource_urls():
    r = requests.get(CKAN, params={"id": DATASET}, timeout=TIMEOUT)
    r.raise_for_status()
    res = r.json()["result"]["resources"]
    urls = {}
    for x in res:
        text = (x.get("name") or "") + " " + (x.get("url") or "")
        m = re.search(r"(20\d\d)", text)
        if m and ((x.get("format") or "").lower() == "csv" or ".csv" in text.lower()):
            urls[int(m.group(1))] = x["url"]
    return urls


def main():
    ap = argparse.ArgumentParser(description="Learn usage patterns from Open Data BCN electricity data")
    ap.add_argument("--year", type=int, help="default: the latest full year available")
    ap.add_argument("--postal", nargs="+", default=list(FOCUS_POSTAL))
    ap.add_argument("--out", default=str(PROFILE_PATH))
    args = ap.parse_args()
    urls = resource_urls()
    if not urls:
        raise SystemExit("No yearly CSV found in the Open Data BCN dataset.")
    full_years = [y for y in urls if y < date.today().year]
    year = args.year or (max(full_years) if full_years else max(urls))
    if year not in urls:
        raise SystemExit(f"No data for {year}. Years available: {sorted(urls)}")
    print(f"years available: {sorted(urls)}; using {year}")
    r = requests.get(urls[year], timeout=TIMEOUT)
    r.raise_for_status()
    r.encoding = r.encoding or "utf-8"
    prof = learn(read_rows(r.text), args.postal)
    prof["year"] = year
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(prof, indent=2), encoding="utf-8")
    for k in ("home", "shop"):
        if k in prof:
            p = prof[k]
            print(f"{k}: {prof['yearly_mwh'][k]:,.0f} MWh in {year}; day split (00-06/06-12/12-18/18-24) "
                  f"{[round(100 * s) for s in p['band_share']['weekday']]}%, weekend x{p['weekend_vs_weekday']}")
        else:
            print(f"{k}: no rows found; check the sector names in the CSV")
    print(f"-> {args.out}")


if __name__ == "__main__":
    main()
