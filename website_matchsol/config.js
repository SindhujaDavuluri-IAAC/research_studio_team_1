// MATCHSOL (the hourly version, kept for later) — settings and assumptions.
// It reads the main site's data in ../website/data, so open it from the repository folder (VS Code Live Server does).
// Every number marked ASSUMPTION should be replaced with a sourced value before the final review.

window.APP_CONFIG = {
  // ---- Barcelona City Council open services (geo.bcn.cat) ----
  // 3D model shown on the map. The first one that loads is used.
  // Slow laptop? Put the "simple volumes" line first: it is much lighter than the detailed model.
  SCENE_LAYERS: [
    "https://geo.bcn.cat/agisserver/rest/services/Hosted/BCN_3DtoFeat/SceneServer", // detailed LOD2 model
    "https://geo.bcn.cat/agisserver/rest/services/Hosted/3D_MTM/SceneServer/layers/0", // simple volumes
  ],
  // Same buildings as 2D footprints with height, roof form and use (used without data/buildings.json).
  BUILDINGS_FEATURE_LAYER: "https://geo.bcn.cat/agisserver/rest/services/Hosted/BCN_3DtoFeat/FeatureServer/22",
  // City background map.
  BASEMAP_STYLE: "https://geo.bcn.cat/agisportal/sharing/rest/content/items/31ee4f5c2b52411b8d1a43b9c56ec808/resources/styles/root.json",

  // ---- Our own data (made by the Python pipeline, see ../pipeline/README.md) ----
  // The study area's buildings, saved once with `python -m web.buildings` (without it they come
  // from the city server, a few seconds slower).
  BUILDINGS_FILE: "../website/data/buildings.json",   // shared with the main site
  // One file per roof run by the pipeline (step 4 with `--web`), plus index.json, the list of those roofs.
  ROOFS_FOLDER: "../website/data/roofs/",

  // ---- Matching (step 4 of MATCHSOL) ----
  MATCH: {
    MAX_DISTANCE_M: 5000,  // Real Decreto-ley 7/2026: buildings up to 5 km apart can share one roof's solar power
    NEAR_M: 600,           // nearer buildings are preferred: one 600 m away must add 2.7 times as much to be picked
    MAX_MEMBERS: 10,       // ASSUMPTION: at most 10 buildings in one match, so it stays easy to agree on
    MIN_GAIN_KWH: 200,     // a building joins only if the match then uses at least this much more solar power a year
    MIN_SHARED_KWH: 500,   // a match must share at least this much a year to be worth the paperwork
    MIN_PANELS: 6,         // a roof needs room for at least 6 panels...
    MIN_SUN_FACTOR: 0.6,   // ...and at least 60% of the sun of an open roof, or it counts as "too shaded for panels"
  },

  // ---- Money and CO2 ----
  GRID_PRICE_EUR: 0.16,      // what a kWh bought from the grid costs (step 5c)
  SURPLUS_PRICE_EUR: 0.05,   // what a kWh sold to the grid earns (step 5c)
  SHARED_PRICE_EUR: 0.10,    // ASSUMPTION: the price one building pays another for a shared kWh (the Money tab changes it)
  CO2_KG_PER_KWH: 0.10,      // ASSUMPTION: CO2 of a kWh from Spain's grid. Check with Red Eléctrica before the review.

  // ---- Each building's use, hour by hour: the same rules as pipeline/step5/demand.py ----
  USE: {
    FLAT_GROSS_M2: 100,        // ASSUMPTION: floor area per flat, to count flats from the city model
    FLAT_BASE_KWH: 1000,       // a flat uses 1,000 kWh a year...
    FLAT_KWH_PER_M2: 18,       // ...plus 18 kWh per m² (85 m² -> about 2,500 kWh)
    OFFICE_KWH_PER_M2: 120,
    SCHOOL_KWH_PER_M2: 60,     // schools, health centres, other public services
    // Homes: low at night, a small morning peak, a big evening peak (hours 0-23)
    HOME_DAY: [0.75, 0.6, 0.5, 0.45, 0.45, 0.5, 0.65, 0.85, 0.95, 0.95, 0.95, 0.95,
               1.0, 1.05, 1.05, 0.95, 0.9, 0.95, 1.1, 1.3, 1.5, 1.55, 1.35, 1.0],
    MONTH: [1.15, 1.1, 1.0, 0.9, 0.85, 0.95, 1.1, 1.05, 0.95, 0.9, 1.0, 1.15],   // January..December
    WEEKEND_HOME: 1.1,         // people are at home more at the weekend
    OFFICE_OPEN: [8, 18], OFFICE_CLOSED: 0.15, OFFICE_AUGUST: 0.6,   // weekdays; a small base load when closed
    SCHOOL_OPEN: [8, 17], SCHOOL_CLOSED: 0.1,
    SCHOOL_HOLIDAY_MONTHS: [6, 7],                                     // July and August (0 = January)
  },

  // The three days you can pick in the time bar (date: for the sun on the map).
  DAYS: {
    weekday: { label: "Weekday", month: 5, weekend: false, date: [2026, 5, 17] },
    weekend: { label: "Weekend", month: 5, weekend: true, date: [2026, 5, 20] },
    summer: { label: "Summer holidays", month: 6, weekend: false, date: [2026, 6, 15] },
  },

  // ---- Colours ----
  COLORS: {
    HOME: "#eaa733",          // homes with solar panels
    HOME_NO_PANELS: "#f5d38f",// homes whose roof is too shaded or too small for panels
    SCHOOL: "#1f5f8b",
    OFFICE: "#8fb8de",
    NOT_MATCHED: "#ebe5df",
    OUT: "#cdc8c2",           // one match open: every building outside it
    FROM_HOMES: "#b06f00",    // power lines from home roofs
    FROM_DAYTIME: "#1f5f8b",  // power lines from school and office roofs
  },

  // ---- Speed ----
  QUALITY: "medium",               // "high" is sharper but much heavier for a laptop
  SHADOWS_AT_START: false,         // live sun shadows on the 3D model; the Shadows switch in the time bar

  // ---- Quick roof estimate (roofs our pipeline has not run yet) ----
  GHI_KWH_M2_YEAR: 1600,   // ASSUMPTION: yearly sun on a flat open surface. Check with PVGIS for your point.
  DIFFUSE_FRACTION: 0.38,  // ASSUMPTION: share of that sun that comes from the sky, not directly from the sun.
  PANEL_LENGTH_M: 1.76,
  PANEL_WIDTH_M: 1.13,
  PANEL_GAP_M: 0.05,
  PANEL_EFFICIENCY: 0.21,          // typical 2026 monocrystalline panel (420 W for this size, as in step 3)
  PERFORMANCE_RATIO: 0.8,          // losses: heat, inverter, cables, dirt
  PANEL_HEIGHT_ABOVE_ROOF_M: 0.5,
  ROOF_SETBACK_M: 1.0,             // free strip along the roof edge and courtyards (parapet, safety, access)
  PANEL_PACKING: 0.9,              // share of the free roof the panels cover (flat panels, small gaps)
  OBSTACLE_FACTOR: 0.75,           // ASSUMPTION: 25% of the roof lost to stairs, tanks, AC units (step 2 measures it)
  FLOOR_HEIGHT_M: 3.2,
};
