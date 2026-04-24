# DICOM Viewer

A desktop DICOM image viewer built with Electron and Node.js.

![Platform](https://img.shields.io/badge/platform-Windows-blue)
![Electron](https://img.shields.io/badge/Electron-28-47848F)
![License](https://img.shields.io/badge/license-GPL%20v2-blue)

## Features

### Image Display
- Load DICOM files via the File menu or `Ctrl+O`.
- Supports common uncompressed DICOM images and compressed transfer syntaxes including JPEG Baseline, JPEG Lossless, and JPEG 2000.
- JPEG 2000 decoding runs in a persistent worker so the UI stays responsive while large images load.
- Supports MONOCHROME1/MONOCHROME2 display handling with auto-inversion and a manual invert toggle.
- Zoom and pan the image:
  - `Ctrl + mouse wheel` zooms around the cursor.
  - Left-drag pans the image.
  - Images auto-fit to the viewport on load.
- Optional overlays for patient/study information, window/level, geometry, cursor pixel value, and physical scale ruler.

### Window / Level
- Live histogram visualization for Window Center and Window Width.
- Drag yellow histogram edges to adjust Window Width.
- Drag the yellow window region to adjust Window Center.
- Reset Window Center/Width to the original DICOM tag values.

### Histogram Navigation
- Histogram panel is resizable:
  - Drag the vertical divider to resize the image/side-panel split.
  - Drag the horizontal divider to resize histogram vs. info sections.
  - Drag the histogram corner grip to resize both width and height.
- Histogram zoom tools:
  - Use the magnifier buttons to zoom in/out.
  - Use the reset button to return to the full histogram range.
  - Use the mouse wheel over the histogram to zoom around the cursor.
- Histogram panning:
  - After zooming in, drag empty histogram space to pan the X-axis range.
  - Use the hand button to pan the whole histogram even when the window region fills the view.
- Existing Window Center/Width dragging remains separate from histogram pan/zoom behavior.

### Histogram Range Selection
- `Shift + drag` on the histogram to brush-select a value range.
- Matching pixels are highlighted on the main image in magenta.
- Pixels outside the selected range are dimmed so selected points are easier to see.
- The dim slider in the histogram toolbar adjusts how strongly non-selected pixels are darkened.
- The histogram shows the selected range and selected pixel count.
- The main image overlay shows selected HU range, pixel count, and percentage of the image.
- Press `Esc` to clear the selection.
- Export exact raw histogram value/count data from `Function > Export Raw Histogram CSV`.

### Display Options
- Image information overlay.
- Smooth interpolation on zoom.
- Manual invert.
- Cursor pixel value display in HU/modality values.
- Physical ruler based on pixel spacing when available.

### Side Panel Sections

| Section | Description |
|---|---|
| Histogram | Live W/C and W/W visualization with zoom, pan, brushing, and image highlighting |
| Rendering Pipeline Tags | Tags used for pixel decode, Modality LUT, VOI LUT, and photometric interpretation |
| DICOM Image Info | Patient, study, series, geometry, and acquisition parameters |
| All DICOM Tags | Every parsed tag in the file with ID, name, and value |

### All DICOM Tags Panel
- 2700+ tag name dictionary sourced from the DICOM standard.
- Displays tag ID, name, decoded value, and common numeric VR types.
- Live search/filter by tag ID, name, or value.
- Right-click context menu:
  - Copy all visible tags as tab-separated text for spreadsheet use.
  - Copy selected row.
  - Copy selected value only.

### About / Build Info
- Version is shown in the window title, side-panel header, and Help/About dialog.
- Build date is generated before `npm start`, `npm run dist`, and `npm run dist:portable`.

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

### Build Outputs

| Command | Output | Description |
|---|---|---|
| `npm run dist` | `dist/DICOM Viewer-win32-x64/DICOM Viewer.exe` | Folder-based portable app |
| `npm run dist:portable` | `dist/DICOM Viewer 1.0.0.exe` | Single-file portable exe |

### Building Single-File Exe On Windows

`npm run dist:portable` uses electron-builder with code signing disabled.
If you get a symlink permission error, use either of these methods:

**Method A - Run PowerShell as Administrator:**

```powershell
cd G:\dicom_veiwer_claude
$env:CSC_IDENTITY_AUTO_DISCOVERY="false"
npx electron-builder --win portable
```

**Method B - Enable Windows Developer Mode (recommended, one-time):**

Settings > System > For developers > Developer Mode > On

After enabling Developer Mode, `npm run dist:portable` should work in a normal terminal.

## Tech Stack

| Library | Purpose |
|---|---|
| [Electron](https://www.electronjs.org/) | Desktop app framework |
| [dicom-parser](https://github.com/cornerstonejs/dicomParser) | DICOM file parsing |
| [jpeg-js](https://github.com/jpeg-js/jpeg-js) | JPEG Baseline decompression |
| [jpeg-lossless-decoder-js](https://github.com/rii-mango/JPEG-Lossless-Decoder-JS) | JPEG Lossless decompression |
| [@cornerstonejs/codec-openjpeg](https://github.com/cornerstonejs/codec-openjpeg) | JPEG 2000 decompression (WASM) |
| [electron-packager](https://github.com/electron/electron-packager) | Folder-based portable packaging |
| [electron-builder](https://www.electron.build/) | Single-file portable packaging |

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
| 1.2.840.10008.1.2.4.90 | JPEG 2000 Lossless |
| 1.2.840.10008.1.2.4.91 | JPEG 2000 Lossy |

## License

GPL v2 (c) [Anndy](https://github.com/anndymaktub)
