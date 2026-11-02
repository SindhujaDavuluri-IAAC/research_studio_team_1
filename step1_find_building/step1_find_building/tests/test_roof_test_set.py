"""Offline tests for the roof test set (no Catastro calls)."""
import csv

from shapely.geometry import box

from step4 import roof_test_set as rts

GML = """<?xml version="1.0"?>
<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" xmlns:gml="http://www.opengis.net/gml/3.2"
  xmlns:cp="http://inspire.ec.europa.eu/schemas/cp/4.0">
 <wfs:member><cp:CadastralParcel gml:id="ES.SDGC.CP.0629625DF3802H">
  <cp:areaValue uom="m2">512</cp:areaValue>
  <cp:geometry><gml:MultiSurface><gml:surfaceMember><gml:Surface><gml:patches><gml:PolygonPatch>
   <gml:exterior><gml:LinearRing><gml:posList>0 0 20 0 20 25 0 25 0 0</gml:posList></gml:LinearRing></gml:exterior>
  </gml:PolygonPatch></gml:patches></gml:Surface></gml:surfaceMember></gml:MultiSurface></cp:geometry>
  <cp:nationalCadastralReference>0629625DF3802H</cp:nationalCadastralReference>
  <cp:referencePoint><gml:Point><gml:pos>10 12</gml:pos></gml:Point></cp:referencePoint>
 </cp:CadastralParcel></wfs:member>
</wfs:FeatureCollection>"""


def test_parse_parcels():
    (p,) = rts.parse_parcels(GML)
    assert p["refcat"] == "0629625DF3802H" and p["area_m2"] == 512
    assert (p["point"].x, p["point"].y) == (10, 12) and p["geometry"].area == 500


def _parcel(ref, x, y):
    g = box(x, y, x + 20, y + 20)
    return {"refcat": ref, "area_m2": 400, "point": g.centroid, "geometry": g}


def test_touching_plots_form_one_block_and_streets_split_blocks():
    parcels = [_parcel("A", 0, 0), _parcel("B", 20, 0), _parcel("C", 60, 0)]   # 20 m street before C
    blocks = sorted(rts.group_blocks(parcels), key=lambda b: len(b["parcels"]))
    assert [len(b["parcels"]) for b in blocks] == [1, 2]


def test_a_passage_does_not_split_a_block():
    parcels = [_parcel("A", 0, 0), _parcel("B", 28, 0)]   # 8 m passatge between them
    assert len(rts.group_blocks(parcels)) == 1


def test_block_numbers_follow_the_streets():
    b5 = ["CL PAU CLARIS 120 BARCELONA (BARCELONA)", "CL ROGER DE LLURIA 70 BARCELONA (BARCELONA)",
          "CL DIPUTACIO 300 BARCELONA (BARCELONA)", "CL CONSELL DE CENT 380 BARCELONA (BARCELONA)",
          "PJ PERMANYER 5 BARCELONA (BARCELONA)"]
    assert rts.classify_block(b5) == (5, "Pau Claris-Roger de Llúria / Diputació-Consell de Cent")
    b1 = ["PS GRACIA 20", "CL PAU CLARIS 90", "GV GRAN VIA DE LES CORTS CATALANES 650", "CL DIPUTACIO 250"]
    assert rts.classify_block(b1)[0] == 1
    b9 = ["CL ROGER DE LLURIA 100", "CL BRUC 90", "CL CONSELL DE CENT 400", "CL ARAGÓ 300"]
    assert rts.classify_block(b9)[0] == 9


def test_neighbouring_blocks_are_left_out():
    east = ["CL BRUC 50", "CL GIRONA 40", "CL GIRONA 42", "CL DIPUTACIO 320", "CL CONSELL DE CENT 410"]
    south = ["CL CASP 30", "CL CASP 32", "GV GRAN VIA DE LES CORTS CATALANES 640", "CL PAU CLARIS 80",
             "CL ROGER DE LLURIA 20", "CL CASP 34"]
    west = ["RB CATALUNYA 30", "RB CATALUNYA 32", "PS GRACIA 30", "CL DIPUTACIO 260", "CL CONSELL DE CENT 330"]
    north = ["CL ARAGO 280", "CL VALENCIA 270", "CL VALENCIA 272", "CL PAU CLARIS 150", "CL ROGER DE LLURIA 110"]
    for addrs in (east, south, west, north):
        assert rts.classify_block(addrs) is None
    assert rts.classify_block([]) is None
    assert rts.classify_block(["CL PAU CLARIS 100"]) is None   # one street only: can't tell which block


def test_clean_address():
    assert rts.clean_address("CL ROGER DE LLURIA 56 BARCELONA (BARCELONA)") == "CL ROGER DE LLURIA 56, Barcelona"


def test_build_offline(tmp_path, monkeypatch):
    # 2 blocks 130 m apart; the first faces our streets, the second Girona
    parcels = [_parcel("P1", 0, 0), _parcel("P2", 20, 0), _parcel("Q1", 130, 0), _parcel("Q2", 150, 0)]
    streets = {"P1": "CL PAU CLARIS 1 BARCELONA (BARCELONA)", "P2": "CL DIPUTACIO 2 BARCELONA (BARCELONA)",
               "Q1": "CL GIRONA 3", "Q2": "CL GIRONA 4"}
    monkeypatch.setattr(rts, "geocode", lambda a: {"lat": 0, "lon": 0})
    monkeypatch.setattr(rts, "to_utm", lambda lon, lat: (80, 10))
    monkeypatch.setattr(rts, "to_wgs", lambda x, y: (2.17, 41.39))
    monkeypatch.setattr(rts, "download_parcels", lambda cx, cy: parcels)
    calls = []
    def fake_lookup(p, cache, pause=0):
        calls.append(p["refcat"])
        cache[p["refcat"]] = {"address": streets[p["refcat"]]}
        return cache[p["refcat"]]
    monkeypatch.setattr(rts, "lookup_address", fake_lookup)
    monkeypatch.setattr(rts, "classify_block",
                        lambda a: (4, "test") if any("PAU CLARIS" in x for x in a) else None)
    rows = rts.build(tmp_path, radius=500)
    assert [r["refcat"] for r in rows] == ["P1", "P2"] and rows[0]["block"] == 4
    with open(tmp_path / "roof_test_set.csv", encoding="utf-8") as f:
        assert list(csv.DictReader(f))[0]["address"] == "CL PAU CLARIS 1, Barcelona"
    assert (tmp_path / "roof_test_set.png").exists() and (tmp_path / "roof_test_set.geojson").exists()


def test_half_blocks_are_placed_by_the_grid():
    pitch = 133.3
    def blk(col, row, w=113.3, dx=0):
        g = box(col * pitch + dx, row * pitch, col * pitch + dx + w, row * pitch + 113.3)
        return {"shape": g, "parcels": [], "addresses": []}
    kept = [((r * 3 + c + 1, ""), blk(c, r)) for r in range(3) for c in range(3) if (c, r) != (2, 2)]
    west = blk(2, 2, w=50); west["addresses"] = ["CL ROGER DE LLURIA 120", "PJ MENDEZ VIGO 3"]
    east = blk(2, 2, w=50, dx=63.3); east["addresses"] = ["CL BRUC 100", "CL ARAGO 310"]
    outside = blk(3, 2); outside["addresses"] = ["CL GIRONA 50", "CL BRUC 101"]
    placed = rts.place_by_grid(kept, [west, east, outside])
    assert sorted(n for n, _ in placed) == [9, 9]
    assert rts.block_name(9) == "Roger de Llúria-Bruc / Consell de Cent-Aragó"
