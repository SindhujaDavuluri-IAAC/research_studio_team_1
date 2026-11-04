// Roofscapes RePowered — settings of the map. The pipeline's assumptions are in ../pipeline.

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
  // Our 9 blocks: the first 5 characters of the cadastral reference (Catastro "manzana"). Two of the blocks are
  // split in two by a passage (one of them is Passatge Permanyer), so 11 codes. Only these buildings are coloured by us;
  // the rest of the city keeps the city's own 3D model.
  BLOCKS: ["03286", "04276", "05266", "04296", "05293", "05285", "06282", "06276", "05306", "06296", "07285"],
  // The 9 blocks' buildings, saved once with `python -m web.buildings` (without it they come from the city server).
  BUILDINGS_FILE: "data/buildings.json",
  // One file per roof run by the pipeline (step 4 with `--web`), plus index.json, the list of those roofs.
  ROOFS_FOLDER: "data/roofs/",
  // Step 5c's communities. The first file found is shown:
  COMMUNITIES_FILE: "data/communities.json",         // step 5c's full results: python -m web.communities
  COMMUNITIES_MAP_FILE: "data/communities_map.json", // the same communities read from step 5c's map (until the first exists)

  // One colour per community, the same as step 5c's map (pipeline/step5/communities.py, PALETTE). The host roof
  // gets the colour, the guest buildings a pale version of it: GUEST_TINT of the way towards white.
  COMMUNITY_COLORS: ["#1f77b4", "#ff7f0e", "#2ca02c", "#d62728", "#9467bd", "#8c564b", "#e377c2", "#bcbd22", "#17becf", "#7f7f7f"],
  GUEST_TINT: 0.45,
  NOT_MEMBER_COLOR: "#dad8d2",   // a building of the 9 blocks in no community (step 5c's map: 218, 216, 210)

  // ---- Speed ----
  QUALITY: "medium",               // "high" is sharper but much heavier for a laptop
  SHADOWS_AT_START: false,         // live sun shadows on the 3D model; the Shadows switch in the time bar

  FLOOR_HEIGHT_M: 3.2,   // to count floors from a building's height
};
