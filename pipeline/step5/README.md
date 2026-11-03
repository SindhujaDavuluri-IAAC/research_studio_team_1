# Step 5: predict building use, then share surplus sun between buildings

Step 4 gives every roof's solar output, hour by hour. Step 5 adds the other half: how much each building uses, and which buildings should share.

```
python -m step5.sharing --roofs data\roof_test_set\roof_test_set.csv --yield-dir data\yield_all --out data\sharing
```

Run it after `python -m step4.batch` has written `data\yield_all`. The first run asks Catastro for every building's dwellings and floors (a few minutes); after that the answers are cached. `--block 6` limits it to one block, and `--max-distance 5000` uses the 5 km rule instead of 500 m.

## 5a. Predicting use (`step5/demand.py`)

We have no meter data, so use is predicted from Catastro:

| Input | From | Used for |
|---|---|---|
| dwellings | Catastro INSPIRE buildings | number of flats |
| floors, footprint | Catastro building parts | flat size, ground-floor shop area |
| main use | Catastro | homes, or offices/shops |

- Each flat: 1,000 kWh/yr + 18 kWh per m2 (85 m2 flat: about 2,500 kWh/yr).
- Ground floor of buildings with 3+ floors: shops at 100 kWh per m2 a year.
- Spread over the year with a day shape (homes peak in the evening, shops are open 9:00-20:00 Monday to Saturday), weekends, and a month factor (more in winter and in July and August).

**The yearly numbers are first estimates, all at the top of `demand.py`.** The daily and seasonal pattern can already come from real meter data:

```
python -m step5.bcn_data
```

This downloads Open Data BCN's electricity use by postal code, sector and time band (Datadis meters), keeps our postal codes (08007, 08009, 08010), and learns for homes and for services how use splits over the day (00-06, 06-12, 12-18, 18-24), across months, and on weekends. It saves `data\weather\bcn_usage_profile.json`, which `step5.sharing` then uses automatically.

 Next step to make this the AI part: calibrate against Open Data BCN's electricity use by postal code, sector and time band (dataset `consum-electricitat-bcn`, postal codes 08007, 08009, 08010), then train a model on Datadis meter data from buildings that agree to share it.

## 5b. Sharing groups (`step5/sharing.py`)

Hour by hour, for every building:
1. its own panels first cover its own use,
2. any surplus goes to other members of its sharing group, split in proportion to what each still needs (hourly coefficients, allowed since 2021),
3. what nobody in the group needs goes to the grid.

Groups start from the building with the most surplus and keep adding the neighbour that takes up the most of the remaining surplus, until another member would add less than 200 kWh a year (or 12 members). Every member must be within 500 m of every other member: the original RD 244/2019 limit, so the groups are legal under the later 1 km, 2 km and 5 km rules too.

## Outputs (`data\sharing`)

- `groups.csv`: each group, who started it, its members, solar kWh, kWh used in the buildings that made it, kWh shared with neighbours, kWh to the grid, and how much of the group's use solar covers.
- `buildings.csv`: each building's predicted use, solar, self-consumed, received, and % covered.
- The printout ends with the totals for the whole area, with and without sharing.

## 5c. Co-investment communities (`step5/communities.py`)

This is the version the team chose on 3 Nov 2026: panels go only on the roofs that produce the most per panel, and neighbours co-invest in them for a fixed share of the output.

```
python -m step5.communities --yield-dir data\yield_all_v2 --out data\communities
```

It takes a few seconds. It reuses `data\sharing\buildings_demand_cache.json` from the earlier step 5 run, so it does not ask Catastro again.

1. **Hosts:** the 10 roofs with the highest kWh per kWp, with at least 5 kWp (`--hosts`, `--min-kwp`).
2. **Members:** first 40% of the host building's own flats (`--participation`), then neighbours ring by ring outwards (150 m rings). In each ring, offices and schools come first, because they use power in sunny hours while homes peak in the morning and evening. Offices and schools take at most 20% each and 40% together, so most shares go to flats. Members are added until their use in sunny hours matches the roof's output.
3. **Shares:** every member gets a fixed share (beta) for the whole year and pays the same share of the cost.
4. **Legal rules (see the legal check doc):** members within 500 m of the host minus a 50 m margin (`--max-distance 5000` for the 5 km rule); each building in one community only; flags for permits over 15 kW, no bill credit over 100 kW, and the host owners' approval. The IBI bonus is counted only for flats in the host building.

Building types come from Catastro's main use: `4_1_office` = office (8:00-18:00 weekdays), `4_3_publicServices` = school-like hours (8:00-17:00 weekdays, closed July, August and Christmas). To mark a school or office by hand, add it to `data\building_types.csv` (`refcat,type`).

Outputs in `data\communities`: `communities.csv` (one row per community), `members.csv` (one row per member building: role, type, distance, flats joining, beta, investment, kWh, savings, payback with and without incentives), `communities.png` (the map), `communities.geojson` (for QGIS or the 3D map).

All prices are ASSUMPTIONS at the top of the file: 1,400 EUR per kWp, 0.16 EUR per kWh used, 0.05 EUR per surplus kWh, IBI 300 EUR per flat a year. The "used on the spot" figure is optimistic because predicted use is a smooth average day, not real meter data.
