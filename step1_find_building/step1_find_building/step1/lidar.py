"""LiDAR: which tiles cover the building, and is its roof flat?

Works on LAZ/LAS files you have downloaded from the ICGC (Territorial LiDAR,
3rd coverage) or CNIG (PNOA LiDAR) download viewers into one folder. Tiles are
matched by reading each file's header bounds, so the file names don't matter.
Both providers deliver EPSG:25831 for Catalonia, the same as Catastro.
"""
from pathlib import Path

import laspy
import numpy as np
import shapely
from shapely.geometry import box

BUILDING_CLASS = 6        # ASPRS class for building points
GRID_SIZE = 0.5           # metres per cell when rasterising the roof
FLAT_SLOPE_DEG = 5.0      # a cell counts as flat below this slope
FLAT_SHARE_NEEDED = 0.7   # roof counts as flat if this share of cells is flat
MIN_POINTS = 50


def tile_bounds(path):
    with laspy.open(path) as f:
        h = f.header
        return box(h.mins[0], h.mins[1], h.maxs[0], h.maxs[1])


def find_tiles(footprint, laz_dir):
    """Return paths of LAZ/LAS files in laz_dir whose extent overlaps the footprint."""
    hits = []
    for path in sorted(Path(laz_dir).glob("*.la[sz]")):
        try:
            if tile_bounds(path).intersects(footprint):
                hits.append(path)
        except Exception as e:  # unreadable file: skip, but say so
            print(f"warning: could not read {path.name}: {e}")
    return hits


def roof_points(footprint, tiles):
    """Building-class points (x, y, z) that fall inside the footprint."""
    chunks = []
    minx, miny, maxx, maxy = footprint.bounds
    for path in tiles:
        las = laspy.read(path)
        x, y, z = np.asarray(las.x), np.asarray(las.y), np.asarray(las.z)
        keep = (np.asarray(las.classification) == BUILDING_CLASS)
        keep &= (x >= minx) & (x <= maxx) & (y >= miny) & (y <= maxy)
        x, y, z = x[keep], y[keep], z[keep]
        inside = shapely.contains_xy(footprint, x, y)
        chunks.append(np.column_stack([x[inside], y[inside], z[inside]]))
    return np.vstack(chunks) if chunks else np.empty((0, 3))


def roof_flatness(points, grid=GRID_SIZE):
    """Rasterise the roof (highest point per cell) and measure how much of it is flat.

    Returns a dict with the share of flat cells, median slope and roof height
    range. Stair housings and tanks show up as small steep patches, so a flat
    roof with obstacles still scores high; a pitched roof scores low.
    """
    if len(points) < MIN_POINTS:
        return {"is_flat": None, "flat_share": None, "median_slope_deg": None,
                "roof_height_min": None, "roof_height_max": None,
                "points": int(len(points)), "note": "too few building points"}
    x, y, z = points[:, 0], points[:, 1], points[:, 2]
    ix = ((x - x.min()) / grid).astype(int)
    iy = ((y - y.min()) / grid).astype(int)
    dsm = np.full((iy.max() + 1, ix.max() + 1), np.nan)
    order = np.argsort(z)  # write lowest first so the highest point wins
    dsm[iy[order], ix[order]] = z[order]

    gy, gx = np.gradient(dsm, grid)
    slope = np.degrees(np.arctan(np.hypot(gx, gy)))
    valid = slope[~np.isnan(slope)]
    if valid.size == 0:
        flat_share = None
    else:
        flat_share = float((valid < FLAT_SLOPE_DEG).mean())
    return {
        "is_flat": None if flat_share is None else flat_share >= FLAT_SHARE_NEEDED,
        "flat_share": None if flat_share is None else round(flat_share, 3),
        "median_slope_deg": None if valid.size == 0 else round(float(np.median(valid)), 1),
        "roof_height_min": round(float(np.nanmin(dsm)), 2),
        "roof_height_max": round(float(np.nanmax(dsm)), 2),
        "points": int(len(points)),
        "note": None,
    }
