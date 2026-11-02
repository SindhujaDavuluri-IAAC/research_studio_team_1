"""Offline tests for steps 3 and 4: panel layout, sun, LiDAR shade and yield.

Catastro is replaced by a stand-in and PVGIS by a clear-sky year, so no
internet is needed.
"""
import csv
import json

import laspy
import numpy as np
import pytest
from shapely import affinity
from shapely.geometry import box

from step3.layout import PANEL_WP, facing_azimuth, lay_out, row_pitch
from step2.grid import Grid
from step2.lidar_roof import rasterise_max
from step4 import batch, shade_yield
from step4.horizon import horizons, is_lit, sky_view
from step4.sun import sun_position
from step4.weather import Weather

X0, Y0 = 430000.0, 4582000.0
LAT, LON = 41.39, 2.17
FP = box(X0, Y0, X0 + 20, Y0 + 15)


def _clear_sky_year():
    times = np.arange(np.datetime64("2023-01-01T00:30"), np.datetime64("2024-01-01T00:30"),
                      np.timedelta64(1, "h"))
    elev, _ = sun_position(times, LAT, LON)
    s = np.sin(np.deg2rad(elev.clip(0)))
    dni = np.where(elev > 2, 900 * s ** 0.3, 0.0)
    dhi = np.where(elev > 0, 100 * s, 0.0)
    return Weather(times, dni * s + dhi, dni, dhi, np.full(len(times), 18.0))


def _write_las(path, x, y, z, cls):
    header = laspy.LasHeader(point_format=6, version="1.4")
    header.offsets = [x.min(), y.min(), z.min()]
    header.scales = [0.01, 0.01, 0.01]
    las = laspy.LasData(header)
    las.x, las.y, las.z = x, y, z
    las.classification = np.asarray(cls, dtype=np.uint8)
    las.write(path)


def _scene(tower=True):
    """Our flat roof at 25 m, ground at 0 around it, and (optionally) a 60 m tower just south."""
    xs, ys = np.meshgrid(np.arange(X0 - 60, X0 + 80, 0.5), np.arange(Y0 - 60, Y0 + 75, 0.5))
    x, y = xs.ravel(), ys.ravel()
    z = np.zeros_like(x)
    cls = np.full(x.shape, 2)
    ours = (x >= X0) & (x < X0 + 20) & (y >= Y0) & (y < Y0 + 15)
    z[ours], cls[ours] = 25.0, 6
    if tower:
        t = (x >= X0) & (x < X0 + 20) & (y >= Y0 - 12) & (y < Y0 - 4)
        z[t], cls[t] = 60.0, 6
    return x, y, z, cls


class _Record:
    refcat, catastro_address, query, year_built, dwellings = "0123456DF3802C", "CL TEST 1", "test", 1900, 10
    lat, lon = LAT, LON


@pytest.fixture
def offline(tmp_path, monkeypatch):
    _write_las(tmp_path / "tile.laz", *_scene())
    monkeypatch.setattr(shade_yield, "find_building", lambda *a, **k: (_Record(), FP))
    monkeypatch.setattr(shade_yield, "load_tmy", lambda path: _clear_sky_year())
    (tmp_path / "tmy.json").write_text("{}")
    return tmp_path


def test_sun_at_barcelona_summer_noon():
    elev, az = sun_position(np.array(["2023-06-21T11:51"], dtype="datetime64[m]"), LAT, LON)
    assert abs(elev[0] - (90 - LAT + 23.44)) < 1.0 and abs(az[0] - 180) < 5


def test_layout_faces_closest_to_south_and_spaces_rows():
    eixample = box(0, 0, 30, 20)
    assert facing_azimuth(eixample) == pytest.approx(180, abs=1)
    turned = affinity.rotate(eixample, 45)   # Eixample grid: 45 degrees
    assert facing_azimuth(turned) % 90 == pytest.approx(45, abs=1)
    lay = lay_out(box(0, 0, 10, 10), eixample)
    assert 5 * 6 <= lay.count <= 6 * 7   # 5 panels a row, rows every ~1.53 m
    assert row_pitch() == pytest.approx(1.53, abs=0.02)
    assert lay.kwp == pytest.approx(lay.count * PANEL_WP / 1000)
    assert all(box(0, 0, 10, 10).contains(p) for p in lay.panels)


def test_tower_to_the_south_blocks_low_sun():
    x, y, z, cls = _scene()
    area = box(X0 - 60, Y0 - 60, X0 + 80, Y0 + 75)
    grid = Grid.around(area, 1.0, buffer=0)
    dsm = rasterise_max(np.column_stack([x, y, z]), grid)
    h = horizons(grid, dsm, [X0 + 10, X0 + 10], [Y0 + 2, Y0 + 13], [25.4, 25.4])
    south = h[:, 18]
    assert south[0] > 60 and south[0] > south[1] > 0   # nearer the tower = higher horizon
    assert h[:, 0].max() < 1          # nothing to the north
    assert sky_view(h)[0] < sky_view(h)[1] < 1
    lit = is_lit(h, np.array([30.0, 80.0]), np.array([180.0, 180.0]))
    assert not lit[1, 0] and lit[1, 1]   # north panel: winter sun blocked, summer sun clear


def test_full_run_writes_outputs_and_shade_costs_energy(offline):
    res = shade_yield.shade_yield(str(offline), "test", weather_path=str(offline / "tmy.json"),
                                  out=str(offline / "roof"), max_shade_loss=None)
    y = res["yield"]
    assert y["panels"] > 20 and y["yearly_kwh"] > 0
    assert 0.1 < y["mean_shade_loss"] < 0.9          # a 60 m tower right in front
    assert sum(y["monthly_kwh"]) == pytest.approx(y["yearly_kwh"], rel=0.01)
    losses = [p["shade_loss"] for p in res["panels"]]
    south_row = min(res["panels"], key=lambda p: p["y"])
    north_row = max(res["panels"], key=lambda p: p["y"])
    assert south_row["shade_loss"] > north_row["shade_loss"] and max(losses) > min(losses)
    rows = list(csv.reader(open(offline / "roof_hourly.csv")))
    assert len(rows) == 8761
    fc = json.loads((offline / "roof_panels.geojson").read_text())
    assert len(fc["features"]) == y["panels"]
    assert (offline / "roof_panels.png").exists()


def test_heavily_shaded_panels_are_left_out(offline):
    out = str(offline / "roof")
    every = shade_yield.shade_yield(str(offline), "test", weather_path=str(offline / "tmy.json"),
                                    out=out, max_shade_loss=None)["yield"]
    kept = shade_yield.shade_yield(str(offline), "test", weather_path=str(offline / "tmy.json"),
                                   out=out, max_shade_loss=0.4)
    y = kept["yield"]
    assert y["panels_left_out"] > 0 and y["panels"] + y["panels_left_out"] == every["panels"]
    assert all(p["shade_loss"] <= 0.4 for p in kept["panels"])
    assert y["kwh_per_kwp"] > every["kwh_per_kwp"]


def test_open_roof_yield_is_plausible(tmp_path, monkeypatch):
    _write_las(tmp_path / "tile.laz", *_scene(tower=False))
    monkeypatch.setattr(shade_yield, "find_building", lambda *a, **k: (_Record(), FP))
    monkeypatch.setattr(shade_yield, "load_tmy", lambda path: _clear_sky_year())
    (tmp_path / "tmy.json").write_text("{}")
    y = shade_yield.shade_yield(str(tmp_path), "test", weather_path=str(tmp_path / "tmy.json"),
                                out=str(tmp_path / "roof"))["yield"]
    assert y["mean_shade_loss"] < 0.05
    assert 1000 < y["kwh_per_kwp"] < 2200   # clear-sky year, so above Barcelona's real ~1,500


def test_batch_ranks_and_survives_errors(offline, monkeypatch):
    real = shade_yield.shade_yield
    def fake(laz_dir, address, **kw):
        if address == "bad":
            raise SystemExit("No LiDAR tile")
        return real(laz_dir, address, **kw)
    monkeypatch.setattr(batch, "shade_yield", fake)
    (offline / "roofs.csv").write_text("address,block\ngood,1\nbad,2\n")
    rows = batch.run_batch(offline / "roofs.csv", str(offline), offline / "out", offline / "tmy.json")
    assert rows[0]["address"] == "good" and rows[0]["rank"] == 1
    assert rows[1]["error"] and rows[1]["rank"] == ""
    assert (offline / "out" / "ranking.csv").exists()


def test_batch_uses_lat_lon_from_the_roof_test_set(offline, monkeypatch):
    seen = []
    real = shade_yield.shade_yield
    def fake(laz_dir, address, lat=None, lon=None, **kw):
        seen.append((address, lat, lon))
        return real(laz_dir, address, lat=lat, lon=lon, **kw)
    monkeypatch.setattr(batch, "shade_yield", fake)
    (offline / "roofs.csv").write_text(
        "address,block,block_name,refcat,lat,lon,plot_m2\n"
        "CL PAU CLARIS 1,5,Pau Claris-Roger de Llúria / Diputació-Consell de Cent,0629625DF3802H,41.39,2.17,500\n",
        encoding="utf-8")
    rows = batch.run_batch(offline / "roofs.csv", str(offline), offline / "out", offline / "tmy.json")
    assert seen == [(None, 41.39, 2.17)]
    assert rows[0]["block_name"].startswith("Pau Claris") and rows[0]["rank"] == 1
    assert (offline / "out" / "0629625df3802h_yield.json").exists()


def test_batch_can_run_one_block(offline, monkeypatch):
    monkeypatch.setattr(batch, "shade_yield", lambda laz_dir, address, **kw: (_ for _ in ()).throw(SystemExit("x")))
    (offline / "roofs.csv").write_text("address,block\na,1\nb,5\nc,5\n", encoding="utf-8")
    rows = batch.run_batch(offline / "roofs.csv", str(offline), offline / "out", offline / "tmy.json", blocks=[5])
    assert sorted(r["address"] for r in rows) == ["b", "c"]


def test_batch_reads_each_lidar_tile_once(tmp_path, monkeypatch):
    import laspy
    calls = []
    monkeypatch.setattr(laspy, "read", lambda path: calls.append(path) or object())
    batch.keep_lidar_in_memory()
    tile = tmp_path / "t.laz"
    first = laspy.read(tile)
    assert laspy.read(str(tile)) is first and len(calls) == 1

