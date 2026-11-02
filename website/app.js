/* Roofscapes RePowered — the map and the screen.
 * 3D model and building data: Ajuntament de Barcelona open services (geo.bcn.cat), shown with the ArcGIS Maps SDK.
 *
 * Four tabs (top bar):
 *  - Area:     every building of the study area coloured from the best 20% for solar panels to the worst 20%
 *              (our pipeline's result where it ran, a quick estimate elsewhere); click one for its rating.
 *  - Building: the Roof Report of one roof (click a roof, search, or pick a best roof).
 *  - Sharing:  step 5's sharing groups on the map, with their numbers.
 *  - How it works: the problem and the five steps, over the map.
 * The time bar (month, hour) moves the real sun on the map and the typical-day chart.
 *
 * Where the numbers come from:
 *  - Roofs run by our Python pipeline (steps 2–4, sent with --web): data/roofs/<refcat>.json. Shown, not recalculated.
 *  - Step 5 (use and sharing): data/sharing.json (python -m web.sharing).
 *  - Every other roof: a quick estimate in the browser (solar.js), clearly labelled as one.
 * Speed: inside our study area the buildings come from one local file (data/buildings.json).
 */
require([
  "esri/Map",
  "esri/Basemap",
  "esri/views/SceneView",
  "esri/layers/SceneLayer",
  "esri/layers/VectorTileLayer",
  "esri/layers/OpenStreetMapLayer",
  "esri/layers/GraphicsLayer",
  "esri/Graphic",
  "esri/layers/FeatureLayer",
  "esri/geometry/Polygon",
  "esri/layers/support/SceneFilter",
  "esri/geometry/projection",
  "esri/widgets/ShadowCast",
  "esri/widgets/Expand",
  "esri/core/reactiveUtils",
], function (Map, Basemap, SceneView, SceneLayer, VectorTileLayer, OpenStreetMapLayer, GraphicsLayer, Graphic,
  FeatureLayer, Polygon, SceneFilter, projection, ShadowCast, Expand, reactiveUtils) {
  "use strict";
  const CFG = window.APP_CONFIG;
  const S = window.Solar;
  const $ = (id) => document.getElementById(id);
  const fmt = (n, d = 0) => Number(n).toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d });
  const BUILDINGS_FILE = CFG.BUILDINGS_FILE || "data/buildings.json";
  const ROOFS = CFG.ROOFS_FOLDER || "data/roofs/";
  const SHARING_FILE = CFG.SHARING_FILE || "data/sharing.json";
  const PANEL_W = 400;   // the side panel's width + margin, kept free when the map centres on something

  const PLACES = { focus: { lat: 41.3928, lng: 2.1684 } }; // our 9 blocks: Passeig de Gràcia to Bruc, Gran Via to Aragó
  // Field names in the city's building layer (BCN_3DtoFeat). pipeline/web/buildings.py uses the same list.
  const F = {
    id: "objectid",
    zMin: "edificacio_ajbcn_z_min_vol",
    zMax: "edificacio_ajbcn_z_max_vol",
    height: "bldgheight",
    base: "baseelev",
    roof: "roofform",
    use: "uso_desc",
    refcat: "edificacio_ajbcn_addspatialj_15",
    deleg: "edificacio_ajbcn_addspatialjo_2",
    muni: "edificacio_ajbcn_addspatialjo_3",
    number: "edificacio_ajbcn_addspatialjo_9",
    barri: "edificacio_ajbcn_barri",
    district: "edificacio_ajbcn_districte",
  };
  const OUT_FIELDS = Object.values(F).join(",");
  const SR = { wkid: 4326 };
  const MONTHS = "JFMAMJJASOND";
  const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

  const COLORS = {
    sel: [242, 165, 22],
    gotPart: [169, 211, 155],
    gotFull: [63, 138, 70],
    panelLow: [61, 79, 99],
    panelMid: [242, 165, 22],
    panelHigh: [255, 224, 102],
    usable: [255, 230, 0],
    ink: [22, 32, 42],
  };
  // sharing groups: [roof with extra sun, building that receives, line and badge]
  const GROUP_COLORS = [
    ["#1f5f8b", "#a8c8e2", "#1f5f8b"], ["#d08a0b", "#f5d38f", "#b06f00"], ["#8a63c9", "#d3c2ee", "#6a45ae"],
    ["#2a8c82", "#a9dcd5", "#1f6f67"], ["#c25d7a", "#efb9c9", "#a2425f"], ["#7d8c34", "#ccd59b", "#556222"],
  ];

  let view, sceneLayer;
  let tab = "area";
  let area = null;          // buildings in use: { local, center, proj, buildings, index, sun, byRef, cover? }
  let localArea = null;     // our study area from BUILDINGS_FILE (null if the file is missing)
  let localReady = null;    // promise: resolves when BUILDINGS_FILE is read (or found missing)
  let sel = null;           // { k, slots, roofArea, reading, source: "pipeline" | "browser", summary, title }
  let roofIndex = null;     // data/roofs/index.json
  let sharing = null;       // data/sharing.json
  let ruleKey = null;       // the sharing rule shown ("500", "2000", "5000")
  let searchLabel = null;   // the last address found, for the Roof Report title
  const readings = {};      // refcat -> roof file ("Map" is the ArcGIS map class in this file)
  const time = { month: 5, hour: 13 };
  let panelGraphics = [];
  let rating = null;        // Area tab: { items, rated, byK, exact } — every building of the study area, rated
  let potentialLayer = null; // Area tab: those buildings as coloured 3D volumes
  let cityFilter = null;    // hides the city's own model where our coloured volumes stand
  let picked = null;        // the building clicked in the Area tab
  let pickHandle = null;    // its highlight on the map
  let areaError = null;     // why the study area could not be loaded, if it could not
  const STUDY_RADIUS_M = 350, STUDY_MARGIN_M = 100;   // without data/buildings.json: what to load from the city
  const RATING_NAMES = ["Best 20%", "Good", "Middle", "Below average", "Worst 20%"];
  const NOT_RATED = "#e6ddd6";
  const absolute = { mode: "absolute-height" };
  const labelLayer = new GraphicsLayer({ elevationInfo: absolute, title: "Block numbers" });
  const shareLayer = new GraphicsLayer({ elevationInfo: absolute, title: "Sharing groups" });
  const roofLayer = new GraphicsLayer({ elevationInfo: absolute, title: "Selected roof" });
  const ringLayer = new GraphicsLayer({ elevationInfo: { mode: "on-the-ground" }, title: "2 km circle" });

  /* ---------- small helpers ---------- */
  function setStatus(kind, text) {
    const el = $("status");
    el.dataset.kind = kind;
    el.textContent = text;
  }
  const nextFrame = () => new Promise((r) => setTimeout(r, 30));
  const ref14 = (v) => String(v || "").trim().slice(0, 14).toUpperCase();
  const cleanAddress = (a) => String(a || "").replace(/\s+BARCELONA\s*\(BARCELONA\)\s*$/i, "").replace(/,\s*Barcelona$/i, "");
  const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const kwhToMwh = (v) => (v == null ? "–" : `${fmt(v / 1000, v >= 100000 ? 0 : 1)} MWh`);
  const ruleLabel = (k) => (Number(k) >= 1000 ? `${Number(k) / 1000} km` : `${k} m`);

  // element(tag, {class, text, title, ...attributes}, children)
  function el(tag, opts = {}, children = []) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(opts)) {
      if (v == null) continue;
      if (k === "class") e.className = v;
      else if (k === "text") e.textContent = v;
      else if (k === "style") e.setAttribute("style", v);
      else e.setAttribute(k, v);
    }
    for (const c of [].concat(children)) if (c != null) e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    return e;
  }

  async function getJson(url) {
    try {
      const res = await fetch(url, { cache: "no-cache" });
      return res.ok ? await res.json() : null;
    } catch (_) {
      return null;
    }
  }

  /* ---------- map ---------- */
  function makeBasemap() {
    const vt = new VectorTileLayer({ url: CFG.BASEMAP_STYLE });
    const bm = new Basemap({ baseLayers: [vt], title: "Barcelona" });
    vt.load().catch(() => {
      console.warn("City basemap did not load; using OpenStreetMap.");
      view.map.basemap = new Basemap({ baseLayers: [new OpenStreetMapLayer()], title: "OpenStreetMap" });
    });
    return bm;
  }

  async function addSceneLayer(map) {
    for (const url of CFG.SCENE_LAYERS) {
      const layer = new SceneLayer({ url, popupEnabled: false, title: "Barcelona buildings" });
      try {
        await layer.load();
        const hField = (layer.fields || []).find((f) => /^bldgheight$/i.test(f.name));
        layer.renderer = {
          type: "simple",
          symbol: {
            type: "mesh-3d",
            symbolLayers: [{
              type: "fill",
              material: { color: [214, 160, 145], colorMixMode: "replace" },
              edges: { type: "solid", color: [70, 25, 20, 0.35], size: 0.4 },
            }],
          },
          visualVariables: hField ? [{
            type: "color",
            field: hField.name,
            stops: [
              { value: 4, color: [241, 221, 213] },
              { value: 18, color: [214, 140, 120] },
              { value: 35, color: [160, 62, 48] },
              { value: 60, color: [112, 30, 24] },
            ],
          }] : [],
        };
        map.add(layer, 0);
        return layer;
      } catch (err) {
        console.warn("3D layer did not load:", url, err);
      }
    }
    return null;
  }

  // Camera looking at a place from the south-west, like a zoom-17 view, so the page opens right over it.
  function cameraOver(p, dist = 900, tilt = 60, heading = 30) {
    const t = (tilt * Math.PI) / 180, h = (heading * Math.PI) / 180;
    const ground = dist * Math.sin(t);
    return {
      position: {
        longitude: p.lng - (ground * Math.sin(h)) / (111320 * Math.cos((p.lat * Math.PI) / 180)),
        latitude: p.lat - (ground * Math.cos(h)) / 111320,
        z: dist * Math.cos(t) + 40, // + about 40 m: ground level in the Eixample
      },
      heading, tilt,
    };
  }

  /* ---------- city building data (FeatureServer): used outside our study area ---------- */
  async function query(params) {
    const body = new URLSearchParams({
      f: "json", where: "1=1", outFields: OUT_FIELDS, returnGeometry: "true",
      multipatchOption: "xyFootprint", inSR: "4326", outSR: "4326", ...params,
    });
    let res;
    try {
      res = await fetch(CFG.BUILDINGS_FEATURE_LAYER + "/query", { method: "POST", body });
    } catch (err) {
      throw new Error("Could not reach the city's building data (geo.bcn.cat). Check the internet connection; if it keeps failing, the server may block requests from this address.");
    }
    if (!res.ok) throw new Error(`City building data answered ${res.status}.`);
    const json = await res.json();
    if (json.error) throw new Error("City building data: " + (json.error.message || "error") + ".");
    return json;
  }

  function queryAtPoint(lng, lat) {
    return query({
      geometry: JSON.stringify({ x: lng, y: lat, spatialReference: SR }),
      geometryType: "esriGeometryPoint",
      spatialRel: "esriSpatialRelIntersects",
    });
  }

  async function queryArea(lng, lat, radius) {
    const dLat = radius / 111320, dLng = radius / (111320 * Math.cos((lat * Math.PI) / 180));
    const env = { xmin: lng - dLng, ymin: lat - dLat, xmax: lng + dLng, ymax: lat + dLat, spatialReference: SR };
    const base = { geometry: JSON.stringify(env), geometryType: "esriGeometryEnvelope", spatialRel: "esriSpatialRelIntersects" };
    const features = [];
    let offset = 0;
    for (let page = 0; page < 20; page++) {
      let j;
      try {
        j = await query({ ...base, resultOffset: String(offset), resultRecordCount: "2000", orderByFields: F.id });
      } catch (err) {
        if (page === 0 && /pagina/i.test(err.message)) j = await query(base); // server without paging
        else throw err;
      }
      const got = j.features || [];
      features.push(...got);
      setStatus("loading", `Loading neighbouring buildings from the city server… ${fmt(features.length)}`);
      if (!j.exceededTransferLimit || !got.length) break;
      offset += got.length;
    }
    return features;
  }

  function intensityFor(use) {
    const u = String(use || "").toLowerCase();
    const hit = CFG.DEMAND_BY_USE.find((d) => u.includes(d.match));
    return hit ? hit.kwh : CFG.DEMAND_KWH_M2_YEAR;
  }

  // City features -> buildings for the solar engine (outer ring + courtyards; multi-part = several buildings).
  function toBuildings(features, proj) {
    const out = [];
    for (const f of features) {
      const a = f.attributes || {}, g = f.geometry;
      if (!g || !g.rings) continue;
      const rings = g.rings.map((r) => S.cleanRing(r)).filter(Boolean)
        .map((ll) => ({ ll, xy: ll.map(([lng, lat]) => proj.toXY(lng, lat)) }))
        .sort((p, q) => S.polygonArea(q.xy) - S.polygonArea(p.xy));
      const outers = [];
      for (const r of rings) {
        const host = outers.find((o) => S.pointInPolygon(r.xy[0][0], r.xy[0][1], o.xy));
        if (host) host.holes.push(r);
        else outers.push({ ...r, holes: [] });
      }
      const top = a[F.zMax] != null ? a[F.zMax] : (a[F.base] || 0) + (a[F.height] || 0);
      const rel = a[F.height] != null ? a[F.height] : top - (a[F.zMin] || 0);
      if (!(rel > 0.5)) continue;
      for (const o of outers) {
        const b = {
          id: a[F.id], attrs: a, ll: o.ll, xy: o.xy,
          holes: o.holes.map((h) => h.xy), holesLL: o.holes.map((h) => h.ll),
          height: top, relHeight: rel,
        };
        b.bbox = S.bbox(b.xy);
        b.c = S.centroid(b.xy);
        b.footprint = S.footprintArea(b);
        if (b.footprint < 4) continue;
        b.floors = Math.max(1, Math.round(rel / CFG.FLOOR_HEIGHT_M));
        b.intensity = intensityFor(a[F.use]);
        b.demand = S.buildingDemand(b, CFG);
        out.push(b);
      }
    }
    return out;
  }

  function makeArea(features, lng, lat, extra = {}) {
    const proj = S.makeProjection(lat, lng);
    const buildings = toBuildings(features, proj);
    const byRef = {};   // cadastral reference -> positions in `buildings` (a plot can have several parts)
    buildings.forEach((b, k) => {
      const r = ref14(b.attrs[F.refcat]);
      if (r) (byRef[r] = byRef[r] || []).push(k);
    });
    return { center: { lng, lat }, proj, buildings, byRef, index: S.buildIndex(buildings), sun: S.sunSamples(lat, lng), ...extra };
  }

  async function loadServerArea(lng, lat) {
    area = makeArea(await queryArea(lng, lat, CFG.LOAD_RADIUS_M), lng, lat, { local: false });
  }

  /* ---------- our study area (BUILDINGS_FILE, made by `python -m web.buildings`) ---------- */
  async function loadLocalArea() {
    const j = await getJson(BUILDINGS_FILE);
    if (!j || !Array.isArray(j.buildings) || !Array.isArray(j.fields)) return null;
    const n = j.fields.length;
    const features = j.buildings.map((row) => {
      const attributes = {};
      for (let i = 0; i < n; i++) attributes[j.fields[i]] = row[i];
      return { attributes, geometry: { rings: row[n] } };
    });
    const [lng, lat] = j.center;
    return makeArea(features, lng, lat, { local: true, cover: j.cover_radius_m, made: j.made });
  }

  const inLocalArea = (lng, lat) => !!localArea && Math.hypot(...localArea.proj.toXY(lng, lat)) <= localArea.cover;

  // A plot's buildings in our study area: [{ b, lng, lat }], largest first ([] when not in the file).
  function partsOf(ref) {
    if (!localArea) return [];
    return (localArea.byRef[ref14(ref)] || []).map((k) => localArea.buildings[k])
      .sort((p, q) => q.footprint - p.footprint)
      .map((b) => { const [lng, lat] = localArea.proj.toLngLat(b.c[0], b.c[1]); return { b, lng, lat }; });
  }

  /* ---------- click -> building ---------- */
  async function onClick(event) {
    let pt = event.mapPoint, hitK = null;
    try {
      const layers = [sceneLayer, potentialLayer].filter(Boolean);
      const hit = await view.hitTest(event, layers.length ? { include: layers } : undefined);
      const r = hit.results.find((x) => x.mapPoint);
      if (r) pt = r.mapPoint;
      const g = hit.results.find((x) => x.graphic && x.graphic.layer === potentialLayer);
      if (g && g.graphic.attributes) hitK = g.graphic.attributes.k;
    } catch (_) { /* use the ground point */ }
    if (!pt) return;
    if (tab === "area") { pickInArea(pt.longitude, pt.latitude, hitK); return; }
    searchLabel = null;
    try {
      await selectAt(pt.longitude, pt.latitude);
    } catch (err) {
      setStatus("error", err.message);
      console.error(err);
    }
  }

  // Buildings within `radius` metres of a point (an address point often falls on the facade or the street).
  function queryNear(lng, lat, radius) {
    return query({
      geometry: JSON.stringify({ x: lng, y: lat, spatialReference: SR }),
      geometryType: "esriGeometryPoint",
      spatialRel: "esriSpatialRelIntersects",
      distance: String(radius), units: "esriSRUnit_Meter",
    });
  }

  // The feature whose outline is closest to the point.
  function nearestFeature(feats, lng, lat) {
    const proj = S.makeProjection(lat, lng);
    let best = null, bestD = Infinity;
    for (const f of feats) {
      for (const r of f.geometry.rings || []) {
        const xy = r.map(([x, y]) => proj.toXY(x, y));
        const d = S.pointInPolygon(0, 0, xy) ? 0 : Math.min(...xy.map(([x, y]) => Math.hypot(x, y)));
        if (d < bestD) { bestD = d; best = f; }
      }
    }
    return best;
  }

  async function selectAt(lng, lat, nearby = 0) {
    setStatus("loading", "Finding the building…");
    if (localReady) await localReady;
    if (inLocalArea(lng, lat)) {          // our study area: everything is already in the browser
      area = localArea;
      const [x, y] = area.proj.toXY(lng, lat);
      const k = S.findBuilding(area.buildings, area.index, x, y, nearby);
      if (k < 0) { setStatus("idle", "No building at that point. Click on a roof."); return; }
      await analyze(k);
      return;
    }

    // outside the study area: ask the city server, as before
    const j = await queryAtPoint(lng, lat);
    let feats = (j.features || []).filter((f) => f.geometry);
    if (!feats.length && nearby) {
      const near = ((await queryNear(lng, lat, nearby)).features || []).filter((f) => f.geometry);
      const f = nearestFeature(near, lng, lat);
      if (f) {
        feats = [f];
        const [x, y] = S.centroid(f.geometry.rings[0].map(([a, b]) => S.makeProjection(lat, lng).toXY(a, b)));
        [lng, lat] = S.makeProjection(lat, lng).toLngLat(x, y);
      }
    }
    if (!feats.length) { setStatus("idle", "No building at that point. Click on a roof."); return; }
    const top = (f) => f.attributes[F.zMax] ?? 0;
    const f = feats.reduce((a, b) => (top(b) > top(a) ? b : a));

    const far = !area || area.local || Math.hypot(...area.proj.toXY(lng, lat)) > CFG.LOAD_RADIUS_M - 120;
    if (far) {
      setStatus("loading", "Loading neighbouring buildings from the city server (outside our study area)…");
      await loadServerArea(lng, lat);
    }
    const [px, py] = area.proj.toXY(lng, lat);
    let k = area.buildings.findIndex((b) => b.id === f.attributes[F.id] && S.insideFootprint(px, py, b));
    if (k < 0) k = area.buildings.findIndex((b) => b.id === f.attributes[F.id]);
    if (k < 0) {
      const extra = toBuildings([f], area.proj);
      if (!extra.length) { setStatus("error", "This building has no usable outline in the city data."); return; }
      area.buildings.push(...extra);
      area.index = S.buildIndex(area.buildings);
      k = area.buildings.length - extra.length;
    }
    await analyze(k);
  }

  /* ---------- address search ---------- */
  async function geocode(text) {
    const q = /barcelona/i.test(text) ? text : `${text}, Barcelona`;
    const icgc = await getJson(`https://eines.icgc.cat/geocodificador/cerca?size=1&text=${encodeURIComponent(q)}`);
    const f = icgc && icgc.features && icgc.features[0];
    if (f) return { lng: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], label: f.properties.etiqueta || f.properties.label || q };
    const osm = await getJson(`https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=es&q=${encodeURIComponent(q)}`);
    if (osm && osm[0]) return { lng: +osm[0].lon, lat: +osm[0].lat, label: osm[0].display_name };
    return null;
  }

  async function onSearch(event) {
    event.preventDefault();
    const text = $("search-input").value.trim();
    if (!text) return;
    setStatus("loading", `Looking up "${text}"…`);
    try {
      const hit = await geocode(text);
      if (!hit) { setStatus("error", `Could not find "${text}". Try "Carrer de Pau Claris 100" or click the roof on the map.`); return; }
      searchLabel = text;
      await selectAt(hit.lng, hit.lat, 25);
    } catch (err) {
      setStatus("error", err.message);
      console.error(err);
    }
  }

  /* ---------- roofs run by the pipeline (data/roofs/, written with --web) ---------- */
  async function getRoofIndex() {
    if (!roofIndex) roofIndex = (await getJson(ROOFS + "index.json")) || { roofs: [] };
    return roofIndex;
  }
  const doneRoofs = () => (roofIndex ? roofIndex.roofs.filter((r) => r.yearly_kwh != null) : []);
  const roofCenter = (r) => [(r.bbox[0] + r.bbox[2]) / 2, (r.bbox[1] + r.bbox[3]) / 2];

  // The pipeline's file for this building, or null: matched by cadastral reference,
  // otherwise by the building's centre falling inside a roof file's area.
  async function loadReading(b) {
    const index = await getRoofIndex();
    const ref = ref14(b.attrs[F.refcat]);
    const [lng, lat] = area.proj.toLngLat(b.c[0], b.c[1]);
    const hit = index.roofs.find((r) => r.refcat === ref) ||
      index.roofs.find((r) => r.bbox && lng >= r.bbox[0] && lng <= r.bbox[2] && lat >= r.bbox[1] && lat <= r.bbox[3]);
    if (!hit) return null;
    if (!(hit.refcat in readings)) readings[hit.refcat] = await getJson(`${ROOFS}${hit.refcat}.json`);
    return readings[hit.refcat];
  }

  // Usable areas from longitude/latitude to the solar engine's local metres.
  function usableXY(reading) {
    return reading.usable.map((poly) => poly.map((ring) => ring.map(([lng, lat]) => area.proj.toXY(lng, lat))));
  }

  // Step 4's panels -> the same shape the browser estimate uses (sunFactor 1 = no shade).
  function pipelineSlots(energy) {
    return energy.panel_list.map((p) => ({ ring: p.ring, sunFactor: 1 - p.loss, kwh: p.kwh }));
  }

  const isPipeline = () => !!sel && sel.source === "pipeline";
  const obstacleFactor = () => (sel && sel.reading ? 1 : CFG.OBSTACLE_FACTOR);
  const panelKwh = (s) => (s.kwh != null ? s.kwh : S.panelYearKwh(s, CFG));
  // Quick estimates scaled to match our pipeline (see rateArea); 1 until some roof has been run.
  const quickScale = () => (rating && rating.factor) || 1;

  /* ---------- analysis + drawing (Building tab) ---------- */
  async function analyze(k) {
    const b = area.buildings[k];
    const reading = await loadReading(b);
    const flat = !b.attrs[F.roof] || /flat/i.test(b.attrs[F.roof]);
    const roofNote = flat ? "" : ` Roof form "${b.attrs[F.roof]}": panels are placed as if the roof were flat, so the result is approximate.`;
    const title = reading && reading.address ? cleanAddress(reading.address) : searchLabel || `City building ${b.id}`;

    if (reading && reading.energy && Array.isArray(reading.energy.panel_list)) {
      sel = { k, slots: pipelineSlots(reading.energy), roofArea: reading.roof_area_m2 || b.footprint, reading, source: "pipeline", title };
      show();
      setStatus("idle", `Results from our pipeline (steps 2–4): ${fmt(sel.slots.length)} panels.`);
      return;
    }
    setStatus("loading", "Calculating a quick estimate of sun and shade on the roof…");
    await nextFrame();
    const t0 = performance.now();
    const res = S.analyzeRoof(area.buildings, area.index, k, area.sun, CFG, reading ? usableXY(reading) : undefined);
    sel = { k, ...res, reading, source: "browser", title };
    show();
    setStatus("idle", (res.slots.length
      ? `Quick estimate calculated in ${fmt((performance.now() - t0) / 1000, 1)} s with ${fmt(area.buildings.length)} neighbouring buildings.`
      : reading ? "No panel fits on the usable area that step 2 found on this roof."
        : "No panel fits on this roof after the edge setback.") + roofNote);
  }

  function show() {
    drawSelection();
    updateResults();
    setTab("building");
  }

  function ringToZ(ll, z) {
    const r = ll.map(([lng, lat]) => [lng, lat, z]);
    r.push(r[0]);
    return r;
  }

  function slab(b, z, size, color) {
    return new Graphic({
      geometry: { type: "polygon", hasZ: true, spatialReference: SR, rings: [ringToZ(b.ll, z), ...(b.holesLL || []).map((h) => ringToZ(h, z))] },
      symbol: {
        type: "polygon-3d",
        symbolLayers: [{ type: "extrude", size, material: { color }, edges: { type: "solid", color: [0, 0, 0, 0.25], size: 0.5 } }],
      },
    });
  }

  function mix(a, b, t) { return a.map((v, i) => Math.round(v + (b[i] - v) * t)); }
  function panelColor(f) {
    const t = Math.min(1, Math.max(0, (f - 0.5) / 0.5));
    return t < 0.6 ? mix(COLORS.panelLow, COLORS.panelMid, t / 0.6) : mix(COLORS.panelMid, COLORS.panelHigh, (t - 0.6) / 0.4);
  }

  function drawSelection() {
    roofLayer.removeAll();
    ringLayer.removeAll();
    const b = area.buildings[sel.k];
    roofLayer.add(slab(b, b.height + 0.02, 0.12, [...COLORS.sel, 0.9]));
    panelGraphics = sel.slots.map((s) => new Graphic({
      geometry: {
        type: "polygon", hasZ: true, spatialReference: SR,
        rings: [ringToZ(s.ring || s.corners.map(([x, y]) => area.proj.toLngLat(x, y)), b.height + 0.3)],
      },
      symbol: { type: "polygon-3d", symbolLayers: [{ type: "extrude", size: 0.12, material: { color: panelColor(s.sunFactor) } }] },
    }));
    roofLayer.addMany(panelGraphics);
    if (sel.reading) {
      roofLayer.addMany(sel.reading.usable.flat().map((ring) => new Graphic({
        geometry: { type: "polyline", hasZ: true, spatialReference: SR, paths: [ringToZ(ring, b.height + 0.2)] },
        symbol: { type: "line-3d", symbolLayers: [{ type: "line", size: 2, material: { color: COLORS.usable } }] },
      })));
    }

    const path = [];
    for (let a = 0; a <= 360; a += 3) {
      const t = (a * Math.PI) / 180, r = CFG.SHARE_RADIUS_M;
      path.push(area.proj.toLngLat(b.c[0] + r * Math.sin(t), b.c[1] + r * Math.cos(t)));
    }
    ringLayer.add(new Graphic({
      geometry: { type: "polyline", paths: [path], spatialReference: SR },
      symbol: { type: "line-3d", symbolLayers: [{ type: "line", size: 3, material: { color: COLORS.sel }, pattern: { type: "style", style: "dash" } }] },
    }));

    const [lng, lat] = area.proj.toLngLat(b.c[0], b.c[1]);
    view.goTo({ center: [lng, lat], zoom: 19, tilt: 55 }, { duration: 1200 }).catch(() => {});
  }

  let neighbourGraphics = [];
  function drawNeighbours(alloc) {
    roofLayer.removeMany(neighbourGraphics);
    neighbourGraphics = [];
    alloc.forEach((v, i) => {
      if (i === sel.k || v.received <= 0) return;
      const b = area.buildings[i];
      neighbourGraphics.push(slab(b, b.height + 0.05, 0.6, [...mix(COLORS.gotPart, COLORS.gotFull, Math.min(1, v.share)), 0.95]));
    });
    roofLayer.addMany(neighbourGraphics);
  }

  const compass = (az) => ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"][Math.round((az || 0) / 45) % 8];

  // Step 2's notes: a roof left out by hand (sports court, garden...) and lower roofs not counted.
  function roofNotes(roof) {
    const notes = [];
    if (roof.excluded) notes.push(`Left out by hand: ${roof.excluded}, so no usable area.`);
    if (roof.lower_roof_m2) notes.push(`${fmt(roof.lower_roof_m2)} m² of lower roofs (inner-block shops, garages) not counted.`);
    return notes.length ? " " + notes.join(" ") : "";
  }

  function readingText() {
    const rd = sel.reading;
    if (isPipeline()) {
      const e = rd.energy;
      const ai = rd.roof.method === "lidar + ai" ? " and the AI model on the photo" : "";
      return `Calculated by our pipeline. Step 2 read the roof from LiDAR${ai} (confidence ${rd.roof.confidence}): ` +
        `${fmt(rd.roof.usable_area_m2)} m² usable. Step 3 placed panels tilted ${fmt(e.tilt_deg)}° facing ${compass(e.azimuth_deg)}. ` +
        `Step 4 worked out every hour of a typical year, with shade from the LiDAR surface (neighbours, trees, rooftop structures)` +
        (e.panels_left_out ? ` and left out ${fmt(e.panels_left_out)} panels with too much shade.` : ".") + roofNotes(rd.roof);
    }
    if (rd) {
      return `Roof read by step 2 (${rd.roof.method}, confidence ${rd.roof.confidence}): ${fmt(rd.roof.usable_area_m2)} m² usable, ` +
        `${fmt(rd.roof.obstacle_area_m2)} m² of stairs, tanks and other obstacles. Panels sit only on the usable area (yellow outline). ` +
        `The energy is the browser's quick estimate: run step 4 with --web for the exact numbers.` + roofNotes(rd.roof);
    }
    return `Quick estimate in the browser: this roof has not been run by our pipeline yet, so ${Math.round((1 - CFG.OBSTACLE_FACTOR) * 100)}% ` +
      `of panel slots are assumed lost to obstacles. Run steps 2–4 with --web for this building.`;
  }

  function drawMonths(scale) {
    const box = $("r-months");
    const months = isPipeline() && sel.reading.energy.monthly_kwh;
    box.hidden = !months;
    if (!months) return;
    const max = Math.max(...months, 1);
    box.replaceChildren(...months.map((v, m) => {
      const bar = el("span", { title: `${MONTH_NAMES[m]}: ${fmt(v * scale)} kWh`, "data-m": MONTHS[m], class: m === time.month ? "on" : null });
      bar.style.setProperty("--h", `${Math.round((100 * v) / max)}%`);
      return bar;
    }));
  }

  // Typical day for the time bar's month (step 4's hourly results), with the time bar's hour marked.
  function drawDay() {
    const box = $("r-day-box");
    const days = isPipeline() && sel.reading.energy.typical_day_kwh;
    box.hidden = !days;
    if (!days) return;
    const max = Math.max(1, ...days.flat());
    const x = (h) => 20 + (h - 5) * 18;
    const y = (v) => 95 - (v * 85) / max;
    const day = days[time.month];
    const pts = [];
    for (let h = 5; h <= 22; h++) pts.push(`${x(h)},${y(day[h] || 0).toFixed(1)}`);
    const hv = day[time.hour] || 0;
    const ticks = [6, 9, 12, 15, 18, 21].map((h) => `<text x="${x(h)}" y="112" text-anchor="middle">${h}${h === 21 ? " h" : ""}</text>`).join("");
    $("r-day").innerHTML =
      `<line x1="20" y1="95" x2="330" y2="95" stroke="#cfc8bb"/>` +
      `<line x1="20" y1="${y(max / 2)}" x2="330" y2="${y(max / 2)}" stroke="#e7e1d6"/>` +
      `<line x1="20" y1="10" x2="330" y2="10" stroke="#e7e1d6"/>` +
      `<g font-family="IBM Plex Mono, monospace" font-size="9" fill="#5b6875">` +
      `<text x="0" y="98">0</text><text x="0" y="${y(max / 2) + 3}">${fmt(max / 2, max < 4 ? 1 : 0)}</text><text x="0" y="13">${fmt(max, max < 4 ? 1 : 0)}</text>${ticks}</g>` +
      `<polyline points="${pts.join(" ")}" fill="none" stroke="#c47a06" stroke-width="2.5" stroke-linejoin="round"/>` +
      `<line x1="${x(time.hour)}" y1="10" x2="${x(time.hour)}" y2="95" stroke="#16202a" stroke-dasharray="3 3"/>` +
      `<circle cx="${x(time.hour)}" cy="${y(hv)}" r="4" fill="#16202a"/>` +
      `<text x="${Math.min(300, x(time.hour) + 6)}" y="${Math.max(20, y(hv) - 6)}" font-family="IBM Plex Mono, monospace" font-size="10" fill="#16202a">${fmt(hv, 1)} kWh</text>`;
    $("r-day").setAttribute("aria-label", `Solar output per hour on a typical day in ${MONTH_NAMES[time.month]}; ${fmt(hv, 1)} kWh at ${time.hour}:00`);
    $("r-day-month").textContent = MONTH_NAMES[time.month];
  }

  // Step 5's numbers for this building, when step 5 has run.
  function step5Line(b) {
    const rule = currentRule();
    const s = rule && rule.buildings && rule.buildings[ref14(b.attrs[F.refcat])];
    const line = $("r-step5");
    line.hidden = !s;
    if (!s) return;
    line.textContent = `Step 5 (${ruleLabel(ruleKey)} rule): this building uses about ${kwhToMwh(s.use_kwh)} a year; ` +
      `solar covers ${fmt(s.covered_pct || 0, 1)}% of it` + (s.group ? `, as part of sharing group ${s.group}.` : ".");
  }

  function updateResults() {
    if (!sel) return;
    const min = Number($("sun-range").value) / 100;
    $("sun-out").textContent = `${Math.round(min * 100)}%`;
    const b = area.buildings[sel.k], a = b.attrs;
    const pipe = isPipeline();
    const kept = sel.slots.filter((s) => s.sunFactor >= min);
    sel.slots.forEach((s, j) => { if (panelGraphics[j]) panelGraphics[j].visible = s.sunFactor >= min; });

    const panelArea = CFG.PANEL_LENGTH_M * CFG.PANEL_WIDTH_M;
    const factor = pipe ? 1 : obstacleFactor() * quickScale();
    const energy = kept.reduce((sum, s) => sum + panelKwh(s), 0) * factor;
    const panels = Math.round(kept.length * factor);
    const kwpEach = pipe && sel.reading.energy.panels
      ? sel.reading.energy.kwp / sel.reading.energy.panels
      : panelArea * CFG.PANEL_EFFICIENCY;
    const kwp = panels * kwpEach;
    const avgSun = kept.length ? kept.reduce((s, x) => s + x.sunFactor, 0) / kept.length : 0;

    $("r-title").textContent = sel.title;
    $("r-use").textContent = `${a[F.use] || "Use not given"} · roof: ${a[F.roof] || "unknown"}`;
    $("r-building").textContent = `${fmt(b.relHeight, 1)} m high · about ${b.floors} floors · roof at ${fmt(b.height, 1)} m above sea level` +
      (sel.reading && sel.reading.block ? ` · block ${sel.reading.block}` : "");
    const ref = a[F.refcat];
    if (ref && ref.trim().length >= 14) {
      const url = `https://www1.sedecatastro.gob.es/CYCBienInmueble/OVCListaBienes.aspx?del=${a[F.deleg] || 8}&muni=${a[F.muni] || 900}&rc1=${ref.slice(0, 7)}&rc2=${ref.slice(7, 14)}`;
      $("r-catastro").replaceChildren(`Cadastral ref. ${ref.slice(0, 14)} · `, el("a", { href: url, target: "_blank", rel: "noopener", text: "open in Catastro" }));
    } else {
      $("r-catastro").textContent = "";
    }
    $("r-source").textContent = pipe ? "Our pipeline · steps 2–4" : "Quick estimate";
    $("r-source").dataset.kind = pipe ? "pipeline" : "estimate";
    $("r-reading").textContent = readingText();
    $("r-reading").dataset.kind = pipe ? "pipeline" : sel.reading ? "read" : "guess";
    $("r-energy").textContent = fmt(energy);
    $("r-roof").textContent = `${fmt(sel.roofArea)} m²`;
    $("r-slots").textContent = fmt(sel.slots.length);
    $("r-slots-label").textContent = pipe ? "Panels placed (step 3)" : sel.reading ? "Panel slots (usable area)" : "Panel slots (geometry)";
    $("r-panels-label").textContent = pipe ? "Panels kept (enough sun)" : "Panels after obstacles";
    $("r-panels").textContent = fmt(panels);
    $("r-parea").textContent = `${fmt(panels * panelArea)} m²`;
    $("r-kwp").textContent = `${fmt(kwp, 1)} kWp`;
    $("r-shade").textContent = kept.length ? `${fmt((1 - avgSun) * 100)}%` : "–";
    $("r-own").textContent = `Covers ${fmt(Math.min(999, (100 * energy) / b.demand))}% of this building's own use (≈ ${fmt(b.demand)} kWh/yr at ${b.intensity} kWh/m², assumed).`;
    drawMonths(pipe && sel.reading.energy.yearly_kwh ? energy / sel.reading.energy.yearly_kwh : 1);
    drawDay();
    step5Line(b);

    shareEnergy(energy);
    fillAssumptions();
    sel.summary = { source: sel.source, energy_kwh_year: energy, panels, kwp, avg_sun_factor: avgSun, min_sun_kept: min, obstacle_factor: factor };
  }

  function shareEnergy(energy) {
    const policy = $("policy-select").value;
    const alloc = S.allocate(area.buildings, sel.k, energy, CFG, policy);
    drawNeighbours(alloc);
    const own = alloc.get(sel.k);
    const others = [...alloc.entries()].filter(([i, v]) => i !== sel.k && v.received > 0);
    const full = others.filter(([, v]) => v.share >= 0.999).length;
    const shared = others.reduce((s, [, v]) => s + v.received, 0);
    let text;
    if (policy === "equal") {
      text = `Every building in the loaded area (${fmt(alloc.size)}) gets ${fmt((own ? own.share : 0) * 100, 2)}% of its yearly use.`;
    } else if (!others.length) {
      text = "All the energy stays in this building: it uses more than the roof makes. Nothing is left for neighbours.";
    } else {
      text = `${fmt(shared)} kWh/yr go to ${fmt(others.length)} neighbours: ${fmt(full)} fully supplied${others.length > full ? ", 1 partly" : ""}.`;
    }
    $("r-share").textContent = text;
  }

  function fillAssumptions() {
    const loaded = area.local
      ? `the study area's ${fmt(area.buildings.length)} buildings (${area.fromServer ? "loaded from the city server" : `our file${area.made ? `, saved ${area.made}` : ""}`})`
      : `buildings within ${fmt(CFG.LOAD_RADIUS_M)} m loaded from the city server`;
    const common = [
      `Buildings, heights, roof form and use: Ajuntament de Barcelona 3D model (BCN_3DtoFeat).`,
      `Demand: floor area × kWh per m² by use (residential ${intensityFor("residencial")}, offices ${intensityFor("oficina")}, retail ${intensityFor("comercial")}…).`,
      `Sharing: yearly totals, ${loaded} (the circle shows the full ${fmt(CFG.SHARE_RADIUS_M / 1000)} km). Step 5 does it hour by hour: see the Sharing tab.`,
    ];
    let items;
    if (isPipeline()) {
      const e = sel.reading.energy;
      items = [
        common[0],
        `Usable roof: step 2 (${sel.reading.roof.method}): 1 m from edges, 0.5 m from obstacles, strips narrower than a panel removed.`,
        `Panels: step 3, 1.76 × 1.13 m, ${e.panels && e.kwp ? fmt((1000 * e.kwp) / e.panels) : 420} W each, tilted ${fmt(e.tilt_deg)}°, rows spaced so they don't shade each other at winter noon.`,
        `Sun and shade: step 4, every hour of a typical year (PVGIS), shade from all LiDAR points within 150 m (roofs, trees, rooftop structures), heat losses and 14% system losses.`,
        e.max_shade_loss != null ? `Panels losing more than ${fmt(e.max_shade_loss * 100)}% of their sun to shade were left out by step 4.` : `Step 4 kept every panel.`,
        ...common.slice(1),
      ];
    } else {
      items = [
        common[0],
        `Sun: ${fmt(CFG.GHI_KWH_M2_YEAR)} kWh/m² per year on open flat ground, ${Math.round(CFG.DIFFUSE_FRACTION * 100)}% of it diffuse sky light.`,
        `Panels: ${CFG.PANEL_LENGTH_M} × ${CFG.PANEL_WIDTH_M} m, ${Math.round(CFG.PANEL_EFFICIENCY * 100)}% efficient, ${Math.round(CFG.PERFORMANCE_RATIO * 100)}% system performance, laid flat.`,
        sel.reading
          ? `Usable roof from step 2 (ICGC LiDAR${sel.reading.roof.method === "lidar + ai" ? " + AI on the orthophoto" : ""}): 1 m from edges, 0.5 m from obstacles, strips narrower than a panel removed.`
          : `${CFG.ROOF_SETBACK_M} m free strip along roof edges and courtyards; ${Math.round((1 - CFG.OBSTACLE_FACTOR) * 100)}% of slots lost to stairs, tanks and AC units (until the pipeline reads the roof).`,
        `Shade: neighbours as flat-topped blocks at their roof height; trees are not included.`,
        quickScale() !== 1
          ? `Scaled ×${fmt(quickScale(), 2)} to match our pipeline's results on ${fmt(rating.factorFrom)} roof${rating.factorFrom > 1 ? "s" : ""} (tilted rows and real obstacles make fewer kWh than this estimate's flat panels).`
          : `Not yet compared with our pipeline: no roof in the area has been run.`,
        ...common.slice(1),
      ];
    }
    $("r-assumptions").replaceChildren(...items.map((t) => el("li", { text: t })));
  }

  function saveJson() {
    if (!sel) return;
    const b = area.buildings[sel.k];
    const [lng, lat] = area.proj.toLngLat(b.c[0], b.c[1]);
    const data = {
      source: "Ajuntament de Barcelona, BCN_3DtoFeat",
      result_from: isPipeline() ? "pipeline steps 2-4" : "browser quick estimate (solar.js)",
      building: { city_id: b.id, lat, lng, height_m: b.relHeight, roof_m_asl: b.height, floors: b.floors, footprint_m2: b.footprint, demand_kwh_year: b.demand, attributes: b.attrs },
      result: { roof_area_m2: sel.roofArea, panel_slots: sel.slots.length, ...sel.summary },
      roof_reading: sel.reading ? { refcat: sel.reading.refcat, ...sel.reading.roof, energy: sel.reading.energy ? { ...sel.reading.energy, panel_list: undefined } : null } : null,
      panels: sel.slots.map((s) => {
        const [plng, plat] = s.ring
          ? [s.ring.reduce((t, p) => t + p[0], 0) / s.ring.length, s.ring.reduce((t, p) => t + p[1], 0) / s.ring.length]
          : area.proj.toLngLat(s.cx, s.cy);
        const out = { lat: plat, lng: plng, sun_factor: +s.sunFactor.toFixed(3), kwh_year: +panelKwh(s).toFixed(1) };
        if (s.direct != null) { out.direct = +s.direct.toFixed(3); out.sky = +s.sky.toFixed(3); }
        return out;
      }),
      assumptions: CFG,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `roof_${b.id}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  /* ---------- Area tab: every building of the study area, rated ---------- */
  // Our study area: data/buildings.json, or (once per visit) the same buildings from the city server.
  async function ensureStudyArea() {
    if (localReady) await localReady;
    if (localArea) return localArea;
    setStatus("loading", "Loading the study area's buildings from the city server (this is fast once you run python -m web.buildings)…");
    const { lng, lat } = PLACES.focus;
    localArea = makeArea(await queryArea(lng, lat, STUDY_RADIUS_M + STUDY_MARGIN_M), lng, lat,
      { local: true, cover: STUDY_RADIUS_M, fromServer: true });
    return localArea;
  }

  // Rate every building in the study area by kWh a year per m² of roof: our pipeline's result where
  // it ran (exact), the quick estimate elsewhere. Then split them into 5 equal groups, best to worst.
  async function rateArea() {
    const a = await ensureStudyArea();
    const sun = S.fewSun(a.sun);
    const exact = {};
    for (const r of doneRoofs()) {
      const ks = a.byRef[r.refcat] || [];
      const m2 = ks.reduce((t, k) => t + a.buildings[k].footprint, 0);
      if (ks.length && m2) exact[r.refcat] = { roof: r, m2 };
    }
    const items = [];
    a.buildings.forEach((b, k) => {
      // every building the city model hides (it touches the study circle) gets a volume of ours
      const near = Math.min(...b.xy.map(([x, y]) => Math.hypot(x, y)));
      if (near > a.cover) return;
      const inside = Math.hypot(b.c[0], b.c[1]) <= a.cover && b.footprint >= 30 && b.relHeight >= 3;
      items.push({ k, inside, ref: ref14(b.attrs[F.refcat]) });
    });
    const todo = items.filter((it) => it.inside);
    for (let i = 0; i < todo.length; i++) {
      const it = todo[i], b = a.buildings[it.k], ex = exact[it.ref];
      if (ex) {
        const share = b.footprint / ex.m2;
        Object.assign(it, { exact: true, roof: ex.roof, kwhPerM2: ex.roof.yearly_kwh / ex.m2,
          kwhYear: ex.roof.yearly_kwh * share, panels: Math.round((ex.roof.panels || 0) * share) });
      } else {
        const q = S.roofPotential(a.buildings, a.index, it.k, sun, CFG);
        if (q) Object.assign(it, { exact: false, kwhPerM2: q.kwhPerM2, kwhYear: q.kwhYear, panels: q.panels });
      }
      if (i % 150 === 149) {
        setStatus("loading", `Rating the roofs of the study area… ${Math.round((100 * i) / todo.length)}%`);
        await nextFrame();
      }
    }
    // Our pipeline (tilted rows, real obstacles) makes fewer kWh per m² than the quick estimate (flat panels,
    // a fixed obstacle allowance). So that both can share one ranking, the quick estimates are scaled by the
    // median ratio pipeline ÷ quick estimate on the roofs that have both.
    const ratios = [];
    for (const ex of Object.values(exact)) {
      const quick = (a.byRef[ref14(ex.roof.refcat)] || []).map((k) => S.roofPotential(a.buildings, a.index, k, sun, CFG)).filter(Boolean);
      const q = quick.reduce((t, x) => t + x.kwhYear, 0);
      if (q > 0) ratios.push(ex.roof.yearly_kwh / q);
    }
    ratios.sort((p, q) => p - q);
    const mid = Math.floor(ratios.length / 2);
    const median = ratios.length % 2 ? ratios[mid] : (ratios[mid - 1] + ratios[mid]) / 2;
    const factor = ratios.length ? Math.min(2, Math.max(0.2, median)) : 1;
    for (const it of todo) {
      if (it.exact || it.kwhPerM2 == null) continue;
      it.kwhPerM2 *= factor; it.kwhYear *= factor; it.panels = Math.round(it.panels * factor);
    }
    const rated = todo.filter((it) => it.kwhPerM2 != null).sort((p, q) => q.kwhPerM2 - p.kwhPerM2);
    rated.forEach((it, i) => { it.rank = i + 1; it.cls = Math.min(4, Math.floor((5 * i) / rated.length)); });
    const byK = {};
    items.forEach((it, i) => { it.oid = i + 1; byK[it.k] = it; });
    rating = { items, rated, byK, exact: rated.filter((it) => it.exact).length, factor, factorFrom: ratios.length };
  }

  const ratingColor = (it) => (it && it.cls != null ? CFG.POTENTIAL_COLORS[4 - it.cls] : NOT_RATED);
  const volume = (hex) => ({
    type: "polygon-3d",
    symbolLayers: [{ type: "extrude", material: { color: hexRgb(hex) }, edges: { type: "solid", color: [60, 40, 30, 0.35], size: 0.6 } }],
  });
  const closed = (ll) => [...ll, ll[0]];

  // The rated buildings as whole 3D volumes, from the ground to the roof, in their rating colour.
  function buildPotentialLayer() {
    if (potentialLayer) view.map.remove(potentialLayer);
    const a = localArea;
    const graphics = rating.items.map((it) => {
      const b = a.buildings[it.k];
      return new Graphic({
        geometry: new Polygon({ rings: [closed(b.ll), ...(b.holesLL || []).map(closed)], spatialReference: SR }),
        attributes: { oid: it.oid, k: it.k, cls: it.cls == null ? -1 : it.cls, h: Math.max(1, b.relHeight), base: b.height - b.relHeight },
      });
    });
    potentialLayer = new FeatureLayer({
      title: "Roof rating", source: graphics, objectIdField: "oid", geometryType: "polygon", spatialReference: SR,
      fields: [{ name: "oid", type: "oid" }, { name: "k", type: "integer" }, { name: "cls", type: "integer" },
        { name: "h", type: "double" }, { name: "base", type: "double" }],
      outFields: ["*"], popupEnabled: false, visible: tab === "area",
      elevationInfo: { mode: "absolute-height", featureExpressionInfo: { expression: "$feature.base" }, unit: "meters" },
      renderer: {
        type: "unique-value", field: "cls", defaultSymbol: volume(NOT_RATED),
        uniqueValueInfos: [0, 1, 2, 3, 4].map((c) => ({ value: c, label: RATING_NAMES[c], symbol: volume(CFG.POTENTIAL_COLORS[4 - c]) })),
        visualVariables: [{ type: "size", field: "h", valueUnit: "meters" }],
      },
    });
    view.map.add(potentialLayer);
  }

  // Hide the city's model inside the study circle while the Area tab shows our coloured volumes there.
  async function makeCityFilter() {
    if (!sceneLayer || !localArea) return null;
    try {
      const ring = [];
      for (let d = 0; d <= 360; d += 5) {
        const t = (d * Math.PI) / 180;
        ring.push(localArea.proj.toLngLat(localArea.cover * Math.sin(t), localArea.cover * Math.cos(t)));
      }
      let poly = new Polygon({ rings: [ring], spatialReference: SR });
      const sr = sceneLayer.spatialReference;
      if (sr && !sr.isWGS84) {
        await projection.load();
        poly = projection.project(poly, sr);
      }
      return new SceneFilter({ geometries: [poly], spatialRelationship: "disjoint" });
    } catch (err) {
      console.warn("Could not hide the city model in the study area; it is hidden everywhere in Area instead.", err);
      return null;
    }
  }

  function showCityModel(areaTab) {
    if (!sceneLayer) return;
    const ours = areaTab && potentialLayer;
    sceneLayer.filter = ours && cityFilter ? cityFilter : null;
    sceneLayer.visible = !(ours && !cityFilter);
  }

  // A click in the Area tab: the building's rating in the panel, highlighted on the map.
  function pickInArea(lng, lat, k = null) {
    if (!rating) { setStatus("loading", "Still rating the roofs… one moment."); return; }
    if (k == null) {
      const [x, y] = localArea.proj.toXY(lng, lat);
      k = S.findBuilding(localArea.buildings, localArea.index, x, y, 3);
    }
    const it = k != null && k >= 0 ? rating.byK[k] : null;
    if (!it) {
      setStatus("idle", "That building is outside our 9 blocks. Open the Building tab and click it there for a quick estimate.");
      return;
    }
    picked = it;
    if (pickHandle) pickHandle.remove();
    view.whenLayerView(potentialLayer).then((lv) => { pickHandle = lv.highlight(it.oid); }).catch(() => {});
    fillPick();
  }

  function fillPick() {
    const it = picked;
    $("a-pick").hidden = !it;
    if (!it) return;
    const b = localArea.buildings[it.k];
    $("a-pick-title").textContent = it.roof && it.roof.address ? cleanAddress(it.roof.address)
      : it.ref ? `Cadastral ref. ${it.ref}` : `City building ${b.id}`;
    $("a-pick-swatch").style.setProperty("--c", ratingColor(it));
    $("a-pick-rank").textContent = it.cls != null
      ? `${RATING_NAMES[it.cls]} · number ${fmt(it.rank)} of ${fmt(rating.rated.length)}`
      : "Not rated: too small, or outside the 9 blocks";
    $("a-pick-m2").textContent = it.kwhPerM2 != null ? `${fmt(it.kwhPerM2)} kWh` : "–";
    $("a-pick-year").textContent = it.kwhYear != null ? `${fmt(it.kwhYear)} kWh` : "–";
    $("a-pick-panels").textContent = it.panels != null ? fmt(it.panels) : "–";
    $("a-pick-src").textContent = it.exact ? "Our pipeline" : it.kwhPerM2 != null ? "Quick estimate" : "–";
    $("a-pick-floor").textContent = `${fmt(b.relHeight, 1)} m high · about ${b.floors} floors · roof ${fmt(b.footprint)} m²`;
  }

  function openPicked() {
    if (!picked) return;
    area = localArea;
    searchLabel = picked.roof && picked.roof.address ? cleanAddress(picked.roof.address) : null;
    analyze(picked.k).catch((err) => setStatus("error", err.message));
  }

  function fillArea() {
    const rule = sharing && sharing.rules && (sharing.rules["500"] || currentRule());
    const t = rule && rule.totals;
    const rated = rating ? rating.rated : [];
    if (t && t.covered_pct != null) {
      $("a-source").textContent = "Our pipeline · step 5";
      $("a-source").dataset.kind = "pipeline";
      $("a-cover").textContent = `${fmt(t.covered_pct, 1)}%`;
      $("a-cover-note").textContent = `from solar panels on their own roofs, after sharing between buildings (step 5, ${ruleLabel(sharing.rules["500"] ? "500" : ruleKey)} rule). Without sharing: ${fmt(t.covered_alone_pct, 1)}%.`;
    } else if (rated.length) {
      const energy = rated.reduce((s, it) => s + it.kwhYear, 0);
      const demand = rated.reduce((s, it) => s + localArea.buildings[it.k].demand, 0);
      $("a-source").textContent = rating.exact ? `Quick estimate · ${fmt(rating.exact)} roofs exact from our pipeline` : "Quick estimate";
      $("a-source").dataset.kind = "estimate";
      $("a-cover").textContent = demand ? `≈ ${fmt((100 * energy) / demand)}%` : "–";
      $("a-cover-note").replaceChildren("if every rated roof had panels, before sharing. The exact share comes from step 5 (",
        el("code", { text: "python -m step5.sharing" }), ", then ", el("code", { text: "python -m web.sharing" }), ").");
    } else {
      $("a-source").textContent = "";
      $("a-cover").textContent = "–";
      if (areaError) {
        $("a-cover-note").replaceChildren(`Could not load the study area's buildings (${areaError}) Make the area file once, in pipeline/: `,
          el("code", { text: "python -m web.buildings" }), ", then reload the page.");
      } else {
        $("a-cover-note").textContent = rating ? "No building to rate in the study area." : "Rating the roofs of the study area…";
      }
    }
    const energy = rated.reduce((s, it) => s + it.kwhYear, 0);
    $("a-roofs").textContent = rated.length ? `${fmt(rated.length)}${rating.exact ? ` (${fmt(rating.exact)} exact)` : ""}` : "–";
    $("a-panels").textContent = rated.length ? fmt(rated.reduce((s, it) => s + (it.panels || 0), 0)) : "–";
    $("a-energy").textContent = rated.length ? (energy >= 1e6 ? `${fmt(energy / 1e6, 1)} GWh` : kwhToMwh(energy)) : "–";
    $("a-homes").textContent = rated.length ? fmt(energy / CFG.HOME_KWH_YEAR) : "–";
    $("a-homes-label").title = `at about ${fmt(CFG.HOME_KWH_YEAR)} kWh a year per home (an assumption in config.js)`;

    // block by block (blocks 1-9 come from the roof test set, through step 4's batch)
    const perBlock = {};
    for (const r of doneRoofs()) if (r.block) perBlock[r.block] = (perBlock[r.block] || 0) + r.yearly_kwh;
    const max = Math.max(1, ...Object.values(perBlock));
    const any = Object.keys(perBlock).length > 0;
    $("a-blocks").replaceChildren(...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => {
      const v = perBlock[n];
      const bar = el("div", { class: v ? "bar" : "bar empty", title: v ? `Block ${n}: ${fmt(v)} kWh a year` : `Block ${n}: not run yet` }, [el("span"), el("b", { text: String(n) })]);
      if (v) bar.firstChild.style.setProperty("--h", `${Math.round((100 * v) / max)}%`);
      return bar;
    }));
    $("a-blocks-note").textContent = any ? "Exact results from our pipeline. Blocks as in the roof test set: row 1 is Gran Via–Diputació, row 3 Consell de Cent–Aragó." :
      "Fills in with exact numbers when step 4's batch runs the roof test set with --web.";

    // best roofs: the 5 rated buildings that make the most kWh a year
    const best = rated.slice().sort((p, q) => q.kwhYear - p.kwhYear).slice(0, 5);
    if (!best.length) {
      $("a-best").replaceChildren(el("p", { class: "note", text: areaError ? "The list appears once the study area's buildings load." : rating ? "No building to list yet." : "Rating the roofs…" }));
      return;
    }
    $("a-best").replaceChildren(...best.map((it, i) => {
      const b = localArea.buildings[it.k];
      const swatch = el("i", { class: "swatch" });
      swatch.style.setProperty("--c", ratingColor(it));
      const btn = el("button", { type: "button" }, [
        el("span", { class: "rank", text: String(i + 1) }),
        el("span", { class: "name" }, [it.roof && it.roof.address ? cleanAddress(it.roof.address) : it.ref ? `Cadastral ref. ${it.ref}` : `City building ${b.id}`,
          el("small", {}, [swatch, `${RATING_NAMES[it.cls]} · ${it.exact ? "our pipeline" : "quick estimate"}`])]),
        el("span", { class: "kwh", text: `${fmt(it.kwhYear)} kWh` }),
      ]);
      btn.addEventListener("click", () => {
        const [lng, lat] = localArea.proj.toLngLat(b.c[0], b.c[1]);
        pickInArea(lng, lat, it.k);
        view.goTo({ center: [lng, lat], zoom: 18, tilt: 55 }, { duration: 1000 }).catch(() => {});
      });
      return btn;
    }));
  }

  // Block numbers 1-9 above the blocks (from the roof test set, through step 4's batch).
  function drawBlockLabels() {
    labelLayer.removeAll();
    if (!localArea) return;
    const blocks = {};
    for (const r of doneRoofs()) if (r.block) (blocks[r.block] = blocks[r.block] || []).push(...partsOf(r.refcat));
    for (const [n, parts] of Object.entries(blocks)) {
      if (!parts.length) continue;
      const lng = parts.reduce((s, p) => s + p.lng, 0) / parts.length;
      const lat = parts.reduce((s, p) => s + p.lat, 0) / parts.length;
      const z = Math.max(...parts.map((p) => p.b.height)) + 8;
      labelLayer.add(new Graphic({
        geometry: { type: "point", longitude: lng, latitude: lat, z, spatialReference: SR },
        symbol: {
          type: "point-3d",
          symbolLayers: [
            { type: "icon", resource: { primitive: "circle" }, size: 24, material: { color: COLORS.ink }, outline: { color: [255, 255, 255], size: 1.5 } },
            { type: "text", text: String(n), size: 11, material: { color: [255, 255, 255] }, font: { weight: "bold" } },
          ],
        },
      }));
    }
  }

  /* ---------- Sharing tab (step 5) ---------- */
  const ruleKeys = () => (sharing && sharing.rules ? Object.keys(sharing.rules).sort((a, b) => a - b) : []);
  function currentRule() {
    const keys = ruleKeys();
    if (!keys.length) return null;
    if (!keys.includes(ruleKey)) ruleKey = keys.includes("500") ? "500" : keys[0];
    return sharing.rules[ruleKey];
  }
  const RULE_NOTES = {
    500: "Every member within 500 m of every other: the first Spanish rule (RD 244/2019), so the groups are legal under the newer rules too.",
    2000: "Members up to 2 km apart.",
    5000: "Members up to 5 km apart: today's widest rule for solar (RDL 7/2026).",
  };

  function fillSharing() {
    const rule = currentRule();
    const keys = [...new Set(["500", "2000", "5000", ...ruleKeys()])].sort((a, b) => a - b);
    $("s-rules").replaceChildren(...keys.map((k) => {
      const have = ruleKeys().includes(k);
      const btn = el("button", { type: "button", "aria-pressed": String(have && k === ruleKey), text: ruleLabel(k),
        title: have ? null : `Not run yet: python -m step5.sharing --max-distance ${k} --out data\\sharing_${k}, then python -m web.sharing --sharing data\\sharing_${k} --rule ${k}` });
      btn.disabled = !have;
      btn.addEventListener("click", () => { ruleKey = k; fillSharing(); drawSharing(); if (sel) step5Line(area.buildings[sel.k]); });
      return btn;
    }));
    if (!rule) {
      $("s-rule-note").replaceChildren("Appears after step 5. In pipeline/: ", el("code", { text: "python -m step5.sharing" }), ", then ", el("code", { text: "python -m web.sharing" }), ".");
      for (const id of ["s-alone", "s-with"]) $(id).textContent = "–";
      $("s-groups").replaceChildren(el("p", { class: "note", text: "The groups and their numbers will be listed here." }));
      return;
    }
    $("s-rule-note").textContent = RULE_NOTES[ruleKey] || `Members up to ${ruleLabel(ruleKey)} apart.`;
    const t = rule.totals;
    $("s-alone").textContent = t.covered_alone_pct != null ? `${fmt(t.covered_alone_pct, 1)}%` : "–";
    $("s-with").textContent = t.covered_pct != null ? `${fmt(t.covered_pct, 1)}%` : "–";
    $("s-alone-bar").style.width = `${Math.min(100, t.covered_alone_pct || 0)}%`;
    $("s-with-bar").style.width = `${Math.min(100, t.covered_pct || 0)}%`;

    const groups = rule.groups.map((g, i) => ({ g, i })).sort((p, q) => (q.g.solar_kwh || 0) - (p.g.solar_kwh || 0));
    const cards = groups.slice(0, 12).map(({ g, i }) => {
      const [, , line] = GROUP_COLORS[i % GROUP_COLORS.length];
      const dot = el("span", { class: "dot", text: String(g.id) });
      dot.style.background = line;
      const card = el("button", { type: "button", class: "group" }, [
        el("span", { class: "head" }, [dot, `Started by ${cleanAddress(g.started_by || g.starter || "")}`,
          el("span", { class: "count", text: `${fmt(g.members.length)} buildings` })]),
        el("span", { class: "nums" }, [
          el("span", {}, ["Used at home", el("b", { text: kwhToMwh(g.self_kwh) })]),
          el("span", {}, ["Shared", el("b", { text: kwhToMwh(g.shared_kwh) })]),
          el("span", {}, ["To the grid", el("b", { text: kwhToMwh(g.grid_kwh) })]),
        ]),
        el("span", { class: "note", text: g.covered_pct != null ? `Solar covers ${fmt(g.covered_pct, 1)}% of the group's use.` : "" }),
      ]);
      card.addEventListener("click", () => {
        const p = partsOf(g.starter)[0] || (rule.buildings[g.starter] && { lng: rule.buildings[g.starter].lon, lat: rule.buildings[g.starter].lat });
        if (p && p.lng != null) view.goTo({ center: [p.lng, p.lat], zoom: 18, tilt: 55 }, { duration: 1000 }).catch(() => {});
      });
      return card;
    });
    if (groups.length > 12) cards.push(el("p", { class: "note", text: `and ${fmt(groups.length - 12)} smaller groups on the map` }));
    if (!groups.length) cards.push(el("p", { class: "note", text: "Step 5 found no group: no roof has extra sun to share." }));
    $("s-groups").replaceChildren(...cards);
  }

  // Each group: the roof with extra sun in a strong colour, the buildings it supplies in a light one,
  // and an arc from the first to each of the others.
  function drawSharing() {
    shareLayer.removeAll();
    const rule = currentRule();
    if (!rule || !localArea) return;
    rule.groups.forEach((g, i) => {
      const [solid, tint, line] = GROUP_COLORS[i % GROUP_COLORS.length];
      const start = partsOf(g.starter)[0];
      g.members.forEach((ref, j) => {
        const parts = partsOf(ref);
        for (const p of parts) shareLayer.add(slab(p.b, p.b.height + 0.05, 0.5, [...hexRgb(j === 0 ? solid : tint), 0.95]));
        const end = parts[0];
        if (!start || !end || j === 0) return;
        const za = start.b.height + 3, zb = end.b.height + 3;
        const mid = [(start.lng + end.lng) / 2, (start.lat + end.lat) / 2, Math.max(za, zb) + 12];
        shareLayer.add(new Graphic({
          geometry: { type: "polyline", hasZ: true, spatialReference: SR, paths: [[[start.lng, start.lat, za], mid, [end.lng, end.lat, zb]]] },
          symbol: { type: "line-3d", symbolLayers: [{ type: "line", size: 3, material: { color: hexRgb(line) }, cap: "round" }] },
        }));
      });
    });
  }

  /* ---------- tabs and legend ---------- */
  const LEGENDS = {
    area: () => {
      const best = CFG.POTENTIAL_COLORS.slice().reverse();
      return `<p class="title">Best and worst roofs for solar panels</p>` +
        `<div class="scale">${best.map((c) => `<i style="--c:${c}"></i>`).join("")}</div>` +
        `<div class="ends"><span>best 20%</span><span>worst 20%</span></div>` +
        `<p class="row"><i style="--c:${NOT_RATED}"></i>Not rated (small, or outside the 9 blocks)</p>` +
        `<p class="hint">${rating ? `${fmt(rating.rated.length)} buildings rated by kWh a year per m² of roof: ${fmt(rating.exact)} exact from our pipeline, the rest quick estimates${rating.factor !== 1 ? ` (scaled ×${fmt(rating.factor, 2)} to match the pipeline)` : ""}. Click a building for its rating.`
          : areaError ? "The study area's buildings could not be loaded: run python -m web.buildings (pipeline folder)." : "Rating the roofs of the study area…"}</p>`;
    },
    building: () => `<p class="title">On the map</p>` +
      `<p class="row"><i style="--c:var(--sel)"></i>Selected roof</p>` +
      `<p class="row"><i style="--c:linear-gradient(90deg,#3d4f63,#f2a516,#ffe066)"></i>Panel: shade → full sun</p>` +
      `<p class="row"><i style="--c:#ffe600"></i>Usable roof (step 2)</p>` +
      `<p class="row"><i style="--c:var(--got-full)"></i>Neighbour fully supplied</p>` +
      `<p class="row"><i style="--c:var(--got-part)"></i>Neighbour partly supplied</p>`,
    sharing: () => `<p class="title">Each colour is one sharing group</p>` +
      `<p class="row">${GROUP_COLORS.slice(0, 3).map((c) => `<i style="--c:${c[0]}"></i>`).join("")}Roof with extra sun: gives</p>` +
      `<p class="row">${GROUP_COLORS.slice(0, 3).map((c) => `<i style="--c:${c[1]}"></i>`).join("")}Building that receives</p>` +
      `<p class="row"><i style="--c:var(--soft);height:3px"></i>Energy flow</p>` +
      `<p class="hint">${!currentRule() ? "Groups appear after step 5." : localArea ? "" : "Groups are drawn after python -m web.buildings."}</p>`,
  };

  function setTab(name) {
    tab = name;
    document.body.dataset.tab = name;
    document.querySelectorAll(".tabs [data-tab]").forEach((btn) => btn.setAttribute("aria-selected", String(btn.dataset.tab === name)));
    for (const t of ["area", "building", "sharing"]) $(`tab-${t}`).hidden = t !== name;
    const method = name === "method";
    $("panel").hidden = method;
    $("story").hidden = !method;
    $("veil").hidden = !method;
    $("legend").hidden = method;
    if (!method) $("legend").innerHTML = LEGENDS[name]();
    labelLayer.visible = name === "area";
    if (potentialLayer) potentialLayer.visible = name === "area";
    showCityModel(name === "area");
    roofLayer.visible = ringLayer.visible = name === "building";
    shareLayer.visible = name === "sharing";
    $("building-empty").hidden = !!sel;
    $("report").hidden = !sel;
    if (view) view.padding = { top: 0, left: 0, bottom: 80, right: method ? 0 : PANEL_W };
  }

  /* ---------- time bar: moves the real sun ---------- */
  function sunDate() {
    const offset = time.month >= 3 && time.month <= 9 ? 2 : 1;   // Barcelona: UTC+2 April-October, else UTC+1
    return new Date(Date.UTC(2026, time.month, 15, time.hour - offset, 0));
  }

  function onTime() {
    [...$("t-months").children].forEach((b, i) => b.setAttribute("aria-pressed", String(i === time.month)));
    $("t-hour-out").textContent = `${String(time.hour).padStart(2, "0")}:00`;
    if (view) view.environment.lighting.date = sunDate();
    if (sel && isPipeline()) {
      drawDay();
      drawMonths(sel.reading.energy.yearly_kwh ? sel.slots.filter((s) => s.sunFactor >= Number($("sun-range").value) / 100).reduce((t, s) => t + s.kwh, 0) / sel.reading.energy.yearly_kwh : 1);
    }
  }

  function buildTimebar() {
    $("t-months").replaceChildren(...MONTHS.split("").map((m, i) => {
      const b = el("button", { type: "button", "aria-label": MONTH_NAMES[i], "aria-pressed": String(i === time.month), text: m });
      b.addEventListener("click", () => { time.month = i; onTime(); });
      return b;
    }));
    $("t-hour").value = String(time.hour);
    $("t-hour").addEventListener("input", (e) => { time.hour = Number(e.target.value); onTime(); });
    $("t-shadows").checked = !!CFG.SHADOWS_AT_START;
    $("t-shadows").addEventListener("change", (e) => { if (view) view.environment.lighting.directShadowsEnabled = e.target.checked; });
  }

  // "Hours of shadow" is heavy: it runs only while its box is open.
  function addShadowTool() {
    const box = document.createElement("div");
    const expand = new Expand({ view, content: box, expandIcon: "clock", expandTooltip: "Hours of shadow" });
    let tool = null;
    reactiveUtils.watch(() => expand.expanded, (open) => {
      if (open && !tool) {
        const node = document.createElement("div");
        box.replaceChildren(node);
        tool = new ShadowCast({ view, container: node });
      } else if (!open && tool) {
        tool.destroy();
        tool = null;
        box.replaceChildren();
      }
    });
    view.ui.add(expand, "bottom-left");
  }

  // The top bar can wrap onto two lines; the map and the cards start under it.
  function fitLayout() {
    const top = $("topbar").offsetHeight || 64;
    document.documentElement.style.setProperty("--top", `${top}px`);
    if (view) {
      const phone = window.innerWidth <= 760;
      view.ui.padding = { top: phone ? 70 : 16, left: 20, right: 16, bottom: phone ? Math.round(window.innerHeight * 0.48) + 10 : 92 };
    }
  }

  /* ---------- start ---------- */
  async function main() {
    // start reading our files right away, while the 3D map loads
    localReady = loadLocalArea()
      .then((a) => { localArea = a; })
      .catch((err) => { console.warn("Could not read " + BUILDINGS_FILE, err); });
    const dataReady = Promise.all([getRoofIndex(), getJson(SHARING_FILE).then((j) => { sharing = j; })]);

    const map = new Map({ basemap: makeBasemap(), ground: "world-elevation" });
    view = new SceneView({
      container: "map",
      map,
      qualityProfile: CFG.QUALITY || "medium",
      popupEnabled: false,
      environment: {
        lighting: { type: "sun", date: sunDate(), directShadowsEnabled: !!CFG.SHADOWS_AT_START },
        atmosphereEnabled: true,
      },
      camera: cameraOver(PLACES.focus),
      padding: { top: 0, left: 0, bottom: 80, right: PANEL_W },
    });
    map.addMany([labelLayer, shareLayer, roofLayer, ringLayer]);
    view.ui.move(["zoom", "navigation-toggle", "compass"], "bottom-left");
    addShadowTool();
    fitLayout();
    window.addEventListener("resize", fitLayout);

    document.querySelectorAll(".tabs [data-tab]").forEach((btn) => btn.addEventListener("click", () => setTab(btn.dataset.tab)));
    $("sun-range").addEventListener("input", updateResults);
    $("policy-select").addEventListener("change", updateResults);
    $("save-btn").addEventListener("click", saveJson);
    $("search").addEventListener("submit", onSearch);
    $("a-pick-open").addEventListener("click", openPicked);
    $("a-pick-close").addEventListener("click", () => { picked = null; if (pickHandle) pickHandle.remove(); fillPick(); });
    buildTimebar();
    setTab("area");

    await dataReady;
    fillArea();
    fillSharing();

    try {
      await view.when();
    } catch (err) {
      setStatus("error", "The 3D map could not start. This browser may not support WebGL2.");
      console.error(err);
      return;
    }
    view.on("click", onClick);
    sceneLayer = await addSceneLayer(map);
    try {
      await rateArea();
      buildPotentialLayer();
      cityFilter = await makeCityFilter();
    } catch (err) {
      areaError = err.message;
      setStatus("error", "Could not rate the study area: " + err.message);
      console.error(err);
    }
    drawBlockLabels();
    drawSharing();
    fillArea();
    setTab(tab);
    if (!sceneLayer) setStatus("error", "The city's 3D model did not load. The calculation still works: click where a building is.");
    else if (rating) setStatus("idle", `${fmt(rating.rated.length)} buildings rated (${fmt(rating.exact)} exact from our pipeline). Click one for its rating, or type an address.`);
  }

  main();
});
