"""Offline tests for reading EPW weather files (Ladybug EPW Map / climate.onebuilding.org)."""
import json
import zipfile

import numpy as np
import pytest

from step4.weather import compare, load_epw, load_tmy, monthly_sun

HEADER = [
    "LOCATION,Barcelona,CT,ESP,SRC-TMYx,081800,41.418,2.124,1.0,98.0",
    "DESIGN CONDITIONS,0", "TYPICAL/EXTREME PERIODS,0", "GROUND TEMPERATURES,0",
    "HOLIDAYS/DAYLIGHT SAVINGS,No,0,0,0", "COMMENTS 1,test", "COMMENTS 2,test",
    "DATA PERIODS,1,1,Data,Sunday, 1/ 1,12/31",
]
DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]


def _epw(path, ghi_noon=800.0, temp=15.0):
    """A fake year: sun only in the hour ending at 13:00 local, so its UTC time is easy to check."""
    rows = []
    for m, n in enumerate(DAYS, 1):
        for d in range(1, n + 1):
            for h in range(1, 25):
                g = ghi_noon if h == 13 else 0.0
                rows.append(f"2015,{m},{d},{h},60,?9,{temp},5,70,101300,0,0,300,{g},{g * 0.8},{g * 0.2}"
                            + ",0" * 19)
    path.write_text("\n".join(HEADER + rows) + "\n", encoding="latin-1")
    return path


def _pvgis(path, ghi_noon=800.0):
    rows = []
    t = np.arange(np.datetime64("2023-01-01T00:00"), np.datetime64("2024-01-01T00:00"), np.timedelta64(1, "h"))
    for x in t:
        s = str(x)
        g = ghi_noon if s[11:13] == "11" else 0.0
        rows.append({"time(UTC)": f"2010{s[5:7]}{s[8:10]}:{s[11:13]}00", "G(h)": g, "Gb(n)": g * 0.8,
                     "Gd(h)": g * 0.2, "T2m": 15.0})
    path.write_text(json.dumps({"outputs": {"tmy_hourly": rows}}), encoding="utf-8")
    return path


def test_epw_reads_8760_hours_in_utc(tmp_path):
    w = load_epw(_epw(tmp_path / "bcn.epw"))
    assert len(w) == 8760
    assert np.all(np.diff(w.times) == np.timedelta64(60, "m"))
    assert str(w.times[0]) == "2023-01-01T00:30"
    # hour ending 13:00 local (UTC+1) is 11:00-12:00 UTC, middle 11:30
    lit = w.times[w.ghi > 0]
    assert {str(t)[11:] for t in lit} == {"11:30"}
    assert w.source == "EPW Barcelona"
    assert w.dni.max() == pytest.approx(640.0)


def test_epw_and_pvgis_line_up(tmp_path):
    a = load_tmy(_pvgis(tmp_path / "tmy.json"))
    b = load_tmy(_epw(tmp_path / "bcn.epw"))
    assert np.array_equal(a.times, b.times)
    assert np.allclose(a.ghi, b.ghi)
    sa, sb = compare(tmp_path / "bcn.epw", tmp_path / "tmy.json")
    assert np.allclose(sa, sb)
    assert monthly_sun(b)[0] == pytest.approx(31 * 0.8)


def test_epw_inside_zip(tmp_path):
    epw = _epw(tmp_path / "ESP_CT_Barcelona.081800_TMYx.epw")
    z = tmp_path / "ESP_CT_Barcelona.081800_TMYx.zip"
    with zipfile.ZipFile(z, "w") as f:
        f.write(epw, epw.name)
        f.writestr("readme.txt", "x")
    assert len(load_tmy(z)) == 8760


def test_epw_missing_values_filled_or_refused(tmp_path):
    p = _epw(tmp_path / "bcn.epw")
    lines = p.read_text(encoding="latin-1").splitlines()
    parts = lines[8 + 12].split(",")
    parts[13] = "9999"
    lines[8 + 12] = ",".join(parts)
    p.write_text("\n".join(lines), encoding="latin-1")
    w = load_epw(p)
    assert np.isfinite(w.ghi).all()

    for i in range(8, 8 + 100):
        parts = lines[i].split(",")
        parts[6] = "99.9"
        lines[i] = ",".join(parts)
    p.write_text("\n".join(lines), encoding="latin-1")
    with pytest.raises(SystemExit):
        load_epw(p)
