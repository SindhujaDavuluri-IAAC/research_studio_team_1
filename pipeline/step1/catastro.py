"""Spanish cadastre (Catastro): point -> cadastral reference -> building data.

Two public services, no API key needed:
- OVC "Consulta_RCCOOR": which plot is at this point? Gives the 14-character
  plot reference (the "14 digits" also used by the shared self-consumption rule).
- INSPIRE Buildings WFS: footprint, year built, use, number of homes and floors
  for the buildings on that plot.

All geometry is returned in EPSG:25831 (ETRS89 / UTM zone 31N, metres), the
same system as the ICGC LiDAR and orthophotos.
"""
import xml.etree.ElementTree as ET

import requests
from shapely.geometry import Polygon
from shapely.ops import unary_union

RCCOOR_URL = (
    "https://ovc.catastro.meh.es/OVCServWeb/OVCWcfCallejero/"
    "COVCCoordenadas.svc/json/Consulta_RCCOOR"
)
WFS_BU_URL = "https://ovc.catastro.meh.es/INSPIRE/wfsBU.aspx"
CRS = "EPSG:25831"
TIMEOUT = 30


class CatastroError(Exception):
    pass


# ---------- point -> plot reference ----------

def _find_key(obj, key):
    """Depth-first search for the first value stored under `key` in nested JSON."""
    if isinstance(obj, dict):
        if key in obj:
            return obj[key]
        children = obj.values()
    elif isinstance(obj, list):
        children = obj
    else:
        return None
    for child in children:
        found = _find_key(child, key)
        if found is not None:
            return found
    return None


def parse_rccoor(data):
    """Pull the 14-character plot reference and address out of a Consulta_RCCOOR reply."""
    pc = _find_key(data, "pc")
    if not pc or "pc1" not in pc or "pc2" not in pc:
        err = _find_key(data, "des") or "no plot found at this point"
        raise CatastroError(f"Catastro: {err}")
    return {"refcat": pc["pc1"] + pc["pc2"], "address": _find_key(data, "ldt")}


def refcat_from_point(lat, lon):
    params = {"SRS": "EPSG:4326", "CoorX": lon, "CoorY": lat, "Coordenada_X": lon, "Coordenada_Y": lat}
    r = requests.get(RCCOOR_URL, params=params, timeout=TIMEOUT)
    r.raise_for_status()
    return parse_rccoor(r.json())


# ---------- plot reference -> buildings (INSPIRE GML) ----------

def _local(tag):
    return tag.rsplit("}", 1)[-1]


def _first_text(elem, name):
    for e in elem.iter():
        if _local(e.tag) == name and e.text and e.text.strip():
            return e.text.strip()
    return None


def _polygons(elem):
    """Read every gml:Polygon / gml:PolygonPatch under elem (exterior ring + holes)."""
    polys = []
    for p in elem.iter():
        if _local(p.tag) not in ("Polygon", "PolygonPatch"):
            continue
        rings = []
        for ring_parent in p:  # exterior / interior
            pos = _first_text(ring_parent, "posList")
            if not pos:
                continue
            vals = [float(v) for v in pos.split()]
            rings.append(list(zip(vals[0::2], vals[1::2])))
        if rings:
            polys.append(Polygon(rings[0], rings[1:]))
    return polys


def _year(date_text):
    return int(date_text[:4]) if date_text and date_text[:4].isdigit() else None


def parse_buildings(gml_text):
    """Parse a WFS GetBuildingByParcel reply into a list of dicts."""
    root = ET.fromstring(gml_text)
    buildings = []
    for b in root.iter():
        if _local(b.tag) != "Building":
            continue
        polys = _polygons(b)
        footprint = unary_union(polys) if polys else None
        dwellings = _first_text(b, "numberOfDwellings")
        units = _first_text(b, "numberOfBuildingUnits")
        buildings.append({
            "id": _first_text(b, "localId"),
            "year_built": _year(_first_text(b, "beginning")),
            "current_use": _first_text(b, "currentUse"),
            "condition": _first_text(b, "conditionOfConstruction"),
            "dwellings": int(dwellings) if dwellings else None,
            "building_units": int(units) if units else None,
            "footprint": footprint,
        })
    return buildings


def parse_building_parts(gml_text):
    """Parse a WFS GetBuildingPartByParcel reply: floors above ground per part."""
    root = ET.fromstring(gml_text)
    parts = []
    for p in root.iter():
        if _local(p.tag) != "BuildingPart":
            continue
        floors = _first_text(p, "numberOfFloorsAboveGround")
        polys = _polygons(p)
        parts.append({
            "id": _first_text(p, "localId"),
            "floors_above_ground": int(floors) if floors else None,
            "footprint": unary_union(polys) if polys else None,
        })
    return parts


def _wfs(stored_query, refcat):
    params = {
        "service": "wfs",
        "version": "2",
        "request": "getfeature",
        "STOREDQUERIE_ID": stored_query,  # sic: Catastro's own spelling
        "refcat": refcat,
        "srsname": CRS,
    }
    r = requests.get(WFS_BU_URL, params=params, timeout=TIMEOUT)
    r.raise_for_status()
    if "ExceptionReport" in r.text[:2000]:
        raise CatastroError(f"Catastro WFS error for {refcat}: {r.text[:300]}")
    return r.text


def buildings_for_refcat(refcat):
    """Return (buildings, parts) for a 14-character plot reference."""
    refcat = refcat[:14]
    buildings = parse_buildings(_wfs("GetBuildingByParcel", refcat))
    parts = parse_building_parts(_wfs("GetBuildingPartByParcel", refcat))
    buildings = [b for b in buildings if b["footprint"] is not None]
    if not buildings:
        raise CatastroError(f"No building with a footprint found on plot {refcat}")
    return buildings, parts
