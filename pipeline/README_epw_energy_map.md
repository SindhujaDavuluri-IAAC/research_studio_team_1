# EPW weather option and city energy map benchmark (2026-11-04)

Extract this zip inside `research_studio_team_1\pipeline` (it replaces `step4\weather.py`
and adds `step4\energy_map.py` plus two test files). Nothing changes for runs without
the new options: PVGIS stays the default weather.

## 1. EPW weather (Ladybug EPW Map, Barcelona CT 081800 TMYx)

Compare the two typical years first (seconds, no internet):

    python -m step4.weather --compare data\weather\ESP_CT_Barcelona.081800_TMYx.epw

Run one roof or the whole test set on the EPW year (the .zip works too):

    python -m step4.shade_yield "Carrer del Bruc 59, Barcelona" --laz-dir data\lidar --weather data\weather\ESP_CT_Barcelona.081800_TMYx.epw --out bruc59_epw
    python -m step4.batch data\roof_test_set\roof_test_set.csv --laz-dir data\lidar --weather data\weather\ESP_CT_Barcelona.081800_TMYx.epw --out data\yield_epw

(The batch is the usual ~15 minutes.)

## 2. Barcelona Mapa d'Energia benchmark

The viewer keeps its roof data in CARTO (table `fotovoltaica`). The script reads the
viewer's config.js to find it, downloads every PV roof polygon around our blocks once
(`data\energy_map\fotovoltaica.geojson`) and adds them up per Catastro plot.
Needs internet on the laptop.

    python -m step4.energy_map --discover
    python -m step4.energy_map --address "Carrer del Bruc 59, Barcelona"
    python -m step4.energy_map data\roof_test_set\roof_test_set.csv --ranking data\yield_all_v2\ranking.csv --out data\energy_map

Output `data\energy_map\energy_map.csv`: our kWh, kWp and usable m2 next to the city's
(energia_ge kWh/yr, potencia_i kW, superfici1 m2), plus the city's radiation, investment
and saving. The run also prints total MWh for both and how well the rankings agree.

Tests: `python -m pytest tests\test_weather_epw.py tests\test_energy_map.py tests\test_step4.py`
