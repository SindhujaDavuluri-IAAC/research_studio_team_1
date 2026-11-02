# Roofscapes RePowered

IAAC MaAI · Research Studio "Operable Futures" · team 1: Breno, Sindhuja, Daria

A rooftop solar tool for Barcelona: which roofs in an area can carry panels, how much electricity they make after shade, and which nearby buildings can share it (2 km rule).

## Two parts

```
research_studio_team_1/
├── pipeline/   Python: from an address to panels and kWh (steps 1–5)
│   ├── step1/  find the building (Catastro, LiDAR)
│   ├── step2/  read the roof (LiDAR rules + AI model on the photo)
│   ├── step3/  lay out the panels
│   ├── step4/  shade and yield, hour by hour (PVGIS + LiDAR); the 9 blocks' roof list
│   ├── step5/  each building's use and sharing groups, hour by hour
│   ├── web/    send results to the map; download the study area
│   ├── tests/
│   └── examples/
└── website/    the 3D map of Barcelona with the Roof Report
    └── data/   our study area + one file per roof the pipeline ran
```

**The rule that keeps the map fast:** the heavy work happens once, in the pipeline. The website only shows the results. Each roof is one small file, opened only when someone clicks that roof, so adding roofs doesn't slow the map down.

## Quick start

**See the map:** open `website/index.html` with VS Code's Live Server (details in [website/README.md](website/README.md)).

**Run the pipeline** (details in [pipeline/README.md](pipeline/README.md)):

```
cd pipeline
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
python -m step4.weather
python -m step4.roof_test_set --out data\roof_test_set
python -m web.buildings
python -m step4.batch data\roof_test_set\roof_test_set.csv --laz-dir data\lidar --out data\yield_all --web
python -m step5.sharing
python -m web.sharing
```

## Where the project stands

| | Status |
|---|---|
| Step 1: find the building | done |
| Step 2: read the roof, LiDAR | done; tested on Roger de Llúria 56, Aragó 284 and 308 |
| Step 2: read the roof, AI model | code ready; needs labelled roofs to train |
| Step 3: panel layout | done |
| Step 4: shade and yield | done; tested on Bruc 59 and Diputació 311 |
| Roof list of the 9 blocks | done (`step4.roof_test_set`) |
| Step 5: use and sharing groups | first version done (use predicted from Catastro) |
| 3D map | four screens (Area, Building, Sharing, How it works) on the city's 3D model, with a time bar that moves the sun; fill in as the pipeline runs |
| Next | run steps 2–4 on every roof of the 9 blocks with `--web`; label roofs and train the AI model |
| Later | step 6: checks against PVGIS / Google Solar / an installer quote |
