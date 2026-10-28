// Roofscapes RePowered — settings and assumptions.
// Every number marked ASSUMPTION should be replaced with a sourced value before the final review.

window.APP_CONFIG = {
  // Optional. Free token from https://ion.cesium.com (Access Tokens). With it the map shows aerial photos;
  // without it the map shows the OpenStreetMap street map. Everything else works the same.
  CESIUM_ION_TOKEN: "",

  // Area loaded around the map centre (metres). Bigger = more buildings, slower.
  LOAD_RADIUS_M: 400,

  // ---- Sun and climate (Barcelona) ----
  GHI_KWH_M2_YEAR: 1600,   // ASSUMPTION: yearly sun on a flat open surface. Check with PVGIS for your point.
  DIFFUSE_FRACTION: 0.38,  // ASSUMPTION: share of that sun that comes from the sky, not directly from the sun.

  // ---- Panels ----
  PANEL_LENGTH_M: 1.76,
  PANEL_WIDTH_M: 1.13,
  PANEL_GAP_M: 0.05,
  PANEL_EFFICIENCY: 0.21,          // typical 2026 monocrystalline panel
  PERFORMANCE_RATIO: 0.8,          // losses: heat, inverter, cables, dirt
  PANEL_HEIGHT_ABOVE_ROOF_M: 0.5,
  ROOF_SETBACK_M: 1.0,             // free strip along the roof edge (parapet, safety, access)
  OBSTACLE_FACTOR: 0.75,           // ASSUMPTION: 25% of slots lost to stairs, tanks, AC units. The AI roof reading will replace this.

  // ---- Buildings and demand ----
  FLOOR_HEIGHT_M: 3.2,
  DEFAULT_HEIGHT_M: 15,            // used when OpenStreetMap has no height for a building (marked "estimated")
  DEMAND_KWH_M2_YEAR: 30,          // ASSUMPTION: electricity per m² of floor area per year. Replace with Barcelona data.

  // ---- Sharing rule ----
  SHARE_RADIUS_M: 2000,            // Spanish collective self-consumption: up to 2 km from the panels
};
