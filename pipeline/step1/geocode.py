"""Turn an address typed by the owner into a point (latitude, longitude).

Two geocoders are tried in order:
1. ICGC geocoder (Catalan mapping institute): best with Catalan street names.
2. Nominatim (OpenStreetMap): fallback.

If the owner taps the building on a map instead, skip this module and pass the
point straight to the next step.
"""
import requests

ICGC_URL = "https://eines.icgc.cat/geocodificador/cerca"
NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
USER_AGENT = "rooftop-solar-studio/0.1 (student project)"
TIMEOUT = 20


class GeocodeError(Exception):
    pass


def geocode_icgc(address):
    r = requests.get(ICGC_URL, params={"text": address, "size": 1}, timeout=TIMEOUT)
    r.raise_for_status()
    features = r.json().get("features", [])
    if not features:
        return None
    lon, lat = features[0]["geometry"]["coordinates"][:2]
    label = features[0].get("properties", {}).get("etiqueta") or features[0].get("properties", {}).get("label")
    return {"lat": lat, "lon": lon, "label": label, "source": "ICGC"}


def geocode_nominatim(address):
    r = requests.get(
        NOMINATIM_URL,
        params={"q": address, "format": "json", "limit": 1, "countrycodes": "es"},
        headers={"User-Agent": USER_AGENT},
        timeout=TIMEOUT,
    )
    r.raise_for_status()
    results = r.json()
    if not results:
        return None
    return {
        "lat": float(results[0]["lat"]),
        "lon": float(results[0]["lon"]),
        "label": results[0].get("display_name"),
        "source": "Nominatim",
    }


def geocode(address):
    """Return {lat, lon, label, source} for an address, or raise GeocodeError."""
    errors = []
    for fn in (geocode_icgc, geocode_nominatim):
        try:
            hit = fn(address)
            if hit:
                return hit
            errors.append(f"{fn.__name__}: no result")
        except (requests.RequestException, KeyError, ValueError) as e:
            errors.append(f"{fn.__name__}: {e}")
    raise GeocodeError(f"Could not find '{address}'. " + "; ".join(errors))
