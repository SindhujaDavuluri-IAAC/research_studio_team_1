"""Offline tests for sending pipeline results to the Roofscapes RePowered map."""
import json

from shapely.geometry import box, mapping

from web.export import energy_block, export, export_files

X0, Y0 = 430550.0, 4582740.0  # Roger de Llúria 56, EPSG:25831


def _result(refcat="0629625DF3802H", usable=120.0):
    return {"building": {"refcat": refcat, "address": "CL TEST 1"},
            "roof": {"method": "lidar only", "usable_area_m2": usable, "free_area_m2": 150.0,
                     "obstacle_area_m2": 30.0, "existing_panels_m2": None, "confidence": "medium"},
            "lidar": {"roof_area_m2": 200.0, "lidar_coverage": 0.97,
                      "obstacles": [{"area_m2": 9.0, "height_m": 2.8, "x": X0 + 5, "y": Y0 + 5}]}}


def _usable():
    area = box(X0, Y0, X0 + 12, Y0 + 10).difference(box(X0 + 4, Y0 + 4, X0 + 6, Y0 + 6))
    return {"type": "FeatureCollection", "features": [{"type": "Feature", "geometry": mapping(area), "properties": {}}]}


def _energy(n=3):
    panels = [box(X0 + 1, Y0 + 1 + 1.6 * k, X0 + 2.76, Y0 + 2.11 + 1.6 * k) for k in range(n)]
    summary = {"panels": n, "kwp": 0.42 * n, "tilt_deg": 10.0, "azimuth_deg": 135.0, "yearly_kwh": 600 * n,
               "kwh_per_kwp": 1430, "mean_shade_loss": 0.1, "monthly_kwh": [50 * n] * 12, "peak_hour_kw": 0.4 * n,
               "panels_left_out": 1, "max_shade_loss": 0.4}
    return summary, [list(p.exterior.coords) for p in panels], [600.0] * n, [0.1] * n


def test_export_writes_reading_in_lnglat_with_holes(tmp_path):
    path = export(_result(), _usable(), tmp_path)
    r = json.loads(path.read_text(encoding="utf-8"))
    assert path.name == "0629625DF3802H.json" and path.parent == tmp_path / "data" / "roofs"
    assert len(r["usable"]) == 1 and len(r["usable"][0]) == 2      # one area with one hole
    lng, lat = r["usable"][0][0][0]
    assert 2.16 < lng < 2.18 and 41.38 < lat < 41.40
    assert r["usable"][0][0][0] != r["usable"][0][0][-1]            # no repeated closing point
    w, s, e, n = r["bbox"]
    assert w < e and s < n
    assert r["roof"]["usable_area_m2"] == 120.0 and len(r["obstacles"]) == 1
    assert r["energy"] is None                                       # step 4 not run


def test_index_keeps_one_entry_per_roof(tmp_path):
    export(_result(usable=100.0), _usable(), tmp_path)
    export(_result(usable=120.0), _usable(), tmp_path)
    export(_result(refcat="0629624DF3802H0001AB"), _usable(), tmp_path)
    index = json.loads((tmp_path / "data" / "roofs" / "index.json").read_text(encoding="utf-8"))
    assert [r["refcat"] for r in index["roofs"]] == ["0629624DF3802H", "0629625DF3802H"]
    assert index["roofs"][1]["usable_area_m2"] == 120.0


def test_empty_usable_area_still_exports(tmp_path):
    r = json.loads(export(_result(usable=0.0), {"features": []}, tmp_path).read_text(encoding="utf-8"))
    assert r["usable"] == [] and r["bbox"] is None


def test_step4_energy_goes_to_the_roof_file_and_the_index(tmp_path):
    energy = energy_block(*_energy(3))
    r = json.loads(export(_result(), _usable(), tmp_path, energy).read_text(encoding="utf-8"))
    e = r["energy"]
    assert e["yearly_kwh"] == 1800 and e["panels"] == 3 and len(e["monthly_kwh"]) == 12
    assert len(e["panel_list"]) == 3
    p = e["panel_list"][0]
    assert len(p["ring"]) == 4 and p["kwh"] == 600.0 and p["loss"] == 0.1
    lng, lat = p["ring"][0]
    assert 2.16 < lng < 2.18 and 41.38 < lat < 41.40
    index = json.loads((tmp_path / "data" / "roofs" / "index.json").read_text(encoding="utf-8"))
    assert index["roofs"][0]["yearly_kwh"] == 1800 and index["roofs"][0]["panels"] == 3


def test_export_files_after_step4(tmp_path, monkeypatch):
    """python -m web.export <name> finds step 4's files and sends the energy too."""
    monkeypatch.chdir(tmp_path)
    summary, rings, kwh, loss = _energy(2)
    (tmp_path / "roof_usable.geojson").write_text(json.dumps(_usable()))
    (tmp_path / "roof_yield.json").write_text(json.dumps({**_result(), "yield": summary,
                                                          "usable_file": "roof_usable.geojson"}))
    feats = [{"type": "Feature", "geometry": {"type": "Polygon", "coordinates": [r]},
              "properties": {"kwh_year": k, "shade_loss": s}} for r, k, s in zip(rings, kwh, loss)]
    (tmp_path / "roof_panels.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": feats}))
    r = json.loads(export_files("roof", tmp_path / "site").read_text(encoding="utf-8"))
    assert r["energy"]["panels"] == 2 and len(r["energy"]["panel_list"]) == 2


def test_typical_day_per_month_in_local_time():
    from web.export import typical_days
    times = ["2023-06-15T11:30", "2023-06-16T11:30", "2023-12-15T11:30"]
    days = typical_days(times, [10.0, 6.0, 4.0])
    assert days[5][13] == 8.0          # June: 11 UTC = 13:00 in Barcelona (summer time), average of 2 days
    assert days[11][12] == 4.0         # December: 11 UTC = 12:00
    assert len(days) == 12 and all(len(d) == 24 for d in days)


def test_block_and_typical_day_reach_the_roof_file(tmp_path):
    summary, rings, kwh, loss = _energy(2)
    energy = energy_block(summary, rings, kwh, loss, ["2023-01-01T12:30"], [1.5])
    r = json.loads(export(_result(), _usable(), tmp_path, energy, {"block": 5, "block_name": None}).read_text())
    assert r["block"] == 5 and "block_name" not in r and r["energy"]["typical_day_kwh"][0][13] == 1.5
    index = json.loads((tmp_path / "data" / "roofs" / "index.json").read_text())
    assert index["roofs"][0]["block"] == 5
