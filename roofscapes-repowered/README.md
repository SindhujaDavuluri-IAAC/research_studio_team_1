# Roofscapes RePowered — 3D roof solar prototype (open tools)

A 3D map of Barcelona. Click a building and the page calculates, with our own model:

- how many solar panels fit on the roof (with a 1 m free strip along the edge)
- how much sun each panel gets over a year, **including shade from neighbouring buildings**
- yearly energy, installed power, and how much of the building's own use it covers
- who gets the energy inside the 2 km sharing circle: buildings turn green when they are supplied
- a time bar that shows the real shadows of the city on any day and hour

No Google account and no credit card are needed.

## Tools

| Part | Tool | Cost |
|---|---|---|
| 3D map | [CesiumJS](https://cesium.com/platform/cesiumjs/) 1.121 | free, open source |
| Buildings and heights | OpenStreetMap through the Overpass API | free |
| Sun position, shade, sky view, energy | our own code in `solar.js` | — |
| Aerial photo background (optional) | Cesium ion free account | free |

## Files

| File | What it does |
|---|---|
| `index.html` | Page structure |
| `style.css` | Look of the page |
| `config.js` | **All assumptions** (sun, panels, demand, sharing radius) and the optional Cesium token |
| `solar.js` | The solar engine: sun path, panel slots, shade rays, sky view, energy, sharing |
| `app.js` | The 3D map, loading buildings, clicks, colours, the Roof Report |

## Run it

The page must be opened from a small local web server, not by double-clicking.

**VS Code (easiest):** install the extension **Live Server** → right-click `index.html` → **Open with Live Server**.

**Or in a terminal, inside this folder:**

```
python -m http.server 8000
```

Then open http://localhost:8000

## Use it

1. The map opens over the Eixample and downloads the buildings (5–20 seconds).
2. Click a roof. The Roof Report fills in and the panels appear on the roof, coloured from dark (shade) to yellow (full sun).
3. Move **Keep panels with at least X% of full sun** to drop shaded panels.
4. Change **Who gets the energy** to see which neighbours are supplied.
5. Move the time bar at the bottom left to see the shadows of the city.
6. To work somewhere else, move the map and press **Load buildings here**.
7. **Save roof data (JSON)** saves the result of every panel, for our dataset and for checking against PVGIS, Ladybug or Google Solar.

## Optional: aerial photos

1. Make a free account at https://ion.cesium.com (no card).
2. **Access Tokens** → copy the *Default* token.
3. Paste it in `config.js` → `CESIUM_ION_TOKEN`.

## How the calculation works (for the presentation)

1. **Panel slots.** The roof outline is turned to its longest edge and filled with 1.76 × 1.13 m panels, keeping 1 m from every edge.
2. **Sun path.** 140 sun positions: every hour of the 15th of each month, weighted by how strong the direct sun is at that moment.
3. **Shade.** From the centre of each panel a ray is sent towards the sun, every 1 m. If the ray passes inside a neighbouring building that is higher than the ray at that point, the panel is in shade at that hour.
4. **Sky view.** The horizon is measured in 16 directions; this gives how much of the sky the panel sees, for the diffuse (cloud and sky) light.
5. **Energy.** sun on the panel × panel area × efficiency × performance ratio × obstacle factor.
6. **Demand.** footprint × floors × kWh per m² per year.
7. **Sharing.** Own building first, then the nearest buildings inside 2 km get their full yearly use until the energy runs out (or: everyone gets the same %).

## Known limits (next steps)

- Roof obstacles (stairs, tanks, AC units) are a fixed 25% assumption → **AI roof reading on aerial photos** will replace it.
- Trees are not in the shade model; roofs are flat; OSM heights are not always present (estimated buildings are darker on the map).
- Energy and demand are yearly totals → next: hour-by-hour matching (no sun at night).
- Only buildings in the loaded area (default 400 m around the centre) take part in sharing, not the full 2 km.
- Assumptions in `config.js` marked ASSUMPTION need sources (PVGIS, Barcelona Energy Observatory).
