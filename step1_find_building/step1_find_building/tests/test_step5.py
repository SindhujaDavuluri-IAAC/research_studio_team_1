"""Offline tests for step 5 (demand prediction and sharing groups)."""
import csv

import numpy as np

from step4.batch import slug
from step5 import demand as dm
from step5 import sharing as sh

TIMES = np.arange(np.datetime64("2023-01-01T00:30"), np.datetime64("2024-01-01T00:30"),
                  np.timedelta64(60, "m"))


def test_predicted_use_grows_with_dwellings_and_flat_size():
    small = dm.predict_yearly("A", 10, 6, 400, "1_residential")
    more = dm.predict_yearly("B", 20, 6, 400, "1_residential")
    bigger_flats = dm.predict_yearly("C", 10, 6, 800, "1_residential")
    assert more.home_kwh > small.home_kwh and bigger_flats.home_kwh > small.home_kwh
    assert small.shop_kwh == 400 * dm.COMMERCIAL_KWH_PER_M2       # ground-floor shops
    assert 15000 < small.home_kwh < 60000                            # 10 flats of ~200 m2


def test_shapes_sum_to_one_and_homes_peak_in_the_evening():
    home, shop = dm.hourly_shapes(TIMES)
    assert len(home) == 8760 and abs(home.sum() - 1) < 1e-9 and abs(shop.sum() - 1) < 1e-9
    hour, weekday, _ = dm.local_hours(TIMES)
    assert home[hour == 21].mean() > 2 * home[hour == 4].mean()
    assert shop[(hour == 12) & (weekday < 5)].mean() > 3 * shop[hour == 3].mean()


def test_local_time_and_weekdays():
    hour, weekday, month = dm.local_hours(np.array(["2023-07-03T10:30", "2023-01-01T23:30"], dtype="datetime64[m]"))
    assert list(hour) == [12, 0] and weekday[0] == 0 and list(month) == [7, 1]   # 3 Jul 2023 was a Monday


def test_surplus_is_split_by_need_and_rest_exported():
    rec, exp = sh.split_surplus(np.array([10.0, 2.0]), [np.array([3.0, 3.0]), np.array([1.0, 1.0])])
    assert np.allclose(rec[0], [3, 1.5]) and np.allclose(rec[1], [1, 0.5]) and np.allclose(exp, [6, 0])


def _b(surplus, need, lat=41.393):
    return {"surplus": np.array(surplus, float), "need": np.array(need, float), "latlon": (lat, 2.17)}


def test_groups_pair_surplus_with_need_within_distance():
    buildings = {"sunny": _b([500, 500], [0, 0]),
                 "shaded": _b([0, 0], [400, 400]),
                 "far": _b([0, 0], [900, 900], lat=41.40),       # ~780 m away
                 "small": _b([0, 0], [20, 20])}
    groups = sh.form_groups(buildings, max_distance=500, min_gain=60)
    assert groups == [["sunny", "shaded"]]
    groups5k = sh.form_groups(buildings, max_distance=5000, min_gain=60)
    assert groups5k[0][:2] == ["sunny", "far"]


def test_run_offline(tmp_path):
    ydir = tmp_path / "yield"
    ydir.mkdir()
    sun = np.clip(np.sin((dm.local_hours(TIMES)[0] - 6) / 12 * np.pi), 0, None)
    for ref, kw in (("SUNNY", 10.0), ("SHADED", 0.3)):
        with open(ydir / f"{slug(ref)}_hourly.csv", "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(["time_utc", "kwh"])
            w.writerows((str(t), kw * s) for t, s in zip(TIMES, sun))
    roofs = tmp_path / "roofs.csv"
    roofs.write_text("address,block,refcat,lat,lon\nSunny 1,6,SUNNY,41.393,2.169\n"
                     "Shaded 2,6,SHADED,41.3932,2.1692\nNoRoof 3,6,NOROOF,41.3931,2.1691\n"
                     "Empty 4,6,EMPTY,41.3931,2.1691\n", encoding="utf-8")
    data = {"SUNNY": (2, 3, 300), "SHADED": (20, 7, 300), "NOROOF": (12, 6, 250)}
    def lookup(ref, cache):
        if ref == "EMPTY":
            raise RuntimeError("No building with a footprint found")
        d, fl, fp = data[ref]
        return {"dwellings": d, "floors": fl, "footprint_m2": fp, "current_use": "1_residential", "year_built": 1900}
    rows, groups = sh.run(roofs, ydir, tmp_path / "out", lookup=lookup)
    by = {r["refcat"]: r for r in rows}
    assert set(by) == {"SUNNY", "SHADED", "NOROOF"}
    assert by["SUNNY"]["surplus_kwh"] > 0 and by["SHADED"]["received_kwh"] > 0
    assert groups and groups[0]["started_by"] == "Sunny 1" and groups[0]["shared_kwh"] > 0
    assert by["SHADED"]["covered_pct"] > 100 * by["SHADED"]["self_consumed_kwh"] / by["SHADED"]["predicted_use_kwh"]
    assert (tmp_path / "out" / "groups.csv").exists()


CSV = """﻿01.Any,02.Data,03.Codi_Postal,04.Sector_Economic,05.Tram_Horari,06.Valor
2023,2023-01-02,08009,Residencial,De 00:00:00 a 05:59:59,10
2023,2023-01-02,08009,Residencial,De 06:00:00 a 11:59:59,20
2023,2023-01-02,08009,Residencial,De 12:00:00 a 17:59:59,30
2023,2023-01-02,08009,Residencial,De 18:00:00 a 23:59:59,40
2023,2023-07-01,08009,Residencial,De 18:00:00 a 23:59:59,50
2023,2023-01-02,08009,Serveis,De 12:00:00 a 17:59:59,70
2023,2023-01-02,08028,Residencial,De 00:00:00 a 05:59:59,999
2023,2023-01-02,08009,No consta,De 00:00:00 a 05:59:59,5
"""


def test_learn_from_open_data_bcn():
    from step5 import bcn_data as bd
    prof = bd.learn(bd.read_rows(CSV), ["08009"])
    assert prof["yearly_mwh"] == {"home": 150.0, "shop": 70.0}           # other postal codes and sectors left out
    assert prof["home"]["band_share"]["weekday"] == [0.1, 0.2, 0.3, 0.4]  # 2 Jan 2023 was a Monday
    assert prof["home"]["band_share"]["weekend"][3] == 1.0


def test_learned_profile_changes_the_day_split(tmp_path):
    import json
    prof = {"home": {"band_share": {"weekday": [0.1, 0.2, 0.3, 0.4], "weekend": [0.1, 0.2, 0.3, 0.4]},
                     "weekend_vs_weekday": 1.0, "month_factor": [1.0] * 12}}
    path = tmp_path / "p.json"
    path.write_text(json.dumps(prof))
    home, _ = dm.hourly_shapes(TIMES, path)
    hour, weekday, _ = dm.local_hours(TIMES)
    wd = weekday < 5
    split = [home[wd & (hour // 6 == b)].sum() / home[wd].sum() for b in range(4)]
    assert np.allclose(split, [0.1, 0.2, 0.3, 0.4], atol=0.02)
    assert abs(home.sum() - 1) < 1e-9
