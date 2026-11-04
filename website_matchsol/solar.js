/* MATCHSOL — quick roof estimate (no map code here, so it can be tested on its own).
 *
 *  - sun position for Barcelona through the year
 *  - shade from neighbouring buildings: a ray from a roof point towards the sun
 *  - sky view (how much open sky a roof point sees) for diffuse light
 *  - a quick rating of every roof (roofPotential), for roofs our pipeline has not run
 */
(function (root) {
  "use strict";
  const R = 6378137;
  const DEG = Math.PI / 180;

  /* ---------- geometry ---------- */
  function makeProjection(lat0, lng0) {
    const kx = Math.cos(lat0 * DEG) * R * DEG;
    const ky = R * DEG;
    return {
      toXY: (lng, lat) => [(lng - lng0) * kx, (lat - lat0) * ky],
      toLngLat: (x, y) => [lng0 + x / kx, lat0 + y / ky],
    };
  }

  function polygonArea(p) {
    let a = 0;
    for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += (p[j][0] + p[i][0]) * (p[j][1] - p[i][1]);
    return Math.abs(a / 2);
  }

  function centroid(p) {
    let a = 0, cx = 0, cy = 0;
    for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
      const f = p[j][0] * p[i][1] - p[i][0] * p[j][1];
      a += f; cx += (p[j][0] + p[i][0]) * f; cy += (p[j][1] + p[i][1]) * f;
    }
    if (Math.abs(a) < 1e-9) return [p[0][0], p[0][1]];
    return [cx / (3 * a), cy / (3 * a)];
  }

  function pointInPolygon(x, y, p) {
    let inside = false;
    for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
      const xi = p[i][0], yi = p[i][1], xj = p[j][0], yj = p[j][1];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  function distToSegment(x, y, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const L = dx * dx + dy * dy;
    let t = L ? ((x - a[0]) * dx + (y - a[1]) * dy) / L : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(x - (a[0] + t * dx), y - (a[1] + t * dy));
  }

  function minEdgeDistance(x, y, p) {
    let m = Infinity;
    for (let i = 0, j = p.length - 1; i < p.length; j = i++) m = Math.min(m, distToSegment(x, y, p[j], p[i]));
    return m;
  }

  function bbox(p) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of p) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    return [x0, y0, x1, y1];
  }

  /* ---------- clean OSM rings so the 3D engine never gets a broken polygon ---------- */
  function cleanRing(ring) {
    const out = [];
    for (const pt of ring) {
      const last = out[out.length - 1];
      if (!last || Math.abs(last[0] - pt[0]) > 1e-9 || Math.abs(last[1] - pt[1]) > 1e-9) out.push(pt);
    }
    if (out.length > 1) {
      const a = out[0], z = out[out.length - 1];
      if (Math.abs(a[0] - z[0]) < 1e-9 && Math.abs(a[1] - z[1]) < 1e-9) out.pop();
    }
    return out.length >= 3 ? out : null;
  }

  /* ---------- spatial index: which buildings touch each 8 m cell ---------- */
  function buildIndex(buildings, cell = 8) {
    const map = new Map();
    let maxH = 0;
    buildings.forEach((b, k) => {
      maxH = Math.max(maxH, b.height);
      const [x0, y0, x1, y1] = b.bbox;
      for (let i = Math.floor(x0 / cell); i <= Math.floor(x1 / cell); i++)
        for (let j = Math.floor(y0 / cell); j <= Math.floor(y1 / cell); j++) {
          const key = i + "," + j;
          let list = map.get(key);
          if (!list) map.set(key, (list = []));
          list.push(k);
        }
    });
    return { cell, map, maxH };
  }

  // Inside the footprint and not inside a courtyard (hole).
  function insideFootprint(x, y, b) {
    if (!pointInPolygon(x, y, b.xy)) return false;
    if (b.holes) for (const h of b.holes) if (pointInPolygon(x, y, h)) return false;
    return true;
  }

  function footprintArea(b) {
    let a = polygonArea(b.xy);
    if (b.holes) for (const h of b.holes) a -= polygonArea(h);
    return Math.max(0, a);
  }

  // The building at (x, y): the tallest one whose footprint holds the point, otherwise (when
  // radius > 0, e.g. an address point on the street) the one whose outline is nearest within radius.
  // Returns its position in `buildings`, or -1.
  function findBuilding(buildings, index, x, y, radius = 0) {
    const c = index.cell;
    let best = -1;
    for (const k of index.map.get(Math.floor(x / c) + "," + Math.floor(y / c)) || []) {
      if (insideFootprint(x, y, buildings[k]) && (best < 0 || buildings[k].height > buildings[best].height)) best = k;
    }
    if (best >= 0 || !(radius > 0)) return best;
    let bestD = radius;
    const seen = new Set();
    const r = Math.ceil(radius / c), i0 = Math.floor(x / c), j0 = Math.floor(y / c);
    for (let i = i0 - r; i <= i0 + r; i++)
      for (let j = j0 - r; j <= j0 + r; j++)
        for (const k of index.map.get(i + "," + j) || []) {
          if (seen.has(k)) continue;
          seen.add(k);
          const b = buildings[k];
          const d = Math.min(...[b.xy, ...(b.holes || [])].map((ring) => minEdgeDistance(x, y, ring)));
          if (d < bestD) { bestD = d; best = k; }
        }
    return best;
  }

  function heightAbove(index, buildings, x, y, z) {
    // tallest building at (x, y) that is higher than z; 0 if none
    const list = index.map.get(Math.floor(x / index.cell) + "," + Math.floor(y / index.cell));
    if (!list) return 0;
    let h = 0;
    for (const k of list) {
      const b = buildings[k];
      if (b.height <= z || b.height <= h) continue;
      const [x0, y0, x1, y1] = b.bbox;
      if (x < x0 || x > x1 || y < y0 || y > y1) continue;
      if (insideFootprint(x, y, b)) h = b.height;
    }
    return h;
  }

  /* ---------- sun ---------- */
  // Sun altitude and azimuth (azimuth from north, clockwise), accurate to ~0.5° — enough for shade.
  function sunPosition(date, lat, lng) {
    const n = date.getTime() / 86400000 + 2440587.5 - 2451545.0;
    const L = (280.46 + 0.9856474 * n) % 360;
    const g = ((357.528 + 0.9856003 * n) % 360) * DEG;
    const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * DEG;
    const eps = (23.439 - 0.0000004 * n) * DEG;
    const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
    const dec = Math.asin(Math.sin(eps) * Math.sin(lambda));
    const gmst = (((18.697374558 + 24.06570982441908 * n) % 24) + 24) % 24;
    const H = (gmst * 15 + lng) * DEG - ra;
    const phi = lat * DEG;
    const alt = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
    let az = Math.atan2(-Math.sin(H), Math.tan(dec) * Math.cos(phi) - Math.sin(phi) * Math.cos(H));
    if (az < 0) az += 2 * Math.PI;
    return { alt, az };
  }

  // Clear-sky direct sun on a flat surface (W/m²), used only as a weight between hours.
  function clearSkyBeamHorizontal(alt) {
    const altDeg = alt / DEG;
    if (altDeg <= 2) return 0;
    const am = 1 / (Math.sin(alt) + 0.50572 * Math.pow(altDeg + 6.07995, -1.6364));
    const dni = 1361 * Math.pow(0.7, Math.pow(am, 0.678));
    return dni * Math.sin(alt);
  }

  // One sun position per hour on the 15th of every month, weighted by how much direct sun it brings.
  function sunSamples(lat, lng, year = 2026) {
    const days = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    const out = [];
    let total = 0;
    for (let m = 0; m < 12; m++) {
      for (let h = 0; h < 24; h++) {
        const s = sunPosition(new Date(Date.UTC(year, m, 15, h, 30)), lat, lng);
        const w = clearSkyBeamHorizontal(s.alt) * days[m];
        if (w <= 0) continue;
        out.push({ dx: Math.sin(s.az), dy: Math.cos(s.az), tanAlt: Math.tan(s.alt), w });
        total += w;
      }
    }
    out.forEach((s) => (s.w /= total));
    return out;
  }

  /* ---------- shade tests ---------- */
  function isShaded(index, buildings, x, y, z, s, step = 1, maxDist = 300) {
    const reach = Math.min(maxDist, (index.maxH - z) / s.tanAlt);
    for (let d = step; d <= reach; d += step) {
      const rz = z + d * s.tanAlt;
      if (heightAbove(index, buildings, x + s.dx * d, y + s.dy * d, rz) > 0) return true;
    }
    return false;
  }

  // Share of the open sky dome a point sees (1 = fully open). N directions (16 by default).
  function skyView(index, buildings, x, y, z, step = 1.5, maxDist = 150, N = 16) {
    let sum = 0;
    for (let k = 0; k < N; k++) {
      const a = (k / N) * 2 * Math.PI, dx = Math.sin(a), dy = Math.cos(a);
      let tanMax = 0;
      for (let d = step; d <= maxDist; d += step) {
        if ((index.maxH - z) / d <= tanMax) break;
        const h = heightAbove(index, buildings, x + dx * d, y + dy * d, z);
        if (h > 0) tanMax = Math.max(tanMax, (h - z) / d);
      }
      const c = Math.cos(Math.atan(tanMax));
      sum += c * c;
    }
    return sum / N;
  }

  /* ---------- quick rating of every roof ---------- */
  // Every `every`-th sun position, weights renormalised: enough to rank roofs, 4x faster.
  function fewSun(sun, every = 4) {
    const few = sun.filter((_, i) => i % every === 0);
    const total = few.reduce((t, s) => t + s.w, 0) || 1;
    return few.map((s) => ({ ...s, w: s.w / total }));
  }

  function perimeter(p) {
    let L = 0;
    for (let i = 0, j = p.length - 1; i < p.length; j = i++) L += Math.hypot(p[i][0] - p[j][0], p[i][1] - p[j][1]);
    return L;
  }

  // Up to 9 points on the roof, at least the edge setback from every edge and courtyard.
  function roofPoints(b, setback) {
    const [x0, y0, x1, y1] = b.bbox;
    const rings = [b.xy, ...(b.holes || [])];
    const pts = [];
    for (const fx of [0.2, 0.5, 0.8]) for (const fy of [0.2, 0.5, 0.8]) {
      const x = x0 + fx * (x1 - x0), y = y0 + fy * (y1 - y0);
      if (insideFootprint(x, y, b) && rings.every((r) => minEdgeDistance(x, y, r) >= setback)) pts.push([x, y]);
    }
    if (!pts.length) {
      const [cx, cy] = b.c;
      if (insideFootprint(cx, cy, b)) pts.push([cx, cy]);
    }
    return pts;
  }

  // Quick rating of one roof, for roofs our pipeline has not run: sun and shade at a few roof points,
  // the roof minus its edge strip and the obstacle allowance, flat panels. kwhPerM2 = kWh a year per m² of roof.
  function roofPotential(buildings, index, k, sun, cfg) {
    const b = buildings[k];
    const pts = roofPoints(b, cfg.ROOF_SETBACK_M);
    if (!pts.length) return null;
    const z = b.height + cfg.PANEL_HEIGHT_ABOVE_ROOF_M, kd = cfg.DIFFUSE_FRACTION;
    let factor = 0;
    for (const [x, y] of pts) {
      let lit = 0;
      for (const s of sun) if (!isShaded(index, buildings, x, y, z, s, 1.5)) lit += s.w;
      factor += (1 - kd) * lit + kd * skyView(index, buildings, x, y, z, 2, 120, 8);
    }
    const sunFactor = factor / pts.length;
    const edge = [b.xy, ...(b.holes || [])].reduce((t, r) => t + perimeter(r), 0) * cfg.ROOF_SETBACK_M;
    const usableM2 = Math.max(0, b.footprint - edge) * cfg.OBSTACLE_FACTOR;
    const panelM2 = usableM2 * (cfg.PANEL_PACKING || 0.9);
    const kwhYear = panelM2 * cfg.GHI_KWH_M2_YEAR * sunFactor * cfg.PANEL_EFFICIENCY * cfg.PERFORMANCE_RATIO;
    return {
      sunFactor, usableM2, kwhYear, kwhPerM2: b.footprint ? kwhYear / b.footprint : 0,
      panels: Math.floor(panelM2 / (cfg.PANEL_LENGTH_M * cfg.PANEL_WIDTH_M)),
    };
  }

  const api = {
    makeProjection, polygonArea, footprintArea, insideFootprint, centroid, pointInPolygon, bbox, cleanRing, buildIndex, findBuilding,
    sunPosition, sunSamples, isShaded, skyView, fewSun, roofPotential,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Solar = api;
})(typeof window !== "undefined" ? window : globalThis);
