"""Is a low month real weather, or a mistake in our code?

    python -m step4.check_months

Compares, month by month, the sunshine in our typical year (data/weather/barcelona_tmy.json)
with PVGIS's long-term average for the same spot (every year 2005-2020). PVGIS builds the
typical year from one real year per month, so one month can come from an unusually cloudy year.

Reading the table:
- "typical yr" much lower than "average" for October (ratio well under 100%): the dip comes
  from the weather year PVGIS chose, not from our code.
- Both about the same: the weather is normal, so the dip comes from steps 3-4 (shade or sun
  angles) and Claude should look at the code.
"""
import argparse
import json
from collections import defaultdict
from pathlib import Path

import requests

from .weather import DEFAULT_PATH, FOCUS_LAT, FOCUS_LON

MRCALC_URLS = ["https://re.jrc.ec.europa.eu/api/v5_3/MRcalc", "https://re.jrc.ec.europa.eu/api/v5_2/MRcalc"]
MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split()


def tmy_monthly(tmy_json):
    """kWh/m2 of sun on flat ground per month in the typical year, and the real year each month came from."""
    out = tmy_json["outputs"]
    kwh = [0.0] * 12
    for r in out["tmy_hourly"]:
        kwh[int(r["time(UTC)"][4:6]) - 1] += float(r["G(h)"]) / 1000
    years = {int(m["month"]): int(m["year"]) for m in out.get("months_selected", [])}
    return kwh, years


def long_term_monthly(mr_json):
    """Average kWh/m2 per month over all years PVGIS has."""
    per_month = defaultdict(list)
    for r in mr_json["outputs"]["monthly"]:
        per_month[int(r["month"])].append(float(r["H(h)_m"]))
    return [sum(per_month[m]) / len(per_month[m]) if per_month[m] else float("nan") for m in range(1, 13)], \
        {m: v for m, v in per_month.items()}


def download_long_term(lat, lon):
    errors = []
    for url in MRCALC_URLS:
        try:
            r = requests.get(url, params={"lat": lat, "lon": lon, "horirrad": 1, "outputformat": "json"}, timeout=60)
            r.raise_for_status()
            return r.json()
        except (requests.RequestException, ValueError) as e:
            errors.append(f"{url}: {e}")
    raise SystemExit("PVGIS download failed. " + "; ".join(errors))


def report(tmy_json, mr_json):
    tmy, years = tmy_monthly(tmy_json)
    avg, all_years = long_term_monthly(mr_json)
    lines = [f"{'month':<6}{'from year':>10}{'typical yr':>12}{'average':>10}{'ratio':>8}   (kWh/m2 on flat ground)"]
    for i in range(12):
        ratio = tmy[i] / avg[i] * 100 if avg[i] else float("nan")
        flag = "  <-- unusual" if abs(ratio - 100) > 15 else ""
        lines.append(f"{MONTHS[i]:<6}{years.get(i + 1, ''):>10}{tmy[i]:>12.0f}{avg[i]:>10.0f}{ratio:>7.0f}%{flag}")
    octs = all_years.get(10, [])
    if octs:
        lines.append(f"\nOctober over the years: lowest {min(octs):.0f}, highest {max(octs):.0f}, average {avg[9]:.0f} kWh/m2")
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser(description="Compare our typical year with PVGIS's long-term monthly average")
    ap.add_argument("--weather", default=str(DEFAULT_PATH))
    args = ap.parse_args()
    tmy_json = json.loads(Path(args.weather).read_text(encoding="utf-8"))
    print(report(tmy_json, download_long_term(FOCUS_LAT, FOCUS_LON)))


if __name__ == "__main__":
    main()
