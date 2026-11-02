from step4 import check_months as cm


def test_report_flags_a_cloudy_october():
    hourly = []
    for m in range(1, 13):
        g = 500 if m == 10 else 1000          # October half as sunny
        hourly += [{"time(UTC)": f"2010{m:02d}15:1200", "G(h)": g}] * 100
    tmy = {"outputs": {"tmy_hourly": hourly, "months_selected": [{"month": m, "year": 2010} for m in range(1, 13)]}}
    mr = {"outputs": {"monthly": [{"year": y, "month": m, "H(h)_m": 100.0} for y in (2005, 2006) for m in range(1, 13)]}}
    text = cm.report(tmy, mr)
    oct_line = next(l for l in text.splitlines() if l.startswith("Oct"))
    assert "50%" in oct_line and "unusual" in oct_line
    assert "unusual" not in next(l for l in text.splitlines() if l.startswith("Sep"))
