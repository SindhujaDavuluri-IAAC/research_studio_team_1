"""Live check against the real services. Run from a laptop with internet:

    python smoke_test.py

Uses four Eixample buildings from our reading (Artés et al. 2017). No LiDAR
needed. If something fails, the message says which service and step.
"""
import json
import traceback
from dataclasses import asdict

from step1.find_building import find_building

ADDRESSES = [
    "Carrer de Girona 81, Barcelona",
    "Carrer d'Aragó 359, Barcelona",
    "Carrer d'Enric Granados 69, Barcelona",
    "Carrer de Letamendi 29, Barcelona",
]

ok = 0
for addr in ADDRESSES:
    print(f"\n=== {addr}")
    try:
        record, _ = find_building(addr)
        out = {k: v for k, v in asdict(record).items() if k != "footprint_wkt"}
        print(json.dumps(out, indent=2, default=str))
        ok += 1
    except Exception:
        traceback.print_exc()
print(f"\n{ok} of {len(ADDRESSES)} addresses worked")
