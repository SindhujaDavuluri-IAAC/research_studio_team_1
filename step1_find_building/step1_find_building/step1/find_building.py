"""Pipeline step 1: find the building.

address (or a map tap) -> point -> cadastral reference -> footprint, age, homes
-> LiDAR tiles -> building height, flat roof? -> heritage flag.

Run from the folder that contains `step1/`:
    python -m step1.find_building "Carrer de Girona 81, Barcelona" --laz-dir data/lidar
    python -m step1.find_building --lat 41.3935 --lon 2.1689 --laz-dir data/lidar
"""
import argparse
import json
from dataclasses import asdict, dataclass, field
from pathlib import Path

from pyproj import Transformer
from shapely.geometry import Point, mapping

from . import catastro, geocode, height, heritage, lidar

to_utm = Transformer.from_crs("EPSG:4326", "EPSG:25831", always_xy=True).transform


@dataclass
class BuildingRecord:
    query: str
    lat: float
    lon: float
    geocoder: str | None
    refcat: str                      # 14-character plot reference
    catastro_address: str | None
    building_id: str | None
    year_built: int | None
    current_use: str | None
    dwellings: int | None
    building_height_m: float | None  # ground to highest roof point
    height_source: str | None        # "lidar" or "estimate (3 m per Catastro floor)"
    footprint_area_m2: float
    footprint_wkt: str               # EPSG:25831
    lidar_tiles: list = field(default_factory=list)
    roof: dict | None = None         # output of lidar.roof_flatness
    flat_roof: bool | None = None    # None = not checked (no LiDAR given)
    heritage_protected: bool | None = None  # None = unknown (no layer given)
    heritage_details: dict | None = None
    warnings: list = field(default_factory=list)


def pick_building(buildings, point_utm):
    """The building whose footprint contains the point, else the largest on the plot."""
    with_fp = [b for b in buildings if b["footprint"] is not None]
    for b in with_fp:
        if b["footprint"].contains(point_utm):
            return b
    return max(with_fp, key=lambda b: b["footprint"].area) if with_fp else buildings[0]


def max_floors(parts, footprint):
    floors = [p["floors_above_ground"] for p in parts
              if p["floors_above_ground"] is not None
              and (p["footprint"] is None or p["footprint"].intersects(footprint))]
    return max(floors) if floors else None


def find_building(address=None, lat=None, lon=None, laz_dir=None, heritage_path=None):
    warnings = []
    if lat is None or lon is None:
        hit = geocode.geocode(address)
        lat, lon, geocoder = hit["lat"], hit["lon"], hit["source"]
    else:
        geocoder = None

    plot = catastro.refcat_from_point(lat, lon)
    buildings, parts = catastro.buildings_for_refcat(plot["refcat"])
    point_utm = Point(to_utm(lon, lat))
    b = pick_building(buildings, point_utm)
    fp = b["footprint"]
    if len(buildings) > 1:
        warnings.append(f"{len(buildings)} buildings on this plot; picked {b['id']}")

    record = BuildingRecord(
        query=address or f"{lat},{lon}",
        lat=lat, lon=lon, geocoder=geocoder,
        refcat=plot["refcat"], catastro_address=plot["address"],
        building_id=b["id"], year_built=b["year_built"], current_use=b["current_use"],
        dwellings=b["dwellings"],
        building_height_m=None, height_source=None,
        footprint_area_m2=round(fp.area, 1), footprint_wkt=fp.wkt,
        warnings=warnings,
    )

    lidar_height = height.height_from_lidar(fp, laz_dir) if laz_dir else None
    if lidar_height:
        record.building_height_m = lidar_height["building_height_m"]
        record.height_source = "lidar"
    else:
        record.building_height_m = height.height_from_floors(max_floors(parts, fp))
        if record.building_height_m is not None:
            record.height_source = "estimate (3 m per Catastro floor)"

    if laz_dir:
        tiles = lidar.find_tiles(fp, laz_dir)
        record.lidar_tiles = [p.name for p in tiles]
        if not tiles:
            warnings.append("no LiDAR tile in the folder covers this building")
        else:
            record.roof = lidar.roof_flatness(lidar.roof_points(fp, tiles))
            record.flat_roof = record.roof["is_flat"]
            if record.flat_roof is False:
                warnings.append("roof does not look flat: outside the tool's scope")

    protected = heritage.load_protected(heritage_path) if heritage_path else None
    record.heritage_protected, record.heritage_details = heritage.heritage_flag(fp, protected)
    return record, fp


def save_geojson(record, footprint, path):
    """Footprint + attributes as GeoJSON (EPSG:25831) to check in QGIS."""
    props = {k: v for k, v in asdict(record).items() if k != "footprint_wkt"}
    fc = {
        "type": "FeatureCollection",
        "crs": {"type": "name", "properties": {"name": "urn:ogc:def:crs:EPSG::25831"}},
        "features": [{"type": "Feature", "geometry": mapping(footprint), "properties": props}],
    }
    Path(path).write_text(json.dumps(fc, indent=2, default=str), encoding="utf-8")


def main():
    ap = argparse.ArgumentParser(description="Pipeline step 1: find the building")
    ap.add_argument("address", nargs="?", help='e.g. "Carrer de Girona 81, Barcelona"')
    ap.add_argument("--lat", type=float)
    ap.add_argument("--lon", type=float)
    ap.add_argument("--laz-dir", help="folder with downloaded ICGC/CNIG LAZ tiles")
    ap.add_argument("--heritage", help="GeoJSON of protected buildings (optional)")
    ap.add_argument("--out", default="building.json")
    args = ap.parse_args()
    if not args.address and (args.lat is None or args.lon is None):
        ap.error("give an address, or both --lat and --lon")

    record, fp = find_building(args.address, args.lat, args.lon, args.laz_dir, args.heritage)
    Path(args.out).write_text(json.dumps(asdict(record), indent=2, default=str), encoding="utf-8")
    save_geojson(record, fp, Path(args.out).with_suffix(".geojson"))
    print(json.dumps({k: v for k, v in asdict(record).items() if k != "footprint_wkt"},
                     indent=2, default=str))


if __name__ == "__main__":
    main()