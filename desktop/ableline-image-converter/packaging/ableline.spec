# PyInstaller spec for Ableline Image Converter (one-folder, windowed build).
# Run from the project root:  pyinstaller packaging/ableline.spec --noconfirm
from pathlib import Path

root = Path(SPECPATH).parent
datas = [
    (str(root / "src" / "ableline" / "resources"), "resources"),
    (str(root / "licenses"), "licenses"),
]
vendor = root / "vendor" / "imagemagick"
if (vendor / "magick.exe").is_file():
    datas.append((str(vendor), "imagemagick"))
else:
    print("WARNING: vendor/imagemagick/magick.exe not found - building WITHOUT bundled ImageMagick.")

a = Analysis(
    [str(root / "run.py")],
    pathex=[str(root / "src")],
    datas=datas,
    excludes=["tkinter", "PySide6.QtNetwork", "PySide6.QtQml", "PySide6.QtQuick",
              "PySide6.QtWebEngineCore", "PySide6.QtMultimedia", "PySide6.Qt3DCore"],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz, a.scripts, [],
    exclude_binaries=True,
    name="AblelineImageConverter",
    console=False,
    upx=False,
)
coll = COLLECT(exe, a.binaries, a.datas, upx=False, name="AblelineImageConverter")
