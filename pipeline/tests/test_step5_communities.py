"""Offline tests for step 5c (co-investment communities)."""
import csv
import json

import numpy as np

from step4.batch import slug
from step5 import communities as cm
from step5 import demand as dm

TIMES = np.arange(np.datetime64("2023-01-01T00:30"), np.datetime64("2024-01-01T00:30"),
                  np.timedelta64(60, "m"))


def sun(kw):
    hour = dm.local_hours(TIMES)[0]
    return kw * np.clip(np.sin((hour - 6) / 12 * np.pi), 0, None)


def test_office_and_school_shapes():
    s = dm.profile_shapes(TIMES)
    hour, weekday, month = dm.local_hours(TIMES)
    for k in ("home", "shop", "office", "school"):
        assert abs(s[k].sum() - 1) < 1e-9
    work = (weekday < 5) & (hour == 11)
    assert s["office"][work].mean() > 5 * s["office"][(weekday >= 5) & (hour == 11)].mean()
    assert s["school"][work & (month == 7)].mean() < 0.2 * s["school"][work & (month == 10)].mean()
    gen = sun(10)
    # complementarity: offices and schools use more of their energy in sunny hours than homes
    assert cm.daytime_share(s["office"], gen) > cm.daytime_share(s["home"], gen)


def test_kind_from_catastro_use():
    assert dm.kind_from_use("4_1_office") == "office"
    assert dm.kind_from_use("4_3_publicServices") == "school"
    assert dm.kind_from_use("1_residential") == "shop"
    assert dm.kind_from_use("1_residential", "school") == "school"
    b = dm.predict_yearly("S", 0, 3, 1000, "4_3_publicServices")
    assert b.kind == "school" and b.shop_kwh == 3000 * dm.SCHOOL_KWH_PER_M2


def test_hosts_are_best_kwh_per_kwp():
    ranking = [{"refcat": "A", "kwp": 10, "yearly_kwh": 11000, "kwh_per_kwp": 1100},
               {"refcat": "B", "kwp": 15, "yearly_kwh": 19000, "kwh_per_kwp": 1260},
               {"refcat": "C", "kwp": 2, "yearly_kwh": 2600, "kwh_per_kwp": 1300}]   # too small
    assert [h["refcat"] for h in cm.pick_hosts(ranking, 5, min_kwp=5)] == ["B", "A"]


def test_host_flats_first_then_daytime_users():
    s = dm.profile_shapes(TIMES)
    gen = sun(15)
    home = dm.predict_yearly("H", 10, 6, 400, "1_residential")
    office = dm.predict_yearly("O", 0, 4, 300, "4_1_office")
    flats = dm.predict_yearly("F", 30, 6, 500, "1_residential")
    cands = [("H", 0, cm.participants_of(home, s)), ("F", 50, cm.participants_of(flats, s)),
             ("O", 120, cm.participants_of(office, s))]
    picked = cm.form_community("H", gen, cands)
    assert picked[0]["refcat"] == "H" and picked[1]["refcat"] == "O"    # same ring: office before nearer flats
    rows = cm.settle(picked, gen, "H", 15, 36)
    assert abs(sum(r["beta"] for r in rows) - 1) < 1e-9
    host = rows[0]
    assert host["ibi_unit"] > 0 and all(r["ibi_unit"] == 0 for r in rows[1:])   # IBI for host owners only
    assert all(r["payback_incentives"] < r["payback"] for r in rows)
    assert all(r["used_unit"] <= r["kwh_unit"] + 1e-9 for r in rows)


def _area(tmp_path):
    """A small made-up area: 3 roofs with panels, 6 other buildings, one office, one far away."""
    ydir = tmp_path / "yield"
    ydir.mkdir()
    specs = [  # refcat, address, x, y, kwp, dwellings, floors, footprint, use
        ("HOSTA", "Host A 1", 0, 0, 16, 12, 6, 400, "1_residential"),
        ("HOSTB", "Host B 2", 150, 0, 10, 10, 6, 350, "1_residential"),
        ("SMALL", "Small roof 3", 60, 60, 2, 8, 6, 300, "1_residential"),
        ("OFF", "Office 4", 80, -40, 0, 0, 5, 500, "4_1_office"),
        ("G1", "Flats 5", 30, 30, 0, 20, 7, 450, "1_residential"),
        ("G2", "Flats 6", 120, 50, 0, 18, 7, 420, "1_residential"),
        ("G3", "Flats 7", 200, -30, 0, 16, 6, 400, "1_residential"),
        ("FAR", "Far away 8", 900, 0, 0, 20, 6, 400, "1_residential")]
    ranking, roofs, feats, data = [], [], [], {}
    for ref, addr, x, y, kwp, dw, fl, fp, use in specs:
        lat, lon = 41.39 + y / 111000, 2.165 + x / 83500
        roofs.append({"address": addr, "block": 6, "refcat": ref, "lat": lat, "lon": lon})
        data[ref] = {"dwellings": dw, "floors": fl, "footprint_m2": fp, "current_use": use, "year_built": 1900}
        sq = [[430000 + x, 4582000 + y], [430020 + x, 4582000 + y], [430020 + x, 4582020 + y],
              [430000 + x, 4582020 + y], [430000 + x, 4582000 + y]]
        feats.append({"type": "Feature", "geometry": {"type": "Polygon", "coordinates": [sq]},
                      "properties": {"refcat": ref, "address": addr}})
        if kwp:
            g = sun(kwp * 0.62)
            with open(ydir / f"{slug(ref)}_hourly.csv", "w", newline="", encoding="utf-8") as f:
                w = csv.writer(f)
                w.writerow(["time_utc", "kwh"])
                w.writerows((str(t), v) for t, v in zip(TIMES, g))
            ranking.append({"rank": 0, "address": addr, "refcat": ref, "panels": round(kwp / 0.42), "kwp": kwp,
                            "yearly_kwh": round(g.sum()), "kwh_per_kwp": round(g.sum() / kwp), "error": ""})
    ranking[1]["kwh_per_kwp"] -= 50       # Host B a bit worse than Host A
    with open(ydir / "ranking.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(ranking[0]))
        w.writeheader()
        w.writerows(ranking)
    roofs_csv = tmp_path / "roofs.csv"
    with open(roofs_csv, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(roofs[0]))
        w.writeheader()
        w.writerows(roofs)
    gj = tmp_path / "roofs.geojson"
    gj.write_text(json.dumps({"type": "FeatureCollection", "features": feats}), encoding="utf-8")
    return roofs_csv, ydir, gj, (lambda ref, cache: data[ref])


def test_run_offline(tmp_path):
    roofs_csv, ydir, gj, lookup = _area(tmp_path)
    out = tmp_path / "out"
    comms, members = cm.run(roofs_csv, ydir, out, tmp_path / "cache.json", hosts=5, min_kwp=5,
                            types_path=tmp_path / "none.csv", geojson_path=gj, lookup=lookup)
    assert [c["host_refcat"] for c in comms] == ["HOSTA", "HOSTB"]           # SMALL is under 5 kWp
    refs = [m["refcat"] for m in members]
    assert len(refs) == len(set(refs))                                      # one community per building
    assert "FAR" not in refs                                                # more than 450 m away
    a = [m for m in members if m["community"] == 1]
    assert a[0]["role"] == "host" and any(m["refcat"] == "OFF" for m in a)  # office joins the best roof
    assert abs(sum(m["beta_pct"] for m in a) - 100) < 0.1
    assert comms[0]["flags"].startswith("grid permits")                     # over 15 kWp
    assert 50 < comms[0]["used_on_the_spot_pct"] <= 100
    assert (out / "communities.png").exists() and (out / "communities.geojson").exists()
    far = cm.run(roofs_csv, ydir, tmp_path / "out5k", tmp_path / "cache.json", hosts=5, max_distance=5000,
                 types_path=tmp_path / "none.csv", lookup=lookup)[1]
    assert len(far) >= len(members)
