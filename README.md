# DICOM Viewer

A desktop DICOM image viewer built with Electron and Node.js.

![Platform](https://img.shields.io/badge/platform-Windows-blue)
![Electron](https://img.shields.io/badge/Electron-28-47848F)
![License](https://img.shields.io/badge/license-GPL%20v2-blue)

## Features

- **Load DICOM files** via File menu (`Ctrl+O`)
- **Compressed format support**: JPEG Baseline, JPEG Lossless (Process 14/SV1), JPEG 2000
- **Window / Level control** with interactive histogram
  - Drag the yellow handles on the histogram to adjust WW
  - Drag the center region to adjust WC
  - Reset to original DICOM tag values
- **MONOCHROME1 → MONOCHROME2** auto-inversion with toggle
- **Zoom & Pan**: `Ctrl + Scroll` to zoom, left-drag to pan, auto-fit on load
- **Display options**:
  - Image info overlay (patient, study, W/L, geometry)
  - Smooth interpolation on zoom
  - Manual invert
  - Cursor pixel value display (HU)
  - Physical scale ruler
- **Resizable side panel** — drag the divider between image and panel
- **Rendering pipeline Tags panel** — shows every tag used in the render path (pixel decode → Modality LUT → VOI LUT → photometric interpretation)
- **DICOM metadata panel** — patient, study, series, geometry, acquisition parameters
- **All DICOM Tags panel** — lists every tag in the file with ID, name, and value; includes 400+ tag name dictionary with live search/filter

## Screenshots

> Load a DICOM file via **檔案 → 載入** (or `Ctrl+O`)

## Installation

**Requirements:** Node.js 18+

```bash
git clone https://github.com/anndymaktub/dicom-viewer-claude.git
cd dicom-viewer-claude
npm install
```

## Usage

```bash
npm start
```

## Tech Stack

| Library | Purpose |
|---|---|
| [Electron](https://www.electronjs.org/) | Desktop app framework |
| [dicom-parser](https://github.com/cornerstonejs/dicomParser) | DICOM file parsing |
| [jpeg-js](https://github.com/jpeg-js/jpeg-js) | JPEG Baseline decompression |
| [jpeg-lossless-decoder-js](https://github.com/rii-mango/JPEG-Lossless-Decoder-JS) | JPEG Lossless decompression |
| [@cornerstonejs/codec-openjpeg](https://github.com/cornerstonejs/codec-openjpeg) | JPEG 2000 decompression (WASM) |

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

GPL v2 © [Anndy](https://github.com/anndymaktub)
