"""Hour-by-hour electricity from each panel, after shade, heat and system losses.

For every hour of the typical year:
    sun on the panel = direct sun (if not shaded) + diffuse sky light x open sky
                       + light reflected from the roof
    AC output       = sun on the panel x panel size x heat factor x (1 - system losses)
"""
import numpy as np

from step3.layout import PANEL_WP

from .horizon import is_lit, sky_view
from .sun import sun_position

ALBEDO = 0.2              # light reflected by the roof around the panels
SYSTEM_LOSSES = 0.14      # inverter, cables, dirt, mismatch (PVGIS default)
TEMP_COEFF = -0.0035      # power change per degree C of cell temperature
NOCT_RISE = 25.0          # cell is this many degrees above air at 800 W/m2


def plane_of_array(weather, sun_elev, sun_az, lit, svf, tilt_deg, azimuth_deg):
    """Sun on the tilted panel, W/m2: array (n_panels, n_hours)."""
    t, a = np.deg2rad(tilt_deg), np.deg2rad(azimuth_deg)
    e, z = np.deg2rad(sun_elev), np.deg2rad(sun_az)
    cos_inc = np.sin(e) * np.cos(t) + np.cos(e) * np.sin(t) * np.cos(z - a)
    up = sun_elev > 0
    beam = np.where(up, weather.dni * np.clip(cos_inc, 0, None), 0.0)
    diffuse = weather.dhi * (1 + np.cos(t)) / 2
    ground = weather.ghi * ALBEDO * (1 - np.cos(t)) / 2
    return beam[None, :] * lit + svf[:, None] * diffuse[None, :] + ground[None, :]


def panel_output(poa, temp):
    """AC kWh per panel per hour from sun on the panel (W/m2) and air temperature."""
    cell = temp[None, :] + poa / 800.0 * NOCT_RISE
    heat = 1 + TEMP_COEFF * (cell - 25.0)
    return poa / 1000.0 * PANEL_WP / 1000.0 * heat * (1 - SYSTEM_LOSSES)


def yield_for_layout(layout, horizon, weather, lat, lon, max_shade_loss=None):
    """Returns per-panel yearly kWh, per-panel shade loss (0-1), the roof's hourly kWh and
    which panels are kept. Panels losing more than max_shade_loss of their sun are left
    out of the hourly total (None keeps them all)."""
    elev, az = sun_position(weather.times, lat, lon)
    n = horizon.shape[0]
    svf = sky_view(horizon)
    lit = is_lit(horizon, elev, az)
    poa = plane_of_array(weather, elev, az, lit, svf, layout.tilt_deg, layout.azimuth_deg)
    open_poa = plane_of_array(weather, elev, az, np.ones_like(lit), np.ones(n), layout.tilt_deg, layout.azimuth_deg)
    kwh = panel_output(poa, weather.temp)
    shade_loss = 1 - poa.sum(axis=1) / np.maximum(open_poa.sum(axis=1), 1e-9)
    keep = np.ones(n, bool) if max_shade_loss is None else shade_loss <= max_shade_loss
    return kwh.sum(axis=1), shade_loss, kwh[keep].sum(axis=0), keep
