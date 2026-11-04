"""Offline tests for sending step 5c's communities to the map."""
import json

import pytest

from web.communities import export


def _csv(path, rows):
    cols = list(rows[0])
    path.write_text("\n".join([",".join(cols)] + [",".join(str(r[c]) for c in cols) for r in rows]) + "\n",
                    encoding="utf-8")


def _step5c(folder):
    folder.mkdir()
    _csv(folder / "communities.csv", [
        dict(community=1, host_address="CL BRUC 59", host_refcat="0629613DF3802H", block=6, panels=37, kwp=15.54,
             yearly_kwh=19463, kwh_per_kwp=1252, buildings=2, flats_joining=40, offices_schools_joining=1,
             cost_eur=21756, used_on_the_spot_pct=88.5, saving_eur_per_year=2900, payback_years=7.5,
             farthest_member_m=120, flags="grid permits likely needed (over 15 kW); host owners must approve other buildings' shares"),
    ])
    member = lambda ref, role, flats, nonhome, beta, d: dict(
        community=1, role=role, address="CL X", block=6, refcat=ref, type="home" if not nonhome else "home+office",
        distance_m=d, dwellings=20, flats_joining=flats, nonhome_joining=nonhome, beta_pct=beta, investment_eur=100,
        kwh_per_year=500, kwh_used_on_the_spot=450, covers_pct_of_their_use=18.2, saving_eur_per_year=70,
        per_flat_investment_eur=540, per_flat_kwh=480, per_flat_saving_eur=72, payback_years="inf",
        payback_with_incentives_years=6.1, ibi_bonus_counted="no", participants=flats)
    _csv(folder / "members.csv", [member("0629612DF3802H0001AB", "guest", 32, "office", 70.0, 120),
                                  member("0629613DF3802H", "host", 8, "", 30.0, 0)])


def test_communities_json_has_groups_members_and_totals(tmp_path):
    _step5c(tmp_path / "communities")
    out, totals = export(tmp_path / "communities", tmp_path / "site" / "communities.json")
    d = json.loads(out.read_text(encoding="utf-8"))
    g = d["groups"][0]
    assert g["host"] == "0629613DF3802H" and g["kwp"] == 15.54 and g["yearly_kwh"] == 19463 and g["block"] == 6
    assert len(g["flags"]) == 2
    assert [m["role"] for m in g["members"]] == ["host", "guest"]          # host first
    assert g["members"][1]["refcat"] == "0629612DF3802H"                    # 14 characters
    assert g["members"][1]["nonhome_joining"] == "office" and g["members"][1]["payback_years"] is None
    assert totals["flats_joining"] == 40 and d["max_distance_m"] == 500 and d["participation"] == 0.4


def test_missing_step5c_says_what_to_run(tmp_path):
    with pytest.raises(SystemExit, match="step5.communities"):
        export(tmp_path / "nothing", tmp_path / "out.json")
