# DICOM Viewer

A desktop DICOM image viewer built with Electron and Node.js.

![Platform](https://img.shields.io/badge/platform-Windows-blue)
![Electron](https://img.shields.io/badge/Electron-28-47848F)
![License](https://img.shields.io/badge/license-GPL%20v2-blue)

## Features

### Image Display
- **Load DICOM files** via File menu (`Ctrl+O`)
- **Compressed format support**: JPEG Baseline, JPEG Lossless (Process 14/SV1), JPEG 2000
- **MONOCHROME1 → MONOCHROME2** auto-inversion with toggle
- **Zoom & Pan**: `Ctrl + Scroll` to zoom, left-drag to pan, auto-fit on load

### Window / Level
- Interactive histogram with draggable handles
  - Drag yellow edges to adjust Window Width
  - Drag center to adjust Window Center
- Reset to original DICOM tag values

### Display Options
- Image info overlay (patient, study, W/L, geometry)
- Smooth interpolation on zoom
- Manual invert
- Cursor pixel value display (HU)
- Physical scale ruler

### Layout
- **Resizable panels** — three drag handles:
  - Left/right divider between image and side panel
  - Top/bottom divider between histogram and info panel
- All dividers highlight blue on hover/drag

### Side Panel — Info Sections
| Section | Description |
|---|---|
| **Histogram** | Live W/C & W/W visualization with draggable handles |
| **渲染流程 Tags** | Tags used in render pipeline: pixel decode → Modality LUT → VOI LUT → photometric |
| **DICOM 影像資訊** | Patient, study, series, geometry, acquisition parameters |
| **所有 DICOM Tags** | Every tag in the file with ID, name, and value |

### All DICOM Tags Panel
- **2700+ tag name dictionary** sourced from the DICOM standard
- Displays tag ID, name, and decoded value (supports US/SS/UL/SL/FL/FD/AT VR types, multi-value)
- **Live search/filter** by tag ID, name, or value
- **Right-click context menu**:
  - Copy all visible tags (tab-separated, paste into Excel)
  - Copy selected row (ID + name + value)
  - Copy value only

### About
- Version info displayed in title bar, side panel header, and Help → About dialog

## Installation

**Requirements:** Node.js 18+

```bash
git clone https://github.com/anndymaktub/dicom-viewer-claude.git
cd dicom-viewer-claude
npm install
```

## Usage

```bash
# Development
npm start

# Build portable folder (electron-packager)
npm run dist

# Build single-file portable .exe (electron-builder)
npm run dist:portable
```

### Build outputs

| Command | Output | Description |
|---|---|---|
| `npm run dist` | `dist/DICOM Viewer-win32-x64/DICOM Viewer.exe` | Folder-based portable |
| `npm run dist:portable` | `dist/DICOM Viewer 1.0.0.exe` | Single-file portable exe |

### Building single-file exe on Windows

`npm run dist:portable` uses electron-builder with code signing disabled.
If you get a symlink permission error, use either of these methods:

**Method A — Run PowerShell as Administrator:**
```powershell
cd G:\dicom_veiwer_claude
$env:CSC_IDENTITY_AUTO_DISCOVERY="false"
npx electron-builder --win portable
```

**Method B — Enable Windows Developer Mode (recommended, one-time):**

Settings → System → For developers → Developer Mode → On

After enabling, `npm run dist:portable` will work in any terminal without admin rights.

## Tech Stack

| Library | Purpose |
|---|---|
| [Electron](https://www.electronjs.org/) | Desktop app framework |
| [dicom-parser](https://github.com/cornerstonejs/dicomParser) | DICOM file parsing |
| [jpeg-js](https://github.com/jpeg-js/jpeg-js) | JPEG Baseline decompression |
| [jpeg-lossless-decoder-js](https://github.com/rii-mango/JPEG-Lossless-Decoder-JS) | JPEG Lossless decompression |
| [@cornerstonejs/codec-openjpeg](https://github.com/cornerstonejs/codec-openjpeg) | JPEG 2000 decompression (WASM) |
| [electron-packager](https://github.com/electron/electron-packager) | Portable exe packaging |

## Supported Transfer Syntaxes

| UID | Format |
|---|---|
| 1.2.840.10008.1.2 | Implicit VR Little Endian |
| 1.2.840.10008.1.2.1 | Explicit VR Little Endian |
| 1.2.840.10008.1.2.2 | Explicit VR Big Endian |
| 1.2.840.10008.1.2.4.50 | JPEG Baseline (8-bit) |
| 1.2.840.10008.1.2.4.51 | JPEG Extended (12-bit) |
| 1.2.840.10008.1.2.4.57 | JPEG Lossless Process 14 |
| 1.2.840.10008.1.2.4.70 | JPEG Lossless SV1 |
| 1.2.840.10008.1.2.4.80 | JPEG-LS Lossless |
| 1.2.840.10008.1.2.4.81 | JPEG-LS Lossy |
| 1.2.840.10008.1.2.4.90 | JPEG 2000 Lossless |
| 1.2.840.10008.1.2.4.91 | JPEG 2000 Lossy |
| 1.2.840.10008.1.2.5 | RLE Lossless |

## License

GPL v2 © [Anndy](https://github.com/anndymaktub)
