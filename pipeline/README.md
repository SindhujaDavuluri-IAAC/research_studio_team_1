# The pipeline: from an address to panels and kWh

All the Python code. Run every command **from this folder** (`pipeline/`).

| Step | Folder | What it does | Details |
|---|---|---|---|
| 1 | `step1/` | Find the building: address → Catastro plot, footprint, age, height, flat roof? | [step1/README.md](step1/README.md) |
| 2 | `step2/` | Read the roof: LiDAR (+ AI on the photo) → usable area, obstacles, lower roofs | [step2/README.md](step2/README.md) |
| 3 | `step3/` | Lay out panels in rows on the usable area | [step4/README.md](step4/README.md) |
| 4 | `step4/` | Shade and yield: kWh per panel, hour by hour; the roof test set of the 9 blocks | [step4/README.md](step4/README.md) |
| 5 | `step5/` | Each building's use, hour by hour, and sharing groups between buildings | [step5/README.md](step5/README.md) |
| → map | `web/` | Send results to the 3D map; save the study area's buildings for it | below |

`tests/` has offline tests for every step. `examples/` has real outputs (Roger de Llúria 56, Aragó 284 and 308, Bruc 59, Diputació 311, Travessera 308) to look at.

## Setup (once)

```
python -m venv .venv
.venv\Scripts\activate            (Mac/Linux: source .venv/bin/activate)
pip install -r requirements.txt
python -m step4.weather           (downloads the PVGIS sun data for our blocks)
python -m pytest tests            (should end with "passed"; the AI tests are skipped without PyTorch)
```

Only for the AI part of step 2: `pip install -r requirements-ai.txt` (large; Google Colab is fine).

LiDAR tiles: download the ICGC Territorial LiDAR tiles (LAZ) that cover the 9 blocks into `data\lidar\`. File names don't matter.

## The usual order

```
# 1. Once: every roof in the 9 blocks, numbered 1-9 (from Catastro)
python -m step4.roof_test_set --out data\roof_test_set

# 2. Once: the study area's buildings for the map, so it doesn't wait for the city server
python -m web.buildings

# 3. All roofs: steps 2-4, ranked, and sent to the map (--block 5 runs one block)
python -m step4.batch data\roof_test_set\roof_test_set.csv --laz-dir data\lidar --out data\yield_all --web

# 4. Use and sharing between buildings, and send them to the map
python -m step5.sharing
python -m web.sharing

# 5. Training pictures for the AI model, from the same roof list
python -m step2.dataset data\roof_test_set\roof_test_set.csv --laz-dir data\lidar --out data\chips
```

Then open the map (`../website`, see its README). Roofs run with `--web` show **Our pipeline** and the exact numbers; the others show a **Quick estimate**.

Roofs already in use (sports courts, gardens): list them in `data\roof_exclusions.csv` (columns `refcat,reason`). Step 2 gives them no usable area, and the map says why. This one file in `data` is shared in git, so everyone uses the same list.

One roof at a time:

```
python -m step2.read_roof "Carrer de Roger de Llúria 56, Barcelona" --laz-dir data\lidar --out lluria56
python -m step4.shade_yield "Carrer de Roger de Llúria 56, Barcelona" --laz-dir data\lidar --usable lluria56_usable.geojson --out lluria56 --web
```

`--web` alone sends the result to `../website`. To send a roof you ran earlier: `python -m web.export lluria56`.

## Where outputs go

Commands write their outputs into this folder (for example `lluria56.json`, `lluria56_preview.png`). Git ignores them, so they don't fill the repository. Put the ones worth sharing in `examples/`. `data/` (LiDAR, chips, weather, yields) and `models/` are also ignored, except `data/roof_exclusions.csv`: each person keeps their own copy.

## The web folder

| File | What it does |
|---|---|
| `web/buildings.py` | Downloads the study area's buildings from the city (once) → `../website/data/buildings.json` |
| `web/export.py` | Writes one roof file for the map: step 2's usable area and obstacles, step 4's panels, kWh, shade and a typical day per month, and the block → `../website/data/roofs/<refcat>.json` |
| `web/sharing.py` | Sends step 5's groups, members and totals to the map → `../website/data/sharing.json` (one entry per distance rule) |
