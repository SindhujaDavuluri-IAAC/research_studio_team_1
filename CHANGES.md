# Clean-up, 2 November 2026 (for Breno and Sindhuja)

Based on the repo after Breno's merge of PR #6 (`dbaf9bd`), with all of PR #6 included (step 5, the roof test set, lower roofs and exclusions, check_months, the new outputs). Nothing was lost: every deleted folder was an older or identical copy. You can delete this file once you've read it.

## What moved where

| Before | Now |
|---|---|
| `step1_find_building/step1_find_building/` (steps 1–4, tests) | `pipeline/` |
| `step2_read_the_roof/` (older copy of step 2) | deleted |
| `link_roofscapes/` (copy of the site without `config.js`, and of 3 step 2 files) | deleted |
| `roofscapes-repowered/` | `website/` |
| `roofscapes-repowered/roofs/` | `website/data/roofs/` |
| `README.md`, `README_step2.md`, `README_step4.md`, `README_step5.md` (inside the double folder) | `pipeline/step1/README.md`, `pipeline/step2/README.md`, `pipeline/step4/README.md`, `pipeline/step5/README.md` |
| `README_step1.md`, `README_step2.md` at the top | deleted (older copies) |
| `requirements.txt` + `requirements-step2.txt` | `pipeline/requirements.txt` (everything except the AI) + `pipeline/requirements-ai.txt` (PyTorch) |
| `step2/export_web.py` | `pipeline/web/export.py` (`python -m web.export lluria56`) |
| `tests/test_step2_web.py` | `pipeline/tests/test_web.py` |
| example outputs (`lluria56*`, `travessera308*`, `building.*`, `arago284t*`, `arago308*`, `bruc59*`, `diputacio311*`) | `pipeline/examples/` |
| `step1/__pycache__/` | deleted (now ignored by git) |
| `.gitignore` (inside the double folder, lines twice) | one `.gitignore` at the top. Outputs written in `pipeline/` are ignored now, so put results to share in `examples/`. `data/roof_exclusions.csv` is the one file in `data/` that git shares. |

Run commands from `pipeline/` now, instead of from the double folder.

## What's new

- **`--web` on step 4** (`step4.shade_yield` and `step4.batch`): sends the roof, every panel with its kWh and shade loss, the totals and the monthly kWh to the map. The map now **shows step 4's numbers** for those roofs ("Our pipeline") and keeps its own calculation only as a labelled "Quick estimate" for roofs not run yet. `--web` with no folder means `../website`.
- **`python -m web.buildings`**: downloads the study area's buildings from the city once → `website/data/buildings.json`. The map then stops asking the city server on every click inside the study area. (The roof list itself is Breno's `step4.roof_test_set`.)
- `step2.dataset` uses `lat,lon` when a row has them, like `step4.batch`, so it reads the roof test set directly.
- The map shows step 2's notes: a roof on the exclusion list ("Left out by hand: …") and lower roofs not counted.
- `step4.shade_yield` also writes `<out>_usable.geojson` when it reads the roof itself, and saves step 2's numbers in `<out>_yield.json`.
- Website: medium quality and live shadows off at start (turn them on in "Sun and shadows"), opens directly over the 9 blocks, "Hours of shadow" only runs while open, month-by-month bars, slider starts at 60% (same as step 4's 40% shade limit).
- New tests: `tests/test_web.py` (energy export), `tests/test_buildings.py`, and one in `tests/test_step4.py` (`--web`).

## The website's four screens (same day, later)

From Daria's design: a top bar with four tabs, all on the city's real 3D model.

- **Area**: roofs run by the pipeline coloured by kWh per m² of roof (colour steps in `website/config.js`), block numbers 1–9, the share of the blocks' own use their roofs cover (from step 5), panels, energy, homes, block by block, best roofs.
- **Building**: the Roof Report, plus a typical day for the month in the time bar and step 5's use and coverage for that building.
- **Sharing**: step 5's groups drawn on the map with arcs, with and without sharing, a card per group, the 500 m / 2 km / 5 km rule.
- **How it works**: the problem and the five steps, with images from `examples/`.
- **Time bar**: month and hour move the real sun on the map (and the typical-day chart); a Shadows switch.
- New for the pipeline: `step4.batch --web` sends each roof's block; roof files get `typical_day_kwh` (12 months × 24 hours, local time); `python -m web.sharing` sends step 5 to the map. New tests: `tests/test_sharing_web.py`, two more in `tests/test_web.py`.

## To do: put the tested roofs on the map

The outputs of Bruc 59, Diputació 311 and Aragó 284/308 in `examples/` were made before the lower-roof and exclusion rules (Aragó 284 looks like the sports court in the exclusion test, with 941 m² "usable" in its old reading). Rather than putting old numbers on the map, rerun them with `--web`, e.g. `python -m step4.batch data\roof_test_set\roof_test_set.csv --laz-dir data\lidar --out data\yield_all --block 5 --web`.

## Please check

The Python tests couldn't run where this was made (no geometry packages there). Run them once:

```
cd pipeline
pip install -r requirements.txt
python -m pytest tests
```

## Co-investment communities on the map (4 November 2026)

The map now shows Breno's step 5c: solar co-investment communities in the Eixample. Panels go on the 10 roofs with the most energy per panel; neighbours within 500 m buy a fixed share of the output.

- **Only the 9 blocks are coloured**, exactly like step 5c's map: host roof in the community's colour with a dark outline and its number, guests in a pale version, the rest of the 9 blocks light grey. The rest of the city keeps the city's red model. The camera looks north-west like the map (Passeig de Gràcia on the left, Gran Via at the front).
- 3D arrows from each host roof to its guests, and the table of step 5c's map (kWp, MWh a year, buildings, flats + offices/schools, kWh per kWp, payback, total).
- **Click a building**: its community opens (the rest turns grey), with the table's numbers, every member (address, homes/offices/shops, year built from Catastro, distance) and the building you clicked.
- The communities come from `website/data/communities_map.json`: read from step 5c's map of 3 November (members from its colours, matched to the city's plot outlines; all 10 host addresses match Catastro). When `website/data/communities.json` is there (`python -m step5.communities`, then `python -m web.communities`, new, with `tests/test_communities_web.py`), it is used instead and adds each member's share.
- The hourly idea (MATCHSOL) is kept for later in `website_matchsol/`.
- Removed `pipeline/web/sharing.py` and `tests/test_sharing_web.py` (export for the old Sharing tab; step 5b itself stays).
