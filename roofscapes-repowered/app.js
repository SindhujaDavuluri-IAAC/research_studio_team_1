/* Roofscapes RePowered — the map and the screen.
 * Buildings: OpenStreetMap (Overpass API), drawn in 3D with CesiumJS.
 * Sun and shade: our own calculation in solar.js.
 */
(function () {
  "use strict";
  const CFG = window.APP_CONFIG;
  const S = window.Solar;
  const $ = (id) => document.getElementById(id);
  const fmt = (n, d = 0) => Number(n).toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d });

  const PLACES = {
    eixample: { lat: 41.3917, lng: 2.1649 },
    gracia: { lat: 41.4025, lng: 2.1567 },
    poblenou: { lat: 41.3995, lng: 2.1985 },
  };
  const OVERPASS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  ];

  const COL = {
    bld: Cesium.Color.fromCssColorString("#d9d4cb"),
    bldEst: Cesium.Color.fromCssColorString("#a59d90"),
    sel: Cesium.Color.fromCssColorString("#e8930c"),
    gotPart: Cesium.Color.fromCssColorString("#cde8c2"),
    gotFull: Cesium.Color.fromCssColorString("#2f7d3a"),
    panelLow: Cesium.Color.fromCssColorString("#3d4f63"),
    panelMid: Cesium.Color.fromCssColorString("#f2a516"),
    panelHigh: Cesium.Color.fromCssColorString("#ffe066"),
  };

  let viewer;
  let area = null;        // { proj, buildings, index, sun, prim }
  let panelPrim = null;
  let ringEntity = null;
  let colored = new Set(); // buildings whose colour was changed
  let sel = null;          // { k, slots, roofArea }

  /* ---------- status ---------- */
  function setStatus(kind, text) {
    const el = $("status");
    el.dataset.kind = kind;
    el.textContent = text;
  }
  const nextFrame = () => new Promise((r) => setTimeout(r, 30));

  /* ---------- viewer ---------- */
  function makeViewer() {
    let baseLayer;
    if (CFG.CESIUM_ION_TOKEN) {
      Cesium.Ion.defaultAccessToken = CFG.CESIUM_ION_TOKEN;
      baseLayer = Cesium.ImageryLayer.fromProviderAsync(Cesium.IonImageryProvider.fromAssetId(2));
    } else {
      baseLayer = new Cesium.ImageryLayer(new Cesium.OpenStreetMapImageryProvider({ url: "https://tile.openstreetmap.org/" }));
    }
    viewer = new Cesium.Viewer("map", {
      baseLayer,
      baseLayerPicker: false, geocoder: false, homeButton: false, sceneModePicker: false,
      navigationHelpButton: false, animation: false, timeline: false, fullscreenButton: false,
      infoBox: false, selectionIndicator: false,
      shadows: true,
      terrainShadows: Cesium.ShadowMode.RECEIVE_ONLY,
    });
    viewer.scene.globe.depthTestAgainstTerrain = true;
    viewer.scene.globe.enableLighting = true;
    viewer.shadowMap.softShadows = true;
    viewer.shadowMap.size = 2048;
    viewer.shadowMap.maximumDistance = 2000;
    viewer.clock.shouldAnimate = false;
    viewer.scene.screenSpaceCameraController.minimumZoomDistance = 30;

    const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    handler.setInputAction((e) => {
      const picked = viewer.scene.pick(e.position);
      if (Cesium.defined(picked) && typeof picked.id === "string" && picked.id[0] === "b") {
        selectBuilding(Number(picked.id.slice(1)));
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  function lookAt(lat, lng, range, duration = 1.5, pitchDeg = -40) {
    viewer.camera.flyToBoundingSphere(new Cesium.BoundingSphere(Cesium.Cartesian3.fromDegrees(lng, lat, 0), 1), {
      offset: new Cesium.HeadingPitchRange(Cesium.Math.toRadians(20), Cesium.Math.toRadians(pitchDeg), range),
      duration,
    });
  }

  function viewCenter() {
    const c = viewer.scene.canvas;
    const hit = viewer.camera.pickEllipsoid(new Cesium.Cartesian2(c.clientWidth / 2, c.clientHeight / 2));
    if (!hit) return null;
    const carto = Cesium.Cartographic.fromCartesian(hit);
    return { lat: Cesium.Math.toDegrees(carto.latitude), lng: Cesium.Math.toDegrees(carto.longitude) };
  }

  /* ---------- time of day (visual shadows) ---------- */
  function updateClock() {
    const m = Number($("day-select").value);
    const hour = Number($("hour-range").value);
    const tz = m >= 3 && m <= 9 ? 2 : 1; // Barcelona: CEST in summer, CET in winter
    const hh = Math.floor(hour), mm = Math.round((hour - hh) * 60);
    viewer.clock.currentTime = Cesium.JulianDate.fromDate(new Date(Date.UTC(2026, m, 21, hh - tz, mm)));
    $("hour-out").textContent = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  }

  /* ---------- OpenStreetMap buildings ---------- */
  async function fetchOverpass(lat, lng, radius) {
    const dLat = radius / 111320, dLng = radius / (111320 * Math.cos((lat * Math.PI) / 180));
    const bb = `${(lat - dLat).toFixed(6)},${(lng - dLng).toFixed(6)},${(lat + dLat).toFixed(6)},${(lng + dLng).toFixed(6)}`;
    const q = `[out:json][timeout:60];(way["building"](${bb});relation["building"]["type"="multipolygon"](${bb}););out geom;`;
    let lastErr;
    for (const url of OVERPASS) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: "data=" + encodeURIComponent(q),
        });
        if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
        return await res.json();
      } catch (err) {
        lastErr = err;
      }
    }
    throw new Error("Could not download buildings from OpenStreetMap (" + (lastErr && lastErr.message) + "). Try again in a minute.");
  }

  function stitchOuter(members) {
    const same = (a, b) => Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
    const segs = members
      .filter((m) => m.type === "way" && m.role !== "inner" && m.geometry)
      .map((m) => m.geometry.map((g) => [g.lon, g.lat]));
    if (!segs.length) return null;
    let ring = segs.shift();
    let guard = 0;
    while (!same(ring[0], ring[ring.length - 1]) && segs.length && guard++ < 500) {
      const end = ring[ring.length - 1];
      const k = segs.findIndex((s) => same(s[0], end) || same(s[s.length - 1], end));
      if (k < 0) break;
      let s = segs.splice(k, 1)[0];
      if (!same(s[0], end)) s = s.slice().reverse();
      ring = ring.concat(s.slice(1));
    }
    return same(ring[0], ring[ring.length - 1]) ? ring : null;
  }

  function parseHeight(tags) {
    const h = parseFloat(String(tags.height || "").replace(",", "."));
    if (h > 2 && h < 300) return { height: h, source: "OSM height" };
    const lv = parseFloat(tags["building:levels"]);
    if (lv >= 1 && lv < 100) return { height: lv * CFG.FLOOR_HEIGHT_M, source: `OSM, ${lv} floors` };
    return { height: CFG.DEFAULT_HEIGHT_M, source: "estimated" };
  }

  function parseBuildings(json, proj) {
    const out = [];
    const seen = new Set();
    for (const el of json.elements || []) {
      const tags = el.tags || {};
      if (!tags.building || tags.building === "roof" || tags.building === "no") continue;
      let ring = null;
      if (el.type === "way" && el.geometry) ring = el.geometry.map((g) => [g.lon, g.lat]);
      else if (el.type === "relation" && el.members) ring = stitchOuter(el.members);
      if (!ring) continue;
      ring = S.cleanRing(ring);
      if (!ring) continue;
      const key = ring.map((p) => p[0].toFixed(6) + p[1].toFixed(6)).sort().join("");
      if (seen.has(key)) continue;
      seen.add(key);
      const xy = ring.map(([lng, lat]) => proj.toXY(lng, lat));
      const footprint = S.polygonArea(xy);
      if (footprint < 8) continue;
      const { height, source } = parseHeight(tags);
      const b = { osm: `${el.type}/${el.id}`, ll: ring, xy, height, source, tags, footprint };
      b.bbox = S.bbox(xy);
      b.c = S.centroid(xy);
      b.demand = S.buildingDemand(b, CFG);
      out.push(b);
    }
    return out;
  }

  async function loadArea(center) {
    const btn = $("load-btn");
    btn.disabled = true;
    setStatus("loading", "Downloading buildings from OpenStreetMap…");
    try {
      const json = await fetchOverpass(center.lat, center.lng, CFG.LOAD_RADIUS_M);
      const proj = S.makeProjection(center.lat, center.lng);
      const buildings = parseBuildings(json, proj);
      if (!buildings.length) throw new Error("No buildings found here. Move the map over the city and try again.");
      clearSelection();
      if (area && area.prim) viewer.scene.primitives.remove(area.prim);
      area = {
        center, proj, buildings,
        index: S.buildIndex(buildings),
        sun: S.sunSamples(center.lat, center.lng),
        prim: drawBuildings(buildings),
      };
      const real = buildings.filter((b) => b.source !== "estimated").length;
      setStatus("idle", `${fmt(buildings.length)} buildings loaded (${Math.round((100 * real) / buildings.length)}% with real height data). Click a roof.`);
    } catch (err) {
      setStatus("error", err.message);
      console.error(err);
    } finally {
      btn.disabled = false;
    }
  }

  function baseColor(b) {
    return b.source === "estimated" ? COL.bldEst : COL.bld;
  }

  function drawBuildings(buildings) {
    const instances = [];
    buildings.forEach((b, i) => {
      instances.push(new Cesium.GeometryInstance({
        geometry: new Cesium.PolygonGeometry({
          polygonHierarchy: new Cesium.PolygonHierarchy(Cesium.Cartesian3.fromDegreesArray(b.ll.flat())),
          height: 0,
          extrudedHeight: b.height,
          vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
        }),
        id: "b" + i,
        attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(baseColor(b)) },
      }));
    });
    return viewer.scene.primitives.add(new Cesium.Primitive({
      geometryInstances: instances,
      appearance: new Cesium.PerInstanceColorAppearance({ translucent: false, closed: true }),
      shadows: Cesium.ShadowMode.ENABLED,
    }));
  }

  function whenReady(prim, fn) {
    if (prim.ready) return fn();
    const remove = viewer.scene.postRender.addEventListener(() => {
      if (prim.ready) { remove(); fn(); }
    });
  }

  function setBuildingColor(i, color) {
    const attr = area.prim.getGeometryInstanceAttributes("b" + i);
    if (attr) attr.color = Cesium.ColorGeometryInstanceAttribute.toValue(color, attr.color);
  }

  /* ---------- selection ---------- */
  function clearSelection() {
    if (panelPrim) { viewer.scene.primitives.remove(panelPrim); panelPrim = null; }
    if (ringEntity) { viewer.entities.remove(ringEntity); ringEntity = null; }
    if (area && area.prim && area.prim.ready) colored.forEach((i) => setBuildingColor(i, baseColor(area.buildings[i])));
    colored = new Set();
    sel = null;
    $("report").hidden = true;
  }

  async function selectBuilding(k) {
    if (!area) return;
    clearSelection();
    const b = area.buildings[k];
    setStatus("loading", "Calculating sun and shade on the roof…");
    await nextFrame();
    const t0 = performance.now();
    const res = S.analyzeRoof(area.buildings, area.index, k, area.sun, CFG);
    sel = { k, ...res };
    drawPanels();
    drawRing(b);
    updateResults();
    $("report").hidden = false;
    const [lng, lat] = area.proj.toLngLat(b.c[0], b.c[1]);
    lookAt(lat, lng, Math.max(160, Math.sqrt(b.footprint) * 6), 1.2, -50);
    setStatus("idle", res.slots.length
      ? `Roof calculated in ${fmt((performance.now() - t0) / 1000, 1)} s. Move the time bar to see the shadows.`
      : "No panel fits on this roof after the edge setback. Try a bigger roof.");
  }

  function drawRing(b) {
    const pts = [];
    for (let a = 0; a <= 360; a += 3) {
      const r = CFG.SHARE_RADIUS_M, t = (a * Math.PI) / 180;
      const [lng, lat] = area.proj.toLngLat(b.c[0] + r * Math.sin(t), b.c[1] + r * Math.cos(t));
      pts.push(lng, lat, 2);
    }
    ringEntity = viewer.entities.add({
      polyline: {
        positions: Cesium.Cartesian3.fromDegreesArrayHeights(pts),
        width: 3,
        material: new Cesium.PolylineDashMaterialProperty({ color: COL.sel }),
      },
    });
  }

  function panelColor(f) {
    const t = Math.min(1, Math.max(0, (f - 0.5) / 0.5));
    return t < 0.6
      ? Cesium.Color.lerp(COL.panelLow, COL.panelMid, t / 0.6, new Cesium.Color())
      : Cesium.Color.lerp(COL.panelMid, COL.panelHigh, (t - 0.6) / 0.4, new Cesium.Color());
  }

  function drawPanels() {
    if (!sel.slots.length) return;
    const b = area.buildings[sel.k];
    const instances = sel.slots.map((s, j) => new Cesium.GeometryInstance({
      geometry: new Cesium.PolygonGeometry({
        polygonHierarchy: new Cesium.PolygonHierarchy(
          Cesium.Cartesian3.fromDegreesArray(s.corners.flatMap(([x, y]) => area.proj.toLngLat(x, y)))),
        height: b.height + 0.25,
        extrudedHeight: b.height + 0.4,
        vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
      }),
      id: "p" + j,
      attributes: {
        color: Cesium.ColorGeometryInstanceAttribute.fromColor(panelColor(s.sunFactor)),
        show: new Cesium.ShowGeometryInstanceAttribute(true),
      },
    }));
    panelPrim = viewer.scene.primitives.add(new Cesium.Primitive({
      geometryInstances: instances,
      appearance: new Cesium.PerInstanceColorAppearance({ translucent: false, closed: true }),
      shadows: Cesium.ShadowMode.DISABLED,
    }));
  }

  /* ---------- numbers + colours ---------- */
  function updateResults() {
    if (!sel) return;
    const min = Number($("sun-range").value) / 100;
    $("sun-out").textContent = `${Math.round(min * 100)}%`;
    const b = area.buildings[sel.k];
    const kept = sel.slots.filter((s) => s.sunFactor >= min);

    const prim = panelPrim;
    if (prim) whenReady(prim, () => {
      if (prim !== panelPrim) return;
      sel.slots.forEach((s, j) => {
        const a = prim.getGeometryInstanceAttributes("p" + j);
        if (a) a.show = Cesium.ShowGeometryInstanceAttribute.toValue(s.sunFactor >= min, a.show);
      });
    });

    const of = CFG.OBSTACLE_FACTOR;
    const panelArea = CFG.PANEL_LENGTH_M * CFG.PANEL_WIDTH_M;
    const energy = kept.reduce((sum, s) => sum + S.panelYearKwh(s, CFG), 0) * of;
    const panels = Math.round(kept.length * of);
    const kwp = panels * panelArea * CFG.PANEL_EFFICIENCY; // 1 kW of sun per m² at test conditions
    const avgSun = kept.length ? kept.reduce((s, x) => s + x.sunFactor, 0) / kept.length : 0;

    $("r-building").textContent = `${b.tags["addr:street"] ? b.tags["addr:street"] + " " + (b.tags["addr:housenumber"] || "") + " · " : ""}${fmt(b.height, 1)} m high (${b.source}) · OSM ${b.osm}`;
    $("r-energy").textContent = fmt(energy);
    $("r-roof").textContent = `${fmt(sel.roofArea)} m²`;
    $("r-slots").textContent = fmt(sel.slots.length);
    $("r-panels").textContent = fmt(panels);
    $("r-parea").textContent = `${fmt(panels * panelArea)} m²`;
    $("r-kwp").textContent = `${fmt(kwp, 1)} kWp`;
    $("r-shade").textContent = kept.length ? `${fmt((1 - avgSun) * 100)}%` : "–";
    $("r-own").textContent = `Covers ${fmt(Math.min(999, (100 * energy) / b.demand))}% of this building's own use (≈ ${fmt(b.demand)} kWh/yr, assumed).`;

    shareEnergy(energy);
    fillAssumptions();
    sel.summary = { energy, panels, kwp, avgSun, minSun: min };
  }

  function shareEnergy(energy) {
    const policy = $("policy-select").value;
    const alloc = S.allocate(area.buildings, sel.k, energy, CFG, policy);
    const prim = area.prim;
    whenReady(prim, () => {
      colored.forEach((i) => setBuildingColor(i, baseColor(area.buildings[i])));
      colored = new Set();
      alloc.forEach((v, i) => {
        if (i === sel.k || v.received <= 0) return;
        setBuildingColor(i, Cesium.Color.lerp(COL.gotPart, COL.gotFull, Math.min(1, v.share), new Cesium.Color()));
        colored.add(i);
      });
      setBuildingColor(sel.k, COL.sel);
      colored.add(sel.k);
    });

    const own = alloc.get(sel.k);
    const others = [...alloc.entries()].filter(([i, v]) => i !== sel.k && v.received > 0);
    const full = others.filter(([, v]) => v.share >= 0.999).length;
    const shared = others.reduce((s, [, v]) => s + v.received, 0);
    let text;
    if (policy === "equal") {
      text = `Every building in the loaded area (${fmt(alloc.size)}) gets ${fmt((own ? own.share : 0) * 100, 2)}% of its yearly use.`;
    } else if (!others.length) {
      text = `All the energy stays in this building: it uses more than the roof makes. Nothing is left for neighbours.`;
    } else {
      text = `${fmt(shared)} kWh/yr go to ${fmt(others.length)} neighbours: ${fmt(full)} fully supplied${others.length > full ? ", 1 partly" : ""}.`;
    }
    $("r-share").textContent = text;
  }

  function fillAssumptions() {
    const items = [
      `Sun: ${fmt(CFG.GHI_KWH_M2_YEAR)} kWh/m² per year on open flat ground, ${Math.round(CFG.DIFFUSE_FRACTION * 100)}% of it diffuse sky light.`,
      `Panels: ${CFG.PANEL_LENGTH_M} × ${CFG.PANEL_WIDTH_M} m, ${Math.round(CFG.PANEL_EFFICIENCY * 100)}% efficient, ${Math.round(CFG.PERFORMANCE_RATIO * 100)}% system performance, laid flat.`,
      `${CFG.ROOF_SETBACK_M} m free strip along the roof edge; ${Math.round((1 - CFG.OBSTACLE_FACTOR) * 100)}% of slots lost to stairs, tanks and AC units (until the AI reads the roof).`,
      `Demand: ${CFG.DEMAND_KWH_M2_YEAR} kWh per m² of floor per year; floors = height ÷ ${CFG.FLOOR_HEIGHT_M} m.`,
      `Shade: neighbours from OpenStreetMap as flat-topped blocks; trees are not included. Buildings without height data are ${CFG.DEFAULT_HEIGHT_M} m.`,
      `Sharing: yearly totals, inside the loaded area and the ${fmt(CFG.SHARE_RADIUS_M / 1000)} km circle. Hour-by-hour matching comes next.`,
    ];
    $("r-assumptions").innerHTML = items.map((t) => `<li>${t}</li>`).join("");
  }

  function saveJson() {
    if (!sel) return;
    const b = area.buildings[sel.k];
    const [lng, lat] = area.proj.toLngLat(b.c[0], b.c[1]);
    const data = {
      building: { osm: b.osm, lat, lng, height_m: b.height, height_source: b.source, footprint_m2: b.footprint, demand_kwh_year: b.demand, tags: b.tags },
      result: { roof_area_m2: sel.roofArea, panel_slots: sel.slots.length, ...sel.summary },
      panels: sel.slots.map((s) => {
        const [plng, plat] = area.proj.toLngLat(s.cx, s.cy);
        return { lat: plat, lng: plng, sun_factor: +s.sunFactor.toFixed(3), direct: +s.direct.toFixed(3), sky: +s.sky.toFixed(3), kwh_year: +S.panelYearKwh(s, CFG).toFixed(1) };
      }),
      assumptions: CFG,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `roof_${b.osm.replace("/", "_")}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  /* ---------- start ---------- */
  async function main() {
    try {
      makeViewer();
    } catch (err) {
      setStatus("error", "The 3D map could not start. This browser may not support WebGL.");
      console.error(err);
      return;
    }
    updateClock();
    $("day-select").addEventListener("change", updateClock);
    $("hour-range").addEventListener("input", updateClock);
    $("sun-range").addEventListener("input", updateResults);
    $("policy-select").addEventListener("change", updateResults);
    $("save-btn").addEventListener("click", saveJson);
    $("load-btn").addEventListener("click", () => {
      const c = viewCenter();
      if (c) loadArea(c);
      else setStatus("error", "Tilt the map down so the centre of the screen shows the city, then try again.");
    });
    document.querySelectorAll("[data-place]").forEach((btn) =>
      btn.addEventListener("click", () => {
        const p = PLACES[btn.dataset.place];
        lookAt(p.lat, p.lng, 1100);
        setTimeout(() => loadArea(p), 300);
      }));

    lookAt(PLACES.eixample.lat, PLACES.eixample.lng, 1100, 0);
    loadArea(PLACES.eixample);
  }

  main();
})();
