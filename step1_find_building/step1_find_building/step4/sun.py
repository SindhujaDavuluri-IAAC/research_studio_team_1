"""Sun position (elevation and azimuth) for any UTC times, accurate to about 0.5 degrees.

Same low-precision solar formulas as the Roofscapes RePowered map (solar.js),
written for numpy arrays so a whole year is one call.
"""
import numpy as np

DEG = np.pi / 180


def sun_position(times, lat, lon):
    """times: datetime64 array (UTC). Returns (elevation_deg, azimuth_deg from north, clockwise)."""
    t = np.asarray(times, dtype="datetime64[s]").astype("int64") / 86400.0
    n = t + 2440587.5 - 2451545.0
    L = (280.46 + 0.9856474 * n) % 360
    g = ((357.528 + 0.9856003 * n) % 360) * DEG
    lam = (L + 1.915 * np.sin(g) + 0.02 * np.sin(2 * g)) * DEG
    eps = (23.439 - 0.0000004 * n) * DEG
    ra = np.arctan2(np.cos(eps) * np.sin(lam), np.cos(lam))
    dec = np.arcsin(np.sin(eps) * np.sin(lam))
    gmst = ((18.697374558 + 24.06570982441908 * n) % 24 + 24) % 24
    H = (gmst * 15 + lon) * DEG - ra
    phi = lat * DEG
    alt = np.arcsin(np.sin(phi) * np.sin(dec) + np.cos(phi) * np.cos(dec) * np.cos(H))
    az = np.arctan2(-np.sin(H), np.tan(dec) * np.cos(phi) - np.sin(phi) * np.cos(H))
    return alt / DEG, (az / DEG) % 360
