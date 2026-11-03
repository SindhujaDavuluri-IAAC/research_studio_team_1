# Steps 3 and 4: lay out panels, then shade and yield

Step 3 places panel rows on the usable roof that step 2 found. Step 4 works out, hour by hour for a typical year, how much electricity each panel makes after shade from neighbours, trees and rooftop structures.

| | What it uses | What it gives |
|---|---|---|
| Step 3, `step3/layout.py` | Step 2 usable area, building footprint | Panel rows: 1.76 × 1.13 m panels, 420 W, 10° tilt, facing the building side closest to south, rows spaced for no row-to-row shade at winter noon |
| Step 4, `step4/` | ICGC LiDAR within 150 m (roofs, ground, trees, rooftop structures), PVGIS typical year | kWh per panel per hour, shade loss per panel, yearly and monthly totals, kWh per kWp |

## Setup (once)

Same environment as steps 1 and 2. Download the sunshine data for our blocks (free, no key):

```
python -m step4.weather
```

This writes `data\weather\barcelona_tmy.json` (8760 hours from PVGIS).

## One roof

```
python -m step4.shade_yield "Carrer de Roger de Llúria 56, Barcelona" --laz-dir data\lidar --out lluria56
```

To use a step 2 reading you already have (for example with the AI model), add `--usable lluria56_usable.geojson`.

Add `--web` to send the roof, every panel and the totals to the 3D map (`../website`). The map then shows these numbers, labelled **Our pipeline**, instead of its own quick estimate.

Panels that lose more than 40% of their sun to shade are left out (for example on a lower terrace under the building's own top floors). They show in grey in the picture and are counted as `panels_left_out`. Change the limit with `--max-shade 0.3`, or keep every panel with `--max-shade 1`.

Outputs:
- `lluria56_yield.json`: panels, kWp, yearly kWh, kWh per kWp, mean shade loss, monthly kWh, and every panel with its kWh and shade loss
- `lluria56_hourly.csv`: 8760 hours of kWh for the whole roof (input for step 5 and energy sharing)
- `lluria56_panels.geojson`: panel outlines (EPSG:25831), opens in QGIS
- `lluria56_panels.png`: the layout, dark blue = most shade, orange = best panels
- `lluria56_usable.geojson`: the usable roof it used (only when you leave out `--usable`)

## The roof test set: every building in the 9 focus blocks

```
python -m step4.roof_test_set --out data\roof_test_set
```

This asks Catastro for every plot between Passeig de Gràcia and Bruc, and Gran Via and Aragó, and numbers the blocks:

| | Pg. de Gràcia to Pau Claris | Pau Claris to Roger de Llúria | Roger de Llúria to Bruc |
|---|---|---|---|
| Gran Via to Diputació | 1 | 2 | 3 |
| Diputació to Consell de Cent | 4 | 5 | 6 |
| Consell de Cent to Aragó | 7 | 8 | 9 |

It finds the blocks from the streets their addresses are on, so neighbouring blocks (Rambla de Catalunya, Girona, Casp, València sides) are left out. It takes a few minutes the first time (one Catastro call per plot); answers are cached in `address_cache.json`.

Outputs in `data\roof_test_set`: `roof_test_set.csv` (address, block, block_name, refcat, lat, lon, plot_m2), `roof_test_set.geojson` (QGIS) and `roof_test_set.png`. Check the PNG first: 9 coloured blocks in a 3 x 3 grid, numbered as above. The end of the printout lists each block with its number of plots and warns if it did not find exactly 9.

## All roofs, ranked

```
python -m step4.batch roofs.csv --laz-dir data\lidar --out data\yield
```

For the whole test set: `python -m step4.batch data\roof_test_set\roof_test_set.csv --laz-dir data\lidar --out data\yield`. Rows with `lat` and `lon` are found from that point, so Catastro's address spelling doesn't matter. A hand-made `roofs.csv` with just `address,block` still works. `data\yield\ranking.csv` lists every roof from most to least yearly kWh. A roof that fails is listed with its error.

Add `--web` to send every roof to the 3D map as well. `--block 5` runs only block 5. Already ran it without `--web`? `python -m web.export --all data\yield_all` sends the results you have, without running the LiDAR again.

## How the calculation works

1. **Sun path:** sun position for every hour of the year (`step4/sun.py`, same formulas as the 3D map).
2. **Horizon:** a 1 m height grid from all LiDAR points within 150 m. From each panel, 36 directions are walked outwards and the steepest angle to anything taller is kept.
3. **Shade:** the sun is blocked when it is lower than the horizon in its direction. Diffuse sky light is scaled by the share of open sky.
4. **Sun on the panel:** direct + diffuse + light reflected by the roof (albedo 0.2), on the tilted panel.
5. **Electricity:** 420 W per panel, minus heat losses (−0.35% per °C above 25 °C) and 14% system losses (PVGIS default).

## Checks to do (step 6)

- Compare yearly kWh with PVGIS for the same kWp, tilt and direction on 10 open roofs (target ±10%).
- Compare shade loss with Ladybug or Google Solar on a few shaded roofs.
- Numbers to tune: `step3/layout.py` (panel size, tilt, row spacing) and `step4/energy.py` (losses).

## Known limits

- Trees are solid in winter too (LiDAR is captured with leaves on).
- Panels on a roof the LiDAR misses (new buildings since 2023) are not shaded correctly.
- No snow, no soiling seasons, no inverter clipping.
