/* MATCHSOL — the map and the screens.
 * 3D model and building data: Ajuntament de Barcelona open services (geo.bcn.cat), shown with the ArcGIS Maps SDK.
 *
 * Matches tab: every match of buildings on the real 3D model, coloured by what each building is (homes with
 *   panels, homes whose roof is too shaded for panels, schools, offices), with power lines that change direction
 *   with the day and the hour. Click a match: every other building turns grey, and the panel shows its day,
 *   hour by hour, who gives and who gets, and what it is worth.
 * Hourly split tab: the share of every roof's power for every member and every hour, and the year file for
 *   the electricity company. Money tab: who pays whom, at a price you choose. How it works: the idea and the steps.
 *
 * Where the numbers come from (a preview, computed in the browser; see README):
 *  - buildings, flats and uses: the city's 3D model (data/buildings.json); later Catastro (step 2 of MATCHSOL)
 *  - each building's use, hour by hour: step 5's patterns (config.js, USE); later Open Data BCN (step 3)
 *  - solar power: our pipeline (data/roofs/, steps 2-4) where it ran, the quick estimate (solar.js) elsewhere
 *  - the matching itself: match.js
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
  const M = window.Match;
  const MC = CFG.MATCH, U = CFG.USE, COL = CFG.COLORS;
  const $ = (id) => document.getElementById(id);
  const fmt = (n, d = 0) => Number(n).toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d });
  const BUILDINGS_FILE = CFG.BUILDINGS_FILE || "../website/data/buildings.json";
  const ROOFS = CFG.ROOFS_FOLDER || "../website/data/roofs/";
  const PANEL_W = 410;   // the side panel's width + margin, kept free when the map centres on something
  const PANEL_KWP = CFG.PANEL_LENGTH_M * CFG.PANEL_WIDTH_M * CFG.PANEL_EFFICIENCY;   // about 0.42 kWp per panel
  const SPLIT_HOURS = [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];

  const PLACES = { focus: { lat: 41.3928, lng: 2.1684 } }; // our 9 blocks: Passeig de Gràcia to Bruc, Gran Via to Aragó
  const STUDY_RADIUS_M = 350, STUDY_MARGIN_M = 100;     // without data/buildings.json: what to load from the city
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
  const INK = [22, 32, 42];
  // What each building is: 1 home with panels, 2 home without, 3 school, 4 office, 0 not in the matching
  const KIND = {
    1: { name: "Home building", color: COL.HOME, line: COL.FROM_HOMES },
    2: { name: "Home building, no panels", color: COL.HOME_NO_PANELS, edge: "#a8650a", line: COL.FROM_HOMES },
    3: { name: "School", color: COL.SCHOOL, line: COL.FROM_DAYTIME, text: "#ffffff" },
    4: { name: "Office", color: COL.OFFICE, edge: "#16202a", line: COL.FROM_DAYTIME, text: "#16202a" },
  };

  let view, sceneLayer;
  let tab = "matches";
  let localArea = null;     // the study area's buildings (data/buildings.json or the city server)
  let localReady = null;    // promise: resolves when BUILDINGS_FILE is read (or found missing)
  let areaError = null;     // why the study area could not be loaded, if it could not
  let roofIndex = null;     // data/roofs/index.json
  let rating = null;        // { items, rated, byK, exact } — every building of the study area, with its roof rated
  let shapes = null;        // use shapes per typical-day hour (match.js)
  let sunAverage = null;    // the sun shape for roofs without their own (match.js)
  let exactShapes = {};     // refcat -> its own sun shape (roofs run by the pipeline)
  let plots = [];           // buildings taking part: { key, ref, ks, kind, code, homeKwh, dayKwh, sunKwh, ... }
  let plotOfK = {};         // building part position -> its plot
  let matches = [];
  let totals = null;        // the neighbourhood: sun, used alone, shared
  let current = null;       // the open match, or null for all matches
  let selected = null;      // the match shown in Hourly split and Money
  let splitRoof = 0;        // member index of the roof shown in Hourly split
  let splitFor = null;      // ...and the match it belongs to
  let price = CFG.SHARED_PRICE_EUR;
  let potentialLayer = null; // the study area's buildings as coloured 3D volumes
  let cityFilter = null;    // hides the city's own model where our volumes stand
  let hostHighlight = null;
  const roofFiles = {};     // refcat -> roof file (data/roofs/<refcat>.json)
  const time = { day: "weekday", hour: 13 };
  const absolute = { mode: "absolute-height" };
  const labelLayer = new GraphicsLayer({ elevationInfo: absolute, title: "Match labels" });
  const flowLayer = new GraphicsLayer({ elevationInfo: absolute, title: "Power lines" });

  /* ---------- small helpers ---------- */
  function setStatus(kind, text) {
    const e = $("status");
    e.dataset.kind = kind;
    e.textContent = text;
  }
  const nextFrame = () => new Promise((r) => setTimeout(r, 30));
  const ref14 = (v) => String(v || "").trim().slice(0, 14).toUpperCase();
  const cleanAddress = (a) => String(a || "").replace(/\s+BARCELONA\s*\(BARCELONA\)\s*$/i, "").replace(/,\s*Barcelona$/i, "").trim();
  const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const kwh = (v) => (v == null || !isFinite(v) ? "–" : v >= 1e6 ? `${fmt(v / 1e6, 2)} GWh` : v >= 1e4 ? `${fmt(v / 1000, 1)} MWh` : `${fmt(v)} kWh`);
  const euro = (v) => (v == null || !isFinite(v) ? "–" : `${fmt(v)} €`);
  const pct = (v) => (v == null || !isFinite(v) ? "–" : `${fmt(v)}%`);
  const plural = (n, one, many) => `${fmt(n)} ${n === 1 ? one : many}`;
  const hh = (h) => `${String(h).padStart(2, "0")}:00`;
  const day = () => CFG.DAYS[time.day];
  const sunny = () => slotSun(M.slot(day().month, day().weekend, time.hour)) > 0;

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
  function svgEl(tag, attrs = {}) {
    const e = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    return e;
  }
  const swatch = (code, cls = "sw") => {
    const s = el("i", { class: cls });
    s.style.setProperty("--c", KIND[code] ? KIND[code].color : COL.NOT_MATCHED);
    if (KIND[code] && KIND[code].edge) s.style.setProperty("--b", KIND[code].edge);
    return s;
  };

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

  /* ---------- the study area's buildings ---------- */
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
      setStatus("loading", `Loading the study area's buildings from the city server… ${fmt(features.length)}`);
      if (!j.exceededTransferLimit || !got.length) break;
      offset += got.length;
    }
    return features;
  }

  // City features -> buildings (outer ring + courtyards; multi-part = several buildings).
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

  // data/buildings.json, or (once per visit) the same buildings from the city server.
  async function ensureStudyArea() {
    if (localReady) await localReady;
    if (localArea) return localArea;
    setStatus("loading", "Loading the study area's buildings from the city server (instant once you run python -m web.buildings)…");
    const { lng, lat } = PLACES.focus;
    localArea = makeArea(await queryArea(lng, lat, STUDY_RADIUS_M + STUDY_MARGIN_M), lng, lat,
      { local: true, cover: STUDY_RADIUS_M, fromServer: true });
    return localArea;
  }

  /* ---------- roofs run by the pipeline (data/roofs/) ---------- */
  async function getRoofIndex() {
    if (!roofIndex) roofIndex = (await getJson(ROOFS + "index.json")) || { roofs: [] };
    return roofIndex;
  }
  const doneRoofs = () => (roofIndex ? roofIndex.roofs.filter((r) => r.yearly_kwh != null) : []);
  const roofEntry = (ref) => (roofIndex ? roofIndex.roofs.find((r) => r.refcat === ref) : null);
  async function roofFile(ref) {
    if (!(ref in roofFiles)) roofFiles[ref] = await getJson(`${ROOFS}${ref}.json`);
    return roofFiles[ref];
  }

  // The sun shape through the year: our pipeline's typical days (step 4), or the sun's height without them.
  async function loadSunShapes() {
    const own = [];
    for (const r of doneRoofs()) {
      const f = await roofFile(r.refcat);
      const td = f && f.energy && f.energy.typical_day_kwh;
      if (Array.isArray(td) && td.length === 12) {
        exactShapes[r.refcat] = M.sunShape(td);
        own.push(exactShapes[r.refcat]);
      }
    }
    sunAverage = own.length ? M.averageShape(own) : M.sunShapeFromSky(S.sunPosition, PLACES.focus.lat, PLACES.focus.lng);
  }
  // total sun of all matched roofs at one slot (for "is there sun now?")
  function slotSun(t) {
    return sunAverage ? sunAverage[t] : 0;
  }

  /* ---------- every roof of the study area, rated ---------- */
  // Our pipeline's result where it ran (exact), the quick estimate elsewhere, scaled to match the pipeline.
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
        Object.assign(it, { exact: true, roof: ex.roof, kwhYear: ex.roof.yearly_kwh * share,
          panels: Math.round((ex.roof.panels || 0) * share), sunFactor: 1 });
      } else {
        const q = S.roofPotential(a.buildings, a.index, it.k, sun, CFG);
        if (q) Object.assign(it, { exact: false, kwhYear: q.kwhYear, panels: q.panels, sunFactor: q.sunFactor });
      }
      if (i % 150 === 149) {
        setStatus("loading", `Reading the roofs of the study area… ${Math.round((100 * i) / todo.length)}%`);
        await nextFrame();
      }
    }
    // The pipeline (tilted rows, real obstacles) makes fewer kWh than the quick estimate (flat panels, a fixed
    // obstacle allowance), so quick estimates are scaled by the median ratio on the roofs that have both.
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
      if (it.exact || it.kwhYear == null) continue;
      it.kwhYear *= factor; it.panels = Math.round(it.panels * factor);
    }
    const rated = todo.filter((it) => it.kwhYear != null);
    const byK = {};
    items.forEach((it, i) => { it.oid = i + 1; byK[it.k] = it; });
    rating = { items, rated, byK, exact: new Set(rated.filter((it) => it.exact).map((it) => it.ref)).size, factor };
  }

  /* ---------- each building: what it is and what it uses (preview; Catastro and Open Data BCN later) ---------- */
  // From the city model: use, floors and footprint, with step 5's rules: homes above a ground-floor shop,
  // offices and schools by floor area; shops and other uses are not counted yet.
  function partUse(b) {
    const u = String(b.attrs[F.use] || "").toLowerCase(), fl = b.floors, fp = b.footprint;
    if (/oficin|office/.test(u)) return { kind: "office", kwh: fp * fl * U.OFFICE_KWH_PER_M2, homeM2: 0 };
    if (/educa|ense|docent|cultur|sanid|sanit|religi|asist|benef|public/.test(u)) return { kind: "school", kwh: fp * fl * U.SCHOOL_KWH_PER_M2, homeM2: 0 };
    if (!u || /resid|viviend|habita/.test(u)) return { kind: "home", kwh: 0, homeM2: fp * Math.max(1, fl - (fl >= 3 ? 1 : 0)) };
    return { kind: "other", kwh: 0, homeM2: 0 };
  }

  function plotUse(bs) {
    let homeM2 = 0, office = 0, school = 0;
    for (const b of bs) {
      const p = partUse(b);
      homeM2 += p.homeM2;
      if (p.kind === "office") office += p.kwh;
      if (p.kind === "school") school += p.kwh;
    }
    const flats = Math.round(homeM2 / U.FLAT_GROSS_M2);
    const flatM2 = flats ? Math.min(250, Math.max(30, homeM2 / flats)) : 0;
    const flatKwh = flats ? U.FLAT_BASE_KWH + U.FLAT_KWH_PER_M2 * flatM2 : 0;
    const dayKind = office >= school ? (office > 0 ? "office" : null) : "school";
    return { flats, homeKwh: flats * flatKwh, dayKind, dayKwh: dayKind === "office" ? office : dayKind === "school" ? school : 0 };
  }

  // The rated buildings as plots (one cadastral reference, maybe several parts), ready for match.js.
  function makePlots() {
    const byKey = new globalThis.Map();
    for (const it of rating.rated) {
      const key = it.ref || `k${it.k}`;
      let p = byKey.get(key);
      if (!p) byKey.set(key, (p = { key, ref: it.ref, ks: [], kwhYear: 0, panels: 0, sunW: 0, roof: null }));
      p.ks.push(it.k);
      p.kwhYear += it.kwhYear;
      p.panels += it.panels || 0;
      p.sunW += (it.sunFactor || 0) * localArea.buildings[it.k].footprint;
      if (it.exact) p.roof = it.roof;
    }
    const out = [];
    for (const p of byKey.values()) {
      const bs = p.ks.map((k) => localArea.buildings[k]);
      const m2 = bs.reduce((t, b) => t + b.footprint, 0);
      p.x = bs.reduce((t, b) => t + b.c[0] * b.footprint, 0) / m2;
      p.y = bs.reduce((t, b) => t + b.c[1] * b.footprint, 0) / m2;
      const use = plotUse(bs);
      Object.assign(p, use);
      p.kind = use.dayKwh > use.homeKwh ? use.dayKind : use.flats ? "home" : null;
      if (!p.kind) continue;   // shops and other uses: not counted yet
      if (p.roof) {
        p.hasPanels = (p.roof.panels || 0) > 0 && p.roof.yearly_kwh > 0;
        p.sunKwh = p.hasPanels ? p.roof.yearly_kwh : 0;
        p.kwp = p.roof.kwp || (p.roof.panels || 0) * PANEL_KWP;
        p.sun = exactShapes[p.ref] || sunAverage;
      } else {
        p.hasPanels = p.panels >= MC.MIN_PANELS && p.sunW / m2 >= MC.MIN_SUN_FACTOR;
        p.sunKwh = p.hasPanels ? p.kwhYear : 0;
        p.kwp = p.hasPanels ? p.panels * PANEL_KWP : 0;
        p.sun = sunAverage;
      }
      if (!p.hasPanels) p.panels = 0;
      p.code = p.kind === "school" ? 3 : p.kind === "office" ? 4 : p.hasPanels ? 1 : 2;
      p.name = cleanAddress((roofEntry(p.ref) || {}).address) || "";
      out.push(M.prepare(p, shapes));
    }
    return out;
  }

  const titleOf = (p) => p.name || KIND[p.code].name;
  function detailsOf(p) {
    const bits = [];
    if (p.flats) bits.push(plural(p.flats, "flat", "flats"));
    if (p.dayKwh && p.dayKind) bits.push(`${p.dayKind === "office" ? "offices" : "school or public service"}, ${kwh(p.dayKwh)} a year`);
    bits.push(p.hasPanels ? `${fmt(p.kwp, 1)} kWp of panels` : "roof too shaded or small for panels");
    return bits.join(" · ");
  }
  function composition(members) {
    const n = (f) => members.filter(f).length;
    const schools = n((p) => p.code === 3), offices = n((p) => p.code === 4), homes = n((p) => p.code <= 2);
    const parts = [];
    if (schools) parts.push(schools === 1 ? "a school" : `${schools} schools`);
    if (offices) parts.push(offices === 1 ? "an office" : `${offices} offices`);
    if (homes) parts.push(homes === 1 ? "a home building" : `${homes} home buildings`);
    const s = parts.length > 1 ? parts.slice(0, -1).join(", ") + " and " + parts[parts.length - 1] : parts[0];
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  /* ---------- matching ---------- */
  async function runMatching() {
    setStatus("loading", "Matching the buildings…");
    await nextFrame();
    shapes = M.useShapes(U);
    plots = makePlots();
    plotOfK = {};
    plots.forEach((p) => p.ks.forEach((k) => { plotOfK[k] = p; }));
    matches = M.matchAll(plots, MC);
    matches.forEach((m) => {
      m.color = KIND[m.seed.code].color;
      m.text = KIND[m.seed.code].text || "#16202a";
      m.title = composition(m.members);
      m.members.forEach((p, i) => { p.match = m; p.index = i; });
    });
    let sun = 0, own = 0, shared = 0;
    for (const p of plots) { sun += p.sunYear; own += p.ownYear; }
    for (const m of matches) shared += m.sharedYear;
    totals = { sun, own, shared, alonePct: sun ? (100 * own) / sun : 0, matchedPct: sun ? (100 * (own + shared)) / sun : 0,
      taking: plots.filter((p) => p.sunYear > 0 || p.useYear > 0).length, matched: matches.reduce((t, m) => t + m.members.length, 0) };
    selected = matches[0] || null;
  }

  /* ---------- the coloured buildings ---------- */
  const volume = (hex) => ({
    type: "polygon-3d",
    symbolLayers: [{ type: "extrude", material: { color: hexRgb(hex) }, edges: { type: "solid", color: [60, 40, 30, 0.35], size: 0.6 } }],
  });
  const closed = (ll) => [...ll, ll[0]];
  const SIZE = [{ type: "size", field: "h", valueUnit: "meters" }];
  const kindInfos = () => [1, 2, 3, 4].map((c) => ({ value: String(c), label: KIND[c].name, symbol: volume(KIND[c].color) }));

  function overviewRenderer() {
    return {
      type: "unique-value", defaultSymbol: volume(COL.NOT_MATCHED), defaultLabel: "Not matched", uniqueValueInfos: kindInfos(),
      valueExpression: 'IIf($feature.match > 0, Text($feature.kind), "none")', visualVariables: SIZE,
    };
  }
  function matchRenderer(m) {
    return {
      type: "unique-value", defaultSymbol: volume(COL.OUT), defaultLabel: "Not in this match", uniqueValueInfos: kindInfos(),
      valueExpression: `IIf($feature.match == ${Number(m.id)}, Text($feature.kind), "out")`, visualVariables: SIZE,
    };
  }

  // The study area's buildings as whole 3D volumes, from the ground to the roof.
  function buildPotentialLayer() {
    if (potentialLayer) view.map.remove(potentialLayer);
    const graphics = rating.items.map((it) => {
      const b = localArea.buildings[it.k], p = plotOfK[it.k];
      return new Graphic({
        geometry: new Polygon({ rings: [closed(b.ll), ...(b.holesLL || []).map(closed)], spatialReference: SR }),
        attributes: { oid: it.oid, k: it.k, kind: p ? p.code : 0, match: p && p.match ? p.match.id : 0,
          h: Math.max(1, b.relHeight), base: b.height - b.relHeight },
      });
    });
    potentialLayer = new FeatureLayer({
      title: "Buildings", source: graphics, objectIdField: "oid", geometryType: "polygon", spatialReference: SR,
      fields: [{ name: "oid", type: "oid" }, { name: "k", type: "integer" }, { name: "kind", type: "integer" },
        { name: "match", type: "integer" }, { name: "h", type: "double" }, { name: "base", type: "double" }],
      outFields: ["*"], popupEnabled: false, visible: tab === "matches",
      elevationInfo: { mode: "absolute-height", featureExpressionInfo: { expression: "$feature.base" }, unit: "meters" },
      renderer: overviewRenderer(),
    });
    view.map.add(potentialLayer);
  }

  // Hide the city's model inside the study circle while our coloured volumes stand there.
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
      console.warn("Could not hide the city model in the study area; it is hidden everywhere instead.", err);
      return null;
    }
  }

  function showCityModel() {
    if (!sceneLayer) return;
    const on = !!potentialLayer;
    sceneLayer.filter = on && cityFilter ? cityFilter : null;
    sceneLayer.visible = !(on && !cityFilter);
  }

  /* ---------- labels and power lines on the map ---------- */
  function topOf(ks) {
    const bs = ks.map((k) => localArea.buildings[k]);
    const b = bs.reduce((p, q) => (q.footprint > p.footprint ? q : p));
    const [lng, lat] = localArea.proj.toLngLat(b.c[0], b.c[1]);
    return { lng, lat, x: b.c[0], y: b.c[1], z: Math.max(...bs.map((x) => x.height)) };
  }

  function drawLabels() {
    labelLayer.removeAll();
    if (!localArea) return;
    for (const m of matches) {
      if (current && current !== m) continue;
      const at = topOf(m.seed.ks);
      labelLayer.add(new Graphic({
        geometry: { type: "point", longitude: at.lng, latitude: at.lat, z: at.z + 10, spatialReference: SR },
        symbol: {
          type: "point-3d",
          symbolLayers: [
            { type: "icon", resource: { primitive: "circle" }, size: 24, material: { color: hexRgb(m.color) }, outline: { color: [255, 255, 255], size: 1.5 } },
            { type: "text", text: String(m.id), size: 11, material: { color: hexRgb(m.text) }, font: { weight: "bold" } },
          ],
        },
      }));
    }
  }

  // An arc over the roofs from one building to another, with an arrow at the end.
  function arc(a, b, color, width) {
    const d = Math.hypot(b.x - a.x, b.y - a.y), bump = 8 + 0.12 * d, pts = [];
    for (let i = 0; i <= 16; i++) {
      const f = i / 16;
      const [lng, lat] = localArea.proj.toLngLat(a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f);
      pts.push([lng, lat, a.z + (b.z - a.z) * f + 2 + bump * 4 * f * (1 - f)]);
    }
    const rgb = hexRgb(color);
    return new Graphic({
      geometry: { type: "polyline", paths: [pts], hasZ: true, spatialReference: SR },
      symbol: {
        type: "line-3d",
        symbolLayers: [{ type: "line", size: width, material: { color: rgb }, cap: "round", join: "round",
          marker: { type: "style", style: "arrow", placement: "end", color: rgb } }],
      },
    });
  }

  // Who sends power to whom at the chosen day and hour.
  function drawFlows() {
    flowLayer.removeAll();
    if (!localArea || tab !== "matches") return;
    const t = M.slot(day().month, day().weekend, time.hour);
    for (const m of matches) {
      if (current && current !== m) continue;
      const flows = M.flowsAt(m, t);
      if (!flows.length) continue;
      const top = flows[0].kwh;
      for (const f of flows.filter((x) => x.kwh >= Math.max(0.05, 0.12 * top)).slice(0, current ? 16 : 6)) {
        const a = m.members[f.from], b = m.members[f.to];
        flowLayer.add(arc(topOf(a.ks), topOf(b.ks), KIND[a.code].line, 2 + Math.min(4, f.kwh / 3)));
      }
    }
  }

  /* ---------- the panel: all matches / one match ---------- */
  function setBars(prefix, alone, matched) {
    $(`${prefix}-alone`).textContent = pct(alone);
    $(`${prefix}-matched`).textContent = pct(matched);
    $(`${prefix}-alone-bar`).style.width = `${Math.max(0, Math.min(100, alone || 0))}%`;
    $(`${prefix}-matched-bar`).style.width = `${Math.max(0, Math.min(100, matched || 0))}%`;
  }

  function nowFor(m) {
    const d = time.day;
    if (!sunny()) return { color: "#5b6875", text: m ? "No sun at this hour: every building in the match buys from the grid." : "No sun at this hour, so there is nothing to share. Every building buys from the grid." };
    if (d === "weekday") return { color: COL.HOME, text: m ? "Roofs with more power than their building uses send the extra to the buildings that need it now: offices and schools are open, homes are mostly empty." : "Homes are mostly empty. Their roofs send the extra power to schools, offices and homes without panels." };
    if (d === "weekend") return { color: COL.SCHOOL, text: m ? "Schools and offices are closed: their roofs power the homes, most of all those without panels." : "Schools and offices are closed. Their roofs send their power to the homes." };
    return { color: COL.SCHOOL, text: m ? "Schools are closed all week: their roofs power the homes and the offices that stay open." : "Schools are closed all week. Their roofs power the homes and the offices that stay open." };
  }

  function fillOverview() {
    const now = nowFor(null);
    $("o-now-dot").style.setProperty("--c", now.color);
    $("o-now-title").textContent = `${day().label}, ${hh(time.hour)}.`;
    $("o-now-text").textContent = now.text;
    if (!totals) {
      setBars("o", null, null);
      for (const id of ["o-count", "o-buildings", "o-shared", "o-money"]) $(id).textContent = "–";
      $("o-note").replaceChildren(areaError ? `Could not load the study area's buildings (${areaError}) Make the area file once, in pipeline/: ` : "Reading the roofs and matching the buildings…",
        areaError ? el("code", { text: "python -m web.buildings" }) : "");
      $("o-list").replaceChildren();
      return;
    }
    setBars("o", totals.alonePct, totals.matchedPct);
    $("o-count").textContent = fmt(matches.length);
    $("o-buildings").textContent = `${fmt(totals.matched)} of ${fmt(totals.taking)}`;
    $("o-shared").textContent = kwh(totals.shared);
    $("o-money").textContent = euro(totals.shared * (CFG.GRID_PRICE_EUR - CFG.SURPLUS_PRICE_EUR));
    $("o-note").textContent = `Preview: buildings and flats from the city's 3D model, use from step 5's patterns, solar power from our pipeline (${plural(rating.exact, "roof", "roofs")} exact) and the quick estimate. ` +
      `The panels avoid about ${fmt((totals.sun * CFG.CO2_KG_PER_KWH) / 1000)} t of CO₂ a year matched or not; matching keeps the money in the neighbourhood.`;
    if (!matches.length) {
      $("o-list").replaceChildren(el("p", { class: "note", text: "No buildings with complementary schedules were found in the study area." }));
      return;
    }
    $("o-list").replaceChildren(...matches.map((m) => {
      const dot = el("i", { class: "dot", text: String(m.id) });
      dot.style.setProperty("--c", m.color);
      dot.style.setProperty("--t", m.text);
      const btn = el("button", { type: "button", class: "match-card" }, [
        dot,
        el("span", { class: "name" }, [m.title, el("small", { text: `${pct(m.alonePct)} used alone → ${pct(m.matchedPct)} matched` })]),
        el("span", { class: "kwh", text: kwh(m.sharedYear) }),
      ]);
      btn.addEventListener("click", () => openMatch(m));
      return btn;
    }));
  }

  // A 24-hour chart: sun (area), homes use and daytime use (lines), a mark at the chosen hour.
  function dayArrays(m) {
    const d = day(), sun = [], homes = [], dayUse = [];
    for (let h = 0; h < 24; h++) {
      const t = M.slot(d.month, d.weekend, h);
      let s = 0, a = 0, b = 0;
      for (const p of m.members) {
        s += p.sunH[t];
        a += p.homeKwh * shapes.home[t];
        if (p.dayKwh && p.dayKind) b += p.dayKwh * shapes[p.dayKind][t];
      }
      sun.push(s); homes.push(a); dayUse.push(b);
    }
    return { sun, homes, day: dayUse };
  }
  function niceMax(v) {
    const p = Math.pow(10, Math.floor(Math.log10(Math.max(v, 1e-6))));
    return [1, 2, 2.5, 5, 10].map((x) => x * p).find((x) => x >= v);
  }
  function drawChart(svg, arrs, hour, w, h) {
    const ymax = niceMax(Math.max(...arrs.sun, ...arrs.homes, ...arrs.day) * 1.05);
    const x = (i) => 8 + (i * (w - 16)) / 23, y = (v) => h - 24 - (v * (h - 36)) / ymax;
    const line = (a) => a.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
    const kids = [
      svgEl("line", { x1: 8, y1: y(0), x2: w - 8, y2: y(0), stroke: "#e2ded5" }),
      svgEl("line", { x1: 8, y1: y(ymax / 2), x2: w - 8, y2: y(ymax / 2), stroke: "#e2ded5", "stroke-dasharray": "3 3" }),
      svgEl("line", { x1: 8, y1: y(ymax), x2: w - 8, y2: y(ymax), stroke: "#e2ded5", "stroke-dasharray": "3 3" }),
      svgEl("polygon", { points: `8,${y(0)} ${line(arrs.sun)} ${w - 8},${y(0)}`, fill: "#ffe27a", "fill-opacity": "0.7", stroke: "#d9a400", "stroke-width": "1.2" }),
      svgEl("polyline", { points: line(arrs.homes), fill: "none", stroke: COL.FROM_HOMES, "stroke-width": "2.2" }),
      svgEl("polyline", { points: line(arrs.day), fill: "none", stroke: COL.FROM_DAYTIME, "stroke-width": "2.2" }),
    ];
    if (hour != null) kids.push(svgEl("line", { x1: x(hour), y1: 6, x2: x(hour), y2: y(0), stroke: "#16202a", "stroke-width": "1.2", "stroke-dasharray": "2 2" }));
    const text = (tx, ty, s, anchor = "start") => {
      const t = svgEl("text", { x: tx, y: ty, "font-family": "IBM Plex Mono, monospace", "font-size": "10", fill: "#5b6875", "text-anchor": anchor });
      t.textContent = s;
      return t;
    };
    for (const hr of [0, 6, 12, 18, 23]) kids.push(text(x(hr), h - 8, String(hr).padStart(2, "0"), hr === 0 ? "start" : hr === 23 ? "end" : "middle"));
    kids.push(text(w - 8, y(ymax) - 3, `${fmt(ymax)} kWh`, "end"), text(w - 8, y(ymax / 2) - 3, fmt(ymax / 2), "end"));
    svg.replaceChildren(...kids);
  }

  function fillMatch(m) {
    $("m-dot").style.setProperty("--c", m.color);
    $("m-eyebrow").textContent = `Match ${m.id} · ${plural(m.members.length, "building", "buildings")}`;
    $("match-title").textContent = m.title;
    $("m-sub").textContent = `Around ${titleOf(m.seed)}${m.seed.ref ? ` (${m.seed.ref})` : ""}. Together they use ${pct(m.matchedPct)} of their solar power, instead of ${pct(m.alonePct)} each on their own.`;
    const now = nowFor(m);
    $("m-now-dot").style.setProperty("--c", now.color);
    $("m-now-text").replaceChildren(el("b", { text: `${day().label}, ${hh(time.hour)}. ` }), now.text);
    const names = { weekday: "weekday", weekend: "weekend day", summer: "summer holiday weekday" };
    $("m-chart-title").textContent = `A ${names[time.day]} in match ${m.id} (kWh per hour)`;
    $("m-chart").setAttribute("aria-label", `Chart of one ${names[time.day]}: the sun on the match's roofs, the homes' use and the school and office use, hour by hour`);
    drawChart($("m-chart"), dayArrays(m), time.hour, 336, 156);
    setBars("m", m.alonePct, m.matchedPct);
    const t = M.slot(day().month, day().weekend, time.hour);
    $("m-members").replaceChildren(...m.members.map((p, i) => {
      const gives = m.given[i][t] > 0.05, gets = m.got[i][t] > 0.05;
      const role = gives ? el("span", { class: "role gives", text: "Gives now" }) : gets ? el("span", { class: "role gets", text: "Gets now" }) : el("span", { class: "role", text: sunny() ? "Own power" : "No sun" });
      return el("li", {}, [
        swatch(p.code),
        el("span", { class: "who" }, [el("b", { text: titleOf(p) }), el("small", { text: `${p.ref ? p.ref + " · " : ""}${detailsOf(p)}` }),
          el("small", { text: `A year: gives ${kwh(m.givenYear[i])}, gets ${kwh(m.gotYear[i])}` })]),
        role,
      ]);
    }));
    $("m-shared").textContent = kwh(m.sharedYear);
    $("m-grid").textContent = kwh(m.gridYear);
    $("m-money").textContent = euro(m.sharedYear * (CFG.GRID_PRICE_EUR - CFG.SURPLUS_PRICE_EUR));
    $("m-co2").textContent = `${fmt((m.sunYear * CFG.CO2_KG_PER_KWH) / 1000, 1)} t`;
  }

  function fillLegend() {
    if (tab !== "matches") return;
    const row = (code, label) => `<p class="row"><i style="--c:${KIND[code].color}${KIND[code].edge ? `;--b:${KIND[code].edge}` : ""}" class="${KIND[code].edge ? "edge" : ""}"></i>${label}</p>`;
    $("legend").innerHTML = `<p class="title">Buildings</p>` +
      row(1, "Homes with solar panels") + row(2, "Homes, roof too shaded for panels") + row(3, "School") + row(4, "Office") +
      `<p class="row"><i style="--c:${current ? COL.OUT : COL.NOT_MATCHED}"></i>${current ? "Not in this match" : "Not matched"}</p>` +
      `<p class="title">Power, at this hour</p>` +
      `<p class="row"><i class="flow" style="--c:${COL.FROM_HOMES}"></i>From home roofs</p>` +
      `<p class="row"><i class="flow" style="--c:${COL.FROM_DAYTIME}"></i>From school and office roofs</p>` +
      `<p class="hint">${sunny() ? "Click a building to open its match." : "No sun at this hour: no power to share."}</p>`;
  }

  function showOverview(fly = true) {
    current = null;
    if (hostHighlight) { hostHighlight.remove(); hostHighlight = null; }
    if (potentialLayer) potentialLayer.renderer = overviewRenderer();
    drawLabels();
    drawFlows();
    fillOverview();
    $("overview").hidden = false;
    $("match").hidden = true;
    fillLegend();
    if (fly && view) view.goTo(cameraOver(PLACES.focus), { duration: 1000 }).catch(() => {});
  }

  function openMatch(m) {
    current = m;
    selected = m;
    if (tab !== "matches") setTab("matches");
    if (potentialLayer) {
      potentialLayer.renderer = matchRenderer(m);
      const oids = m.members.flatMap((p) => p.ks).map((k) => rating.byK[k] && rating.byK[k].oid).filter(Boolean);
      if (hostHighlight) hostHighlight.remove();
      view.whenLayerView(potentialLayer).then((lv) => { if (current === m) hostHighlight = lv.highlight(oids); }).catch(() => {});
      const polys = m.members.flatMap((p) => p.ks).map((k) => new Polygon({ rings: [closed(localArea.buildings[k].ll)], spatialReference: SR }));
      if (polys.length) view.goTo({ target: polys, tilt: 55 }, { duration: 1000 }).catch(() => {});
    }
    drawLabels();
    drawFlows();
    fillMatch(m);
    $("overview").hidden = true;
    $("match").hidden = false;
    $("panel").scrollTop = 0;
    fillLegend();
    setStatus("idle", `Match ${m.id}. Change the day and the hour to see the power change direction.`);
  }

  /* ---------- Hourly split ---------- */
  function fillMatchSelect(id) {
    const sel = $(id);
    sel.replaceChildren(...matches.map((m) => el("option", { value: String(m.id), text: `Match ${m.id} · ${m.title}` })));
    if (selected) sel.value = String(selected.id);
  }

  function fillSplit() {
    const m = selected;
    if (!m) {
      $("s-table").replaceChildren(el("p", { class: "note", text: totals ? "No matches in the study area." : "Matching the buildings…" }));
      $("s-roofs").replaceChildren();
      $("s-caption").textContent = "";
      return;
    }
    $("s-dot").style.setProperty("--c", m.color);
    fillMatchSelect("s-match");
    const roofs = m.members.map((p, i) => ({ p, i })).filter((x) => x.p.sunYear > 0);
    if (splitFor !== m || !roofs.some((x) => x.i === splitRoof)) {
      // start with the roof that gives the most to the others
      splitFor = m;
      splitRoof = roofs.length ? roofs.reduce((a, b) => (m.givenYear[b.i] > m.givenYear[a.i] ? b : a)).i : 0;
    }
    $("s-roofs").replaceChildren(...roofs.map(({ p, i }) => {
      const b = el("button", { type: "button", "aria-pressed": String(i === splitRoof), text: `${KIND[p.code].name.replace(", no panels", "")} · ${p.ref || i + 1}` });
      b.addEventListener("click", () => { splitRoof = i; fillSplit(); });
      return b;
    }));
    fillDayPills("s-days");
    const roof = m.members[splitRoof];
    const d = day();
    const rows = M.splitTable(m, splitRoof, d.month, d.weekend, SPLIT_HOURS);
    const tint = roof.code >= 3 ? [31, 95, 139] : [196, 122, 6];
    const head = el("div", { class: "split-row head" }, [el("span", { text: "Share of the roof's power" }), ...SPLIT_HOURS.map((h) => el("span", { text: String(h).padStart(2, "0") }))]);
    const body = rows.map((r) => {
      const who = el("span", { class: "who" });
      if (r.grid) { const g = swatch(0, ""); g.style.setProperty("--c", "#5b6875"); who.append(g, el("span", { text: "To the grid" })); }
      else who.append(swatch(r.member.code, ""), el("span", { text: r.own ? `Its own building${r.member.ref ? " · " + r.member.ref : ""}` : `${KIND[r.member.code].name}${r.member.ref ? " · " + r.member.ref : ""}` }));
      const cells = r.cells.map((v) => {
        const c = el("span", { class: "cell", text: v == null ? "–" : `${Math.round(100 * v)}%` });
        if (v == null) { c.style.setProperty("--bg", "#f6f3ee"); c.style.setProperty("--fg", "#5b6875"); }
        else {
          const a = (0.08 + 0.82 * Math.min(1, v)).toFixed(2), rgb = r.grid ? [91, 104, 117] : tint;
          c.style.setProperty("--bg", `rgba(${rgb.join(",")},${a})`);
          c.style.setProperty("--fg", v > 0.45 ? "#ffffff" : "#16202a");
        }
        return c;
      });
      return el("div", { class: "split-row" }, [who, ...cells]);
    });
    $("s-table").replaceChildren(head, ...body);
    const dayName = { weekday: "weekday", weekend: "weekend day", summer: "summer-holiday weekday" }[time.day];
    $("s-caption").textContent = `A typical ${dayName} in ${["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][d.month]}, ` +
      `for the roof of ${titleOf(roof)}${roof.ref ? ` (${roof.ref})` : ""}. Each column adds up to 100%. Preview: from step 5's use patterns and our roof estimates.`;
    setBars("s", m.alonePct, m.matchedPct);
    $("s-shared").textContent = kwh(m.sharedYear);
    $("s-grid").textContent = kwh(m.gridYear);
  }

  function downloadSplit() {
    const m = selected;
    if (!m) return;
    const roof = m.members[splitRoof];
    const lines = M.splitYear(m, splitRoof);
    const head = ["date", "hour_local", ...m.members.map((p, i) => (p.ref || `building_${i + 1}`) + (i === splitRoof ? "_roof_owner" : ""))];
    const csv = [head.join(","), ...lines.map((l) => [l.date, l.hour, ...l.shares.map((s) => s.toFixed(4))].join(","))].join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = el("a", { href: url, download: `matchsol_match${m.id}_${roof.ref || "roof" + (splitRoof + 1)}.csv` });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /* ---------- Money ---------- */
  function fillMoney() {
    const p = price, G = CFG.GRID_PRICE_EUR, SP = CFG.SURPLUS_PRICE_EUR;
    $("price").min = String(SP); $("price").max = String(G); $("price").value = String(p);
    $("price-out").textContent = `${p.toFixed(2)} €`;
    $("price-min").textContent = `${SP.toFixed(2)} € · what the grid pays for extra power`;
    $("price-max").textContent = `${G.toFixed(2)} € · what the grid charges`;
    const sell = p - SP, buy = G - p;
    $("sell-bar").style.width = `${(100 * sell) / (G - SP)}%`;
    $("buy-bar").style.width = `${(100 * buy) / (G - SP)}%`;
    const shared = totals ? totals.shared : 0;
    $("g-sell").textContent = `+${euro(shared * sell)}`;
    $("g-buy").textContent = euro(shared * buy);
    $("g-sell-note").textContent = `They get ${p.toFixed(2)} € instead of ${SP.toFixed(2)} € a kWh.`;
    $("g-buy-note").textContent = `They pay ${p.toFixed(2)} € instead of ${G.toFixed(2)} € a kWh.`;
    $("g-note").textContent = `All matches together, ${kwh(shared)} shared a year. Prices are the assumptions of our step 5.`;
    $("y-shared").textContent = kwh(shared);
    $("y-kept").textContent = euro(shared * (G - SP));
    const m = selected;
    if (!m) { $("y-rows").replaceChildren(); return; }
    $("y-dot").style.setProperty("--c", m.color);
    fillMatchSelect("y-match");
    $("y-rows").replaceChildren(...m.members.map((b, i) => {
      const paid = m.givenYear[i] * p, pays = m.gotYear[i] * p;
      const better = m.givenYear[i] * sell + m.gotYear[i] * buy;
      const name = el("td");
      name.append(swatch(b.code), `${titleOf(b)}${b.ref ? " · " + b.ref : ""}`);
      return el("tr", {}, [name, el("td", { text: kwh(m.givenYear[i]) }), el("td", { text: kwh(m.gotYear[i]) }),
        el("td", { text: euro(paid) }), el("td", { text: euro(pays) }), el("td", { class: better > 0 ? "up" : "", text: `+${euro(better)}` })]);
    }));
  }

  /* ---------- How it works ---------- */
  function fillStory() {
    $("p-metric").textContent = totals ? `${pct(totals.alonePct)} → ${pct(totals.matchedPct)}` : "–";
    const m = matches[0];
    for (const [id, dkey] of [["p-weekday", "weekday"], ["p-weekend", "weekend"]]) {
      if (!m) { $(id).replaceChildren(); continue; }
      const keep = time.day;
      time.day = dkey;
      drawChart($(id), dayArrays(m), null, 300, 110);
      time.day = keep;
    }
    // Step 3: use per 6-hour band, as the city's data gives it (homes vs. daytime services), on a June weekday
    const t0 = M.slot(5, false, 0), bandsH = [0, 0, 0, 0], bandsD = [0, 0, 0, 0];
    for (let h = 0; h < 24; h++) { bandsH[Math.floor(h / 6)] += shapes ? shapes.home[t0 + h] : 0; bandsD[Math.floor(h / 6)] += shapes ? shapes.office[t0 + h] : 0; }
    const norm = (a) => { const s = a.reduce((x, y) => x + y, 0) || 1; return a.map((v) => v / s); };
    const hN = norm(bandsH), dN = norm(bandsD), mx = Math.max(...hN, ...dN) || 1;
    const kids = [];
    hN.forEach((v, i) => {
      const x = 14 + i * 46;
      kids.push(svgEl("rect", { x, y: 86 - (v / mx) * 70, width: 16, height: (v / mx) * 70, fill: COL.HOME }));
      kids.push(svgEl("rect", { x: x + 18, y: 86 - (dN[i] / mx) * 70, width: 16, height: (dN[i] / mx) * 70, fill: COL.SCHOOL }));
      const t = svgEl("text", { x: x + 17, y: 100, "font-family": "IBM Plex Mono, monospace", "font-size": "10", fill: "#3d4651", "text-anchor": "middle" });
      t.textContent = ["0–6", "6–12", "12–18", "18–24"][i];
      kids.push(t);
    });
    kids.push(svgEl("line", { x1: 8, y1: 86, x2: 196, y2: 86, stroke: "#3d4651" }));
    $("p-bands").replaceChildren(...kids);
  }

  /* ---------- day and hour ---------- */
  function fillDayPills(id) {
    $(id).replaceChildren(...Object.entries(CFG.DAYS).map(([key, d]) => {
      const b = el("button", { type: "button", "aria-pressed": String(key === time.day), text: d.label });
      b.addEventListener("click", () => { time.day = key; onTime(); });
      return b;
    }));
  }

  function sunDate() {
    const [y, mo, d] = day().date;
    const offset = mo >= 3 && mo <= 9 ? 2 : 1;   // Barcelona: UTC+2 April-October, else UTC+1
    return new Date(Date.UTC(y, mo, d, time.hour - offset, 0));
  }

  function onTime() {
    fillDayPills("t-days");
    $("t-hour").value = String(time.hour);
    $("t-hour-out").textContent = hh(time.hour);
    if (view) view.environment.lighting.date = sunDate();
    drawFlows();
    if (tab === "matches") { if (current) fillMatch(current); else fillOverview(); fillLegend(); }
    if (tab === "split") fillSplit();
  }

  function buildTimebar() {
    fillDayPills("t-days");
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

  /* ---------- clicks and search ---------- */
  function buildingAt(lng, lat, nearby = 0) {
    if (!localArea) return -1;
    const [x, y] = localArea.proj.toXY(lng, lat);
    return S.findBuilding(localArea.buildings, localArea.index, x, y, nearby);
  }

  // A building of a match opens that match; anything else, while a match is open, goes back to all matches.
  function pickBuilding(k) {
    const p = k != null && k >= 0 ? plotOfK[k] : null;
    if (p && p.match) { if (p.match !== current) openMatch(p.match); return; }
    if (current) showOverview(false);
    setStatus("idle", p
      ? "This building is in no match: no building nearby uses power at the times it has extra, or the other way round."
      : "Click a coloured building inside the 9 blocks.");
  }

  async function onClick(event) {
    if (tab !== "matches") return;
    let pt = event.mapPoint, k = null;
    try {
      const layers = [potentialLayer, sceneLayer].filter(Boolean);
      const hit = await view.hitTest(event, layers.length ? { include: layers } : undefined);
      const g = hit.results.find((x) => x.graphic && x.graphic.layer === potentialLayer && x.graphic.attributes);
      if (g) k = g.graphic.attributes.k;
      const r = hit.results.find((x) => x.mapPoint);
      if (r) pt = r.mapPoint;
    } catch (_) { /* use the ground point */ }
    if (k == null && pt) k = buildingAt(pt.longitude, pt.latitude);
    pickBuilding(k);
  }

  async function geocode(text) {
    const q = /barcelona/i.test(text) ? text : `${text}, Barcelona`;
    const icgc = await getJson(`https://eines.icgc.cat/geocodificador/cerca?size=1&text=${encodeURIComponent(q)}`);
    const f = icgc && icgc.features && icgc.features[0];
    if (f) return { lng: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] };
    const osm = await getJson(`https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=es&q=${encodeURIComponent(q)}`);
    if (osm && osm[0]) return { lng: +osm[0].lon, lat: +osm[0].lat };
    return null;
  }

  async function onSearch(event) {
    event.preventDefault();
    const text = $("search-input").value.trim();
    if (!text) return;
    setTab("matches");
    setStatus("loading", `Looking up "${text}"…`);
    const hit = await geocode(text);
    if (!hit) { setStatus("error", `Could not find "${text}". Try "Carrer de Pau Claris 100".`); return; }
    if (!localArea || Math.hypot(...localArea.proj.toXY(hit.lng, hit.lat)) > localArea.cover + 30) {
      setStatus("idle", `"${text}" is outside our 9 blocks.`);
      return;
    }
    const k = buildingAt(hit.lng, hit.lat, 25);
    if (k < 0) { setStatus("idle", `No building found at "${text}".`); return; }
    pickBuilding(k);
  }

  /* ---------- tabs ---------- */
  function setTab(name) {
    tab = name;
    document.body.dataset.tab = name;
    document.querySelectorAll(".tabs [data-tab]").forEach((btn) => btn.setAttribute("aria-selected", String(btn.dataset.tab === name)));
    const onMap = name === "matches";
    $("panel").hidden = !onMap;
    $("legend").hidden = !onMap;
    $("timebar").hidden = !onMap;
    $("veil").hidden = onMap;
    $("split").hidden = name !== "split";
    $("money").hidden = name !== "money";
    $("story").hidden = name !== "method";
    labelLayer.visible = flowLayer.visible = onMap;
    if (view) view.padding = { top: 0, left: 0, bottom: 80, right: onMap ? PANEL_W : 0 };
    if (onMap) { drawFlows(); fillLegend(); }
    if (name === "split") fillSplit();
    if (name === "money") fillMoney();
    if (name === "method") fillStory();
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
    const dataReady = getRoofIndex().then(loadSunShapes);

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
      highlightOptions: { color: INK, haloOpacity: 1, fillOpacity: 0 },
    });
    map.addMany([labelLayer, flowLayer]);
    view.ui.move(["zoom", "navigation-toggle", "compass"], "bottom-left");
    addShadowTool();
    fitLayout();
    window.addEventListener("resize", fitLayout);

    document.querySelectorAll(".tabs [data-tab]").forEach((btn) => btn.addEventListener("click", () => setTab(btn.dataset.tab)));
    $("search").addEventListener("submit", (e) => onSearch(e).catch((err) => setStatus("error", err.message)));
    $("m-back").addEventListener("click", () => showOverview());
    $("m-to-split").addEventListener("click", () => setTab("split"));
    $("m-to-money").addEventListener("click", () => setTab("money"));
    $("s-match").addEventListener("change", (e) => { selected = matches.find((m) => String(m.id) === e.target.value) || selected; fillSplit(); });
    $("y-match").addEventListener("change", (e) => { selected = matches.find((m) => String(m.id) === e.target.value) || selected; fillMoney(); });
    $("price").addEventListener("input", (e) => { price = Number(e.target.value); fillMoney(); });
    $("s-download").addEventListener("click", downloadSplit);
    buildTimebar();
    setTab("matches");
    fillOverview();
    await dataReady;

    try {
      await view.when();
    } catch (err) {
      setStatus("error", "The 3D map could not start. This browser may not support WebGL2.");
      console.error(err);
      return;
    }
    view.on("click", (e) => onClick(e).catch((err) => console.warn(err)));
    sceneLayer = await addSceneLayer(map);
    try {
      await rateArea();
      await runMatching();
      buildPotentialLayer();
      cityFilter = await makeCityFilter();
      showCityModel();
    } catch (err) {
      areaError = err.message;
      setStatus("error", "Could not load the study area: " + err.message);
      console.error(err);
    }
    showOverview(false);
    setTab(tab);
    if (!sceneLayer) setStatus("error", "The city's 3D model did not load.");
    else if (!areaError) setStatus("idle", `${plural(matches.length, "match", "matches")} (preview). Click one, on the map or in the list.`);
  }

  main();
});
