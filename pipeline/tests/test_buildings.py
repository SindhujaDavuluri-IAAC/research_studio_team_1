"""Offline tests for saving the study area for the map (the city server is replaced by a stand-in)."""
import json

import pytest

from web import buildings

LAT, LON = buildings.FOCUS_LAT, buildings.FOCUS_LON


def _feature(oid, lon, lat, size=0.0002):
    a = {k: None for k in buildings.FIELDS}
    a.update(objectid=oid, bldgheight=20.0, roofform="Flat", uso_desc="Residencial")
    ring = [[lon, lat], [lon + size, lat], [lon + size, lat + size], [lon, lat + size], [lon, lat]]
    return {"attributes": a, "geometry": {"rings": [ring]}}


class _Reply:
    def __init__(self, data):
        self.data = data
    def raise_for_status(self):
        pass
    def json(self):
        return self.data


@pytest.fixture
def city(monkeypatch):
    feats = [_feature(k, LON + 0.0003 * k, LAT) for k in range(5)]
    feats.append({"attributes": {"objectid": 99}, "geometry": {}})      # no outline: dropped
    calls = []
    def post(url, data, timeout):
        calls.append(data)
        off = int(data.get("resultOffset", 0))
        return _Reply({"features": feats[off:off + 2], "exceededTransferLimit": off + 2 < len(feats)})
    monkeypatch.setattr(buildings.requests, "post", post)
    return calls


def test_download_pages_through_everything(city):
    feats = buildings.download(LAT, LON, 700)
    assert [f["attributes"]["objectid"] for f in feats] == [0, 1, 2, 3, 4] and len(city) == 3
    env = json.loads(city[0]["geometry"])
    assert env["xmin"] < LON < env["xmax"] and env["ymin"] < LAT < env["ymax"]


def test_server_without_paging_is_split_into_quarters(monkeypatch):
    feats = [_feature(k, LON + 0.0003 * k, LAT) for k in range(3)]
    def post(url, data, timeout):
        if "resultOffset" in data:
            return _Reply({"error": {"message": "Pagination is not supported"}})
        env = json.loads(data["geometry"])
        inside = [f for f in feats if env["xmin"] <= f["geometry"]["rings"][0][0][0] < env["xmax"]
                  and env["ymin"] <= f["geometry"]["rings"][0][0][1] < env["ymax"]]
        return _Reply({"features": inside, "exceededTransferLimit": len(inside) > 1})
    monkeypatch.setattr(buildings.requests, "post", post)
    assert sorted(f["attributes"]["objectid"] for f in buildings.download(LAT, LON, 700)) == [0, 1, 2]


def test_compact_file_for_the_map(city):
    data = buildings.compact(buildings.download(LAT, LON, 700), LAT, LON, 350, 350)
    assert data["fields"] == buildings.FIELDS and len(data["buildings"]) == 5
    row = data["buildings"][0]
    assert len(row) == len(buildings.FIELDS) + 1 and row[0] == 0 and len(row[-1][0]) == 5
    assert data["center"] == [LON, LAT] and data["cover_radius_m"] == 350
