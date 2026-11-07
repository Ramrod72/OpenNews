# PyInstaller spec for Ableline Text Finder (one-folder, windowed build).
# Run from the project root:  pyinstaller packaging/textfinder.spec --noconfirm
from pathlib import Path

root = Path(SPECPATH).parent
rg_dir = root / "vendor" / "ripgrep"
if not (rg_dir / "rg.exe").is_file():
    raise SystemExit("vendor/ripgrep/rg.exe not found - run: python packaging/fetch_ripgrep.py")

a = Analysis(
    [str(root / "run.py")],
    pathex=[str(root / "src")],
    datas=[(str(rg_dir), "ripgrep")],
    excludes=["tkinter", "PySide6.QtNetwork", "PySide6.QtQml", "PySide6.QtQuick",
              "PySide6.QtWebEngineCore", "PySide6.QtMultimedia", "PySide6.Qt3DCore",
              "PySide6.QtSql", "PySide6.QtTest"],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz, a.scripts, [],
    exclude_binaries=True,
    name="AblelineTextFinder",
    console=False,
    upx=False,
)
coll = COLLECT(exe, a.binaries, a.datas, upx=False, name="AblelineTextFinder")
