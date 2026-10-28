"""Heritage flag: is the building in a protected-heritage layer?

We have not yet found Barcelona's heritage catalogue as open data (it is on the
team's "to find" list). Until then this reads any local GeoJSON of protected
buildings or areas you provide. With no file, the flag is None ("unknown").
"""
import json

import numpy as np
import shapely
from pyproj import Transformer
from shapely.geometry import shape


def load_protected(path, source_crs="EPSG:4326", target_crs="EPSG:25831"):
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    t = Transformer.from_crs(source_crs, target_crs, always_xy=True)
    to_utm = lambda xy: np.column_stack(t.transform(xy[:, 0], xy[:, 1]))
    shapes = []
    for feat in data.get("features", []):
        if feat.get("geometry"):
            geom = shape(feat["geometry"])
            shapes.append((shapely.transform(geom, to_utm), feat.get("properties", {})))
    return shapes


def heritage_flag(footprint, protected):
    """Return (flag, properties of the matching feature or None).

    `protected` is the output of load_protected, or None if no layer is available.
    """
    if protected is None:
        return None, None
    for geom, props in protected:
        if geom.intersects(footprint) and geom.intersection(footprint).area > 0.2 * footprint.area:
            return True, props
    return False, None
