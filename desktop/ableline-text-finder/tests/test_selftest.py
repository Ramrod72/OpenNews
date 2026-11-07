import json

from textfinder.app import self_test


def test_self_test(rg, tmp_path):
    out = tmp_path / "report.json"
    assert self_test(str(out)) == 0
    report = json.loads(out.read_text(encoding="utf-8"))
    assert report["ok"] and report["matches"] == 2
