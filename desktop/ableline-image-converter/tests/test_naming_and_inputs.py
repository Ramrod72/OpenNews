from helpers import write_png
from ableline.inputs import collect_inputs
from ableline.naming import reserve_output_path, sanitize_stem


def test_reserve_creates_unique_names(out_dir):
    a = reserve_output_path(out_dir, "photo", ".jpg")
    b = reserve_output_path(out_dir, "photo", ".jpg")
    c = reserve_output_path(out_dir, "photo", ".jpg")
    assert [p.name for p in (a, b, c)] == ["photo.jpg", "photo (1).jpg", "photo (2).jpg"]
    assert all(p.exists() for p in (a, b, c))


def test_reserve_never_touches_existing(out_dir):
    existing = out_dir / "photo.jpg"
    existing.write_bytes(b"precious")
    new = reserve_output_path(out_dir, "photo", ".jpg")
    assert new != existing
    assert existing.read_bytes() == b"precious"


def test_sanitize_stem():
    assert sanitize_stem('a<b>c:"d|e?*') == "a_b_c__d_e__"
    assert sanitize_stem("CON") == "_CON"
    assert sanitize_stem("...") == "image"
    assert len(sanitize_stem("x" * 400)) == 150


def test_collect_inputs_filters_and_dedupes(src_dir):
    a = write_png(src_dir / "a.png", 2, 2)
    (src_dir / "notes.txt").write_text("hi")
    (src_dir / "sub").mkdir()
    write_png(src_dir / "sub" / "deep.png", 2, 2)
    got = collect_inputs([a, a, src_dir])
    assert [p.name for p in got.accepted] == ["a.png"]
    assert [p.name for p in got.skipped] == ["notes.txt"]


def test_collect_inputs_respects_already_queued(src_dir):
    a = write_png(src_dir / "a.png", 2, 2)
    b = write_png(src_dir / "b.png", 2, 2)
    got = collect_inputs([a, b], already=[a])
    assert [p.name for p in got.accepted] == ["b.png"]
