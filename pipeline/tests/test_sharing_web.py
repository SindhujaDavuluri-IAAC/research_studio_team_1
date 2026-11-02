"""Offline tests for sending step 5's sharing groups to the map."""
import json

from web.sharing import export


def _write(path, rows):
    cols = list(rows[0])
    path.write_text("\n".join([",".join(cols)] + [",".join(str(r[c]) for c in cols) for r in rows]) + "\n",
                    encoding="utf-8")


def _step5(tmp_path):
    d = tmp_path / "sharing"
    d.mkdir()
    b = lambda ref, addr, group, use, solar, own, rec, surplus, cov: dict(
        address=addr, block=5, refcat=ref, group=group, dwellings=10, floors=6, predicted_use_kwh=use,
        solar_kwh=solar, self_consumed_kwh=own, received_kwh=rec, surplus_kwh=surplus, covered_pct=cov,
        exported_kwh_if_alone="")
    _write(d / "buildings.csv", [
        b("0629613DF3802H", "CL BRUC 59", 1, 30000, 19463, 9000, 0, 10463, 30.0),
        b("0629612DF3802H", "CL BRUC 57", 1, 25000, 0, 0, 6000, 0, 24.0),
        b("0629611DF3802H", "CL BRUC 55", "", 20000, 0, 0, 0, 0, 0.0),
    ])
    _write(d / "groups.csv", [dict(group=1, members=2, started_by="CL BRUC 59", addresses="CL BRUC 59 | CL BRUC 57",
                                   solar_kwh=19463, self_consumed_kwh=9000, shared_kwh=6000, exported_kwh=4463,
                                   use_kwh=55000, covered_pct=27.3)])
    roofs = tmp_path / "roof_test_set.csv"
    _write(roofs, [dict(address="CL BRUC 59", block=5, refcat="0629613DF3802H", lat=41.3935, lon=2.1712),
                   dict(address="CL BRUC 57", block=5, refcat="0629612DF3802H", lat=41.3933, lon=2.1714)])
    return d, roofs


def test_sharing_json_has_groups_members_and_totals(tmp_path):
    d, roofs = _step5(tmp_path)
    out, totals = export(d, roofs, 500, tmp_path / "site" / "sharing.json")
    r = json.loads(out.read_text(encoding="utf-8"))["rules"]["500"]
    g = r["groups"][0]
    assert g["starter"] == "0629613DF3802H" and g["members"] == ["0629613DF3802H", "0629612DF3802H"]
    assert g["shared_kwh"] == 6000 and g["covered_pct"] == 27.3
    assert r["buildings"]["0629612DF3802H"]["lat"] == 41.3933 and r["buildings"]["0629611DF3802H"]["group"] is None
    assert totals["covered_pct"] == round(100 * 15000 / 75000, 1) and totals["covered_alone_pct"] == 12.0
    assert totals["grid_kwh"] == 19463 - 9000 - 6000


def test_each_rule_is_kept(tmp_path):
    d, roofs = _step5(tmp_path)
    out = tmp_path / "sharing.json"
    export(d, roofs, 500, out)
    export(d, roofs, 2000, out)
    assert sorted(json.loads(out.read_text(encoding="utf-8"))["rules"]) == ["2000", "500"]
