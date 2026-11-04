"""Offline tests for the Mapa d'Energia benchmark: a fake CARTO stands in for the city."""
import csv
import json

import pytest
from pyproj import Transformer
from shapely.geometry import box, mapping
from shapely.ops import transform

from step4 import energy_map as em

CONFIG = '''var SQL_URL = "https://urbisadmin.carto.com/api/v2/sql/";
var API_KEY = "publickey";
var TABLE_NAMES = [];
TABLE_NAMES[0] = "termosolar";
TABLE_NAMES[1] = "fotovoltaica";'''
X0, Y0 = 430500.0, 4582500.0
PLOT = box(X0, Y0, X0 + 20, Y0 + 30)
TO_WGS = Transformer.from_crs("EPSG:25831", "EPSG:4326", always_xy=True)


def _city_fc():
    """Two roof pieces inside the plot, one in the next plot."""
    parts = [(box(X0 + 1, Y0 + 1, X0 + 9, Y0 + 14), "8.000,5", 30), (box(X0 + 11, Y0 + 1, X0 + 19, Y0 + 14), 4000, 20),
             (box(X0 + 25, Y0 + 1, X0 + 35, Y0 + 14), 9999, 40)]
    feats = [{"type": "Feature", "geometry": mapping(transform(TO_WGS.transform, g)),
              "properties": {"cartodb_id": i, "energia_ge": e, "potencia_i": kw, "superfici1": g.area,
                             "radiacio": 1500 + i, "the_geom_webmercator": "x"}}
             for i, (g, e, kw) in enumerate(parts)]
    return {"type": "FeatureCollection", "features": feats}


class Resp:
    def __init__(self, data, ok=True):
        self.ok, self.status_code = ok, 200 if ok else 500
        self.text = data if isinstance(data, str) else json.dumps(data)

    def raise_for_status(self):
        if not self.ok:
            raise em.requests.HTTPError("bad")

    def json(self):
        return json.loads(self.text)


class FakeCarto:
    def __init__(self):
        self.posts = []

    def get(self, url, **kw):
        assert url == em.CONFIG_URL
        return Resp(CONFIG)

    def post(self, url, data=None, **kw):
        self.posts.append(data)
        assert url == "https://urbisadmin.carto.com/api/v2/sql/" and data["api_key"] == "publickey"
        if "LIMIT 1" in data["q"]:
            return Resp({"rows": [{"cartodb_id": 1, "energia_ge": 5, "the_geom": "x"}]})
        assert "ST_MakeEnvelope" in data["q"] and data["format"] == "geojson"
        return Resp(_city_fc())


def test_reads_config():
    svc = em.find_service(FakeCarto())
    assert svc == {"sql_url": "https://urbisadmin.carto.com/api/v2/sql/", "api_key": "publickey",
                   "tables": ["termosolar", "fotovoltaica"]}
    assert em.sample(svc, session=FakeCarto()) == {"cartodb_id": 1, "energia_ge": 5}


def test_numbers_in_spanish_format():
    assert em._number("8.000,5") == 8000.5
    assert em._number("12,5") == 12.5
    assert em._number(None) is None and em._number("n/a") is None


def test_adds_up_city_roofs_per_plot():
    city = em.CityRoofs(_city_fc())
    t = em.CityRoofs.total(city.in_area(PLOT))
    assert t["city_polygons"] == 2
    assert t["energia_ge"] == pytest.approx(12000.5)
    assert t["potencia_i"] == 50
    assert t["radiacio"] == pytest.approx(1500.5)


def test_run_csv_compares_with_our_ranking(tmp_path):
    lon, lat = TO_WGS.transform(PLOT.centroid.x, PLOT.centroid.y)
    roofs = tmp_path / "roof_test_set.csv"
    with open(roofs, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["address", "block", "refcat", "lat", "lon"])
        w.writeheader()
        w.writerow({"address": "Bruc 59", "block": 6, "refcat": "A1", "lat": lat, "lon": lon})
    (tmp_path / "roof_test_set.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": [
        {"type": "Feature", "geometry": mapping(PLOT), "properties": {"refcat": "A1"}}]}), encoding="utf-8")
    ranking = tmp_path / "ranking.csv"
    with open(ranking, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["refcat", "yearly_kwh", "kwp", "usable_area_m2"])
        w.writeheader()
        w.writerow({"refcat": "A1", "yearly_kwh": 9600, "kwp": 8.4, "usable_area_m2": 200})
    carto = FakeCarto()
    svc = em.find_service(carto)
    rows = em.run_csv(roofs, svc, tmp_path / "out", ranking, session=carto)
    assert rows[0]["city_kwh"] == pytest.approx(12000.5)
    assert rows[0]["ours_vs_city"] == pytest.approx(0.8)
    assert (tmp_path / "out" / "fotovoltaica.geojson").exists()
    n = len(carto.posts)
    em.run_csv(roofs, svc, tmp_path / "out", ranking, session=carto)   # second run uses the saved file
    assert len(carto.posts) == n


def test_point_fallback_without_outlines():
    city = em.CityRoofs(_city_fc())
    from shapely.geometry import Point
    assert len(city.at_point(Point(X0 + 5, Y0 + 5))) == 1
