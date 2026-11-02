"""Step 5a: predict each building's hourly electricity use from Catastro data.

We have no meter readings for these buildings, so demand is predicted from what
Catastro tells us: number of dwellings, floors, footprint and main use.

    yearly kWh = dwellings x kWh per flat (grows with flat size)
               + shop/office floor area x kWh per m2

The yearly total is spread over 8760 hours with a typical day shape (low at night,
peak in the evening for homes; daytime for shops), a weekday/weekend difference
and a month factor (winter lighting and heating, summer air conditioning).

Every number below is a first estimate, marked ASSUMPTION. They are kept in one
place so the team can replace them with real data, for example the hourly
consumption by postal code on Open Data BCN (consum-electricitat-bcn), or a
model trained on Datadis meter data from buildings that agree to share it.
"""
import json
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np

from step1 import catastro

# ASSUMPTION: a flat uses about 1,000 kWh/yr fixed (fridge, standby, lighting)
# plus 18 kWh per m2 (appliances, cooling). 85 m2 -> ~2,500 kWh/yr.
FLAT_BASE_KWH = 1000.0
FLAT_KWH_PER_M2 = 18.0
FLAT_M2_DEFAULT = 85.0
# ASSUMPTION: shops and offices on the ground floor, 100 kWh per m2 a year.
COMMERCIAL_KWH_PER_M2 = 100.0
FLOOR_HEIGHT_M = 3.0

# Local-time hour weights (0-23). Homes: low at night, small morning peak, evening peak.
HOME_DAY = np.array([0.75, 0.6, 0.5, 0.45, 0.45, 0.5, 0.65, 0.85, 0.95, 0.95, 0.95, 0.95,
                     1.0, 1.05, 1.05, 0.95, 0.9, 0.95, 1.1, 1.3, 1.5, 1.55, 1.35, 1.0])
# Shops/offices: open 9:00-20:00 Monday-Saturday, small base load otherwise.
SHOP_OPEN = (9, 20)
SHOP_CLOSED_SHARE = 0.2
# Month factors Jan..Dec: winter lighting/heating, summer air conditioning.
MONTH = np.array([1.15, 1.1, 1.0, 0.9, 0.85, 0.95, 1.1, 1.05, 0.95, 0.9, 1.0, 1.15])
WEEKEND_HOME = 1.1   # people at home more


@dataclass
class Building:
    refcat: str
    dwellings: int
    floors: int
    footprint_m2: float
    current_use: str
    year_built: int | None
    home_kwh: float
    shop_kwh: float

    @property
    def yearly_kwh(self):
        return self.home_kwh + self.shop_kwh


def predict_yearly(refcat, dwellings, floors, footprint_m2, current_use, year_built=None):
    """Yearly kWh for homes and for shops/offices in one building."""
    dwellings = dwellings or 0
    floors = max(int(floors or 1), 1)
    use = (current_use or "").lower()
    if dwellings == 0:
        shop_m2 = footprint_m2 * floors if use and "residential" not in use else 0.0
        home_kwh = 0.0
    else:
        shop_floors = 1 if floors >= 3 else 0          # Eixample: shops on the ground floor
        home_m2 = footprint_m2 * (floors - shop_floors)
        flat_m2 = home_m2 / dwellings if home_m2 > 0 else FLAT_M2_DEFAULT
        flat_m2 = float(np.clip(flat_m2, 30, 250))
        home_kwh = dwellings * (FLAT_BASE_KWH + FLAT_KWH_PER_M2 * flat_m2)
        shop_m2 = footprint_m2 * shop_floors
    return Building(refcat, dwellings, floors, round(footprint_m2, 1), current_use or "", year_built,
                    round(home_kwh), round(shop_m2 * COMMERCIAL_KWH_PER_M2))


def local_hours(times_utc):
    """Hour of day, weekday (0=Mon) and month in Barcelona time (UTC+1, UTC+2 April-October)."""
    t = np.asarray(times_utc, dtype="datetime64[m]")
    month = (t.astype("datetime64[M]").astype(int) % 12) + 1
    offset = np.where((month >= 4) & (month <= 10), 120, 60).astype("timedelta64[m]")
    local = t + offset
    hour = ((local - local.astype("datetime64[D]")).astype("timedelta64[h]").astype(int)) % 24
    weekday = (local.astype("datetime64[D]").astype(int) + 3) % 7   # 1970-01-01 was a Thursday
    month = (local.astype("datetime64[M]").astype(int) % 12) + 1
    return hour, weekday, month


PROFILE_PATH = Path("data/weather/bcn_usage_profile.json")   # written by python -m step5.bcn_data


def _apply_learned(shape, hour, weekday, month, learned):
    """Rescale a built-in shape so that its time bands, months and weekends match real data."""
    band = np.minimum(hour // 6, 3)
    weekend = weekday >= 5
    out = shape.copy()
    for wk_name, wk_mask in (("weekday", ~weekend), ("weekend", weekend)):
        shares = np.array(learned["band_share"][wk_name], float)
        for b in range(4):
            m = wk_mask & (band == b)
            if m.any() and out[m].sum() > 0:
                # same total per band as the real data, keeping the hour-by-hour shape inside it
                out[m] *= shares[b] / (out[m].sum() / out[wk_mask].sum())
    # month and weekend levels from the real data
    for mo in range(1, 13):
        m = month == mo
        if m.any():
            out[m] *= learned["month_factor"][mo - 1] / (out[m].mean() / out.mean())
    ratio = out[weekend].mean() / out[~weekend].mean() if weekend.any() else 1.0
    out[weekend] *= learned["weekend_vs_weekday"] / ratio
    return out


def hourly_shapes(times_utc, profile_path=PROFILE_PATH):
    """Two 8760-hour shapes that each sum to 1: homes and shops. Uses the patterns learned
    from Open Data BCN (python -m step5.bcn_data) when that file exists."""
    hour, weekday, month = local_hours(times_utc)
    home = HOME_DAY[hour] * MONTH[month - 1] * np.where(weekday >= 5, WEEKEND_HOME, 1.0)
    open_ = (hour >= SHOP_OPEN[0]) & (hour < SHOP_OPEN[1]) & (weekday < 6)
    shop = np.where(open_, 1.0, SHOP_CLOSED_SHARE) * MONTH[month - 1]
    learned = json.loads(Path(profile_path).read_text(encoding="utf-8")) if profile_path and Path(profile_path).exists() else {}
    if "home" in learned:
        home = _apply_learned(home, hour, weekday, month, learned["home"])
    if "shop" in learned:
        shop = _apply_learned(shop, hour, weekday, month, learned["shop"])
    return home / home.sum(), shop / shop.sum()


def hourly_demand(building, shapes):
    home, shop = shapes
    return building.home_kwh * home + building.shop_kwh * shop


def building_from_catastro(refcat, cache):
    """Dwellings, floors, footprint and use for a plot, from Catastro (cached)."""
    if refcat in cache:
        return cache[refcat]
    buildings, parts = catastro.buildings_for_refcat(refcat)
    fp = sum(b["footprint"].area for b in buildings)
    floors = [p["floors_above_ground"] for p in parts if p["floors_above_ground"]]
    main = max(buildings, key=lambda b: b["footprint"].area)
    info = {"dwellings": sum(b["dwellings"] or 0 for b in buildings),
            "floors": max(floors) if floors else None,
            "footprint_m2": round(fp, 1), "current_use": main["current_use"],
            "year_built": main["year_built"]}
    cache[refcat] = info
    return info


def load_cache(path):
    path = Path(path)
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}


def save_cache(cache, path):
    Path(path).write_text(json.dumps(cache, indent=1), encoding="utf-8")


def to_row(b):
    d = asdict(b)
    d["yearly_kwh"] = b.yearly_kwh
    return d
