# Roofscapes RePowered — the 3D map

The site shows the **Ajuntament de Barcelona 3D model** with four screens, as tabs in the top bar:

| Tab | What it shows | Its data |
|---|---|---|
| **Area** | Every roof run by our pipeline, coloured on the real 3D model by kWh per m² of roof; block numbers 1–9; how much of the 9 blocks' own use their roofs can cover; panels, energy, homes; block by block; the best roofs | `data/roofs/index.json` (step 4), `data/sharing.json` (step 5), `data/buildings.json` |
| **Building** | The Roof Report of one roof: panels on the roof, kWh a year, month by month, a typical day, shade, step 5's use and coverage, who gets the energy | `data/roofs/<refcat>.json` |
| **Sharing** | Step 5's sharing groups on the map (the roof with extra sun in a strong colour, the buildings it supplies in a light one, arcs between them); with and without sharing; one card per group; 500 m / 2 km / 5 km rule | `data/sharing.json` |
| **How it works** | The problem, and the five steps with real pictures from the pipeline | `img/` |

The **time bar** at the bottom (month and hour) moves the real sun on the map, and the typical-day chart in the Roof Report. Tick **Shadows** to see the sun's shadows on the model.

No account, no API key, no credit card.

## Where the numbers come from

Every Roof Report says it at the top:

| Label | Meaning |
|---|---|
| **Our pipeline** (green) | The roof was run by our Python pipeline (steps 2–4) and sent here with `--web`. The page only **shows** its results. Nothing is recalculated in the browser. |
| **Quick estimate** (grey) | The roof was not run yet. The browser makes a fast estimate (`solar.js`): neighbours as simple blocks, flat panels, 25% of the roof assumed lost to obstacles (or step 2's usable area, if step 2 ran). Good for exploring, not for the final numbers. |

Area and Sharing only use pipeline results. Until those exist, they say which command fills them.

## Run it

Open with a local web server (not by double-clicking):

- **VS Code:** right-click `index.html` → **Open with Live Server**, or
- **Terminal in this folder:** `python -m http.server 8000` → open http://localhost:8000

## Fill it with data (from the `pipeline` folder)

```
python -m web.buildings                                   # once: the study area's buildings (fast clicks, roof colours)
python -m step4.roof_test_set --out data\roof_test_set    # once: every roof of the 9 blocks
python -m step4.batch data\roof_test_set\roof_test_set.csv --laz-dir data\lidar --out data\yield_all --web
python -m step5.sharing                                   # use and sharing groups
python -m web.sharing                                     # step 5 -> data/sharing.json
```

Then reload the page. For the 2 km and 5 km buttons in Sharing, run step 5 again with `--max-distance 2000 --out data\sharing_2000` and send it with `python -m web.sharing --sharing data\sharing_2000 --rule 2000`.

## Keeping it fast

- **The heavy work happens once, in Python**, not in every visitor's browser.
- **One small file per roof** in `data/roofs/`, opened only when someone clicks that roof. 10 or 500 roofs make no difference to how fast the page opens. `index.json` and `sharing.json` stay small (a few hundred kB for all the 9 blocks).
- **Our study area in one file** (`data/buildings.json`): a click inside it does not wait for the city server.
- The page starts at medium quality with shadows off, and **Hours of shadow** only runs while its box is open.

Still slow on your laptop? In `config.js`, put the "simple volumes" 3D model first in `SCENE_LAYERS`.

## Files

| File | What it does |
|---|---|
| `index.html` | Page structure: top bar, the four tabs, time bar |
| `style.css` | Look of the page (colours and fonts at the top) |
| `config.js` | Service addresses, data files, speed settings, roof colour steps and **all assumptions** of the quick estimate |
| `solar.js` | Quick-estimate engine: sun path, panel slots, shade rays, sky view, energy, demand, sharing |
| `app.js` | 3D map, the four tabs, time bar, reading our data files, drawing on the model, Roof Report |
| `data/buildings.json` | Our study area's buildings (`python -m web.buildings`) |
| `data/roofs/` | One file per roof run by the pipeline, and `index.json` |
| `data/sharing.json` | Step 5's groups (`python -m web.sharing`) |
| `img/` | Pictures for How it works (from `pipeline/examples`) |

## Data and tools

| Part | Source |
|---|---|
| 3D model on the map | Ajuntament de Barcelona, `Hosted/BCN_3DtoFeat/SceneServer` (falls back to `Hosted/3D_MTM`), geo.bcn.cat |
| Building footprints, height, roof form, use, cadastral ref. | Ajuntament de Barcelona, `Hosted/BCN_3DtoFeat/FeatureServer/22` (`multipatchOption=xyFootprint`) |
| Background map | Ajuntament de Barcelona vector map (falls back to OpenStreetMap) |
| 3D engine | ArcGIS Maps SDK for JavaScript 4.31, free with these public layers |
| Pipeline results | our Python code, `../pipeline` |

## Known limits (next steps)

- Panels on lower roof levels are drawn at the top roof height (the numbers are right; only the drawing is flat).
- Roof colours and sharing groups are drawn only for buildings inside `data/buildings.json`.
- "Homes it could power" uses one assumption: 2,500 kWh a year per home (`HOME_KWH_YEAR` in `config.js`).
- The quick estimate's "Who gets the energy" uses yearly totals; step 5 (Sharing tab) does it hour by hour.
- Values marked ASSUMPTION in `config.js` need sources (PVGIS, Barcelona Energy Observatory).
