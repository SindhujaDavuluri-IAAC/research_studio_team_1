"""Shade from the LiDAR surface: the horizon each panel sees.

Unlike the 3D map, which treats neighbours as flat-topped blocks, this uses
every LiDAR point around the roof: neighbouring roofs at their real height,
stair housings and parapets on our own roof, and street trees.

For each panel we walk outwards in N_DIRECTIONS directions and keep the
steepest angle up to anything taller (the horizon). The sun is blocked at a
given hour when it sits lower than the horizon in its direction. The share
of open sky, used for diffuse light, comes from the same horizon.
"""
import numpy as np

from step1 import lidar as step1_lidar
from step2.grid import Grid
from step2.lidar_roof import rasterise_max

import laspy
from shapely.geometry import box

# 2 ground, 3-5 vegetation, 6 building, 77 structures above roofs
SURFACE_CLASSES = (2, 3, 4, 5, 6, 77)
DSM_RES = 1.0          # metres per cell
REACH_M = 150.0        # how far out to look for things that cast shade
N_DIRECTIONS = 36      # every 10 degrees
STEP_M = 1.0


def surface_points(area, tiles, classes=SURFACE_CLASSES):
    """All surface points inside the box `area` (shapely), as N x 3."""
    minx, miny, maxx, maxy = area.bounds
    chunks = []
    for path in tiles:
        las = laspy.read(path)
        x, y, z = np.asarray(las.x), np.asarray(las.y), np.asarray(las.z)
        keep = np.isin(np.asarray(las.classification), classes)
        keep &= (x >= minx) & (x <= maxx) & (y >= miny) & (y <= maxy)
        chunks.append(np.column_stack([x[keep], y[keep], z[keep]]))
    return np.vstack(chunks) if chunks else np.empty((0, 3))


def surface_model(footprint, laz_dir, reach=REACH_M, res=DSM_RES):
    """Height grid (highest point per cell) for the roof and everything within `reach`."""
    area = box(*footprint.buffer(reach).bounds)
    tiles = step1_lidar.find_tiles(area, laz_dir)
    if not tiles:
        return None, None
    grid = Grid.around(area, res, buffer=0)
    return grid, rasterise_max(surface_points(area, tiles), grid)


def _height_at(grid, dsm, x, y):
    row, col = grid.rowcol(x, y)
    ok = (row >= 0) & (row < grid.height) & (col >= 0) & (col < grid.width)
    h = np.full(np.shape(x), np.nan)
    h[ok] = dsm[row[ok], col[ok]]
    return h


def horizons(grid, dsm, xs, ys, zs, n_dir=N_DIRECTIONS, reach=REACH_M, step=STEP_M):
    """Horizon elevation angle (degrees) per panel and direction: array (n_panels, n_dir)."""
    xs, ys, zs = (np.asarray(v, dtype=float)[:, None] for v in (xs, ys, zs))
    dist = np.arange(step, reach + step, step)[None, :]
    out = np.zeros((xs.shape[0], n_dir))
    for k in range(n_dir):
        a = np.deg2rad(k * 360.0 / n_dir)
        h = _height_at(grid, dsm, xs + np.sin(a) * dist, ys + np.cos(a) * dist)
        angle = np.degrees(np.arctan2(h - zs, dist))
        out[:, k] = np.nanmax(np.where(np.isnan(angle), -90, angle), axis=1).clip(min=0)
    return out


def sky_view(horizon):
    """Share of the open sky dome each panel sees (1 = nothing above the horizon)."""
    return (np.cos(np.deg2rad(horizon)) ** 2).mean(axis=1)


def is_lit(horizon, sun_elev, sun_az):
    """True where the sun is above the horizon: array (n_panels, n_hours)."""
    n_dir = horizon.shape[1]
    pos = (np.asarray(sun_az) / (360.0 / n_dir)) % n_dir
    k0 = np.floor(pos).astype(int) % n_dir
    k1 = (k0 + 1) % n_dir
    f = pos - np.floor(pos)
    h = horizon[:, k0] * (1 - f) + horizon[:, k1] * f
    return np.asarray(sun_elev)[None, :] > h
