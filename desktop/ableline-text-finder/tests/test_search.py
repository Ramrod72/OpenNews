"""Search engine tests (real ripgrep, no GUI)."""

from __future__ import annotations

import os
import subprocess
import sys
import threading
from pathlib import Path

import pytest

from conftest import write
from textfinder.search import (
    Search, SearchError, Status, build_command, parse_extensions, parse_line, run_search, validate,
)


def paths(matches):
    return sorted(Path(m.path).name for m in matches)


def collect(opts, rg):
    found = []
    result = run_search(opts, found.extend, rg=rg)
    return result, found


# 1. Basic text search
def test_basic_search(rg, folder):
    write(folder / "a.txt", "alpha\nthe quick brown fox\nomega\n")
    write(folder / "b.txt", "nothing here\n")
    result, found = collect(validate(folder, "quick brown"), rg)
    assert result.status is Status.COMPLETE
    assert result.match_count == 1 and result.file_count == 1
    m = found[0]
    assert m.filename == "a.txt" and m.line_number == 2 and m.text == "the quick brown fox"
    assert Path(m.path).is_absolute()


def test_literal_not_regex(rg, folder):
    write(folder / "a.txt", "price: $5.00 (approx)\nprice: 5500\n")
    result, found = collect(validate(folder, "$5.00 (approx)"), rg)
    assert result.match_count == 1 and found[0].line_number == 1
    # A query that looks like an option is still a literal search term.
    write(folder / "b.txt", "use --help for help\n")
    result, found = collect(validate(folder, "--help"), rg)
    assert result.match_count == 1 and paths(found) == ["b.txt"]


def test_recursive_toggle(rg, folder):
    write(folder / "top.txt", "needle\n")
    write(folder / "sub" / "deep" / "inner.txt", "needle\n")
    _, found = collect(validate(folder, "needle", recursive=True), rg)
    assert paths(found) == ["inner.txt", "top.txt"]
    _, found = collect(validate(folder, "needle", recursive=False), rg)
    assert paths(found) == ["top.txt"]


# 2. Case-insensitive matching (default) and optional match-case
def test_case_insensitive_default(rg, folder):
    write(folder / "a.txt", "Hello\nHELLO\nhello\nhElLo world\nbye\n")
    result, _ = collect(validate(folder, "hello"), rg)
    assert result.match_count == 4
    result, _ = collect(validate(folder, "HELLO", case_sensitive=True), rg)
    assert result.match_count == 1


# 3. Multiple file extensions
def test_multiple_extensions(rg, folder):
    for name in ["a.txt", "b.CSV", "c.log", "d.json", "e.md", "f.py", "g.js", "h.xml"]:
        write(folder / name, "target\n")
    _, found = collect(validate(folder, "target", extensions="txt, .csv log"), rg)
    assert paths(found) == ["a.txt", "b.CSV", "c.log"]
    _, found = collect(validate(folder, "target", extensions=["json", "xml", "py", "js", "md"]), rg)
    assert paths(found) == ["d.json", "e.md", "f.py", "g.js", "h.xml"]
    _, found = collect(validate(folder, "target"), rg)
    assert len(found) == 8


def test_extension_validation():
    assert parse_extensions("TXT, .csv;  *.log txt") == ["txt", "csv", "log"]
    assert parse_extensions("") == []
    for bad in ["t?t", "a/b", "{txt,csv}", "..\\x", "[ab]"]:
        with pytest.raises(SearchError):
            parse_extensions(bad)


# 4. Unicode filenames and contents
def test_unicode(rg, folder):
    sub = folder / "Ünïcødé folder with spaces"
    write(sub / "résumé 日本語 файл.txt", "line one\nCafé naïve 東京 Привет\n")
    result, found = collect(validate(folder, "東京"), rg)
    assert result.status is Status.COMPLETE and result.match_count == 1
    assert found[0].filename == "résumé 日本語 файл.txt"
    assert "Café naïve 東京 Привет" == found[0].text
    assert os.path.isfile(found[0].path)
    # Case-insensitive search works for non-ASCII letters too.
    result, _ = collect(validate(folder, "ПРИВЕТ"), rg)
    assert result.match_count == 1


def test_malformed_text_and_binary(rg, folder):
    (folder / "latin1.txt").write_bytes(b"caf\xe9 target \xff\xfe broken\n")
    (folder / "bin.txt").write_bytes(b"target\x00\x01\x02binary")
    result, found = collect(validate(folder, "target"), rg)
    assert result.status is Status.COMPLETE
    assert paths(found) == ["latin1.txt"]           # binary file skipped
    assert "target" in found[0].text and "\ufffd" in found[0].text


def test_parse_line_bytes_payload():
    raw = (b'{"type":"match","data":{"path":{"text":"C:\\\\x\\\\a.txt"},'
           b'"lines":{"bytes":"aGVsbG8g/yB3b3JsZA0K"},"line_number":7,"submatches":[]}}')
    kind, m = parse_line(raw)
    assert kind == "match" and m.line_number == 7 and m.text == "hello \ufffd world"
    assert parse_line(b"not json") is None


# 5. Empty results
def test_empty_results(rg, folder):
    write(folder / "a.txt", "nothing to see\n")
    result, found = collect(validate(folder, "zebra"), rg)
    assert result.status is Status.NO_MATCHES and found == [] and result.match_count == 0
    assert result.summary() == "No matches found."


def test_empty_folder(rg, folder):
    result, found = collect(validate(folder, "anything"), rg)
    assert result.status is Status.NO_MATCHES and not found


def test_hidden_and_ignored_skipped(rg, folder):
    write(folder / ".hidden.txt", "secret\n")
    write(folder / ".ignore", "ignored.txt\n")
    write(folder / "ignored.txt", "secret\n")
    write(folder / "visible.txt", "secret\n")
    _, found = collect(validate(folder, "secret"), rg)
    assert paths(found) == ["visible.txt"]


def test_input_validation(folder, tmp_path):
    with pytest.raises(SearchError):
        validate("", "x")
    with pytest.raises(SearchError):
        validate(tmp_path / "missing", "x")
    write(folder / "f.txt", "x")
    with pytest.raises(SearchError):
        validate(folder / "f.txt", "x")
    with pytest.raises(SearchError):
        validate(folder, "   ")
    with pytest.raises(SearchError):
        validate(folder, "two\nlines")


def test_command_is_safe(folder):
    cmd = build_command(Path("rg"), validate(folder, "-rf; del *", extensions="txt"))
    assert "--fixed-strings" in cmd and "--no-config" in cmd and "--json" in cmd
    assert "--follow" not in cmd and "-L" not in cmd
    i = cmd.index("-e")
    assert cmd[i + 1] == "-rf; del *" and cmd[i + 2] == "--"


# 6. Cancellation
def test_cancellation(rg, folder):
    for i in range(400):
        write(folder / f"f{i:04}.txt", "match line\n" * 200)
    search = Search(validate(folder, "match", max_results=10_000_000), rg)
    batches = []

    def on_batch(b):
        batches.append(b)
        search.cancel()

    result = search.run(on_batch, batch_size=50)
    assert result.status is Status.CANCELLED
    assert result.match_count < 400 * 200
    assert search.returncode is not None            # process ended
    assert "incomplete" in result.summary()


def test_cancel_before_start(rg, folder):
    write(folder / "a.txt", "x\n")
    search = Search(validate(folder, "x"), rg)
    search.cancel()
    assert search.run().status is Status.CANCELLED


def test_cancel_from_other_thread(rg, folder):
    for i in range(300):
        write(folder / f"f{i:04}.txt", "match line\n" * 300)
    search = Search(validate(folder, "match", max_results=10_000_000), rg)
    started = threading.Event()
    timer = threading.Thread(target=lambda: (started.wait(10), search.cancel()))
    timer.start()
    result = search.run(lambda b: started.set())
    timer.join()
    assert result.status is Status.CANCELLED


# 7. Permission errors / inaccessible locations
def _deny_read(path: Path) -> bool:
    """Make a file unreadable; return False if this platform/user can still read it."""
    if os.name == "nt":
        user = os.environ.get("USERNAME") or "*S-1-1-0"
        if subprocess.run(["icacls", str(path), "/deny", f"{user}:(R)"], capture_output=True).returncode:
            return False
    else:
        path.chmod(0)
    try:
        path.read_bytes()
        return False
    except PermissionError:
        return True


def _restore(path: Path) -> None:
    if os.name == "nt":
        subprocess.run(["icacls", str(path), "/reset"], capture_output=True)
    else:
        path.chmod(0o644)


def test_permission_error_reported(rg, folder):
    write(folder / "ok.txt", "needle\n")
    locked = write(folder / "locked.txt", "needle\n")
    if not _deny_read(locked):
        _restore(locked)
        pytest.skip("cannot make a file unreadable for this user (e.g. running as root)")
    try:
        result, found = collect(validate(folder, "needle"), rg)
    finally:
        _restore(locked)
    assert paths(found) == ["ok.txt"]                       # rest of search still worked
    assert result.status is Status.COMPLETED_WITH_ERRORS    # never claims complete
    assert result.error_count >= 1 and any("locked.txt" in e for e in result.errors)
    assert "could not be read" in result.summary()


def test_inaccessible_path_reported(rg, folder):
    # Folder disappears between validation and search: reported, no crash.
    write(folder / "sub" / "a.txt", "needle\n")
    opts = validate(folder / "sub", "needle")
    (folder / "sub" / "a.txt").unlink()
    (folder / "sub").rmdir()
    result = run_search(opts, rg=rg)
    assert result.status in (Status.COMPLETED_WITH_ERRORS, Status.FAILED)
    assert result.status is not Status.COMPLETE


@pytest.mark.skipif(sys.platform == "win32", reason="symlink creation needs privileges on Windows")
def test_symlinks_not_followed(rg, folder, tmp_path):
    outside = tmp_path / "outside"
    write(outside / "o.txt", "needle\n")
    write(folder / "in.txt", "needle\n")
    (folder / "link").symlink_to(outside, target_is_directory=True)
    (folder / "loop").symlink_to(folder, target_is_directory=True)
    result, found = collect(validate(folder, "needle"), rg)
    assert paths(found) == ["in.txt"] and result.status is Status.COMPLETE


# 8. Large result sets
def test_large_result_set_truncated(rg, folder):
    for i in range(6):
        write(folder / f"big{i}.log", "error happened\n" * 2500)   # 15,000 matching lines
    batches = []
    result = run_search(validate(folder, "ERROR"), batches.append, rg=rg)
    total = sum(len(b) for b in batches)
    assert result.status is Status.TRUNCATED
    assert result.match_count == total == 10_000
    assert "limit" in result.summary()


def test_large_result_set_under_limit(rg, folder):
    write(folder / "big.csv", "row,value\n" * 9_000)
    result = run_search(validate(folder, "value"), rg=rg)
    assert result.status is Status.COMPLETE and result.match_count == 9_000


def test_long_lines_truncated(rg, folder):
    write(folder / "min.js", "x" * 50_000 + " needle " + "y" * 50_000 + "\n")
    _, found = collect(validate(folder, "needle"), rg)
    assert len(found) == 1 and len(found[0].text) <= 1_002


def test_files_never_modified(rg, folder):
    f = write(folder / "a.txt", "needle\n")
    before = (f.read_bytes(), f.stat().st_mtime_ns)
    run_search(validate(folder, "needle"), rg=rg)
    assert (f.read_bytes(), f.stat().st_mtime_ns) == before
    assert sorted(p.name for p in folder.iterdir()) == ["a.txt"]
