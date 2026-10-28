"""Building height in metres.

With LiDAR: highest roof point (98th percentile of building points, so a stray
antenna or bird does not count) minus the ground level around the building
(median of ground points in a ring 2 to 15 m outside the footprint, which in
the Eixample is mostly the street).

Without LiDAR: a rough estimate from Catastro's floor count, 3 m per floor.
"""
import laspy
import numpy as np
import shapely

from .lidar import BUILDING_CLASS, find_tiles

GROUND_CLASS = 2          # ASPRS class for ground points
RING_INNER, RING_OUTER = 2.0, 15.0
TOP_PERCENTILE = 98
METRES_PER_FLOOR = 3.0
MIN_POINTS = 20


def _points(tiles, area, cls):
    chunks = []
    minx, miny, maxx, maxy = area.bounds
    for path in tiles:
        las = laspy.read(path)
        x, y, z = np.asarray(las.x), np.asarray(las.y), np.asarray(las.z)
        keep = (np.asarray(las.classification) == cls)
        keep &= (x >= minx) & (x <= maxx) & (y >= miny) & (y <= maxy)
        x, y, z = x[keep], y[keep], z[keep]
        chunks.append(z[shapely.contains_xy(area, x, y)])
    return np.concatenate(chunks) if chunks else np.empty(0)


def height_from_lidar(footprint, laz_dir):
    """Return a dict with the height and its parts, or None if the tiles can't give one."""
    ring = footprint.buffer(RING_OUTER).difference(footprint.buffer(RING_INNER))
    tiles = find_tiles(footprint.buffer(RING_OUTER), laz_dir)
    roof_z = _points(tiles, footprint, BUILDING_CLASS)
    ground_z = _points(tiles, ring, GROUND_CLASS)
    if len(roof_z) < MIN_POINTS or len(ground_z) < MIN_POINTS:
        return None
    top = float(np.percentile(roof_z, TOP_PERCENTILE))
    ground = float(np.median(ground_z))
    return {"building_height_m": round(top - ground, 1),
            "ground_level_m": round(ground, 2), "roof_top_m": round(top, 2)}


def height_from_floors(floors):
    return None if floors is None else round(floors * METRES_PER_FLOOR, 1)