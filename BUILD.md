# Build instructions

## Requirements

- Windows 10/11 x64
- Python 3.10.x
- PyInstaller 6.22.3

## Build the local probe

From the repository root:

```powershell
python -m pip install "pyinstaller==6.22.3"
python -m PyInstaller --noconfirm --clean --onefile --noconsole --name WallCheck-Agent source\wallcheck-agent.py
```

The resulting executable is produced under `dist\WallCheck-Agent.exe` with PyInstaller's default output layout. For the portable package, place that executable in the package root next to the launcher scripts.

## Validate browser extension

```powershell
node --check browser-extension\content.js
node --check browser-extension\background.js
Get-Content browser-extension\manifest.json -Raw | ConvertFrom-Json | Out-Null
```

## Validate Python source

```powershell
python -m py_compile source\wallcheck-agent.py
```

## Notes on reproducibility

PyInstaller one-file executables are not guaranteed to be bit-for-bit reproducible across different Python/PyInstaller/Windows build environments. The GitHub Release therefore publishes the canonical binary ZIP and its SHA256 checksum.
