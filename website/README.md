# Roofscapes RePowered — the 3D map

**Solar co-investment communities in the Eixample.** Panels go on the 10 roofs of our 9 blocks with the most energy per panel; neighbours within 500 m buy a fixed share of the output.

The site shows the **Ajuntament de Barcelona 3D model**. Only our **9 blocks** (Passeig de Gràcia to Bruc, Gran Via to Aragó) are coloured by us; the rest of the city keeps the city's own red model, because we have no data there yet. The camera looks north-west, like step 5c's map: Passeig de Gràcia on the left, Gran Via at the front.

| Tab | What it shows |
|---|---|
| **Communities** | Every building of the 9 blocks coloured exactly like step 5c's map: the **host roof** (where the panels are installed) in the community's colour with a dark outline and its number above it; the **guest buildings** (they co-invest and receive a share) in a pale version of the same colour; every other building of the 9 blocks light grey. **Arrows** go from each host roof to each of its guests. The panel lists the communities like the table on step 5c's map: host address, flats + offices/schools, kWh per kWp, payback, kWp, MWh a year, buildings, and the total. |
| **How it works** | The problem, and the five steps with real pictures from the pipeline. |

**Click a building** of the 9 blocks: its community opens (every other building turns grey, only its arrows stay), and the panel shows the community's numbers from the table, every member (address, homes/offices/shops, year built, distance from the host) and, at the top, the building you clicked. A grey building says it is in no community; a red one is outside the 9 blocks. Click a member in the list to see it on the map.

**Find its community** (top bar): type an address in the 9 blocks.

The **time bar** at the bottom only moves the real sun on the map (light and shadows). Tick **Shadows** to see them.

No account, no API key, no credit card.

## How a community is made (Breno's step 5c, `pipeline/step5/communities.py`)

1. **Host roofs:** the 10 roofs with the most kWh per kWp, each with room for at least 5 kWp, get the panels.
2. **Guests:** around each host, flats (40% of each building's assumed to join), offices and schools within 500 m join, nearest first, until their use matches what the roof makes.
3. **Shares:** each member buys a fixed share of the output (RD 244/2019) and pays the same share of the panels. Each building is in one community only.

## Where the communities come from

The panel says it under the title. The first file found is shown:

| File | Label | What it has |
|---|---|---|
| `data/communities.json` | **Our pipeline · step 5c** (green) | Step 5c's full results, exported with `python -m web.communities`: everything below, plus each member's share, investment, saving and kWh. |
| `data/communities_map.json` | **Step 5c's map** (blue) | The same 10 communities read from step 5c's map of 3 November (`pipeline/step5` → `communities.png`): which buildings are in which community (from the map's colours, matched to the city's plot outlines), the numbers of its table, and each member's address, homes/offices/shops and year built from Catastro. |

The map matches buildings by **cadastral reference**: its first 5 characters are the block (Catastro "manzana"), the first 7 the plot. The 9 blocks are 11 codes in `config.js` (`BLOCKS`): two blocks are split in two by a passage.

**To show Breno's full results**, in `pipeline/` on the computer that has them:

```
python -m step5.communities       # if not run yet: writes data\communities
python -m web.communities         # -> ../website/data/communities.json
```

Then commit `website/data/communities.json`. Ran step 5c with other settings (`--max-distance 5000`, `--participation 0.3`)? Give the same ones to `web.communities`, so the map explains them. Keep `communities_map.json`: it is only used when `communities.json` is missing.

## Run it

Open with a local web server (not by double-clicking):

- **VS Code:** right-click `index.html` → **Open with Live Server**, or
- **Terminal in this folder:** `python -m http.server 8000` → open http://localhost:8000

## Fill it with data (from the `pipeline` folder)

```
python -m web.buildings                                   # once: the buildings (fast start)
python -m step4.roof_test_set --out data\roof_test_set    # once: every roof of the 9 blocks
python -m step4.batch data\roof_test_set\roof_test_set.csv --laz-dir data\lidar --out data\yield_all --web
python -m step5.communities --yield-dir data\yield_all    # step 5c: the communities
python -m web.communities                                 # step 5c -> data/communities.json
```

Already ran step 4 without `--web`? `python -m web.export --all data\yield_all` sends the whole folder. Roofs in `data/roofs/` get the pipeline's panels drawn on them when they host a community. Then reload the page.

## Keeping it fast

- **The heavy work happens once, in Python**, not in every visitor's browser.
- Without `data/buildings.json`, the page asks the city server only for the 9 blocks' buildings (about 1,900 parts, one query).
- **One small file per roof** in `data/roofs/`, opened only when its community is open.
- The page starts at medium quality with shadows off, and **Hours of shadow** only runs while its box is open.

Still slow on your laptop? In `config.js`, put the "simple volumes" 3D model first in `SCENE_LAYERS`.

## Files

| File | What it does |
|---|---|
| `index.html` | Page structure: top bar, the two tabs, the panel, time bar |
| `style.css` | Look of the page (colours and fonts at the top) |
| `config.js` | Service addresses, the 9 blocks (`BLOCKS`), data files, the community colours |
| `solar.js` | Geometry helpers (map projection, finding the building under a click). Its sun and shade functions are kept but not used now |
| `app.js` | 3D map, reading our data files, colouring the 9 blocks, the arrows, the panel, time bar |
| `data/communities_map.json` | Step 5c's communities read from its map, with Catastro addresses |
| `data/communities.json` | Step 5c's full results (`python -m web.communities`), when exported |
| `data/buildings.json` | The buildings, saved once (`python -m web.buildings`) |
| `data/roofs/` | One file per roof run by the pipeline, and `index.json` |
| `img/` | Pictures for How it works (from `pipeline/examples`) |

The hourly version of the idea (MATCHSOL) is kept for later in `../website_matchsol`.

## Data and tools

| Part | Source |
|---|---|
| 3D model on the map | Ajuntament de Barcelona, `Hosted/BCN_3DtoFeat/SceneServer` (falls back to `Hosted/3D_MTM`), geo.bcn.cat |
| Building footprints, height, use, cadastral ref. | Ajuntament de Barcelona, `Hosted/BCN_3DtoFeat/FeatureServer/22` (`multipatchOption=xyFootprint`) |
| Addresses, homes/offices/shops, year built | Catastro (Sede Electrónica del Catastro, `Consulta_DNPRC`), 4 Nov 2026 |
| Background map | Ajuntament de Barcelona vector map (falls back to OpenStreetMap) |
| 3D engine | ArcGIS Maps SDK for JavaScript 4.31, free with these public layers |
| Communities | Breno's step 5c, `../pipeline/step5` |

## Known limits (next steps)

- Until `data/communities.json` is in, members have no share and no kWh of their own (step 5c's map does not show them), and distances are measured between plot centres on the map.
- One building on step 5c's map was a lone dot with no plot under it; it is matched to the nearest plot, Roger de Llúria 52 (`0629627`, community 9). The full export will confirm it.
- Panels on lower roof levels are drawn at the top roof height (the numbers are right; only the drawing is flat).
