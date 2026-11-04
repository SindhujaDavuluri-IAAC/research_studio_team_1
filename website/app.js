/* Roofscapes RePowered — solar co-investment communities in the Eixample (Breno's step 5c).
 * 3D model and building data: Ajuntament de Barcelona open services (geo.bcn.cat), shown with the ArcGIS Maps SDK.
 *
 * Only our 9 blocks are drawn by us, each building in the colour of its community, as on step 5c's map.
 * Every other building of the city stays the city's own (red) 3D model: we have no data there yet.
 *  - All communities: the host roof (where the panels go) in the full colour with a dark outline and its number
 *    above it; the guest buildings (they co-invest and get a share) in a pale version of it; the other buildings
 *    of the 9 blocks light grey; an arrow from each host roof to each of its guests.
 *  - Click a building: its community opens, every other building turns grey, and the panel shows the community's
 *    numbers (the table on step 5c's map), its members and the building you clicked.
 * How it works tab: the problem and the five steps. The time bar (month, hour) moves the real sun on the map.
 *
 * Where the communities come from (the first file found):
 *  1. data/communities.json: step 5c's full results (python -m step5.communities, then python -m web.communities).
 *  2. data/communities_map.json: the same communities read from step 5c's map (members from its colours, numbers
 *     from its table, addresses from Catastro).
 * Buildings are matched by cadastral reference: its first 5 characters are the block, the first 7 the plot.
 * The hourly version of the idea (MATCHSOL) is kept in ../website_matchsol, for later.
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
  const FILES = [   // the first one found is shown
    { url: CFG.COMMUNITIES_FILE || "data/communities.json", kind: "pipeline" },
    { url: CFG.COMMUNITIES_MAP_FILE || "data/communities_map.json", kind: "map" },
  ];
  const PANEL_W = 410;   // the side panel's width + margin, kept free when the map centres on something

  // Centre of our 9 blocks (Passeig de Gràcia to Bruc, Gran Via to Aragó). The camera looks north-west, like
  // step 5c's map: Passeig de Gràcia on the left, Gran Via at the front.
  const PLACES = { focus: { lat: 41.39241, lng: 2.16860 } };
  const START = { dist: 900, tilt: 50, heading: 315 };
  const ENVELOPE_M = 320;   // only if the city server refuses our query by block: what to load around the centre
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
  const INK = [22, 32, 42];
  const PANEL_LOW = [61, 79, 99], PANEL_MID = [242, 165, 22], PANEL_HIGH = [255, 224, 102];
  // One colour per community, as on step 5c's map (pipeline/step5/communities.py): the host roof in the full
  // colour, the guest buildings in a pale version of it, the rest of the 9 blocks light grey.
  const PALETTE = CFG.COMMUNITY_COLORS;
  const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const pale = (hex, t = CFG.GUEST_TINT) => "#" + hexRgb(hex).map((c) => Math.round(c + (255 - c) * t).toString(16).padStart(2, "0")).join("");
  const NOT_MEMBER = CFG.NOT_MEMBER_COLOR || "#dad8d2";   // all communities: a building of the 9 blocks in none
  const OUT_GREY = "#cfcbc5";                              // one community open: every building outside it
  const CITY_RED = "#d68c78";                              // legend: the city's own model (outside the 9 blocks)

  let view, sceneLayer;
  let tab = "communities";
  let area = null;          // the 9 blocks' buildings
  let areaError = null;     // why they could not be loaded, if they could not
  const blocks = new Set((CFG.BLOCKS || []).filter((b) => /^\d{5}$/.test(b)));
  let roofIndex = null;     // data/roofs/index.json
  let file = null;          // the communities file shown
  let source = null;        // "pipeline" | "map" | null
  let groups = [];
  let groupOf = {};         // building position -> { g, m, role: 2 host roof, 1 guest }
  let current = null;       // the open community, or null for all of them
  let picked = null;        // the building clicked: { k, g, m } (g and m when it is in a community)
  let potentialLayer = null; // the 9 blocks' buildings as coloured 3D volumes
  let cityFilter = null;    // hides the city's own model where our volumes stand
  let highlight = null;
  const roofFiles = {};     // refcat -> roof file (data/roofs/<refcat>.json)
  const time = { month: 5, hour: 13 };
  const absolute = { mode: "absolute-height" };
  const labelLayer = new GraphicsLayer({ elevationInfo: absolute, title: "Community numbers" });
  const panelLayer = new GraphicsLayer({ elevationInfo: absolute, title: "Panels" });
  const lineLayer = new GraphicsLayer({ elevationInfo: absolute, title: "Arrows from host roofs to guests" });

  /* ---------- small helpers ---------- */
  function setStatus(kind, text) {
    const el = $("status");
    el.dataset.kind = kind;
    el.textContent = text;
  }
  const ref14 = (v) => String(v || "").trim().slice(0, 14).toUpperCase();
  const plotOf = (ref) => ref14(ref).slice(0, 7);
  const blockOf = (ref) => ref14(ref).slice(0, 5);
  const cleanAddress = (a) => String(a || "").replace(/\s+\d{5}\s+BARCELONA.*$/i, "").replace(/\s+BARCELONA\s*\(BARCELONA\)\s*$/i, "")
    .replace(/,\s*Barcelona$/i, "").trim();
  const euro = (v) => (v == null ? null : `${fmt(v)} €`);
  const plural = (n, one, many) => `${fmt(n)} ${n === 1 ? one : many}`;
  const sentence = (f) => f.charAt(0).toUpperCase() + f.slice(1) + (/[.!]$/.test(f) ? "" : ".");

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

  // The city's own 3D model, red by height. It stays everywhere except our 9 blocks.
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

  // Camera looking at a place from `heading` (degrees), so the page opens right over it.
  function cameraOver(p, dist = START.dist, tilt = START.tilt, heading = START.heading) {
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

  /* ---------- the 9 blocks' buildings ---------- */
  async function query(params) {
    const body = new URLSearchParams({
      f: "json", where: "1=1", outFields: OUT_FIELDS, returnGeometry: "true",
      multipatchOption: "xyFootprint", inSR: "4326", outSR: "4326", ...params,
    });
    let res;
    try {
      res = await fetch(CFG.BUILDINGS_FEATURE_LAYER + "/query", { method: "POST", body });
    } catch (err) {
      const e = new Error("Could not reach the city's building data (geo.bcn.cat). Check the internet connection; if it keeps failing, the server may block requests from this address.");
      e.network = true;
      throw e;
    }
    if (!res.ok) throw new Error(`City building data answered ${res.status}.`);
    const json = await res.json();
    if (json.error) throw new Error("City building data: " + (json.error.message || "error") + ".");
    return json;
  }

  async function allPages(params) {
    const features = [];
    let offset = 0;
    for (let page = 0; page < 20; page++) {
      let j;
      try {
        j = await query({ ...params, resultOffset: String(offset), resultRecordCount: "2000", orderByFields: F.id });
      } catch (err) {
        if (page === 0 && !err.network && /pagina/i.test(err.message)) j = await query(params); // server without paging
        else throw err;
      }
      const got = j.features || [];
      features.push(...got);
      setStatus("loading", `Loading the 9 blocks' buildings from the city server… ${fmt(features.length)}`);
      if (!j.exceededTransferLimit || !got.length) break;
      offset += got.length;
    }
    return features;
  }

  // Every building part whose cadastral reference starts with one of our blocks (about 1,900 parts).
  // If the server refuses that query, everything around the centre (filtered by block afterwards).
  async function queryBlocks() {
    const where = [...blocks].map((b) => `${F.refcat} LIKE '${b}%'`).join(" OR ");
    try {
      return await allPages({ where });
    } catch (err) {
      if (err.network) throw err;
      console.warn("Query by block refused; loading the area around the centre instead.", err);
      const { lng, lat } = PLACES.focus;
      const dLat = ENVELOPE_M / 111320, dLng = ENVELOPE_M / (111320 * Math.cos((lat * Math.PI) / 180));
      const env = { xmin: lng - dLng, ymin: lat - dLat, xmax: lng + dLng, ymax: lat + dLat, spatialReference: SR };
      return allPages({ geometry: JSON.stringify(env), geometryType: "esriGeometryEnvelope", spatialRel: "esriSpatialRelIntersects" });
    }
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
          height: top, relHeight: rel, ref: ref14(a[F.refcat]),
        };
        b.plot = b.ref.slice(0, 7);
        b.bbox = S.bbox(b.xy);
        b.c = S.centroid(b.xy);
        b.footprint = S.footprintArea(b);
        if (b.footprint < 2) continue;
        b.floors = Math.max(1, Math.round(rel / CFG.FLOOR_HEIGHT_M));
        out.push(b);
      }
    }
    return out;
  }

  // Only the buildings of our blocks, indexed by plot (the first 7 characters of the cadastral reference).
  function makeArea(features, local) {
    const { lng, lat } = PLACES.focus;
    const proj = S.makeProjection(lat, lng);
    const buildings = toBuildings(features, proj).filter((b) => blocks.has(b.ref.slice(0, 5)));
    const byPlot = {};
    buildings.forEach((b, k) => { (byPlot[b.plot] = byPlot[b.plot] || []).push(k); });
    return { proj, buildings, byPlot, index: S.buildIndex(buildings), local };
  }

  // data/buildings.json (python -m web.buildings), or the same buildings from the city server.
  async function loadArea() {
    const j = await getJson(BUILDINGS_FILE);
    if (j && Array.isArray(j.buildings) && Array.isArray(j.fields)) {
      const n = j.fields.length;
      const features = j.buildings.map((row) => {
        const attributes = {};
        for (let i = 0; i < n; i++) attributes[j.fields[i]] = row[i];
        return { attributes, geometry: { rings: row[n] } };
      });
      const a = makeArea(features, true);
      if (a.buildings.length) return a;
    }
    setStatus("loading", "Loading the 9 blocks' buildings from the city server…");
    return makeArea(await queryBlocks(), false);
  }

  const plotKs = (ref) => (area ? area.byPlot[plotOf(ref)] || [] : []);
  function centreOf(ks) {
    if (!ks.length) return null;
    const bs = ks.map((k) => area.buildings[k]);
    const m2 = bs.reduce((t, b) => t + b.footprint, 0);
    return [bs.reduce((t, b) => t + b.c[0] * b.footprint, 0) / m2, bs.reduce((t, b) => t + b.c[1] * b.footprint, 0) / m2];
  }

  /* ---------- roofs run by the pipeline (data/roofs/) ---------- */
  async function getRoofIndex() {
    if (!roofIndex) roofIndex = (await getJson(ROOFS + "index.json")) || { roofs: [] };
    return roofIndex;
  }
  const roofEntry = (ref) => (roofIndex ? roofIndex.roofs.find((r) => ref14(r.refcat) === ref14(ref)) : null);
  async function roofFile(ref) {
    if (!(ref in roofFiles)) roofFiles[ref] = await getJson(`${ROOFS}${ref}.json`);
    return roofFiles[ref];
  }

  /* ---------- the communities ---------- */
  async function readCommunities() {
    for (const f of FILES) {
      const j = await getJson(f.url);
      if (j && Array.isArray(j.groups) && j.groups.length) {
        file = j;
        source = f.kind;
        break;
      }
    }
    if (!file) return;
    for (const b of file.blocks || []) if (/^\d{5}$/.test(b)) blocks.add(b);
    for (const g of file.groups) for (const m of g.members || []) if (/^\d{5}$/.test(blockOf(m.refcat))) blocks.add(blockOf(m.refcat));
  }

  // "CL ROGER DE LLURIA 29" (Catastro) -> "Roger de Llúria 29", "PS GRACIA 54" -> "Pg. de Gràcia 54", as on step 5c's map.
  const STREETS = {
    "GRACIA": "Pg. de Gràcia", "PASSEIG DE GRACIA": "Pg. de Gràcia", "DIPUTACIO": "Diputació", "ROGER DE LLURIA": "Roger de Llúria",
    "CONSELL DE CENT": "Consell de Cent", "BRUC": "Bruc", "GRAN VIA DE LES CORTS CATALANES": "Gran Via", "GRAN VIA CORTS CATALANES": "Gran Via",
    "CORTS CATALANES": "Gran Via", "ARAGO": "Aragó", "PAU CLARIS": "Pau Claris", "RAMBLA DE CATALUNYA": "Rambla de Catalunya",
    "GIRONA": "Girona", "VALENCIA": "València", "CASP": "Casp", "PERMANYER": "Ptge. Permanyer",
  };
  const SMALL_WORDS = new Set(["de", "del", "la", "les", "els", "i"]);
  function prettyAddress(address) {
    const a = cleanAddress(address);
    if (!a || /[a-zà-ú]/.test(a)) return a;   // already written like on the map
    const words = a.toUpperCase().split(/\s+/).filter(Boolean);
    if (/^(CL|C|CALLE|CARRER|PS|PG|AV|AVDA|GV|PZ|PL|TR|RB|PJ|RD)\.?$/.test(words[0])) words.shift();
    const i = words.findIndex((w) => /^\d/.test(w));
    const street = (i < 0 ? words : words.slice(0, i)).join(" ");
    const rest = i < 0 ? "" : " " + words.slice(i).join(" ").replace(/\(.*?\)/g, "").trim();
    const name = STREETS[street] || street.toLowerCase().split(" ")
      .map((w, j) => (j && SMALL_WORDS.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(" ");
    return name + rest;
  }
  const nameOf = (ref, address) => prettyAddress(address || (roofEntry(ref) || {}).address) || `Plot ${plotOf(ref)}`;

  // step 5c's flags (pipeline/step5/communities.py), when the file has none
  function flagsFor(kwp, otherBuildings) {
    const flags = [];
    if (kwp > 15) flags.push("Grid permits likely needed (over 15 kW).");
    if (kwp > 100) flags.push("Over 100 kW: no bill credit for surplus.");
    if (otherBuildings) flags.push("The host's owners must approve the other buildings' shares.");
    return flags;
  }

  // step 5c's member types (pipeline/step5/communities.py): "home", "office", "school", or several joined by "+"
  const KINDS = { home: "homes", office: "offices", school: "school or daytime use" };
  const aboutOf = (m) => m.about || [m.dwellings ? plural(m.dwellings, "home", "homes") : "",
    ...String(m.type || "").split("+").filter((t) => t && !(t === "home" && m.dwellings)).map((t) => KINDS[t] || t)].filter(Boolean).join(", ");

  // Either file -> the same shape. Distances: from the file, else between the plots' centres on the map.
  function readGroups() {
    return file.groups.map((g) => {
      const host = ref14(g.host);
      const hostKs = plotKs(host), hc = centreOf(hostKs);
      const members = (g.members || []).map((m) => {
        const ref = ref14(m.refcat), ks = plotKs(ref), c = centreOf(ks), isHost = m.role === "host" || plotOf(ref) === plotOf(host);
        return {
          ref, ks, role: isHost ? "host" : "guest",
          title: nameOf(ref, m.address || (isHost ? g.host_address : null)), also: m.also || "", about: aboutOf(m),
          flats: m.flats_joining, nonhome: m.nonhome_joining || "", share: m.beta_pct, kwh: m.kwh_per_year,
          distance: m.distance_m != null ? m.distance_m : isHost ? 0 : hc && c ? Math.hypot(c[0] - hc[0], c[1] - hc[1]) : null,
        };
      }).sort((a, b) => (a.role !== "host") - (b.role !== "host") || (a.distance || 0) - (b.distance || 0));
      const roof = roofEntry(host);
      const far = members.map((m) => m.distance || 0);
      return {
        id: g.id, host, hostKs, title: nameOf(host, g.host_address), exactHost: !!(roof && roof.yearly_kwh != null), block: g.block,
        panels: g.panels, kwp: g.kwp, kwh: g.yearly_kwh, kwhPerKwp: g.kwh_per_kwp, buildings: g.buildings != null ? g.buildings : members.length,
        flats: g.flats_joining || 0, nonhome: g.offices_schools_joining || 0, cost: g.cost_eur, spot: g.used_on_the_spot_pct,
        saving: g.saving_eur_per_year, payback: g.payback_years,
        farthest: g.farthest_member_m != null ? g.farthest_member_m : far.length ? Math.max(...far) : null,
        flags: Array.isArray(g.flags) && g.flags.length ? g.flags.map(sentence) : flagsFor(g.kwp, members.length > 1), members,
      };
    });
  }

  function makeGroups() {
    groups = file ? readGroups() : [];
    groupOf = {};
    for (const g of groups) {
      const c = PALETTE[(g.id - 1) % PALETTE.length];
      g.color = [c, pale(c)];
      for (const m of g.members) for (const k of m.ks) groupOf[k] = { g, m, role: m.role === "host" ? 2 : 1 };
      g.missing = g.members.filter((m) => !m.ks.length).length;
    }
  }

  /* ---------- the coloured buildings ---------- */
  // a host roof gets a dark outline, like on step 5c's map
  const volume = (hex, host) => ({
    type: "polygon-3d",
    symbolLayers: [{ type: "extrude", material: { color: hexRgb(hex) },
      edges: host ? { type: "solid", color: INK, size: 1.8 } : { type: "solid", color: [60, 40, 30, 0.35], size: 0.6 } }],
  });
  const closed = (ll) => [...ll, ll[0]];
  const SIZE = [{ type: "size", field: "h", valueUnit: "meters" }];

  function overviewRenderer() {
    const infos = [];
    for (const g of groups) {
      infos.push({ value: `${g.id}-2`, label: `Community ${g.id}: host roof`, symbol: volume(g.color[0], true) });
      infos.push({ value: `${g.id}-1`, label: `Community ${g.id}: guest building`, symbol: volume(g.color[1]) });
    }
    return {
      type: "unique-value", defaultSymbol: volume(NOT_MEMBER), defaultLabel: "Not in a community", uniqueValueInfos: infos,
      valueExpression: 'IIf($feature.grp > 0, Text($feature.grp) + "-" + Text($feature.role), "none")', visualVariables: SIZE,
    };
  }

  function groupRenderer(g) {
    return {
      type: "unique-value", defaultSymbol: volume(OUT_GREY), defaultLabel: "Not in this community",
      uniqueValueInfos: [
        { value: "2", label: "Host roof", symbol: volume(g.color[0], true) },
        { value: "1", label: "Guest building", symbol: volume(g.color[1]) },
      ],
      valueExpression: `IIf($feature.grp == ${Number(g.id)}, Text($feature.role), "out")`, visualVariables: SIZE,
    };
  }

  // The 9 blocks' buildings as whole 3D volumes, from the ground to the roof (object id = position + 1).
  function buildPotentialLayer() {
    if (potentialLayer) view.map.remove(potentialLayer);
    const graphics = area.buildings.map((b, k) => {
      const go = groupOf[k];
      return new Graphic({
        geometry: new Polygon({ rings: [closed(b.ll), ...(b.holesLL || []).map(closed)], spatialReference: SR }),
        attributes: { oid: k + 1, k, grp: go ? go.g.id : 0, role: go ? go.role : 0, h: Math.max(1, b.relHeight), base: b.height - b.relHeight },
      });
    });
    potentialLayer = new FeatureLayer({
      title: "Communities (9 blocks)", source: graphics, objectIdField: "oid", geometryType: "polygon", spatialReference: SR,
      fields: [{ name: "oid", type: "oid" }, { name: "k", type: "integer" }, { name: "grp", type: "integer" },
        { name: "role", type: "integer" }, { name: "h", type: "double" }, { name: "base", type: "double" }],
      outFields: ["*"], popupEnabled: false, visible: tab === "communities",
      elevationInfo: { mode: "absolute-height", featureExpressionInfo: { expression: "$feature.base" }, unit: "meters" },
      renderer: overviewRenderer(),
    });
    view.map.add(potentialLayer);
  }

  // Convex hull (monotone chain), clockwise, of [x, y] points.
  function hull(points) {
    const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower = [], upper = [];
    for (const q of p) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
      lower.push(q);
    }
    for (let i = p.length - 1; i >= 0; i--) {
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p[i]) <= 0) upper.pop();
      upper.push(p[i]);
    }
    return lower.slice(0, -1).concat(upper.slice(0, -1)).reverse();   // counter-clockwise -> clockwise
  }

  // Hide the city's model on our blocks only (one outline per block, 1.5 m wider), so the rest stays red.
  async function makeCityFilter() {
    if (!sceneLayer || !area || !area.buildings.length) return null;
    try {
      const byBlock = {};
      for (const b of area.buildings) (byBlock[b.plot.slice(0, 5)] = byBlock[b.plot.slice(0, 5)] || []).push(...b.xy);
      let polys = Object.values(byBlock).map((pts) => {
        const h = hull(pts);
        const cx = h.reduce((t, q) => t + q[0], 0) / h.length, cy = h.reduce((t, q) => t + q[1], 0) / h.length;
        const ring = h.map(([x, y]) => {
          const f = 1 + 1.5 / (Math.hypot(x - cx, y - cy) || 1);
          return area.proj.toLngLat(cx + (x - cx) * f, cy + (y - cy) * f);
        });
        return new Polygon({ rings: [closed(ring)], spatialReference: SR });
      });
      const sr = sceneLayer.spatialReference;
      if (sr && !sr.isWGS84) {
        await projection.load();
        polys = polys.map((p) => projection.project(p, sr));
      }
      return new SceneFilter({ geometries: polys, spatialRelationship: "disjoint" });
    } catch (err) {
      console.warn("Could not hide the city model on our blocks; it is hidden everywhere instead.", err);
      return null;
    }
  }

  function showCityModel(ours) {
    if (!sceneLayer) return;
    const on = ours && potentialLayer;
    sceneLayer.filter = on && cityFilter ? cityFilter : null;
    sceneLayer.visible = !(on && !cityFilter);
  }

  /* ---------- labels, arrows and panels on the map ---------- */
  function topOf(ks) {
    const bs = ks.map((k) => area.buildings[k]);
    const b = bs.reduce((p, q) => (q.footprint > p.footprint ? q : p));
    const [lng, lat] = area.proj.toLngLat(b.c[0], b.c[1]);
    return { lng, lat, z: Math.max(...bs.map((x) => x.height)), b };
  }

  function badge(at, text, color, size = 26) {
    return new Graphic({
      geometry: { type: "point", longitude: at.lng, latitude: at.lat, z: at.z + 8, spatialReference: SR },
      symbol: {
        type: "point-3d",
        symbolLayers: [
          { type: "icon", resource: { primitive: "circle" }, size, material: { color: [255, 255, 255] }, outline: { color: hexRgb(color), size: 2.5 } },
          { type: "text", text, size: 11, material: { color: INK }, font: { weight: "bold" } },
        ],
      },
    });
  }

  // All communities: the community's number above its host roof.
  function drawOverviewLabels() {
    labelLayer.removeAll();
    panelLayer.removeAll();
    if (!area) return;
    for (const g of groups) if (g.hostKs.length) labelLayer.add(badge(topOf(g.hostKs), String(g.id), g.color[0]));
  }

  // An arrow over the roofs from the host roof (where the panels are) to one guest building, in the community's colour.
  function arc(a, b, color) {
    const [ax, ay] = area.proj.toXY(a.lng, a.lat), [bx, by] = area.proj.toXY(b.lng, b.lat);
    const d = Math.hypot(bx - ax, by - ay), bump = 8 + 0.12 * d, pts = [];
    for (let i = 0; i <= 16; i++) {
      const f = i / 16;
      const [lng, lat] = area.proj.toLngLat(ax + (bx - ax) * f, ay + (by - ay) * f);
      pts.push([lng, lat, a.z + (b.z - a.z) * f + 2 + bump * 4 * f * (1 - f)]);
    }
    const rgb = hexRgb(color);
    return new Graphic({
      geometry: { type: "polyline", paths: [pts], hasZ: true, spatialReference: SR },
      symbol: { type: "line-3d", symbolLayers: [{ type: "line", size: 3, material: { color: rgb }, cap: "round", join: "round",
        marker: { type: "style", style: "arrow", placement: "end", color: rgb } }] },
    });
  }
  function drawLines() {
    lineLayer.removeAll();
    if (!area) return;
    for (const g of groups) {
      if ((current && current !== g) || !g.hostKs.length) continue;
      const host = topOf(g.hostKs);
      for (const m of g.members) if (m.role !== "host" && m.ks.length) lineLayer.add(arc(host, topOf(m.ks), g.color[0]));
    }
  }

  function mix(a, b, t) { return a.map((v, i) => Math.round(v + (b[i] - v) * t)); }
  function panelColor(f) {
    const t = Math.min(1, Math.max(0, (f - 0.5) / 0.5));
    return t < 0.6 ? mix(PANEL_LOW, PANEL_MID, t / 0.6) : mix(PANEL_MID, PANEL_HIGH, (t - 0.6) / 0.4);
  }
  const ringToZ = (ll, z) => [...ll.map(([lng, lat]) => [lng, lat, z]), [ll[0][0], ll[0][1], z]];

  // One community: a label on the host roof, and our pipeline's panels on it when step 4 ran for it.
  async function drawGroupMarks(g) {
    labelLayer.removeAll();
    panelLayer.removeAll();
    if (!area || !g.hostKs.length) return;
    const top = topOf(g.hostKs);
    labelLayer.add(new Graphic({
      geometry: { type: "point", longitude: top.lng, latitude: top.lat, z: top.z + 2, spatialReference: SR },
      symbol: {
        type: "point-3d",
        verticalOffset: { screenLength: 46, maxWorldLength: 120, minWorldLength: 10 },
        callout: { type: "line", size: 1.5, color: INK },
        symbolLayers: [{ type: "text", text: `${g.id} · panels here · ${fmt(g.kwp, 1)} kWp`, size: 11, font: { weight: "bold" },
          material: { color: [255, 255, 255] }, halo: { color: INK, size: 2 }, background: { color: [...INK, 0.9] } }],
      },
    }));
    if (!g.exactHost) return;
    const roof = await roofFile(g.host);
    if (current !== g || !roof || !roof.energy || !Array.isArray(roof.energy.panel_list)) return;
    panelLayer.addMany(roof.energy.panel_list.map((p) => new Graphic({
      geometry: { type: "polygon", hasZ: true, spatialReference: SR, rings: [ringToZ(p.ring, top.z + 0.3)] },
      symbol: { type: "polygon-3d", symbolLayers: [{ type: "extrude", size: 0.15, material: { color: panelColor(1 - p.loss) } }] },
    })));
  }

  // A dark outline around the building that was clicked (all the parts of its plot).
  function highlightPicked() {
    if (highlight) { highlight.remove(); highlight = null; }
    if (!picked || !potentialLayer) return;
    const oids = (area.byPlot[area.buildings[picked.k].plot] || [picked.k]).map((k) => k + 1);
    const want = picked;
    view.whenLayerView(potentialLayer).then((lv) => { if (picked === want) highlight = lv.highlight(oids); }).catch(() => {});
  }

  /* ---------- all communities / one community ---------- */
  function showOverview(fly = true) {
    current = null;
    if (potentialLayer) potentialLayer.renderer = overviewRenderer();
    drawOverviewLabels();
    drawLines();
    fillOverview();
    highlightPicked();
    $("overview").hidden = false;
    $("group").hidden = true;
    fillLegend();
    if (fly && view) view.goTo(cameraOver(PLACES.focus), { duration: 1000 }).catch(() => {});
  }

  function openGroup(g, fly = true) {
    current = g;
    if (potentialLayer) {
      potentialLayer.renderer = groupRenderer(g);
      const polys = g.members.flatMap((m) => m.ks).map((k) => new Polygon({ rings: [closed(area.buildings[k].ll)], spatialReference: SR }));
      if (fly && polys.length) view.goTo({ target: polys, heading: START.heading, tilt: 52 }, { duration: 1000 }).catch(() => {});
    }
    drawGroupMarks(g).catch((err) => console.warn(err));
    drawLines();
    fillGroup(g);
    highlightPicked();
    $("overview").hidden = true;
    $("group").hidden = false;
    $("panel").scrollTop = 0;
    fillLegend();
    setStatus("idle", `Community ${g.id}. Click another building, or go back to all communities.`);
  }

  const SOURCE_TAG = { pipeline: "Our pipeline · step 5c", map: "Step 5c's map" };
  const sourceTag = (id) => {
    $(id).textContent = SOURCE_TAG[source] || "";
    $(id).dataset.kind = source || "";
  };

  function fillOverview() {
    fillPicked("c-picked");
    if (!source) {
      $("c-source").textContent = "";
      $("c-table").replaceChildren();
      $("c-foot").replaceChildren("No communities yet. In pipeline/: ", el("code", { text: "python -m step5.communities" }), ", then ",
        el("code", { text: "python -m web.communities" }), ".");
      return;
    }
    sourceTag("c-source");
    const pctFlats = Math.round(100 * (file.participation != null ? file.participation : 0.4));
    const rules = `Fixed shares under RD 244/2019, members within ${fmt(file.max_distance_m || 500)} m of the host; ${pctFlats}% of flats assumed to join.`;
    if (source === "pipeline") {
      $("c-foot").textContent = `Planning estimate from our pipeline${file.made ? ` (exported ${file.made})` : ""}. Plots: Catastro. ` +
        `Roof yield: ICGC LiDAR + PVGIS. ${rules}`;
    } else {
      $("c-foot").replaceChildren(`Communities and numbers from step 5c's map (pipeline run 3 Nov 2026); each building matched to the ` +
        `city's plot outlines. Addresses: Catastro. ${rules} Each member's share comes with step 5c's full export (`,
      el("code", { text: "python -m web.communities" }), ").");
    }
    const head = el("div", { class: "c-row head" }, [el("span", { class: "name", text: "Community (host roof)" }),
      el("span", { text: "kWp" }), el("span", { text: "MWh/yr" }), el("span", { text: "Buildings" })]);
    const rows = groups.map((g) => {
      const ring = el("i", { class: "ring", text: String(g.id) });
      ring.style.setProperty("--c", g.color[0]);
      const sub = [`${plural(g.flats, "flat", "flats")}${g.nonhome ? ` + ${fmt(g.nonhome)} office/school` : ""}`,
        g.kwhPerKwp ? `${fmt(g.kwhPerKwp)} kWh per kWp` : "", g.payback != null ? `payback ${fmt(g.payback, 1)} yrs` : ""].filter(Boolean).join(" · ");
      const btn = el("button", { type: "button", class: "c-row" }, [ring, el("span", { class: "name" }, [g.title, el("small", { text: sub })]),
        el("span", { text: fmt(g.kwp, 1) }), el("span", { text: fmt(g.kwh / 1000, 1) }), el("span", { text: fmt(g.buildings) })]);
      btn.addEventListener("click", () => { picked = null; openGroup(g); });
      return btn;
    });
    const t = file.totals || {};
    const sum = (k) => groups.reduce((s, g) => s + (g[k] || 0), 0);
    const total = el("div", { class: "c-row total" }, [el("span", { class: "name", text: "Total" }),
      el("span", { text: fmt(t.kwp != null ? t.kwp : sum("kwp"), 1) }), el("span", { text: fmt((t.yearly_kwh != null ? t.yearly_kwh : sum("kwh")) / 1000, 1) }),
      el("span", { text: fmt(t.buildings != null ? t.buildings : sum("buildings")) })]);
    $("c-table").replaceChildren(head, ...rows, total);
  }

  // The tiles of one community: the numbers of the table on step 5c's map, plus the pipeline's when it is there.
  function setTile(id, text) {
    $(id).textContent = text == null ? "–" : text;
    $(id).parentElement.hidden = text == null;
  }

  function fillGroup(g) {
    $("gv-dot").style.setProperty("--c", g.color[0]);
    $("gv-eyebrow").textContent = `Community ${g.id}${g.block ? ` · block ${g.block}` : ""}`;
    $("group-title").textContent = g.title;
    sourceTag("gv-source");
    fillPicked("gv-picked");
    $("gv-energy").textContent = fmt(g.kwh / 1000, 1);
    $("gv-note").textContent = `from ${fmt(g.kwp, 1)} kWp of panels on the host roof, shared by ${plural(g.flats, "flat", "flats")}` +
      `${g.nonhome ? ` and ${plural(g.nonhome, "office or school", "offices and schools")}` : ""} in ${plural(g.buildings, "building", "buildings")}` +
      `${g.farthest ? `, the farthest about ${fmt(Math.round(g.farthest / 10) * 10)} m away` : ""}.`;
    setTile("gv-kwp", `${fmt(g.kwp, 1)} kWp`);
    setTile("gv-yield", g.kwhPerKwp ? fmt(g.kwhPerKwp) : null);
    setTile("gv-buildings", fmt(g.buildings));
    setTile("gv-members", `${fmt(g.flats)} + ${fmt(g.nonhome)}`);
    setTile("gv-payback", g.payback != null ? `${fmt(g.payback, 1)} years` : null);
    setTile("gv-panels", g.panels != null ? fmt(g.panels) : null);
    setTile("gv-cost", euro(g.cost));
    setTile("gv-saving", g.saving != null ? `${fmt(g.saving)} € a year` : null);
    setTile("gv-spot", g.spot != null ? `${fmt(g.spot)}%` : null);
    $("gv-flags").replaceChildren(...g.flags.map((f) => el("li", { text: f })));
    const pickedPlot = picked ? area.buildings[picked.k].plot : null;
    $("gv-list").replaceChildren(...g.members.map((m) => {
      const li = el("li", { class: m.ks.length && plotOf(m.ref) === pickedPlot ? "picked" : null }, [
        el("span", { class: m.role === "host" ? "role host" : "role", text: m.role === "host" ? "Host" : "Guest" }),
        el("span", { class: "who" }, [m.title + (m.also ? ` (${m.also})` : ""), el("small", {
          text: [m.about, m.role === "host" ? "the panels are here" : m.distance != null ? `${fmt(Math.round(m.distance / 10) * 10)} m from the host` : "",
            m.flats ? `${plural(m.flats, "flat joins", "flats join")}` : "", m.ks.length ? "" : "not on the map"].filter(Boolean).join(" · "),
        })]),
        el("span", { class: "share", text: m.share != null ? `${fmt(m.share, 1)}%` : "" }),
      ]);
      if (m.ks.length) {
        li.tabIndex = 0;
        li.title = "Show it on the map";
        const go = () => { picked = { k: m.ks[0], g, m }; fillGroup(g); highlightPicked(); };
        li.addEventListener("click", go);
        li.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
      }
      return li;
    }));
    $("gv-explain").textContent = "Host roof (full colour, dark outline): where the panels are installed" +
      (g.exactHost ? ", with the panels our pipeline placed on it" : "") + ". Guest buildings (pale): they co-invest and receive a " +
      "fixed share of the output" + (g.members.some((m) => m.share != null) ? " (Share: each member's part of the output and of the cost)" : "") +
      ". Everything else in the 9 blocks is grey; the rest of the city keeps the city's own red model.";
  }

  // The building that was clicked, at the top of the panel.
  function describe(k) {
    const b = area.buildings[k];
    const parts = (area.byPlot[b.plot] || [k]).map((i) => area.buildings[i]);
    const top = Math.max(...parts.map((p) => p.relHeight));
    const use = String(parts.reduce((p, q) => (q.footprint * q.floors > p.footprint * p.floors ? q : p)).attrs[F.use] || "");
    const kind = /resid/i.test(use) ? "homes" : /educa/i.test(use) ? "school" : /alojamiento/i.test(use) ? "hotel"
      : /financ|profesional|oficin/i.test(use) ? "offices" : /administraci/i.test(use) ? "public services"
        : /comercio/i.test(use) ? "shops" : use.toLowerCase();
    return { plot: b.plot, kind, floors: Math.max(1, Math.round(top / CFG.FLOOR_HEIGHT_M)) };
  }

  function fillPicked(id) {
    const box = $(id);
    if (!picked || !area) { box.hidden = true; box.replaceChildren(); return; }
    const d = describe(picked.k), m = picked.m, g = picked.g;
    const lines = [];
    if (m) {
      lines.push(el("p", { class: "picked-role" }, [el("i", { class: m.role === "host" ? "sw host" : "sw", style: `--c:${m.role === "host" ? g.color[0] : g.color[1]}` }),
        m.role === "host" ? `Host roof of community ${g.id}` : `Guest of community ${g.id}`]));
      lines.push(el("p", { class: "picked-title", text: m.title + (m.also ? ` (${m.also})` : "") }));
      lines.push(el("p", { class: "note", text: [m.about, m.role === "host" ? "the panels are installed on this roof"
        : `${m.distance != null ? `about ${fmt(Math.round(m.distance / 10) * 10)} m from the host roof, ` : ""}co-invests and receives a share`,
      m.share != null ? `share ${fmt(m.share, 1)}%` : ""].filter(Boolean).join(" · ") }));
    } else {
      lines.push(el("p", { class: "picked-role" }, [el("i", { class: "sw", style: `--c:${NOT_MEMBER}` }), "Not in a community"]));
      lines.push(el("p", { class: "picked-title", text: `Plot ${d.plot}` }));
      lines.push(el("p", { class: "note", text: `${d.kind ? `${d.kind} · ` : ""}about ${plural(d.floors, "floor", "floors")} · its roof is not one of the ` +
        `${groups.length} host roofs, and no community took it as a guest (each one takes the closest flats, offices and schools until ` +
        "their use matches what its roof makes)." }));
    }
    box.replaceChildren(...lines);
    box.hidden = false;
  }

  function fillLegend() {
    if (tab !== "communities") return;
    const c = current ? current.color : groups[0] ? groups[0].color : [PALETTE[0], pale(PALETTE[0])];
    $("legend").innerHTML = `<p class="title">How to read the map</p>` +
      `<p class="row"><i class="host" style="--c:${c[0]}"></i>Host roof: where the panels are installed</p>` +
      `<p class="row"><i style="--c:${c[1]}"></i>Guest building: co-invests and receives a share</p>` +
      `<p class="row"><i class="line" style="--c:${c[0]}"></i>Arrow from the host roof to each guest</p>` +
      `<p class="row"><i style="--c:${current ? OUT_GREY : NOT_MEMBER}"></i>${current ? "Not in this community" : "In the 9 blocks, not in a community"}</p>` +
      `<p class="row"><i style="--c:${CITY_RED}"></i>Rest of the city: no data yet</p>` +
      `<p class="hint">${current ? "Click another building, or go back to all communities." : "Each colour is one community. Click a building to see its community."}</p>`;
  }

  /* ---------- clicks and search ---------- */
  function buildingAt(lng, lat, nearby = 0) {
    if (!area) return -1;
    const [x, y] = area.proj.toXY(lng, lat);
    return S.findBuilding(area.buildings, area.index, x, y, nearby);
  }

  // A building of a community opens it; another building of the 9 blocks shows what it is.
  function pickBuilding(k, fly = true) {
    if (k == null || k < 0) {
      picked = null;
      if (current) showOverview(false); else { fillPicked("c-picked"); highlightPicked(); }
      setStatus("idle", "Outside our 9 blocks: we only have data for the 9 blocks for now. Click a building in colour or grey.");
      return;
    }
    const go = groupOf[k];
    picked = { k, g: go ? go.g : null, m: go ? go.m : null };
    if (go) {
      if (go.g !== current) openGroup(go.g, fly);
      else { fillGroup(go.g); highlightPicked(); $("panel").scrollTop = 0; }
      return;
    }
    if (current) showOverview(false);
    else { fillPicked("c-picked"); highlightPicked(); }
    $("panel").scrollTop = 0;
    setStatus("idle", "This building is in none of the communities.");
  }

  async function onClick(event) {
    if (tab !== "communities") return;
    let pt = event.mapPoint, k = null, city = false;
    try {
      const layers = [potentialLayer, sceneLayer].filter(Boolean);
      const hit = await view.hitTest(event, layers.length ? { include: layers } : undefined);
      const first = hit.results.find((x) => x.graphic);
      if (first && first.graphic.layer === potentialLayer && first.graphic.attributes) k = first.graphic.attributes.k;
      else if (first && first.graphic.layer === sceneLayer) city = true;
      const r = hit.results.find((x) => x.mapPoint);
      if (r) pt = r.mapPoint;
    } catch (_) { /* use the ground point */ }
    if (k == null && !city && pt) k = buildingAt(pt.longitude, pt.latitude);
    pickBuilding(k == null ? -1 : k, false);
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
    setTab("communities");
    setStatus("loading", `Looking up "${text}"…`);
    const hit = await geocode(text);
    if (!hit) { setStatus("error", `Could not find "${text}". Try "Carrer de Pau Claris 100".`); return; }
    const k = buildingAt(hit.lng, hit.lat, 25);
    if (k < 0) { setStatus("idle", `"${text}" is outside our 9 blocks.`); return; }
    pickBuilding(k);
    if (!groupOf[k]) {
      const b = area.buildings[k];
      view.goTo({ target: new Polygon({ rings: [closed(b.ll)], spatialReference: SR }), zoom: 18, heading: START.heading, tilt: 52 }, { duration: 1000 }).catch(() => {});
    }
  }

  /* ---------- tabs ---------- */
  function setTab(name) {
    tab = name;
    document.body.dataset.tab = name;
    document.querySelectorAll(".tabs [data-tab]").forEach((btn) => btn.setAttribute("aria-selected", String(btn.dataset.tab === name)));
    const method = name === "method";
    $("panel").hidden = method;
    $("story").hidden = !method;
    $("veil").hidden = !method;
    $("legend").hidden = method;
    if (potentialLayer) potentialLayer.visible = !method;
    labelLayer.visible = panelLayer.visible = lineLayer.visible = !method;
    showCityModel(!method);
    if (view) view.padding = { top: 0, left: 0, bottom: 80, right: method ? 0 : PANEL_W };
    fillLegend();
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
    // read our files right away, while the 3D map loads
    const dataReady = Promise.all([getRoofIndex(), readCommunities()]);

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
      highlightOptions: { color: INK, haloOpacity: 1, fillOpacity: 0.15 },
    });
    map.addMany([labelLayer, panelLayer, lineLayer]);
    view.ui.move(["zoom", "navigation-toggle", "compass"], "bottom-left");
    addShadowTool();
    fitLayout();
    window.addEventListener("resize", fitLayout);

    document.querySelectorAll(".tabs [data-tab]").forEach((btn) => btn.addEventListener("click", () => setTab(btn.dataset.tab)));
    $("search").addEventListener("submit", (e) => onSearch(e).catch((err) => setStatus("error", err.message)));
    $("gv-back").addEventListener("click", () => { picked = null; showOverview(); });
    buildTimebar();
    setTab("communities");
    await dataReady;
    makeGroups();          // the list shows before the map is ready
    fillOverview();
    fillLegend();

    try {
      await view.when();
    } catch (err) {
      setStatus("error", "The 3D map could not start. This browser may not support WebGL2.");
      console.error(err);
      return;
    }
    view.on("click", (e) => onClick(e).catch((err) => console.warn(err)));
    const [layer] = await Promise.all([addSceneLayer(map), loadArea().then((a) => { area = a; }).catch((err) => {
      areaError = err.message;
      console.error(err);
    })]);
    sceneLayer = layer;
    makeGroups();
    if (area && area.buildings.length) {
      buildPotentialLayer();
      cityFilter = await makeCityFilter();
    }
    showOverview(false);
    setTab(tab);
    const missing = groups.reduce((t, g) => t + g.missing, 0);
    if (!sceneLayer) setStatus("error", "The city's 3D model did not load.");
    else if (areaError) setStatus("error", `The communities are listed, but the map could not load the 9 blocks: ${areaError}`);
    else if (!source) setStatus("idle", "No communities file found.");
    else setStatus("idle", `${plural(groups.length, "community", "communities")} from ${source === "map" ? "step 5c's map" : "step 5c"}` +
      `${missing ? ` (${plural(missing, "member", "members")} not found on the city model)` : ""}. Click a building, or a community in the list.`);
  }

  main();
});
