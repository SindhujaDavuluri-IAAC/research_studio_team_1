/* MATCHSOL — the matching engine (no map code here, so it can be tested on its own).
 *
 * Every building gets its solar power and its use for 24 typical days (12 months × weekday / weekend),
 * hour by hour. A building first uses its own roof's power. What is left over (surplus) can go to
 * buildings of its match that need power at that same hour. Matches are grown building by building,
 * always adding the one that lets the match use the most extra solar power: buildings whose
 * schedules complement each other (homes empty at noon, schools empty on weekends).
 *
 * Use shapes follow pipeline/step5/demand.py (config.js, USE). The sun shape comes from our
 * pipeline's typical days (step 4), or from the sun's height when no roof has been run.
 */
(function (root) {
  "use strict";
  const H = 24;

  // The 24 typical days of 2026: month, weekend or not, and how many days of that kind.
  function typicalDays(year = 2026) {
    const out = [];
    for (let m = 0; m < 12; m++) {
      let wd = 0, we = 0;
      const n = new Date(Date.UTC(year, m + 1, 0)).getUTCDate();
      for (let d = 1; d <= n; d++) {
        const day = new Date(Date.UTC(year, m, d)).getUTCDay();
        if (day === 0 || day === 6) we++; else wd++;
      }
      out.push({ m, weekend: false, days: wd }, { m, weekend: true, days: we });
    }
    return out;
  }
  const TD = typicalDays();
  const T = TD.length * H;                       // 576 slots
  const W = new Float64Array(T);                 // days per slot
  TD.forEach((d, i) => { for (let h = 0; h < H; h++) W[i * H + h] = d.days; });
  const slot = (m, weekend, h) => (2 * m + (weekend ? 1 : 0)) * H + h;

  // Use shapes per slot, each adding up to 1 over the year (sum of shape × days = 1).
  function useShapes(U) {
    const raw = { home: new Float64Array(T), office: new Float64Array(T), school: new Float64Array(T) };
    TD.forEach((d, i) => {
      const holiday = U.SCHOOL_HOLIDAY_MONTHS.includes(d.m);
      for (let h = 0; h < H; h++) {
        const t = i * H + h;
        raw.home[t] = U.HOME_DAY[h] * U.MONTH[d.m] * (d.weekend ? U.WEEKEND_HOME : 1);
        const officeOpen = !d.weekend && h >= U.OFFICE_OPEN[0] && h < U.OFFICE_OPEN[1];
        raw.office[t] = (officeOpen ? 1 : U.OFFICE_CLOSED) * (d.m === 7 ? U.OFFICE_AUGUST : 1);
        const schoolOpen = !d.weekend && !holiday && h >= U.SCHOOL_OPEN[0] && h < U.SCHOOL_OPEN[1];
        raw.school[t] = schoolOpen ? 1 : U.SCHOOL_CLOSED;
      }
    });
    for (const k of Object.keys(raw)) {
      let z = 0;
      for (let t = 0; t < T; t++) z += raw[k][t] * W[t];
      for (let t = 0; t < T; t++) raw[k][t] /= z;
    }
    return raw;
  }

  // A sun shape per slot from a 12 × 24 typical day (kWh per hour, as step 4 writes it), adding up to 1.
  function sunShape(typicalDay) {
    const s = new Float64Array(T);
    let z = 0;
    TD.forEach((d, i) => { for (let h = 0; h < H; h++) { s[i * H + h] = Math.max(0, typicalDay[d.m][h] || 0); z += s[i * H + h] * d.days; } });
    if (z > 0) for (let t = 0; t < T; t++) s[t] /= z;
    return s;
  }

  // Without any pipeline roof: the sun's height above the horizon (clear sky), the 15th of each month.
  function sunShapeFromSky(sunPosition, lat, lng) {
    const day = [];
    for (let m = 0; m < 12; m++) {
      const row = [];
      for (let h = 0; h < H; h++) {
        const offset = m >= 3 && m <= 9 ? 2 : 1;
        const { alt } = sunPosition(new Date(Date.UTC(2026, m, 15, h - offset, 30)), lat, lng);
        row.push(alt > 0 ? Math.pow(Math.sin(alt), 1.3) : 0);
      }
      day.push(row);
    }
    return sunShape(day);
  }

  // Average of several sun shapes (the pipeline roofs), so one roof's shade does not shape all the others.
  function averageShape(shapes) {
    const s = new Float64Array(T);
    for (const x of shapes) for (let t = 0; t < T; t++) s[t] += x[t] / shapes.length;
    return s;
  }

  /* One building: { sunKwh, sun (shape), homeKwh, dayKwh, dayKind } -> hourly arrays. */
  function prepare(b, shapes) {
    const sun = new Float64Array(T), use = new Float64Array(T);
    for (let t = 0; t < T; t++) {
      sun[t] = b.sunKwh * (b.sun ? b.sun[t] : 0);
      use[t] = b.homeKwh * shapes.home[t] + (b.dayKwh ? b.dayKwh * shapes[b.dayKind][t] : 0);
    }
    const own = new Float64Array(T), surplus = new Float64Array(T), need = new Float64Array(T);
    let ownYear = 0, sunYear = 0, surplusYear = 0;
    for (let t = 0; t < T; t++) {
      own[t] = Math.min(sun[t], use[t]);
      surplus[t] = sun[t] - own[t];
      need[t] = use[t] - own[t];
      ownYear += own[t] * W[t]; sunYear += sun[t] * W[t]; surplusYear += surplus[t] * W[t];
    }
    let useYear = 0;
    for (let t = 0; t < T; t++) useYear += use[t] * W[t];
    return Object.assign(b, { sunH: sun, useH: use, own, surplus, need, ownYear, sunYear, surplusYear, useYear });
  }

  // Extra solar kWh a year the match uses if candidate c joins (pooled surplus S, pooled need N).
  function gain(S, N, c, daylight) {
    let g = 0;
    for (const t of daylight) {
      const before = S[t] < N[t] ? S[t] : N[t];
      const s = S[t] + c.surplus[t], n = N[t] + c.need[t];
      g += ((s < n ? s : n) - before) * W[t];
    }
    return g;
  }

  /* Grow the matches. buildings: prepared, each with x, y (m) and kind. Returns [{ members: [...] }]. */
  function matchAll(buildings, C, daylight) {
    if (!daylight) {
      daylight = [];
      for (let t = 0; t < T; t++) if (buildings.some((b) => b.sunH[t] > 0)) daylight.push(t);
    }
    const taken = new Set();
    const isDay = (b) => b.kind === "school" || b.kind === "office";
    const seeds = [
      ...buildings.filter(isDay).sort((a, b) => b.dayKwh - a.dayKwh),
      ...buildings.filter((b) => !isDay(b) && b.surplusYear > 0).sort((a, b) => b.surplusYear - a.surplusYear),
    ];
    const matches = [];
    for (const seed of seeds) {
      if (taken.has(seed)) continue;
      const members = [seed];
      const S = Float64Array.from(seed.surplus), N = Float64Array.from(seed.need);
      const pool = buildings.filter((b) => b !== seed && !taken.has(b) &&
        Math.hypot(b.x - seed.x, b.y - seed.y) <= C.MAX_DISTANCE_M && (b.surplusYear > 0 || b.useYear > 0));
      while (members.length < C.MAX_MEMBERS) {
        let best = null, bestScore = 0, bestGain = 0;
        for (const c of pool) {
          if (members.includes(c)) continue;
          const g = gain(S, N, c, daylight);
          if (g < C.MIN_GAIN_KWH) continue;
          // the law allows 5 km; nearer buildings are preferred, so a match stays a neighbourhood
          const d = Math.min(...members.map((m) => Math.hypot(c.x - m.x, c.y - m.y)));
          const score = g * Math.exp(-d / C.NEAR_M);
          if (score > bestScore) { best = c; bestScore = score; bestGain = g; }
        }
        if (!best) break;
        members.push(best);
        for (let t = 0; t < T; t++) { S[t] += best.surplus[t]; N[t] += best.need[t]; }
        best.addedGain = bestGain;
      }
      if (members.length < 2) continue;
      const sim = simulate(members);
      if (sim.sharedYear < C.MIN_SHARED_KWH) continue;
      members.forEach((m) => taken.add(m));
      matches.push({ id: matches.length + 1, seed, members, ...sim });
    }
    return matches;
  }

  /* Hour by hour inside one match: pooled surplus goes to pooled need, split in proportion. */
  function simulate(members) {
    const n = members.length;
    const given = members.map(() => new Float64Array(T)), got = members.map(() => new Float64Array(T));
    const shared = new Float64Array(T);
    let sharedYear = 0, sunYear = 0, ownYear = 0, useYear = 0;
    const givenYear = new Array(n).fill(0), gotYear = new Array(n).fill(0);
    for (let t = 0; t < T; t++) {
      let S = 0, N = 0;
      for (const m of members) { S += m.surplus[t]; N += m.need[t]; }
      const x = S < N ? S : N;
      shared[t] = x;
      if (x > 0) {
        members.forEach((m, i) => {
          given[i][t] = (x * m.surplus[t]) / S;
          got[i][t] = (x * m.need[t]) / N;
          givenYear[i] += given[i][t] * W[t];
          gotYear[i] += got[i][t] * W[t];
        });
      }
      sharedYear += x * W[t];
    }
    for (const m of members) { sunYear += m.sunYear; ownYear += m.ownYear; useYear += m.useYear; }
    return {
      given, got, shared, sharedYear, sunYear, ownYear, useYear, givenYear, gotYear,
      gridYear: sunYear - ownYear - sharedYear,
      alonePct: sunYear ? (100 * ownYear) / sunYear : 0,
      matchedPct: sunYear ? (100 * (ownYear + sharedYear)) / sunYear : 0,
    };
  }

  // Who sends power to whom at one slot: [{ from, to, kwh }] (member indexes), largest first.
  function flowsAt(match, t) {
    const x = match.shared[t];
    if (!(x > 0)) return [];
    let S = 0, N = 0;
    for (const m of match.members) { S += m.surplus[t]; N += m.need[t]; }
    const out = [];
    match.members.forEach((a, i) => {
      if (!(a.surplus[t] > 0)) return;
      match.members.forEach((b, j) => {
        if (i === j || !(b.need[t] > 0)) return;
        out.push({ from: i, to: j, kwh: (x * (a.surplus[t] / S) * b.need[t]) / N });
      });
    });
    return out.sort((p, q) => q.kwh - p.kwh);
  }

  /* The split table of one roof (member index r) for one typical day: share of the roof's power, hour by hour.
     rows: its own building, every other member it gives to, and the grid. Hours without sun: null. */
  function splitTable(match, r, m, weekend, hours) {
    const roof = match.members[r];
    const rows = match.members.map((mb, j) => ({ j, member: mb, own: j === r, cells: [] }));
    const grid = { grid: true, cells: [] };
    for (const h of hours) {
      const t = slot(m, weekend, h), sun = roof.sunH[t];
      if (!(sun > 0.01)) { rows.forEach((row) => row.cells.push(null)); grid.cells.push(null); continue; }
      let S = 0, N = 0;
      for (const mb of match.members) { S += mb.surplus[t]; N += mb.need[t]; }
      const x = match.shared[t];
      const given = S > 0 ? (x * roof.surplus[t]) / S : 0;
      rows.forEach((row) => {
        if (row.own) row.cells.push(roof.own[t] / sun);
        else row.cells.push(N > 0 ? (given * row.member.need[t]) / N / sun : 0);
      });
      grid.cells.push((roof.surplus[t] - given) / sun);
    }
    const kept = rows.filter((row) => row.own || row.cells.some((c) => c && c > 0.005));
    kept.sort((a, b) => b.own - a.own);   // the roof's own building first
    return [...kept, grid];
  }

  // The legal file for one roof: one share per participant for every hour of the year (adding up to 1).
  // The part that would go to the grid stays with the roof's own building.
  function splitYear(match, r, year = 2026) {
    const roof = match.members[r];
    const lines = [];
    const start = Date.UTC(year, 0, 1), end = Date.UTC(year + 1, 0, 1);
    for (let ms = start; ms < end; ms += 3600e3) {
      const d = new Date(ms), m = d.getUTCMonth(), h = d.getUTCHours(), wd = d.getUTCDay();
      const t = slot(m, wd === 0 || wd === 6, h), sun = roof.sunH[t];
      const shares = match.members.map(() => 0);
      if (sun > 0.01) {
        let S = 0, N = 0;
        for (const mb of match.members) { S += mb.surplus[t]; N += mb.need[t]; }
        const given = S > 0 ? (match.shared[t] * roof.surplus[t]) / S : 0;
        match.members.forEach((mb, j) => { if (j !== r && N > 0) shares[j] = (given * mb.need[t]) / N / sun; });
        shares[r] = 1 - shares.reduce((a, b) => a + b, 0);
      } else {
        shares[r] = 1;
      }
      lines.push({ date: d.toISOString().slice(0, 10), hour: h, shares });
    }
    return lines;
  }

  const api = { H, T, W, TD, slot, typicalDays, useShapes, sunShape, sunShapeFromSky, averageShape, prepare, gain, matchAll, simulate, flowsAt, splitTable, splitYear };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Match = api;
})(typeof window !== "undefined" ? window : globalThis);
