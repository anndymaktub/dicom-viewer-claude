'use strict';

const { ipcRenderer } = require('electron');
const fs   = require('fs');
const path = require('path');
const dicomParser = require('dicom-parser');
const { version } = require('./package.json');

// ==================== Decode Worker ====================
// Persistent Web Worker for J2K WASM decode + rescale (keeps main thread free).
// nodeIntegrationInWorker: true in main.js gives the worker access to require().
let _decodeWorker   = null;
let _decodeWorkerCb = null;  // { resolve, reject } for the in-flight request

function getDecodeWorker() {
  if (_decodeWorker) return _decodeWorker;
  _decodeWorker = new Worker('./decode-worker.js');
  _decodeWorker.onmessage = ({ data }) => {
    const cb = _decodeWorkerCb;
    _decodeWorkerCb = null;
    if (!cb) return;
    if (data.ok) cb.resolve(data);
    else         cb.reject(new Error(data.message));
  };
  _decodeWorker.onerror = (err) => {
    const cb = _decodeWorkerCb;
    _decodeWorkerCb = null;
    _decodeWorker   = null;  // allow recreation on next call
    if (cb) cb.reject(err);
  };
  return _decodeWorker;
}

function decodeInWorker(frameData, bitsAllocated, pixelRepresentation, slope, intercept) {
  return new Promise((resolve, reject) => {
    _decodeWorkerCb = { resolve, reject };
    // Copy frameData into a standalone ArrayBuffer for transfer (zero-copy to worker).
    const buf = new ArrayBuffer(frameData.length);
    new Uint8Array(buf).set(frameData);
    getDecodeWorker().postMessage({ frameData: buf, bitsAllocated, pixelRepresentation, slope, intercept }, [buf]);
  });
}

// ==================== State ====================
const state = {
  // Image data
  pixelValues: null,      // Float32Array of modality values (after rescale)
  colorPixels: null,      // Uint8Array RGBRGB... (for color images)
  imageWidth: 0,
  imageHeight: 0,

  // Window / Level
  windowCenter: 0,
  windowWidth: 1,
  originalWC: 0,
  originalWW: 1,

  // Histogram axis range
  histXMin: 0,
  histXMax: 1,
  pixelMin: 0,
  pixelMax: 1,

  // View transform (zoom + pan)
  scale: 1,
  tx: 0,
  ty: 0,

  // Pan interaction
  isPanning: false,
  panStartX: 0,
  panStartY: 0,
  panStartTx: 0,
  panStartTy: 0,

  // Histogram W/C drag interaction
  histDragging: null,     // null | 'left' | 'right' | 'center'
  histDragStartX: 0,
  histDragStartWC: 0,
  histDragStartWW: 0,
  histCursorX: null,
  histCursorY: null,

  // Photometric interpretation
  photometricInterp: 'MONOCHROME2',
  invertMono1: true,

  // Display options
  showInfoOverlay:   true,
  smoothInterp:      true,
  manualInvert:      false,
  showPixelValue:    true,
  showRuler:         false,

  // Cursor tracking
  cursorImgX:        -1,
  cursorImgY:        -1,
  cursorPixelValue:  null,

  // DICOM metadata (populated on load)
  dicomMeta: {},

  // Rendering pipeline parameters (populated on load)
  renderPipeline: null,
};

// ==================== DOM References ====================
const mainContainer = document.getElementById('mainContainer');
const mainCanvas    = document.getElementById('mainCanvas');
const mainCtx       = mainCanvas.getContext('2d');
const histContainer = document.getElementById('histContainer');
const histCanvas    = document.getElementById('histCanvas');
const histCtx       = histCanvas.getContext('2d');
const wcDisplay          = document.getElementById('wcDisplay');
const wwDisplay          = document.getElementById('wwDisplay');
const resetBtn           = document.getElementById('resetBtn');
const statusBar          = document.getElementById('statusBar');
document.getElementById('subPanelTitle').textContent = `DICOM Viewer v${version}`;
const dicomInfoSection   = document.getElementById('dicomInfoSection');
const dicomInfoGrid      = document.getElementById('dicomInfoGrid');

// Offscreen canvas for window/level rendered pixels
let offscreenCanvas = null;

// Histogram display data: fixed-size bins used only for drawing bars.
let histogramData = null;

// Raw DICOM histogram stats: exact counts by modality value, used for hover readout.
let histogramStats = null;

// Histogram drawing margins (in canvas pixels)
const M = { left: 58, right: 14, top: 18, bottom: 46 };

// ==================== Compressed DICOM Decoders ====================

/** Return Transfer Syntax UID, defaulting to Explicit VR Little Endian */
function getTransferSyntaxUID(dataSet) {
  const uid = dataSet.string('x00020010');
  return uid ? uid.trim().replace(/\0/g, '') : '1.2.840.10008.1.2.1';
}

/**
 * Extract the first image frame from an encapsulated pixel data element.
 * Works around different dicom-parser versions and BOT layouts.
 */
function extractEncapsulatedFrame(dataSet, element) {
  // Preferred: use dicom-parser built-in helper (requires non-empty BOT)
  try {
    const frame = dicomParser.readEncapsulatedImageFrame(dataSet, element, 0);
    if (frame && frame.length > 0) return frame;
  } catch (_) { /* fall through — common when BOT is empty */ }

  // dicom-parser exposes fragments on `.fragments` (not `.items`)
  const fragments = element.fragments;
  if (fragments && fragments.length > 0) {
    // Empty BOT + single-frame file: concatenate all fragments.
    try {
      return dicomParser.readEncapsulatedPixelDataFromFragments(
        dataSet, element, 0, fragments.length
      );
    } catch (_) { /* fall through */ }

    // Fallback: scan fragments for JPEG/J2K start-of-image markers
    const d = dataSet.byteArray;
    for (const frag of fragments) {
      if (!frag.length || frag.length < 4) continue;
      const off = frag.position !== undefined ? frag.position : frag.dataOffset;
      // JPEG SOI = FF D8  |  JPEG Lossless SOF = FF C3  |  J2K SOC = FF 4F
      if (off + 1 < d.length && d[off] === 0xFF &&
          (d[off + 1] === 0xD8 || d[off + 1] === 0xC3 || d[off + 1] === 0x4F)) {
        return d.slice(off, off + frag.length);
      }
    }
    // Last resort: use the first fragment
    const f0 = fragments[0];
    const off = f0.position !== undefined ? f0.position : f0.dataOffset;
    return d.slice(off, off + f0.length);
  }

  throw new Error('無法從封裝像素資料中提取影像幀（找不到 BOT 或 fragments）');
}

// ---- JPEG 2000 singleton ----
// Cache the Promise (not just the resolved value) to avoid duplicate WASM init
// when pre-warm and first file load overlap.
let _openJPEGPromise = null;

async function getOpenJPEGDecoder() {
  if (!_openJPEGPromise) {
    let factory;
    try {
      factory = require('@cornerstonejs/codec-openjpeg');
    } catch (e) {
      throw new Error('缺少 @cornerstonejs/codec-openjpeg，請執行 npm install');
    }
    const fn = factory.default || factory;
    _openJPEGPromise = (typeof fn === 'function' ? fn() : Promise.resolve(fn));
  }
  return _openJPEGPromise;
}

async function decodeJPEG2000Frame(frameData, bitsAllocated, pixelRepresentation) {
  const codec   = await getOpenJPEGDecoder();
  const decoder = new codec.J2KDecoder();
  try {
    const encBuf = decoder.getEncodedBuffer(frameData.length);
    encBuf.set(frameData);
    decoder.decode();

    const decodedBuf = decoder.getDecodedBuffer();
    // Copy out of WASM heap before decoder is deleted
    const raw = new Uint8Array(decodedBuf.buffer, decodedBuf.byteOffset, decodedBuf.byteLength);
    const own = new Uint8Array(raw.length);
    own.set(raw);

    let pixels;
    if (bitsAllocated <= 8) {
      pixels = pixelRepresentation === 1 ? new Int8Array(own.buffer) : own;
    } else {
      pixels = pixelRepresentation === 1
        ? new Int16Array(own.buffer)
        : new Uint16Array(own.buffer);
    }
    return { pixels };
  } finally {
    decoder.delete();
  }
}

/**
 * Decode a compressed DICOM frame into a typed array of pixel values.
 * Returns a Promise (async) to support JPEG 2000 WASM decoding.
 */
async function decodeCompressedFrame(frameData, tsUID, bitsAllocated, pixelRepresentation, samplesPerPixel = 1) {
  // ---- JPEG Baseline (Process 1 & 2-4) ----
  if (tsUID === '1.2.840.10008.1.2.4.50' || tsUID === '1.2.840.10008.1.2.4.51') {
    let jpegJs;
    try { jpegJs = require('jpeg-js'); }
    catch (e) { throw new Error('缺少 jpeg-js 模組，請執行 npm install'); }

    const decoded = jpegJs.decode(Buffer.from(frameData), { useTArray: true });
    // jpeg-js always outputs RGBA
    const pixelCount = decoded.width * decoded.height;
    if (samplesPerPixel <= 1) {
      const gray = new Uint8Array(pixelCount);
      for (let i = 0; i < pixelCount; i++) {
        gray[i] = decoded.data[i * 4]; // R channel
      }
      return { pixels: gray, width: decoded.width, height: decoded.height };
    }

    const rgb = new Uint8Array(pixelCount * 3);
    for (let i = 0; i < pixelCount; i++) {
      const src = i * 4;
      const dst = i * 3;
      rgb[dst] = decoded.data[src];
      rgb[dst + 1] = decoded.data[src + 1];
      rgb[dst + 2] = decoded.data[src + 2];
    }
    return { pixels: rgb, width: decoded.width, height: decoded.height };
  }

  // ---- JPEG Lossless (Process 14 & SV1) ----
  if (tsUID === '1.2.840.10008.1.2.4.57' || tsUID === '1.2.840.10008.1.2.4.70') {
    let lib;
    try { lib = require('jpeg-lossless-decoder-js'); }
    catch (e) { throw new Error('缺少 jpeg-lossless-decoder-js 模組，請執行 npm install'); }

    // Handle different module export shapes across versions
    let DecoderClass;
    if (lib.lossless && lib.lossless.Decoder) DecoderClass = lib.lossless.Decoder;
    else if (lib.Decoder)                      DecoderClass = lib.Decoder;
    else if (typeof lib === 'function')        DecoderClass = lib;
    else throw new Error('無法識別 jpeg-lossless-decoder-js 的匯出格式');

    const decoder    = new DecoderClass();
    const bytesPerPx = Math.ceil(bitsAllocated / 8);
    const resultBuf  = decoder.decode(
      frameData.buffer,
      frameData.byteOffset,
      frameData.byteLength,
      bytesPerPx
    );

    let pixels;
    if (bitsAllocated <= 8) {
      pixels = pixelRepresentation === 1 ? new Int8Array(resultBuf) : new Uint8Array(resultBuf);
    } else {
      pixels = pixelRepresentation === 1 ? new Int16Array(resultBuf) : new Uint16Array(resultBuf);
    }
    return { pixels, width: null, height: null }; // width/height taken from tags
  }

  // ---- JPEG 2000 Lossless / Lossy ----
  if (tsUID === '1.2.840.10008.1.2.4.90' || tsUID === '1.2.840.10008.1.2.4.91') {
    return await decodeJPEG2000Frame(frameData, bitsAllocated, pixelRepresentation);
  }

  // ---- Unsupported ----
  const names = {
    '1.2.840.10008.1.2.4.80': 'JPEG-LS Lossless',
    '1.2.840.10008.1.2.4.81': 'JPEG-LS Lossy',
    '1.2.840.10008.1.2.5'   : 'RLE Lossless',
  };
  const name = names[tsUID] || tsUID;
  throw new Error(
    `不支援的壓縮格式：${name}\n\n` +
    `目前支援：JPEG Baseline、JPEG Lossless (14/SV1)、JPEG 2000\n` +
    `可使用 DICOM 轉換工具（如 GDCM）將檔案轉為非壓縮格式後再開啟。`
  );
}

// ==================== IPC ====================
ipcRenderer.on('load-dicom-path', async (event, filePath) => {
  try {
    statusBar.textContent = `載入中: ${filePath}`;
    const nodeBuffer = fs.readFileSync(filePath);
    await loadDicom(nodeBuffer, filePath);
  } catch (err) {
    const msg = err.message || String(err);
    statusBar.textContent = `錯誤: ${msg}`;
    console.error(err);
    alert(`DICOM 載入失敗\n\n${msg}`);
  }
});

// ==================== DICOM Metadata Helpers ====================
function formatDicomName(raw) {
  if (!raw) return '';
  // DICOM name: Last^First^Middle^Prefix^Suffix  →  First Last
  const parts = raw.split('^');
  return [parts[1], parts[0]].filter(Boolean).join(' ') || raw;
}

function formatDicomDate(raw) {
  if (!raw || raw.length < 8) return raw || '';
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
}

function formatSpacing(raw) {
  if (!raw) return '';
  const parts = raw.replace(/\\/g, '\\').split(/[\\,]/).map(v => parseFloat(v).toFixed(3));
  return parts.join(' × ');
}

function getDicomTextEncoding(dataSet) {
  const charsetRaw = (dataSet.string('x00080005') || '').replace(/\0/g, '').trim().toUpperCase();
  const charsets = charsetRaw.split('\\').map(s => s.trim()).filter(Boolean);
  return charsets.includes('ISO_IR 192') ? 'utf-8' : 'big5';
}

const CUSTOM_CHARSET_TAGS = new Set([
  'X00100010', // Patient Name
  'X00080080', // Institution Name
]);

function readDicomString(dataSet, tag) {
  const normTag = String(tag || '').toUpperCase();
  if (!CUSTOM_CHARSET_TAGS.has(normTag)) {
    try {
      return (dataSet.string(tag) || '').replace(/\0/g, '').trim();
    } catch (_) {
      return '';
    }
  }

  try {
    const element = dataSet.elements[tag];
    if (!element || !element.length) return '';
    const start = element.dataOffset;
    const end = start + element.length;
    if (start < 0 || end > dataSet.byteArray.length) return '';
    const bytes = dataSet.byteArray.subarray(start, end);
    const decoder = new TextDecoder(getDicomTextEncoding(dataSet), { fatal: false });
    return decoder.decode(bytes).replace(/\0/g, '').trim();
  } catch (_) {
    try {
      return (dataSet.string(tag) || '').replace(/\0/g, '').trim();
    } catch (_) {
      return '';
    }
  }
}

function updateDicomInfoPanel(meta) {
  dicomInfoSection.style.display = 'block';
  dicomInfoGrid.innerHTML = '';

  const sections = [
    { header: '病患資訊' },
    { key: '姓名',   val: meta.patientName,     accent: true },
    { key: 'ID',     val: meta.patientId },
    { key: '生日',   val: meta.patientBirth },
    { key: '性別',   val: meta.patientSex },
    { header: '檢查資訊' },
    { key: '模態',   val: meta.modality,         accent: true },
    { key: '日期',   val: meta.studyDate },
    { key: '機構',   val: meta.institutionName },
    { key: '廠商',   val: meta.manufacturer },
    { key: '部位',   val: meta.bodyPart },
    { key: '研究',   val: meta.studyDesc },
    { key: '系列',   val: meta.seriesDesc },
    { key: '影像類型',val: meta.imageType },
    { header: '影像幾何' },
    { key: '尺寸',   val: meta.cols && meta.rows ? `${meta.cols} × ${meta.rows} px` : '' },
    { key: '位元深度',val: meta.bitsAllocated ? `${meta.bitsAllocated} bit` : '' },
    { key: '光度詮釋',val: meta.photometric },
    { key: '像素間距',val: meta.pixelSpacing ? `${formatSpacing(meta.pixelSpacing)} mm` : '', accent: true },
    { key: '層厚',   val: meta.sliceThickness ? `${meta.sliceThickness} mm` : '', accent: true },
    { key: '層位置', val: meta.sliceLocation ? `${parseFloat(meta.sliceLocation).toFixed(2)} mm` : '' },
    { key: '影像編號',val: meta.instanceNum },
    { header: '收錄參數' },
    { key: 'Rescale Slope',     val: meta.rescaleSlope !== '1' ? meta.rescaleSlope : '' },
    { key: 'Rescale Intercept', val: meta.rescaleIntercept !== '0' ? meta.rescaleIntercept : '' },
    { key: 'KVP',        val: meta.kvp     ? `${meta.kvp} kV`   : '' },
    { key: '管電流',     val: meta.tubeCurrent ? `${meta.tubeCurrent} mA` : '' },
    { key: '曝光時間',   val: meta.exposureTime ? `${meta.exposureTime} ms` : '' },
    { key: 'Echo Time',  val: meta.echoTime  ? `${meta.echoTime} ms`  : '' },
    { key: 'Rep. Time',  val: meta.repTime   ? `${meta.repTime} ms`   : '' },
    { key: 'Flip Angle', val: meta.flipAngle ? `${meta.flipAngle}°`   : '' },
    { key: 'TS UID',     val: meta.transferSyntax ? meta.transferSyntax.split('.').slice(-2).join('.') : '' },
  ];

  for (const item of sections) {
    if (item.header) {
      const sep = document.createElement('div');
      sep.className = 'separator';
      dicomInfoGrid.appendChild(sep);
      const hdr = document.createElement('div');
      hdr.className = 'dk';
      hdr.style.cssText = 'grid-column:1/-1;color:#58a6ff;font-weight:700;font-size:10px;letter-spacing:1px;text-transform:uppercase;padding-bottom:2px;';
      hdr.textContent = item.header;
      dicomInfoGrid.appendChild(hdr);
      continue;
    }
    if (!item.val) continue;
    const k = document.createElement('div'); k.className = 'dk'; k.textContent = item.key;
    const v = document.createElement('div'); v.className = item.accent ? 'dv accent' : 'dv'; v.textContent = item.val;
    dicomInfoGrid.appendChild(k);
    dicomInfoGrid.appendChild(v);
  }
}

// Transfer Syntax UID → human-readable name
const TS_NAMES = {
  '1.2.840.10008.1.2':      'Implicit VR Little Endian',
  '1.2.840.10008.1.2.1':    'Explicit VR Little Endian',
  '1.2.840.10008.1.2.2':    'Explicit VR Big Endian',
  '1.2.840.10008.1.2.4.50': 'JPEG Baseline (8-bit)',
  '1.2.840.10008.1.2.4.51': 'JPEG Extended (12-bit)',
  '1.2.840.10008.1.2.4.57': 'JPEG Lossless Process 14',
  '1.2.840.10008.1.2.4.70': 'JPEG Lossless SV1',
  '1.2.840.10008.1.2.4.80': 'JPEG-LS Lossless',
  '1.2.840.10008.1.2.4.81': 'JPEG-LS Lossy',
  '1.2.840.10008.1.2.4.90': 'JPEG 2000 Lossless',
  '1.2.840.10008.1.2.4.91': 'JPEG 2000 Lossy',
  '1.2.840.10008.1.2.5':    'RLE Lossless',
};

function updateRenderPipelinePanel(p) {
  const el = document.getElementById('renderPipelineGrid');
  if (!el) return;
  document.getElementById('renderPipelineSection').style.display = 'block';
  el.innerHTML = '';

  // Helper: append a row
  const row = (key, val, accent, tag) => {
    if (val === '' || val === undefined || val === null) return;
    const k = document.createElement('div');
    k.className = 'rp-key';
    if (tag) {
      k.textContent = key;
      const sp = document.createElement('span');
      sp.className = 'rp-tag';
      sp.textContent = `(${tag})`;
      k.appendChild(sp);
    } else {
      k.textContent = key;
    }
    const v = document.createElement('div');
    v.className = accent ? 'rp-val accent' : 'rp-val';
    v.textContent = val;
    el.appendChild(k); el.appendChild(v);
  };
  const sep = (label) => {
    const d = document.createElement('div');
    d.className = 'rp-sep';
    d.textContent = label;
    el.appendChild(d);
  };

  // ① 像素解碼
  sep('① 像素解碼');
  row('Transfer Syntax', `${TS_NAMES[p.tsUID] || p.tsUID}`, true, '0002,0010');
  row('壓縮',          p.isCompressed ? '是' : '否（原始）');
  row('Bits Allocated', `${p.bitsAllocated} bit`,  false, '0028,0100');
  row('Bits Stored',    `${p.bitsStored} bit`,      false, '0028,0101');
  row('High Bit',       `${p.highBit}`,             false, '0028,0102');
  row('Pixel Rep.',     p.pixelRepresentation === 1 ? 'Signed (1)' : 'Unsigned (0)', false, '0028,0103');
  row('Samples/Pixel',  `${p.samplesPerPixel}`,     false, '0028,0002');
  row('Endian',         p.isBigEndian ? 'Big Endian' : 'Little Endian');

  // ② Modality LUT (Rescale)
  sep('② Modality LUT (Rescale)');
  const hasRescale = p.rescaleSlope !== 1 || p.rescaleIntercept !== 0;
  row('Rescale Slope',     `${p.rescaleSlope}`,     hasRescale, '0028,1053');
  row('Rescale Intercept', `${p.rescaleIntercept}`, hasRescale, '0028,1052');
  row('Rescale Type',      p.rescaleType || '—',    false,       '0028,1054');
  row('像素值範圍',        (p.pixelMin != null && p.pixelMax != null) ? `${p.pixelMin.toFixed(0)} ～ ${p.pixelMax.toFixed(0)}` : '—', true);
  row('值域說明',          p.rescaleType === 'HU' ? 'Hounsfield Unit (CT)' :
                           p.rescaleType === 'US' ? 'Unspecified' : '');

  // ③ VOI LUT (Window / Level)
  sep('③ VOI LUT (Window / Level)');
  row('Window Center',  p.wcFromTag != null ? `${p.wcFromTag.toFixed(0)}` : '—', true,  '0028,1050');
  row('Window Width',   p.wwFromTag != null ? `${p.wwFromTag.toFixed(0)}` : '—', true,  '0028,1051');
  row('WC/WW 來源',     p.wcWwSource);
  row('WW 說明',        p.wwExplanation || '',        false, '0028,1055');
  row('顯示下限',       (p.wcFromTag != null && p.wwFromTag != null) ? `${(p.wcFromTag - p.wwFromTag / 2).toFixed(0)}` : '—');
  row('顯示上限',       (p.wcFromTag != null && p.wwFromTag != null) ? `${(p.wcFromTag + p.wwFromTag / 2).toFixed(0)}` : '—');

  // ④ 光度詮釋
  sep('④ 光度詮釋');
  row('Photometric Interp.', p.photometric, true, '0028,0004');
  row('Pixel Aspect Ratio',  p.pixelAspectRatio || '1:1', false, '0028,0034');
  row('Planar Config.',      p.samplesPerPixel > 1
        ? (p.planarConfig === 1 ? '1 (分離平面)' : '0 (交錯像素)') : '',
      false, '0028,0006');
  row('MONO1 自動反轉',      p.photometric === 'MONOCHROME1' ? '是（預設）' : '不適用');
}

// ==================== All Tags Panel ====================

// DICOM tag dictionary
const TAG_NAMES = {
  // --- File Meta (0002) ---
  '00020000':'File Meta Information Group Length','00020001':'File Meta Information Version',
  '00020002':'Media Storage SOP Class UID','00020003':'Media Storage SOP Instance UID',
  '00020010':'Transfer Syntax UID','00020012':'Implementation Class UID',
  '00020013':'Implementation Version Name','00020016':'Source Application Entity Title',
  '00020017':'Sending Application Entity Title','00020018':'Receiving Application Entity Title',
  '00020026':'Source Presentation Address','00020027':'Sending Presentation Address',
  '00020028':'Receiving Presentation Address','00020100':'Private Information Creator UID',
  '00020102':'Private Information',
  // --- Identifying (0008) ---
  '00080001':'Length to End','00080005':'Specific Character Set','00080006':'Language Code Sequence',
  '00080008':'Image Type','00080010':'Recognition Code','00080012':'Instance Creation Date',
  '00080013':'Instance Creation Time','00080014':'Instance Creator UID',
  '00080015':'Instance Coercion DateTime','00080016':'SOP Class UID','00080018':'SOP Instance UID',
  '0008001A':'Related General SOP Class UID','0008001B':'Original Specialized SOP Class UID',
  '00080020':'Study Date','00080021':'Series Date','00080022':'Acquisition Date',
  '00080023':'Content Date','00080024':'Overlay Date','00080025':'Curve Date',
  '0008002A':'Acquisition DateTime','00080030':'Study Time','00080031':'Series Time',
  '00080032':'Acquisition Time','00080033':'Content Time','00080034':'Overlay Time',
  '00080035':'Curve Time','00080041':'Data Set Subtype','00080042':'Nuclear Medicine Series Type',
  '00080050':'Accession Number','00080051':'Issuer of Accession Number Sequence',
  '00080052':'Query/Retrieve Level','00080053':'Query/Retrieve View',
  '00080054':'Retrieve AE Title','00080055':'Station AE Title',
  '00080056':'Instance Availability','00080058':'Failed SOP Instance UID List',
  '00080060':'Modality','00080061':'Modalities in Study','00080062':'SOP Classes in Study',
  '00080064':'Conversion Type','00080068':'Presentation Intent Type',
  '00080070':'Manufacturer','00080080':'Institution Name','00080081':'Institution Address',
  '00080082':'Institution Code Sequence','00080090':'Referring Physician Name',
  '00080092':'Referring Physician Address','00080094':'Referring Physician Telephone Numbers',
  '00080096':'Referring Physician Identification Sequence',
  '0008009C':'Consulting Physician Name','0008009D':'Consulting Physician ID Sequence',
  '00081010':'Station Name','00081030':'Study Description','00081032':'Procedure Code Sequence',
  '0008103E':'Series Description','0008103F':'Series Description Code Sequence',
  '00081040':'Institutional Department Name','00081048':'Physician(s) of Record',
  '00081049':'Physician(s) of Record Identification Sequence',
  '00081050':'Performing Physician Name','00081052':'Performing Physician ID Sequence',
  '00081060':'Name of Physician(s) Reading Study','00081062':'Physician(s) Reading Study ID Sequence',
  '00081070':'Operators Name','00081072':'Operators Identification Sequence',
  '00081080':'Admitting Diagnoses Description','00081084':'Admitting Diagnoses Code Sequence',
  '00081090':'Manufacturer Model Name','00081100':'Referenced Results Sequence',
  '00081110':'Referenced Study Sequence','00081111':'Referenced Performed Procedure Step Sequence',
  '00081115':'Referenced Series Sequence','00081120':'Referenced Patient Sequence',
  '00081125':'Referenced Visit Sequence','00081130':'Referenced Overlay Sequence',
  '0008113A':'Referenced Waveform Sequence','00081140':'Referenced Image Sequence',
  '00081145':'Referenced Curve Sequence','0008114A':'Referenced Instance Sequence',
  '0008114B':'Referenced Real World Value Mapping Instance Sequence',
  '00081150':'Referenced SOP Class UID','00081155':'Referenced SOP Instance UID',
  '0008115A':'SOP Classes Supported','00081160':'Referenced Frame Number',
  '00081163':'Referenced Segment Number','00081164':'Referenced Frame of Reference UID',
  '00081167':'Simple Frame List','00081195':'Transaction UID',
  '00081196':'Warning Reason','00081197':'Failure Reason',
  '00081198':'Failed SOP Sequence','00081199':'Referenced SOP Sequence',
  '00081200':'Studies Containing Other Referenced Instances Sequence',
  '00081250':'Related Series Sequence','00082110':'Lossy Image Compression (Retired)',
  '00082111':'Derivation Description','00082112':'Source Image Sequence',
  '00082120':'Stage Name','00082122':'Stage Number','00082124':'Number of Stages',
  '00082127':'View Name','00082128':'View Number','00082129':'Number of Event Timers',
  '0008212A':'Number of Views in Stage','00082130':'Event Elapsed Time(s)',
  '00082132':'Event Timer Name(s)','00082133':'Event Timer Sequence',
  '00082134':'Event Time Offset','00082135':'Event Code Sequence',
  '00082142':'Start Trim','00082143':'Stop Trim','00082144':'Recommended Display Frame Rate',
  '00082200':'Transducer Position','00082204':'Transducer Orientation',
  '00082208':'Anatomic Structure','00082218':'Anatomic Region Sequence',
  '00082220':'Anatomic Region Modifier Sequence','00082228':'Primary Anatomic Structure Sequence',
  '00082229':'Anatomic Structure Space or Region Sequence',
  '00082230':'Primary Anatomic Structure Modifier Sequence',
  '00082240':'Transducer Position Sequence','00082242':'Transducer Position Modifier Sequence',
  '00082244':'Transducer Orientation Sequence','00082246':'Transducer Orientation Modifier Sequence',
  '00082251':'Anatomic Structure Space or Region Code Sequence Trial',
  '00082253':'Anatomic Portal of Entrance Code Sequence Trial',
  '00082255':'Anatomic Approach Direction Code Sequence Trial',
  '00082256':'Anatomic Perspective Description Trial',
  '00082257':'Anatomic Perspective Code Sequence Trial',
  '00082258':'Anatomic Location of Examining Instrument Description Trial',
  '00082259':'Anatomic Location of Examining Instrument Code Sequence Trial',
  '0008225A':'Anatomic Structure Space or Region Modifier Code Sequence Trial',
  '0008225C':'On Axis Background Anatomic Structure Code Sequence Trial',
  '00083001':'RT Plan Label','00083010':'Irradiation Event UID',
  '00083011':'Source Irradiation Event Sequence','00083012':'Radiopharmaceutical Administration Event UID',
  '00084000':'Identifying Comments','00089007':'Frame Type','00089092':'Referenced Image Evidence Sequence',
  '00089121':'Referenced Raw Data Sequence','00089123':'Creator Version UID',
  '00089124':'Derivation Image Sequence','00089154':'Source Image Evidence Sequence',
  '00089205':'Pixel Presentation','00089206':'Volumetric Properties',
  '00089207':'Volume Based Calculation Technique',
  '00089208':'Complex Image Component','00089209':'Acquisition Contrast',
  '00089215':'Derivation Code Sequence','00089237':'Referenced Grayscale Presentation State Sequence',
  '00089410':'Referenced Other Plane Sequence','00089458':'Frame Display Sequence',
  '00089459':'Recommended Display Frame Rate in Float','00089460':'Skip Frame Range Flag',
  // --- Patient (0010) ---
  '00100010':'Patient Name','00100020':'Patient ID','00100021':'Issuer of Patient ID',
  '00100022':'Type of Patient ID','00100024':'Issuer of Patient ID Qualifiers Sequence',
  '00100026':'Source Patient Group Identification Sequence',
  '00100027':'Group of Patients Identification Sequence',
  '00100028':'Subject Relative Position in Image','00100030':'Patient Birth Date',
  '00100032':'Patient Birth Time','00100033':'Patient Birth Date in Alternative Calendar',
  '00100034':'Patient Death Date in Alternative Calendar','00100035':'Patient Alternative Calendar',
  '00100040':'Patient Sex','00100050':'Patient Insurance Plan Code Sequence',
  '00100101':'Patient Primary Language Code Sequence',
  '00100102':'Patient Primary Language Modifier Code Sequence',
  '00100200':'Quality Control Subject','00100212':'Strain Description',
  '00100213':'Strain Nomenclature','00100214':'Strain Stock Number',
  '00100215':'Strain Source Registry Code Sequence','00100216':'Strain Stock Sequence',
  '00100217':'Strain Source','00100218':'Strain Additional Information',
  '00100219':'Strain Code Sequence','00100221':'Genetic Modifications Sequence',
  '00100222':'Genetic Modifications Description','00100223':'Genetic Modifications Nomenclature',
  '00100229':'Genetic Modifications Code Sequence','00101000':'Other Patient IDs',
  '00101001':'Other Patient Names','00101002':'Other Patient IDs Sequence',
  '00101005':'Patient Birth Name','00101010':'Patient Age','00101020':'Patient Size',
  '00101021':'Patient Size Code Sequence','00101022':'Patient Body Mass Index',
  '00101023':'Measured AP Dimension','00101024':'Measured Lateral Dimension',
  '00101030':'Patient Weight','00101040':'Patient Address','00101050':'Insurance Plan Identification',
  '00101060':'Patient Mother Birth Name','00101080':'Military Rank','00101081':'Branch of Service',
  '00101090':'Medical Record Locator','00101100':'Referenced Patient Photo Sequence',
  '00102000':'Medical Alerts','00102110':'Allergies','00102150':'Country of Residence',
  '00102152':'Region of Residence','00102154':'Patient Telephone Numbers',
  '00102155':'Patient Telecom Information','00102160':'Ethnic Group','00102180':'Occupation',
  '001021A0':'Smoking Status','001021B0':'Additional Patient History',
  '001021C0':'Pregnancy Status','001021D0':'Last Menstrual Date',
  '001021F0':'Patient Religious Preference','00102201':'Patient Species Description',
  '00102202':'Patient Species Code Sequence','00102203':'Patient Sex Neutered',
  '00102210':'Anatomical Orientation Type','00102292':'Patient Breed Description',
  '00102293':'Patient Breed Code Sequence','00102294':'Breed Registration Sequence',
  '00102295':'Breed Registration Number','00102296':'Breed Registry Code Sequence',
  '00102297':'Responsible Person','00102298':'Responsible Person Role',
  '00102299':'Responsible Organization','00104000':'Patient Comments',
  '00109431':'Examined Body Thickness',
  // --- Acquisition (0018) ---
  '00180010':'Contrast/Bolus Agent','00180012':'Contrast/Bolus Agent Sequence',
  '00180013':'Contrast/Bolus T1 Relaxivity','00180014':'Contrast/Bolus Administration Route Sequence',
  '00180015':'Body Part Examined','00180020':'Scanning Sequence','00180021':'Sequence Variant',
  '00180022':'Scan Options','00180023':'MR Acquisition Type','00180024':'Sequence Name',
  '00180025':'Angio Flag','00180026':'Intervention Drug Information Sequence',
  '00180027':'Intervention Drug Stop Time','00180028':'Intervention Drug Dose',
  '00180029':'Intervention Drug Code Sequence','0018002A':'Additional Drug Sequence',
  '00180030':'Radionuclide (Retired)','00180031':'Radiopharmaceutical',
  '00180032':'Energy Window Centerline (Retired)','00180033':'Energy Window Total Width (Retired)',
  '00180034':'Intervention Drug Name','00180035':'Intervention Drug Start Time',
  '00180036':'Intervention Sequence','00180037':'Therapy Type (Retired)',
  '00180038':'Intervention Status','00180039':'Therapy Description (Retired)',
  '0018003A':'Interven Description','00180040':'Cine Rate','00180042':'Initial Cine Run Offset',
  '00180050':'Slice Thickness','00180060':'KVP','00180061':'Water Equivalent Diameter',
  '00180062':'Water Equivalent Diameter Calculation Method Code Sequence',
  '00180070':'Counts Accumulated','00180071':'Acquisition Termination Condition',
  '00180072':'Effective Duration','00180073':'Acquisition Start Condition',
  '00180074':'Acquisition Start Condition Data','00180075':'Acquisition Termination Condition Data',
  '00180080':'Repetition Time','00180081':'Echo Time','00180082':'Inversion Time',
  '00180083':'Number of Averages','00180084':'Imaging Frequency','00180085':'Imaged Nucleus',
  '00180086':'Echo Number(s)','00180087':'Magnetic Field Strength',
  '00180088':'Spacing Between Slices','00180089':'Number of Phase Encoding Steps',
  '00180090':'Data Collection Diameter','00180091':'Echo Train Length',
  '00180093':'Percent Sampling','00180094':'Percent Phase Field of View',
  '00180095':'Pixel Bandwidth','001800A0':'Trigger Source or Type','001800A1':'Nominal Interval',
  '001800A2':'Frame Time','001800A4':'Cardiac Framing Type','001800A5':'Frame Time Vector',
  '001800A6':'Frame Delay','001800A7':'Image Trigger Delay','001800A8':'Multiplex Group Time Offset',
  '001800A9':'Trigger Time Offset','001800AA':'Synchronization Trigger',
  '001800AB':'Synchronization Channel','001800AC':'Trigger Sample Position',
  '001800B0':'Cardiac Beat Rejection Technique','001800B2':'Respiratory Motion Compensation Technique',
  '001800B3':'Respiratory Signal Source','001800B4':'Bulk Motion Compensation Technique',
  '001800B5':'Bulk Motion Signal Source','001800B6':'Applicable Safety Standard Agency',
  '001800B7':'Applicable Safety Standard Description',
  '001800B8':'Operating Mode Sequence','001800B9':'Operating Mode Type','001800BA':'Operating Mode',
  '001800BB':'Specific Absorption Rate Definition','001800BC':'Gradient Output Type',
  '001800BD':'Specific Absorption Rate Value','001800BE':'Gradient Output',
  '001800BF':'Flow Compensation Direction','001800C0':'Tagging Gradient',
  '001800C1':'Chemical Shift Reference','001800C2':'Partial Fourier Direction',
  '001800C3':'Cardiac Synchronization Technique',
  '00181000':'Device Serial Number','00181002':'Device UID','00181003':'Device ID',
  '00181004':'Plate ID','00181005':'Generator ID','00181006':'Grid ID',
  '00181007':'Cassette ID','00181008':'Gantry ID','00181009':'Unique Device Identifier',
  '0018100A':'UDI Sequence','0018100B':'Manufacturer Device Class UID',
  '00181010':'Secondary Capture Device ID','00181011':'Hardcopy Creation Device ID',
  '00181012':'Date of Secondary Capture','00181014':'Time of Secondary Capture',
  '00181016':'Secondary Capture Device Manufacturer',
  '00181018':'Secondary Capture Device Manufacturer Model Name',
  '00181019':'Secondary Capture Device Software Versions',
  '0018101A':'Hardcopy Device Manufacturer','0018101B':'Hardcopy Device Manufacturer Model Name',
  '00181020':'Software Version(s)','00181022':'Video Image Format Acquired',
  '00181023':'Digital Image Format Acquired','00181030':'Protocol Name',
  '00181040':'Contrast/Bolus Route','00181041':'Contrast/Bolus Volume',
  '00181042':'Contrast/Bolus Start Time','00181043':'Contrast/Bolus Stop Time',
  '00181044':'Contrast/Bolus Total Dose','00181045':'Syringe Counts',
  '00181046':'Contrast Flow Rate','00181047':'Contrast Flow Duration',
  '00181048':'Contrast/Bolus Ingredient','00181049':'Contrast/Bolus Ingredient Concentration',
  '00181050':'Spatial Resolution','00181060':'Trigger Time',
  '00181061':'Trigger Source or Type','00181062':'Nominal Interval',
  '00181063':'Frame Time','00181064':'Cardiac Framing Type',
  '00181065':'Frame Time Vector','00181066':'Frame Delay',
  '00181067':'Image Trigger Delay','00181068':'Multiplex Group Time Offset',
  '00181069':'Trigger Time Offset','0018106A':'Synchronization Trigger',
  '0018106C':'Synchronization Channel','0018106E':'Trigger Sample Position',
  '00181071':'Radiopharmaceutical Volume','00181072':'Radiopharmaceutical Start Time',
  '00181073':'Radiopharmaceutical Stop Time','00181074':'Radionuclide Total Dose',
  '00181075':'Radionuclide Half Life','00181076':'Radionuclide Positron Fraction',
  '00181077':'Radiopharmaceutical Specific Activity','00181078':'Radiopharmaceutical Start DateTime',
  '00181079':'Radiopharmaceutical Stop DateTime',
  '00181080':'Beat Rejection Flag','00181081':'Low R-R Value','00181082':'High R-R Value',
  '00181083':'Intervals Acquired','00181084':'Intervals Rejected',
  '00181085':'PVC Rejection','00181086':'Skip Beats','00181088':'Heart Rate',
  '00181090':'Cardiac Number of Images','00181094':'Trigger Window',
  '00181100':'Reconstruction Diameter','00181110':'Distance Source to Detector',
  '00181111':'Distance Source to Patient','00181114':'Estimated Radiographic Magnification Factor',
  '00181120':'Gantry/Detector Tilt','00181121':'Gantry/Detector Slew',
  '00181130':'Table Height','00181131':'Table Traverse','00181134':'Table Motion',
  '00181135':'Table Vertical Increment','00181136':'Table Lateral Increment',
  '00181137':'Table Longitudinal Increment','00181138':'Table Angle',
  '0018113A':'Table Type','00181140':'Rotation Direction',
  '00181141':'Angular Position','00181142':'Radial Position',
  '00181143':'Scan Arc','00181144':'Angular Step',
  '00181145':'Center of Rotation Offset','00181146':'Revolution Time',
  '00181147':'Field of View Shape','00181149':'Field of View Dimension(s)',
  '00181150':'Exposure Time','00181151':'X-Ray Tube Current',
  '00181152':'Exposure','00181153':'Exposure in uAs',
  '00181154':'Average Pulse Width','00181155':'Radiation Setting',
  '00181156':'Rectification Type','0018115A':'Radiation Mode',
  '0018115E':'Image and Fluoroscopy Area Dose Product',
  '00181160':'Filter Type','00181161':'Type of Filters',
  '00181162':'Intensifier Size','00181164':'Imager Pixel Spacing',
  '00181166':'Grid','00181170':'Generator Power',
  '00181180':'Collimator/Grid Name','00181181':'Collimator Type',
  '00181182':'Focal Distance','00181183':'X Focus Center',
  '00181184':'Y Focus Center','00181190':'Focal Spot(s)',
  '00181191':'Anode Target Material','001811A0':'Body Part Thickness',
  '001811A2':'Compression Force','001811A3':'Compression Pressure',
  '001811A4':'Paddle Description','001811A6':'Compression Contact Area',
  '00181200':'Date of Last Calibration','00181201':'Time of Last Calibration',
  '00181202':'DateTime of Last Calibration','00181204':'Date of Last Detector Calibration',
  '00181205':'DateTime of Last Detector Calibration',
  '00181210':'Convolution Kernel','00181240':'Upper/Lower Pixel Values',
  '00181242':'Actual Frame Duration','00181243':'Count Rate',
  '00181244':'Preferred Playback Sequencing','00181250':'Receive Coil Name',
  '00181251':'Transmit Coil Name','00181260':'Plate Type',
  '00181261':'Phosphor Type','00181271':'Water Equivalent Diameter',
  '00181300':'Scan Velocity','00181301':'Whole Body Technique',
  '00181302':'Scan Length','00181310':'Acquisition Matrix',
  '00181312':'In-plane Phase Encoding Direction','00181314':'Flip Angle',
  '00181315':'Variable Flip Angle Flag','00181316':'SAR','00181317':'dB/dt',
  '00181318':'B1rms','00181320':'B0 Inhomogeneity',
  '00181380':'Tomo Layer Height','00181381':'Tomo Angle',
  '00181382':'Tomo Time','00181383':'Tomo Type','00181384':'Tomo Class',
  '00181386':'Number of Tomosynthesis Source Images',
  '00181400':'Acquisition Device Processing Description',
  '00181401':'Acquisition Device Processing Code','00181402':'Cassette Orientation',
  '00181403':'Cassette Size','00181404':'Exposures on Plate',
  '00181405':'Relative X-Ray Exposure','00181411':'Exposure Index',
  '00181412':'Target Exposure Index','00181413':'Deviation Index',
  '00181450':'Column Angulation','00181460':'Tomo Layer Height',
  '00181470':'Tomo Angle','00181480':'Tomo Time',
  '00181490':'Tomo Type','00181491':'Tomo Class',
  '00181495':'Number of Tomosynthesis Source Images',
  '00181500':'Positioner Motion','00181508':'Positioner Type',
  '00181510':'Positioner Primary Angle','00181511':'Positioner Secondary Angle',
  '00181520':'Positioner Primary Angle Increment','00181521':'Positioner Secondary Angle Increment',
  '00181530':'Detector Primary Angle','00181531':'Detector Secondary Angle',
  '00181600':'Shutter Shape','00181602':'Shutter Left Vertical Edge',
  '00181604':'Shutter Right Vertical Edge','00181606':'Shutter Upper Horizontal Edge',
  '00181608':'Shutter Lower Horizontal Edge','00181610':'Center of Circular Shutter',
  '00181612':'Radius of Circular Shutter','00181620':'Vertices of the Polygonal Shutter',
  '00181622':'Shutter Presentation Value','00181623':'Shutter Overlay Group',
  '00181624':'Shutter Presentation Color CIELab Value',
  '00181700':'Collimator Shape','00181702':'Collimator Left Vertical Edge',
  '00181704':'Collimator Right Vertical Edge','00181706':'Collimator Upper Horizontal Edge',
  '00181708':'Collimator Lower Horizontal Edge','00181710':'Center of Circular Collimator',
  '00181712':'Radius of Circular Collimator','00181720':'Vertices of the Polygonal Collimator',
  '00181800':'Acquisition Time Synchronized','00181801':'Time Source',
  '00181802':'Time Distribution Protocol','00181803':'NTP Source Address',
  '00182001':'Page Number Vector','00182002':'Frame Label Vector',
  '00182003':'Frame Primary Angle Vector','00182004':'Frame Secondary Angle Vector',
  '00182005':'Slice Location Vector','00182006':'Display Window Label Vector',
  '00182010':'Nominal Scanned Pixel Spacing','00182020':'Digitizing Device Transport Direction',
  '00182030':'Rotation of Scanned Film','00182041':'Biopsy Target Sequence',
  '00182042':'Target UID','00182043':'Localizing Cursor Attribute',
  '00182044':'Calculated Target Position','00182045':'Target Label',
  '00182046':'Displayed Z Value','00183100':'IVUS Acquisition',
  '00183101':'IVUS Pullback Rate','00183102':'IVUS Gated Rate',
  '00183103':'IVUS Pullback Start Frame Number','00183104':'IVUS Pullback Stop Frame Number',
  '00183105':'Lesion Number','00185010':'Ultrasound Transducer Frequency',
  '00185012':'Focus Depth','00185021':'Processing Function','00185022':'Postprocessing Function',
  '00185024':'Mechanical Index','00185026':'Bone Thermal Index',
  '00185027':'Cranial Thermal Index','00185028':'Soft Tissue Thermal Index',
  '00185029':'Soft Tissue-Focus Thermal Index','00185030':'Soft Tissue-Surface Thermal Index',
  '00185050':'Depth of Scan Field','00185100':'Patient Position',
  '00185101':'View Position','00185104':'Projection Eponymous Name Code Sequence',
  '00185210':'Image Transformation Matrix','00185212':'Image Translation Vector',
  '00186000':'Sensitivity','00186011':'Sequence of Ultrasound Regions',
  '00186012':'Region Spatial Format','00186014':'Region Data Type',
  '00186016':'Region Flags','00186018':'Region Location Min X0',
  '0018601A':'Region Location Min Y0','0018601C':'Region Location Max X1',
  '0018601E':'Region Location Max Y1','00186020':'Reference Pixel X0',
  '00186022':'Reference Pixel Y0','00186024':'Physical Units X Direction',
  '00186026':'Physical Units Y Direction','00186028':'Reference Pixel Physical Value X',
  '0018602A':'Reference Pixel Physical Value Y','0018602C':'Physical Delta X',
  '0018602E':'Physical Delta Y','00186030':'Transducer Frequency',
  '00186031':'Transducer Type','00186032':'Pulse Repetition Frequency',
  '00186034':'Doppler Correction Angle','00186036':'Steering Angle',
  '00186039':'Doppler Sample Volume X Position (Retired)','0018603A':'Doppler Sample Volume X Position',
  '0018603B':'Doppler Sample Volume Y Position (Retired)','0018603C':'Doppler Sample Volume Y Position',
  '0018603D':'TM-Line Position X0 (Retired)','0018603E':'TM-Line Position X0',
  '0018603F':'TM-Line Position Y0 (Retired)','00186040':'TM-Line Position Y0',
  '00186041':'TM-Line Position X1 (Retired)','00186042':'TM-Line Position X1',
  '00186043':'TM-Line Position Y1 (Retired)','00186044':'TM-Line Position Y1',
  '00186046':'Pixel Component Organization','00186048':'Pixel Component Mask',
  '0018604A':'Pixel Component Range Start','0018604C':'Pixel Component Range Stop',
  '0018604E':'Pixel Component Physical Units','00186050':'Pixel Component Data Type',
  '00186052':'Number of Table Break Points','00186054':'Table of X Break Points',
  '00186056':'Table of Y Break Points','00186058':'Number of Table Entries',
  '0018605A':'Table of Pixel Values','0018605C':'Table of Parameter Values',
  '00186060':'R Wave Time Vector','00187000':'Detector Conditions Nominal Flag',
  '00187001':'Detector Temperature','00187004':'Detector Type',
  '00187005':'Detector Configuration','00187006':'Detector Description',
  '00187008':'Detector Mode','0018700A':'Detector ID','0018700C':'Date of Last Detector Calibration',
  '0018700E':'Time of Last Detector Calibration','00187010':'Exposures on Detector Since Last Calibration',
  '00187011':'Exposures on Detector Since Manufactured','00187012':'Detector Time Since Last Exposure',
  '00187014':'Detector Active Time','00187016':'Detector Activation Offset From Exposure',
  '0018701A':'Detector Binning','00187020':'Detector Element Physical Size',
  '00187022':'Detector Element Spacing','00187024':'Detector Active Shape',
  '00187026':'Detector Active Dimension(s)','00187028':'Detector Active Origin',
  '0018702A':'Detector Manufacturer Name','0018702B':'Detector Manufacturer Model Name',
  '00187030':'Field of View Origin','00187032':'Field of View Rotation',
  '00187034':'Field of View Horizontal Flip',
  '00187036':'Pixel Data Area Origin Relative To FOV','00187038':'Pixel Data Area Rotation Angle Relative To FOV',
  '00187040':'Grid Absorbing Material','00187041':'Grid Spacing Material',
  '00187042':'Grid Thickness','00187044':'Grid Pitch','00187046':'Grid Aspect Ratio',
  '00187048':'Grid Period','0018704C':'Grid Focal Distance',
  '00187050':'Filter Material','00187052':'Filter Thickness Minimum',
  '00187054':'Filter Thickness Maximum','00187056':'Filter Beam Path Length Minimum',
  '00187058':'Filter Beam Path Length Maximum',
  '00187060':'Exposure Control Mode','00187062':'Exposure Control Mode Description',
  '00187064':'Exposure Status','00187065':'Phototimer Setting',
  '00188150':'Exposure Time in uS','00188151':'X-Ray Tube Current in uA',
  '00189004':'Content Qualification','00189005':'Pulse Sequence Name',
  '00189006':'MR Imaging Modifier Sequence','00189008':'Echo Pulse Sequence',
  '00189009':'Inversion Recovery','00189010':'Flow Compensation',
  '00189011':'Multiple Spin Echo','00189012':'Multi-planar Excitation',
  '00189014':'Phase Contrast','00189015':'Time of Flight Contrast',
  '00189016':'Spoiling','00189017':'Steady State Pulse Sequence',
  '00189018':'Echo Planar Pulse Sequence','00189019':'Tag Angle First Axis',
  '0018901A':'Magnetization Transfer','0018901B':'T2 Preparation',
  '0018901C':'Blood Signal Nulling','0018901D':'Saturation Recovery',
  '0018901E':'Spectrally Selected Suppression','0018901F':'Spectrally Selected Excitation',
  '00189020':'Spatial Pre-saturation','00189021':'Tagging',
  '00189022':'Oversampling Phase','00189024':'Tag Spacing First Dimension',
  '00189025':'Geometry of k-Space Traversal','00189026':'Segmented k-Space Traversal',
  '00189027':'Rectilinear Phase Encode Reordering','00189028':'Tag Thickness',
  '00189029':'Partial Fourier Direction','0018902A':'Cardiac Synchronization Technique',
  '00189030':'Tag Spacing Second Dimension','00189032':'Geometry of k-Space Traversal',
  '00189033':'Segmented k-Space Traversal','00189034':'Rectilinear Phase Encode Reordering',
  '00189035':'Tag Thickness','00189036':'Partial Fourier Direction',
  '00189037':'Cardiac Synchronization Technique','00189058':'MR Velocity Encoding Sequence',
  '00189059':'De-coupling','00189060':'De-coupled Nucleus',
  '00189061':'De-coupling Frequency','00189062':'De-coupling Method',
  '00189063':'De-coupling Chemical Shift Reference For','00189064':'k-space Filtering',
  '00189065':'Time Domain Filtering','00189066':'Number of Zero Fills',
  '00189067':'Baseline Correction','00189069':'Parallel Reduction Factor In-plane',
  '0018906A':'Cardiac R-R Interval Specified','0018906B':'Acquisition Duration',
  '0018906C':'Frame RR Interval','0018906D':'Actual Cardiac Trigger Delay Time',
  '0018906E':'Respiratory Trigger Delay Time','0018906F':'Respiratory Interval Time',
  '00189070':'Cardiac Beat Rejection Technique','00189073':'Acquisition Duration',
  '00189074':'Frame Acquisition DateTime','00189075':'Diffusion Directionality',
  '00189076':'Diffusion Gradient Direction Sequence','00189077':'Parallel Acquisition',
  '00189078':'Parallel Acquisition Technique','00189079':'Inversion Times',
  '0018907A':'Metabolite Map Description','0018907B':'Partial Fourier Category',
  '0018907C':'Effective Echo Time','0018907D':'Metabolite Map Code Sequence',
  '0018907E':'Chemical Shift Sequence','0018907F':'Cardiac Signal Source',
  '00189080':'Diffusion b-value','00189082':'Diffusion Gradient Orientation',
  '00189084':'Ion Plan Label','00189085':'Cardiac Framing Type',
  '00189087':'Diffusion b-matrix Sequence','00189089':'Diffusion Gradient Orientation',
  '00189090':'Velocity Encoding Direction','00189091':'Velocity Encoding Minimum Value',
  '00189092':'Velocity Encoding Acquisition Sequence','00189093':'Number of k-Space Trajectories',
  '00189094':'Coverage of k-Space','00189095':'Spectral Width',
  '00189096':'Chemical Shift Reference','00189098':'Chemical Shift','00189101':'De-coupling Frequency',
  '00189103':'MR Spectroscopy FOV/Geometry Sequence','00189104':'Slab Thickness',
  '00189105':'Slab Orientation','00189106':'Mid Slab Position',
  '00189107':'MR Spatial Saturation Sequence','00189112':'MR Timing and Related Parameters Sequence',
  '00189114':'MR Echo Sequence','00189115':'MR Modifier Sequence',
  '00189117':'MR Diffusion Sequence','00189118':'Cardiac Synchronization Sequence',
  '00189119':'MR Averages Sequence','0018911A':'MR FOV/Geometry Sequence',
  '00189125':'MR Receive Coil Sequence','00189126':'MR Transmit Coil Sequence',
  '00189127':'SAR Data','00189147':'Diffusion Anisotropy Type',
  '00189151':'Frame Reference DateTime','00189152':'MR Metabolite Map Sequence',
  '00189155':'Parallel Reduction Factor out-of-plane','00189159':'Parallel Reduction Factor Second In-plane',
  '0018915A':'Cardiac Beat Rejection Technique',
  '0018915E':'Respiratory Motion Compensation Technique Description',
  '00189160':'Respiratory Signal Source ID','00189170':'Respiratory Motion Compensation Technique',
  '00189171':'Respiratory Signal Source','00189172':'Bulk Motion Compensation Technique',
  '00189173':'Bulk Motion Signal Source','00189174':'Applicable Safety Standard Agency',
  '00189175':'Applicable Safety Standard Description',
  '00189176':'Operating Mode Sequence','00189177':'Operating Mode Type',
  '00189178':'Operating Mode','00189179':'Specific Absorption Rate Definition',
  '0018917A':'Gradient Output Type','0018917B':'Specific Absorption Rate Value',
  '0018917C':'Gradient Output','0018917D':'Flow Compensation Direction',
  '0018917E':'Tagging Gradient','0018917F':'Chemical Shift Reference',
  '00189180':'Partial Fourier Direction','00189181':'Cardiac Synchronization Technique',
  // --- Relationship (0020) ---
  '00200000':'Relationship Group Length','00200010':'Study ID',
  '00200011':'Series Number','00200012':'Acquisition Number','00200013':'Instance Number',
  '00200014':'Isotope Number (Retired)','00200015':'Phase Number (Retired)',
  '00200016':'Interval Number (Retired)','00200017':'Time Slot Number (Retired)',
  '00200018':'Angle Number (Retired)','00200019':'Item Number',
  '00200020':'Patient Orientation','00200022':'Overlay Number (Retired)',
  '00200024':'Curve Number (Retired)','00200026':'Lookup Table Number (Retired)',
  '00200030':'Image Position (Retired)','00200032':'Image Position (Patient)',
  '00200035':'Image Orientation (Retired)','00200037':'Image Orientation (Patient)',
  '00200050':'Location (Retired)','00200052':'Frame of Reference UID',
  '00200060':'Laterality','00200062':'Image Laterality','00200070':'Image Geometry Type (Retired)',
  '00200080':'Masking Image (Retired)','002000AA':'Report Number (Retired)',
  '00200100':'Temporal Position Identifier','00200105':'Number of Temporal Positions',
  '00200110':'Temporal Resolution','00200200':'Synchronization Frame of Reference UID',
  '00200242':'SOP Instance UID of Concatenation Source',
  '00201000':'Series in Study (Retired)','00201001':'Acquisitions in Series (Retired)',
  '00201002':'Images in Acquisition','00201003':'Images in Series (Retired)',
  '00201004':'Acquisitions in Study (Retired)','00201005':'Images in Study (Retired)',
  '00201020':'Reference (Retired)','00201040':'Position Reference Indicator',
  '00201041':'Slice Location','00201070':'Other Study Numbers (Retired)',
  '00201200':'Number of Patient Related Studies','00201202':'Number of Patient Related Series',
  '00201204':'Number of Patient Related Instances','00201206':'Number of Study Related Series',
  '00201208':'Number of Study Related Instances','00201209':'Number of Series Related Instances',
  '002052009':'Source Image IDs (Retired)','00205100':'Patient Position',
  '00209056':'Stack ID','00209057':'In-Stack Position Number',
  '00209071':'Frame Anatomy Sequence','00209072':'Frame Laterality',
  '00209111':'Frame Content Sequence','00209113':'Plane Position Sequence',
  '00209116':'Plane Orientation Sequence','00209128':'Temporal Position Index',
  '00209153':'Nominal Cardiac Trigger Delay Time','00209154':'Nominal Cardiac Trigger Time Prior To R-Peak',
  '00209155':'Actual Cardiac Trigger Time Prior To R-Peak',
  '00209156':'Frame Acquisition Number','00209157':'Dimension Index Values',
  '00209158':'Frame Comments','00209161':'Concatenation UID',
  '00209162':'In-Concatenation Number','00209163':'In-Concatenation Total Number',
  '00209164':'Dimension Organization UID','00209165':'Dimension Index Pointer',
  '00209167':'Functional Group Pointer','00209170':'Unassigned Shared Converted Attributes Sequence',
  '00209171':'Unassigned Per-Frame Converted Attributes Sequence',
  '00209172':'Conversion Source Attributes Sequence',
  '00209213':'Dimension Index Private Creator','00209221':'Dimension Organization Sequence',
  '00209222':'Dimension Index Sequence','00209228':'Concatenation Frame Offset Number',
  '00209238':'Functional Group Private Creator','00209241':'Nominal Percentage of Cardiac Phase',
  '00209245':'Nominal Percentage of Respiratory Phase','00209246':'Starting Respiratory Amplitude',
  '00209247':'Starting Respiratory Phase','00209248':'Ending Respiratory Amplitude',
  '00209249':'Ending Respiratory Phase','00209250':'Respiratory Trigger Type',
  '00209251':'R-R Interval Time Nominal','00209252':'Actual Cardiac Trigger Delay Time',
  '00209253':'Respiratory Synchronization Sequence',
  '00209254':'Respiratory Interval Time','00209255':'Nominal Respiratory Trigger Delay Time',
  '00209256':'Respiratory Trigger Delay Threshold','00209257':'Actual Respiratory Trigger Delay Time',
  '00209301':'Image Position (Volume)','00209302':'Image Orientation (Volume)',
  '00209307':'Ultrasound Acquisition Geometry','00209308':'Apex Position',
  '00209309':'Volume to Transducer Mapping Matrix','0020930A':'Volume to Table Mapping Matrix',
  '0020930B':'Volume to Transducer Relationship',
  '0020930C':'Patient Frame of Reference Source','0020930D':'Temporal Position Time Offset',
  '0020930E':'Plane Position (Volume) Sequence','0020930F':'Plane Orientation (Volume) Sequence',
  '00209310':'Temporal Position Sequence','00209311':'Dimension Organization Type',
  '00209312':'Volume Frame of Reference UID','00209313':'Table Frame of Reference UID',
  '00209421':'Dimension Description Label',
  '00209450':'Patient Orientation in Frame Sequence',
  '00209453':'Frame Label','00209518':'Acquisition Index',
  '00209529':'Contributing SOP Instances Reference Sequence',
  '00209536':'Reconstruction Index',
  // --- Image Pixel (0028) ---
  '00280002':'Samples per Pixel','00280003':'Samples per Pixel Used',
  '00280004':'Photometric Interpretation','00280005':'Image Dimensions (Retired)',
  '00280006':'Planar Configuration','00280007':'Number of Frames in Overlay',
  '00280008':'Number of Frames','00280009':'Frame Increment Pointer',
  '0028000A':'Frame Dimension Pointer','00280010':'Rows','00280011':'Columns',
  '00280012':'Planes (Retired)','00280014':'Ultrasound Color Data Present',
  '00280020':'Image Location (Retired)','00280030':'Pixel Spacing',
  '00280031':'Zoom Factor','00280032':'Zoom Center',
  '00280034':'Pixel Aspect Ratio','00280040':'Image Format (Retired)',
  '00280050':'Manipulated Image (Retired)','00280051':'Corrected Image',
  '0028005F':'Compression Recognition Code (Retired)',
  '00280060':'Compression Code (Retired)','00280061':'Compression Originator (Retired)',
  '00280062':'Compression Label (Retired)','00280063':'Compression Description (Retired)',
  '00280065':'Compression Sequence (Retired)','00280066':'Compression Step Pointers (Retired)',
  '00280068':'Repeat Interval (Retired)','00280069':'Bits Grouped (Retired)',
  '00280070':'Perimeter Table (Retired)','00280071':'Perimeter Value (Retired)',
  '00280080':'Predictor Rows (Retired)','00280081':'Predictor Columns (Retired)',
  '00280082':'Predictor Constants (Retired)','00280090':'Blocked Pixels (Retired)',
  '00280091':'Block Rows (Retired)','00280092':'Block Columns (Retired)',
  '00280093':'Row Overlap (Retired)','00280094':'Column Overlap (Retired)',
  '00280100':'Bits Allocated','00280101':'Bits Stored','00280102':'High Bit',
  '00280103':'Pixel Representation','00280104':'Smallest Valid Pixel Value (Retired)',
  '00280105':'Largest Valid Pixel Value (Retired)',
  '00280106':'Smallest Image Pixel Value','00280107':'Largest Image Pixel Value',
  '00280108':'Smallest Pixel Value in Series','00280109':'Largest Pixel Value in Series',
  '00280110':'Smallest Image Pixel Value in Plane (Retired)',
  '00280111':'Largest Image Pixel Value in Plane (Retired)',
  '00280120':'Pixel Padding Value','00280121':'Pixel Padding Range Limit',
  '00280122':'Float Pixel Padding Value','00280123':'Double Float Pixel Padding Value',
  '00280200':'Image Location (Retired)',
  '00280300':'Quality Control Image','00280301':'Burned In Annotation',
  '00280302':'Recognizable Visual Features','00280303':'Longitudinal Temporal Information Modified',
  '00280304':'Referenced Color Palette Instance UID',
  '00280400':'Transform Label (Retired)','00280401':'Transform Version Number (Retired)',
  '00280402':'Number of Transform Steps (Retired)','00280403':'Sequence of Compressed Data (Retired)',
  '00280404':'Details of Coefficients (Retired)',
  '00280700':'DCT Label (Retired)','00280701':'Data Block Description (Retired)',
  '00280702':'Data Block (Retired)','00280710':'Normalization Factor Format (Retired)',
  '00280720':'Zonal Map Number Format (Retired)','00280721':'Zonal Map Location (Retired)',
  '00280722':'Zonal Map Format (Retired)','00280730':'Adaptive Map Format (Retired)',
  '00280740':'Code Number Format (Retired)',
  '00280A02':'Pixel Spacing Calibration Type','00280A04':'Pixel Spacing Calibration Description',
  '00281040':'Pixel Intensity Relationship','00281041':'Pixel Intensity Relationship Sign',
  '00281050':'Window Center','00281051':'Window Width',
  '00281052':'Rescale Intercept','00281053':'Rescale Slope','00281054':'Rescale Type',
  '00281055':'Window Center & Width Explanation',
  '00281056':'VOI LUT Function','00281090':'Recommended Viewing Mode',
  '00281100':'Gray Lookup Table Descriptor (Retired)',
  '00281101':'Red Palette Color Lookup Table Descriptor',
  '00281102':'Green Palette Color Lookup Table Descriptor',
  '00281103':'Blue Palette Color Lookup Table Descriptor',
  '00281104':'Alpha Palette Color Lookup Table Descriptor',
  '00281111':'Large Red Palette Color Lookup Table Descriptor (Retired)',
  '00281112':'Large Green Palette Color Lookup Table Descriptor (Retired)',
  '00281113':'Large Blue Palette Color Lookup Table Descriptor (Retired)',
  '00281199':'Palette Color Lookup Table UID',
  '00281200':'Gray Lookup Table Data (Retired)',
  '00281201':'Red Palette Color Lookup Table Data',
  '00281202':'Green Palette Color Lookup Table Data',
  '00281203':'Blue Palette Color Lookup Table Data',
  '00281204':'Alpha Palette Color Lookup Table Data',
  '00281211':'Large Red Palette Color Lookup Table Data (Retired)',
  '00281212':'Large Green Palette Color Lookup Table Data (Retired)',
  '00281213':'Large Blue Palette Color Lookup Table Data (Retired)',
  '00281214':'Large Palette Color Lookup Table UID (Retired)',
  '00281221':'Segmented Red Palette Color Lookup Table Data',
  '00281222':'Segmented Green Palette Color Lookup Table Data',
  '00281223':'Segmented Blue Palette Color Lookup Table Data',
  '00281224':'Segmented Alpha Palette Color Lookup Table Data',
  '00281230':'Float 32 Red Palette Color Lookup Table Data',
  '00281231':'Float 32 Green Palette Color Lookup Table Data',
  '00281232':'Float 32 Blue Palette Color Lookup Table Data',
  '00281233':'Float 32 Alpha Palette Color Lookup Table Data',
  '00281300':'Implant Present','00281301':'Partial View',
  '00281302':'Partial View Description','00281303':'Partial View Code Sequence',
  '00281350':'Spatial Locations Preserved','00281351':'Data Frame Assignment Sequence',
  '00281352':'Data Path Assignment','00281353':'Bits Mapped to Color Lookup Table',
  '00281402':'Pixel Spacing Calibration Type','00281403':'Pixel Spacing Calibration Description',
  '00282110':'Lossy Image Compression','00282112':'Lossy Image Compression Ratio',
  '00282114':'Lossy Image Compression Method',
  '00283000':'Modality LUT Sequence','00283002':'LUT Descriptor',
  '00283003':'LUT Explanation','00283004':'Modality LUT Type',
  '00283006':'LUT Data','00283010':'VOI LUT Sequence',
  '00283110':'Softcopy VOI LUT Sequence',
  '00284000':'Image Presentation Comments (Retired)',
  '00285000':'Bi-Plane Acquisition Sequence (Retired)',
  '00286010':'Representative Frame Number','00286020':'Frame Numbers of Interest (FOI)',
  '00286022':'Frame of Interest Description','00286023':'Frame of Interest Type',
  '00286030':'Mask Pointer(s) (Retired)','00286040':'R Wave Pointer',
  '00286100':'Mask Subtraction Sequence','00286101':'Mask Operation',
  '00286102':'Applicable Frame Range','00286110':'Mask Frame Numbers',
  '00286112':'Contrast Frame Averaging','00286114':'Mask Sub-pixel Shift',
  '00286120':'TID Offset','00286190':'Mask Operation Explanation',
  '00287FE0':'Pixel Data Provider URL','00289001':'Data Point Rows',
  '00289002':'Data Point Columns','00289003':'Signal Domain Columns',
  '00289108':'Data Representation','00289110':'Pixel Measures Sequence',
  '00289132':'Frame VOI LUT Sequence','00289145':'Pixel Value Transformation Sequence',
  '00289235':'Signal Domain Rows','00289411':'Display Filter Percentage',
  '00289415':'Pixel Shift Sequence','00289416':'Offset of the First Stored Pixel Value',
  '00289422':'Pixel Intensity Relationship LUT Sequence',
  '00289443':'Frame Pixel Shift Sequence','00289444':'Patient Frame of Reference Source',
  '00289445':'Respiratory Interval Time','00289446':'Nominal Respiratory Trigger Delay Time',
  '00289447':'Respiratory Trigger Delay Threshold',
  '00289449':'Actual Respiratory Trigger Delay Time',
  '00289474':'Mask Selection Mode','00289478':'LUT Label',
  '00289501':'Pixel Shift Frame Range','00289502':'LUT Frame Range',
  '00289503':'Image to Equipment Mapping Matrix',
  '00289505':'Equipment Coordinate System',
  // --- Procedure (0040) ---
  '00400001':'Scheduled Station AE Title','00400002':'Scheduled Procedure Step Start Date',
  '00400003':'Scheduled Procedure Step Start Time','00400004':'Scheduled Procedure Step End Date',
  '00400005':'Scheduled Procedure Step End Time','00400006':'Scheduled Performing Physician Name',
  '00400007':'Scheduled Procedure Step Description','00400008':'Scheduled Protocol Code Sequence',
  '00400009':'Scheduled Procedure Step ID','0040000A':'Stage Code Sequence',
  '0040000B':'Scheduled Performing Physician Identification Sequence',
  '00400010':'Scheduled Station Name','00400011':'Scheduled Procedure Step Location',
  '00400012':'Pre-Medication','00400020':'Scheduled Procedure Step Status',
  '00400026':'Order Placer Identifier Sequence','00400027':'Order Filler Identifier Sequence',
  '00400031':'Local Namespace Entity ID','00400032':'Universal Entity ID',
  '00400033':'Universal Entity ID Type','00400035':'Identifier Type Code',
  '00400036':'Assigning Facility Sequence','00400039':'Assigning Jurisdiction Code Sequence',
  '0040003A':'Assigning Agency or Department Code Sequence',
  '00400100':'Scheduled Procedure Step Sequence',
  '00400220':'Referenced Non-Image Composite SOP Instance Sequence',
  '00400241':'Performed Station AE Title','00400242':'Performed Station Name',
  '00400243':'Performed Location','00400244':'Performed Procedure Step Start Date',
  '00400245':'Performed Procedure Step Start Time','00400250':'Performed Procedure Step End Date',
  '00400251':'Performed Procedure Step End Time','00400252':'Performed Procedure Step Status',
  '00400253':'Performed Procedure Step ID','00400254':'Performed Procedure Step Description',
  '00400255':'Performed Procedure Type Description',
  '00400260':'Performed Protocol Code Sequence','00400261':'Performed Protocol Type',
  '00400270':'Scheduled Step Attributes Sequence','00400275':'Request Attributes Sequence',
  '00400280':'Comments on the Performed Procedure Step',
  '00400281':'Performed Procedure Step Discontinuation Reason Code Sequence',
  '00400293':'Quantity Sequence','00400294':'Quantity','00400295':'Measuring Units Sequence',
  '00400296':'Billing Item Sequence','00400300':'Total Time of Fluoroscopy',
  '00400301':'Total Number of Exposures','00400302':'Entrance Dose',
  '00400303':'Exposed Area','00400306':'Distance Source to Entrance',
  '00400307':'Distance Source to Support','0040030E':'Exposure Dose Sequence',
  '00400310':'Comments on Radiation Dose','00400312':'X-Ray Output',
  '00400314':'Half Value Layer','00400316':'Organ Dose','00400318':'Organ Exposed',
  '00400320':'Billing Procedure Step Sequence','00400321':'Film Consumption Sequence',
  '00400324':'Billing Supplies and Devices Sequence',
  '00400330':'Referenced Procedure Step Sequence (Retired)',
  '00400340':'Performed Series Sequence','00400400':'Comments on the Scheduled Procedure Step',
  '00400440':'Protocol Context Sequence','00400441':'Content Item Modifier Sequence',
  '00400500':'Scheduled Specimen Sequence','0040050A':'Specimen Accession Number (Retired)',
  '00400512':'Container Identifier','00400513':'Issuer of the Container Identifier Sequence',
  '00400515':'Alternate Container Identifier Sequence','00400518':'Container Type Code Sequence',
  '0040051A':'Container Description','00400520':'Container Component Sequence',
  '00400550':'Specimen Sequence (Retired)','00400551':'Specimen Identifier',
  '00400552':'Specimen Description Sequence Trial (Retired)',
  '00400553':'Specimen Description Trial (Retired)',
  '00400554':'Specimen UID','00400555':'Acquisition Context Sequence',
  '00400556':'Acquisition Context Description',
  '0040059A':'Specimen Type Code Sequence','00400560':'Specimen Description Sequence',
  '00400562':'Issuer of the Specimen Identifier Sequence',
  '00400600':'Specimen Short Description','00400602':'Specimen Detailed Description',
  '00400610':'Specimen Preparation Sequence','00400612':'Specimen Preparation Step Content Item Sequence',
  '00400620':'Specimen Localization Content Item Sequence',
  '004006FA':'Slide Identifier (Retired)',
  '0040071A':'Image Center Point Coordinates Sequence',
  '0040072A':'X Offset in Slide Coordinate System','0040073A':'Y Offset in Slide Coordinate System',
  '0040074A':'Z Offset in Slide Coordinate System',
  '004008D8':'Pixel Spacing Sequence (Retired)','004008DA':'Coordinate System Axis Code Sequence (Retired)',
  '004008EA':'Measurement Units Code Sequence','004009F8':'Vital Stain Code Sequence Trial (Retired)',
  '00400A02':'Observation DateTime (Trial) (Retired)',
  '00400A03':'Observation UID (Trial) (Retired)',
  '00400A07':'Findings Flag Trial (Retired)',
  '00400A0A':'Referenced Observation UID Trial (Retired)',
  '00400A0B':'Referenced Observation Class Trial (Retired)',
  '00400A0C':'Referenced Task Ends Trial (Retired)',
  '00400A0D':'Observation Sample Content Item Identifier Trial (Retired)',
  '00400A10':'Relationship Type','00400A120':'UID','00400A121':'Date',
  '00400A122':'Time','00400A123':'PNAME','00400A124':'UID',
  '00400A125':'Code (Retired)','00400A130':'Temporal Range Type',
  '00400A132':'Referenced Sample Positions','00400A136':'Referenced Frame Numbers',
  '00400A138':'Referenced Time Offsets','00400A13A':'Referenced DateTime',
  '00400A160':'Text Value','00400A161':'Float Numeric Value',
  '00400A162':'Rational Numerator Value','00400A163':'Rational Denominator Value',
  '00400A167':'Observation Category Code Sequence Trial (Retired)',
  '00400A168':'Concept Code Sequence','00400A16A':'Bibliographic Citation Trial (Retired)',
  '00400A170':'Purpose of Reference Code Sequence',
  '00400A171':'Observation UID','00400A172':'Referenced Observation UID Trial (Retired)',
  '00400A173':'Referenced Observation Class Trial (Retired)',
  '00400A174':'Referenced Task Ends Trial (Retired)',
  '00400A180':'Annotation Group Number','00400A192':'Observation Date Trial (Retired)',
  '00400A193':'Observation Time Trial (Retired)',
  '00400A194':'Measurement Automation (Trial) (Retired)',
  '00400A195':'Concept Name Code Sequence Modifier (Retired)',
  '00400A224':'Identification Description Trial (Retired)',
  '00400A290':'Coordinates Set Geometric Type Trial (Retired)',
  '00400A296':'Algorithm Code Sequence Trial (Retired)',
  '00400A297':'Algorithm Description Trial (Retired)',
  '00400A29A':'Pixel Coordinates Set Trial (Retired)',
  '00400A300':'Measured Value Sequence','00400A301':'Numeric Value Qualifier Code Sequence',
  '00400A307':'Current Observer Trial (Retired)',
  '00400A30A':'Numeric Value','00400A313':'Referenced Accession Sequence (Retired)',
  '00400A33A':'Report Text Trial (Retired)','00400A340':'Protocol Context Sequence Trial (Retired)',
  '00400A352':'Person Name Trial (Retired)','00400A353':'Address Trial (Retired)',
  '00400A354':'Telephone Number Trial (Retired)','00400A360':'Predecessor Documents Sequence',
  '00400A370':'Referenced Request Sequence','00400A372':'Performed Procedure Code Sequence',
  '00400A375':'Current Requested Procedure Evidence Sequence',
  '00400A380':'Report Detail Sequence Trial (Retired)',
  '00400A385':'Pertinent Other Evidence Sequence',
  '00400A390':'HL7 Structured Document Reference Sequence',
  '00400A402':'Observation Subject UID Trial (Retired)',
  '00400A403':'Observation Subject Class Trial (Retired)',
  '00400A404':'Observation Subject Type Code Sequence Trial (Retired)',
  '00400A491':'Completion Flag','00400A492':'Completion Flag Description',
  '00400A493':'Verification Flag','00400A494':'Archive Requested',
  '00400A496':'Preliminary Flag','00400A504':'Content Template Sequence',
  '00400A525':'Identical Documents Sequence','00400A600':'Observation Subject Context Flag Trial (Retired)',
  '00400A601':'Observer Context Flag Trial (Retired)',
  '00400A603':'Procedure Context Flag Trial (Retired)',
  '00400A730':'Content Sequence','00400A731':'Relationship Sequence Trial (Retired)',
  '00400A732':'Relationship Type Code Sequence Trial (Retired)',
  '00400A744':'Language Code Sequence Trial (Retired)',
  '00400A801':'Tabulated Values Sequence','00400A802':'Number of Table Rows',
  '00400A803':'Number of Table Columns','00400A804':'Table Row Number',
  '00400A805':'Table Column Number','00400A806':'Table Row Definition Sequence',
  '00400A807':'Table Column Definition Sequence','00400A808':'Cell Values Sequence',
  '00400A992':'Uniform Resource Locator Trial (Retired)',
  '00400B020':'Waveform Annotation Sequence',
  '00400DB0':'Template Identifier','00400DB6':'Template Version',
  '00400DB7':'Template Local Version','00400DBC':'Template Extension Flag',
  '00400DBD':'Template Extension Organization UID',
  '00400DBE':'Template Extension Creator UID','00400DC0':'Referenced Content Item Identifier',
  '00400E08':'Document Identifier Code Sequence Trial (Retired)',
  '00400E09':'Document Author Trial (Retired)',
  '00400E0A':'Document Author Identifier Trial (Retired)',
  '00400E0B':'Identifier Code Sequence Trial (Retired)',
  // --- Pixel Data ---
  '7FE00001':'Extended Offset Table','7FE00002':'Extended Offset Table Lengths',
  '7FE00003':'Extended Offset Table Positions','7FE00010':'Pixel Data',
  // --- Presentation (2050) ---
  '20500020':'Presentation LUT Shape',
  '20500500':'Referenced Presentation LUT Sequence',
};

// Extended DICOM tag dictionary (appended to TAG_NAMES)
Object.assign(TAG_NAMES, {
  // --- Command (0000) ---
  '00000000':'Command Group Length','00000002':'Affected SOP Class UID',
  '00000003':'Requested SOP Class UID','00000100':'Command Field',
  '00000110':'Message ID','00000120':'Message ID Being Responded To',
  '00000600':'Move Destination','00000700':'Priority','00000800':'Command Data Set Type',
  '00000900':'Status','00000901':'Offending Element','00000902':'Error Comment',
  '00000903':'Error ID','00001000':'Affected SOP Instance UID',
  '00001001':'Requested SOP Instance UID','00001002':'Event Type ID',
  '00001005':'Attribute Identifier List','00001008':'Action Type ID',
  '00001020':'Number of Remaining Sub-operations','00001021':'Number of Completed Sub-operations',
  '00001022':'Number of Failed Sub-operations','00001023':'Number of Warning Sub-operations',
  '00001030':'Move Originator Application Entity Title',
  '00001031':'Move Originator Message ID',
  // --- Directory (0004) ---
  '00041130':'File-Set ID','00041141':'File-Set Descriptor File ID',
  '00041142':'Specific Character Set of File-Set Descriptor File',
  '00041200':'Offset of the First Directory Record of the Root Directory Entity',
  '00041202':'Offset of the Last Directory Record of the Root Directory Entity',
  '00041212':'File-Set Consistency Flag',
  '00041220':'Directory Record Sequence','00041400':'Offset of the Next Directory Record',
  '00041410':'Record In-use Flag','00041420':'Offset of Referenced Lower-Level Directory Entity',
  '00041430':'Directory Record Type','00041432':'Private Record UID',
  '00041500':'Referenced File ID','00041504':'MRDR Directory Record Offset',
  '00041510':'Referenced SOP Class UID in File','00041511':'Referenced SOP Instance UID in File',
  '00041512':'Referenced Transfer Syntax UID in File',
  '0004151A':'Referenced Related General SOP Class UID in File',
  '00041600':'Number of References',
  // --- Clinical Trial (0012) ---
  '00120010':'Clinical Trial Sponsor Name','00120020':'Clinical Trial Protocol ID',
  '00120021':'Clinical Trial Protocol Name','00120022':'Clinical Trial Site ID',
  '00120023':'Clinical Trial Site Name','00120024':'Clinical Trial Subject ID',
  '00120025':'Clinical Trial Subject Reading ID','00120026':'Clinical Trial Time Point ID',
  '00120027':'Clinical Trial Time Point Description',
  '00120028':'Clinical Trial Coordinating Center Name',
  '00120031':'Clinical Trial Series ID','00120032':'Clinical Trial Series Description',
  '00120040':'Clinical Trial Protocol Ethics Committee Approval Number',
  '00120051':'Consent for Clinical Trial Use Sequence',
  '00120052':'Distribution Type','00120053':'Consent for Distribution Flag',
  '00120060':'Clinical Trial Coordinating Center Name',
  '00120062':'Patient Identity Removed','00120063':'De-identification Method',
  '00120064':'De-identification Method Code Sequence',
  '00120072':'Clinical Trial Series Description','00120081':'Clinical Trial Protocol Ethics Committee Name',
  '00120082':'Clinical Trial Protocol Ethics Committee Approval Number',
  '00120083':'Consent for Clinical Trial Use Sequence','00120084':'Distribution Type',
  '00120085':'Consent for Distribution Flag',
  // --- Measurement (0014) ---
  '00140023':'CAD File Format','00140025':'Component Reference System',
  '00140028':'Component Manufacturer','00140030':'Material Grade',
  '00140032':'Material Properties Description','00140034':'Material Properties File Format (Retired)',
  '00140042':'Material Notes','00140044':'Component Shape',
  '00140045':'Curvature Type','00140046':'Outer Diameter',
  '00140048':'Inner Diameter',
  // --- Study Management (0032) ---
  '00321000':'Scheduled Study Start Date','00321001':'Scheduled Study Start Time',
  '00321010':'Scheduled Study Stop Date','00321011':'Scheduled Study Stop Time',
  '00321020':'Scheduled Study Start Date (Retired)','00321021':'Scheduled Study Start Time (Retired)',
  '00321040':'Scheduled Study Stop Date (Retired)','00321041':'Scheduled Study Stop Time (Retired)',
  '00321050':'Scheduled Study Status ID','00321055':'Scheduled Study Status Comment',
  '00321060':'Requested Procedure Description','00321064':'Requested Procedure Code Sequence',
  '00321067':'Reason for the Requested Procedure','00321068':'Reason for the Requested Procedure Code Sequence',
  '00321070':'Requested Contrast Agent','00324000':'Study Comments',
  // --- Visit / Admission (0038) ---
  '00380004':'Referenced Patient Alias Sequence','00380008':'Visit Status ID',
  '00380010':'Admission ID','00380011':'Issuer of Admission ID',
  '00380016':'Route of Admissions','00380020':'Admitting Date',
  '00380021':'Admitting Time','00380030':'Discharge Date',
  '00380032':'Discharge Time','00380040':'Discharge Diagnosis Description',
  '00380044':'Discharge Diagnosis Code Sequence','00380050':'Special Needs',
  '00380060':'Service Episode ID','00380061':'Issuer of Service Episode ID',
  '00380062':'Service Episode Description','00380064':'Issuer of Service Episode ID Sequence',
  '00380100':'Pertinent Documents Sequence','00380101':'Pertinent Resources Sequence',
  '00380102':'Reference Description','00380300':'Current Patient Location',
  '00380400':'Patient Institution Residence','00380500':'Patient State',
  '00380502':'Patient Clinical Trial Participation Sequence','00384000':'Visit Comments',
  // --- Waveform (003A) ---
  '003A0002':'Waveform Sequence','003A0005':'Number of Waveform Channels',
  '003A0010':'Number of Waveform Samples','003A001A':'Sampling Frequency',
  '003A0020':'Multiplex Group Label','003A0200':'Channel Definition Sequence',
  '003A0202':'Waveform Channel Number','003A0203':'Channel Label',
  '003A0205':'Channel Status','003A0208':'Channel Source Sequence',
  '003A020A':'Channel Source Modifiers Sequence','003A0210':'Channel Sensitivity',
  '003A0211':'Channel Sensitivity Units Sequence',
  '003A0212':'Channel Sensitivity Correction Factor',
  '003A0213':'Channel Baseline','003A0214':'Channel Time Skew',
  '003A0215':'Channel Sample Skew','003A0218':'Channel Offset',
  '003A021A':'Waveform Bits Stored','003A0220':'Filter Low Frequency',
  '003A0221':'Filter High Frequency','003A0222':'Notch Filter Frequency',
  '003A0223':'Notch Filter Bandwidth','003A0230':'Waveform Data Display Scale',
  '003A0240':'Waveform Presentation Group Sequence',
  '003A0241':'Presentation Group Number','003A0242':'Channel Display Sequence',
  '003A0244':'Channel Recommended Display CIELab Value',
  '003A0245':'Channel Position','003A0246':'Display Shading Flag',
  '003A0247':'Fractional Channel Display Scale','003A0248':'Absolute Channel Display Scale',
  '003A0300':'Multiplexed Audio Channels Description Code Sequence',
  '003A0301':'Channel Identification Code','003A0302':'Channel Mode',
  // --- Encrypted / HL7 (0042 / 0044) ---
  '00420011':'Encapsulated Document','00420012':'MIME Type of Encapsulated Document',
  '00420013':'Source Instance Sequence','00420014':'List of MIME Types',
  '00440001':'Product Package Identifier','00440002':'Substance Administration Approval',
  '00440003':'Approval Status Further Description','00440004':'Approval Status DateTime',
  '00440007':'Product Type Code Sequence','00440008':'Product Name',
  '00440009':'Product Description','00440010':'Product Lot Identifier',
  '00440011':'Product Expiration DateTime','00440012':'Substance Administration DateTime',
  '00440013':'Substance Administration Notes','00440019':'Substance Administration Device ID Sequence',
  // --- Ophthalmic (0046 / 0022 / 0024) ---
  '00220001':'Light Path Filter Pass-Through Wavelength','00220002':'Light Path Filter Pass Band',
  '00220003':'Image Path Filter Pass-Through Wavelength','00220004':'Image Path Filter Pass Band',
  '00220005':'Patient Eye Movement Commanded','00220006':'Patient Eye Movement Command Code Sequence',
  '00220007':'Spherical Lens Power','00220008':'Cylinder Lens Power',
  '00220009':'Cylinder Axis','0022000A':'Emmetropic Magnification',
  '0022000B':'Intra Ocular Pressure','0022000C':'Horizontal Field of View',
  '0022000D':'Pupil Dilated','0022000E':'Degree of Dilation',
  '00220010':'Stereo Baseline Angle','00220011':'Stereo Baseline Displacement',
  '00220012':'Stereo Horizontal Pixel Offset','00220013':'Stereo Vertical Pixel Offset',
  '00220014':'Stereo Rotation','00220015':'Acquisition Device Type Code Sequence',
  '00220016':'Illumination Type Code Sequence','00220017':'Light Path Filter Type Stack Code Sequence',
  '00220018':'Image Path Filter Type Stack Code Sequence','00220019':'Lenses Code Sequence',
  '0022001A':'Channel Description Code Sequence','0022001B':'Refractive State Sequence',
  '0022001C':'Mydriatic Agent Code Sequence','0022001D':'Relative Image Position Code Sequence',
  '0022001E':'Camera Angle of View','00220020':'Stereo Pairs Sequence',
  '00220021':'Left Image Sequence','00220022':'Right Image Sequence',
  '00220028':'Stereo Pairs Present',
  '00460012':'Lens Description','00460014':'Right Lens Sequence',
  '00460015':'Left Lens Sequence','00460016':'Unspecified Laterality Lens Sequence',
  '00460018':'Cylinder Sequence','00460028':'Prism Sequence',
  '00460030':'Horizontal Prism Power','00460032':'Horizontal Prism Base',
  '00460034':'Vertical Prism Power','00460036':'Vertical Prism Base',
  '00460038':'Lens Segment Type','00460040':'Optical Transmittance',
  '00460042':'Channel Width','00460044':'Pupil Size','00460046':'Corneal Size',
  // --- Device Characteristics (0050) ---
  '00500004':'Calibration Image','00500010':'Device Sequence',
  '00500012':'Container Component Type Code Sequence','00500013':'Container Component Thickness',
  '00500014':'Device Length','00500015':'Container Component Width',
  '00500016':'Device Diameter','00500017':'Device Diameter Units',
  '00500018':'Device Volume','00500019':'Inter-Marker Distance',
  '0050001A':'Container Component Material','0050001B':'Container Component ID',
  '0050001C':'Container Component Length','0050001D':'Container Component Diameter',
  '0050001E':'Container Component Description','00500020':'Device Description',
  // --- Intravascular OCT (0052) ---
  '00520001':'Contrast/Bolus Ingredient Percent by Volume',
  '00520002':'OCT Focal Distance','00520003':'Beam Spot Size',
  '00520004':'Effective Refractive Index','00520006':'OCT Acquisition Domain',
  '00520007':'OCT Optical Center Wavelength','00520008':'Axial Resolution',
  '00520009':'Ranging Depth','00520011':'A-line Rate',
  '00520012':'A-lines Per Frame','00520013':'Catheter Rotational Rate',
  '00520014':'A-line Pixel Spacing','00520016':'Mode of Percutaneous Access Sequence',
  '00520025':'Intravascular OCT Frame Type Sequence',
  '00520026':'OCT Z Offset Applied','00520027':'Near Z Offset',
  '00520028':'Far Z Offset','00520029':'Inner Lumen Contents',
  '0052002A':'Flush Agent Code Sequence',
  // --- Nuclear Medicine (0054) ---
  '00540010':'Energy Window Vector','00540011':'Number of Energy Windows',
  '00540012':'Energy Window Information Sequence','00540013':'Energy Window Range Sequence',
  '00540014':'Energy Window Lower Limit','00540015':'Energy Window Upper Limit',
  '00540016':'Radiopharmaceutical Information Sequence',
  '00540017':'Residual Syringe Counts','00540018':'Energy Window Name',
  '00540020':'Detector Vector','00540021':'Number of Detectors',
  '00540022':'Detector Information Sequence','00540030':'Phase Vector',
  '00540031':'Number of Phases','00540032':'Phase Information Sequence',
  '00540033':'Number of Frames in Phase','00540036':'Phase Delay',
  '00540038':'Pause Between Frames','00540039':'Phase Description',
  '00540050':'Rotation Vector','00540051':'Number of Rotations',
  '00540052':'Rotation Information Sequence','00540053':'Number of Frames in Rotation',
  '00540060':'R-R Interval Vector','00540061':'Number of R-R Intervals',
  '00540062':'Gated Information Sequence','00540063':'Data Information Sequence',
  '00540070':'Time Slot Vector','00540071':'Number of Time Slots',
  '00540072':'Time Slot Information Sequence','00540073':'Time Slot Time',
  '00540080':'Slice Vector','00540081':'Number of Slices',
  '00540090':'Angular View Vector','00540100':'Time Slice Vector',
  '00540101':'Number of Time Slices','00540200':'Start Angle',
  '00540202':'Type of Detector Motion','00540210':'Trigger Vector',
  '00540211':'Number of Triggers in Phase','00540220':'View Code Sequence',
  '00540222':'View Modifier Code Sequence','00540300':'Radionuclide Code Sequence',
  '00540302':'Administration Route Code Sequence',
  '00540304':'Radiopharmaceutical Code Sequence',
  '00540306':'Calibration Data Sequence','00540308':'Energy Window Number',
  '00540400':'Image ID','00540410':'Patient Orientation Code Sequence',
  '00540412':'Patient Orientation Modifier Code Sequence',
  '00540414':'Patient Gantry Relationship Code Sequence',
  '00540500':'Slice Progression Direction','00540501':'Scan Progression Direction',
  '00541000':'Series Type','00541001':'Units','00541002':'Counts Source',
  '00541004':'Reprojection Method','00541006':'SUV Type',
  '00541100':'Randoms Correction Method','00541101':'Attenuation Correction Method',
  '00541102':'Decay Correction','00541103':'Reconstruction Method',
  '00541104':'Detector Lines of Response Used','00541105':'Scatter Correction Method',
  '00541200':'Axial Acceptance','00541201':'Axial Mash','00541202':'Transverse Mash',
  '00541203':'Detector Element Size','00541210':'Coincidence Window Width',
  '00541220':'Secondary Counts Type','00541300':'Frame Reference Time',
  '00541310':'Primary (Prompts) Counts Accumulated','00541311':'Secondary Counts Accumulated',
  '00541320':'Slice Sensitivity Factor','00541321':'Decay Factor',
  '00541322':'Dose Calibration Factor','00541323':'Scatter Fraction Factor',
  '00541324':'Dead Time Factor','00541330':'Image Index',
  '00541400':'Counts Included','00541401':'Dead Time Correction Flag',
  // --- Histogram (0060) ---
  '00603000':'Histogram Sequence','00603002':'Histogram Number of Bins',
  '00603004':'Histogram First Bin Value','00603006':'Histogram Last Bin Value',
  '00603008':'Histogram Bin Width','00603010':'Histogram Explanation',
  '00603020':'Histogram Data',
  // --- Segmentation (0062) ---
  '00620001':'Segmentation Type','00620002':'Segment Sequence',
  '00620003':'Referenced Segment Number','00620004':'Segment Number',
  '00620005':'Segment Label','00620006':'Segment Description',
  '00620008':'Segment Algorithm Type','00620009':'Segment Algorithm Name',
  '0062000B':'Segment Identification Sequence',
  '0062000C':'Recommended Display Grayscale Value',
  '0062000D':'Recommended Display CIELab Value',
  '0062000E':'Maximum Fractional Value','0062000F':'Segment Type',
  '00620010':'Tracking ID','00620011':'Tracking UID',
  '00620012':'Recommended Fractional Value',
  '00620013':'Segmentation Fractional Type',
  // --- Deformable Registration (0064) ---
  '00640002':'Deformable Registration Sequence','00640003':'Source Frame of Reference UID',
  '00640005':'Deformable Registration Grid Sequence',
  '00640007':'Grid Dimensions','00640008':'Grid Resolution','00640009':'Vector Grid Data',
  '0064000F':'Pre-Deformation Matrix Registration Sequence',
  '00640010':'Post-Deformation Matrix Registration Sequence',
  // --- Surface Mesh (0066) ---
  '00660001':'Number of Surfaces','00660002':'Surface Sequence',
  '00660003':'Surface Number','00660004':'Surface Comments',
  '00660009':'Surface Processing','0066000A':'Surface Processing Ratio',
  '0066000B':'Surface Processing Description',
  '0066000C':'Recommended Presentation Opacity',
  '0066000D':'Recommended Presentation Type',
  '0066000E':'Finite Volume','00660010':'Manifold',
  '00660011':'Surface Points Sequence','00660012':'Surface Points Normals Sequence',
  '00660013':'Surface Mesh Primitives Sequence','00660015':'Number of Surface Points',
  '00660016':'Point Coordinates Data','00660017':'Point Position Accuracy',
  '00660018':'Mean Point Distance','00660019':'Maximum Point Distance',
  '0066001A':'Points Bounding Box Coordinates','0066001B':'Axis of Rotation',
  '0066001C':'Center of Rotation','0066001E':'Number of Vectors',
  '0066001F':'Vector Dimensionality','00660020':'Vector Accuracy',
  '00660021':'Vector Coordinate Data','00660023':'Triangle Point Index List',
  '00660024':'Edge Point Index List','00660025':'Vertex Point Index List',
  '00660026':'Triangle Strip Sequence','00660027':'Triangle Fan Sequence',
  '00660028':'Line Sequence','00660029':'Primitive Point Index List',
  '0066002A':'Surface Count','0066002B':'Referenced Surface Sequence',
  '0066002C':'Referenced Surface Number','0066002D':'Segment Surface Generation Algorithm Identification Sequence',
  '0066002E':'Segment Surface Source Instance Sequence',
  '0066002F':'Algorithm Family Code Sequence','00660030':'Algorithm Name Code Sequence',
  '00660031':'Algorithm Version','00660032':'Algorithm Parameters',
  '00660034':'Facet Sequence','00660035':'Surface Processing Algorithm Identification Sequence',
  '00660036':'Algorithm Name','00660037':'Recommended Point Radius',
  '00660038':'Recommended Line Thickness',
  '00660040':'Long Primitive Point Index List','00660041':'Long Triangle Point Index List',
  '00660042':'Long Edge Point Index List','00660043':'Long Vertex Point Index List',
  // --- Presentation State (0070) ---
  '00700001':'Graphic Annotation Sequence','00700002':'Graphic Layer',
  '00700003':'Bounding Box Annotation Units','00700004':'Anchor Point Annotation Units',
  '00700005':'Graphic Annotation Units','00700006':'Unformatted Text Value',
  '00700008':'Text Object Sequence','00700009':'Graphic Object Sequence',
  '00700010':'Bounding Box Top Left Hand Corner',
  '00700011':'Bounding Box Bottom Right Hand Corner',
  '00700012':'Bounding Box Text Horizontal Justification',
  '00700014':'Anchor Point','00700015':'Anchor Point Visibility',
  '00700020':'Graphic Dimensions','00700021':'Number of Graphic Points',
  '00700022':'Graphic Data','00700023':'Graphic Type','00700024':'Graphic Filled',
  '00700040':'Image Rotation (Retired)','00700041':'Image Horizontal Flip',
  '00700042':'Image Rotation','00700050':'Displayed Area Top Left Hand Corner (Retired)',
  '00700051':'Displayed Area Bottom Right Hand Corner (Retired)',
  '00700052':'Displayed Area Top Left Hand Corner',
  '00700053':'Displayed Area Bottom Right Hand Corner',
  '0070005A':'Displayed Area Selection Sequence',
  '00700060':'Graphic Layer Sequence','00700062':'Graphic Layer Order',
  '00700066':'Graphic Layer Recommended Display Grayscale Value',
  '00700067':'Graphic Layer Recommended Display RGB Value',
  '00700068':'Graphic Layer Description',
  '00700080':'Content Label','00700081':'Content Description',
  '00700082':'Presentation Creation Date','00700083':'Presentation Creation Time',
  '00700084':'Content Creator Name','00700086':'Content Creator Identification Code Sequence',
  '00700087':'Alternate Content Description Sequence',
  '00700100':'Presentation Size Mode','00700101':'Presentation Pixel Spacing',
  '00700102':'Presentation Pixel Aspect Ratio',
  '00700103':'Presentation Pixel Magnification Ratio',
  '00700207':'Graphic Group Label','00700208':'Graphic Group Description',
  '00700209':'Compound Graphic Sequence','0070021A':'Graphic Group ID',
  '00700226':'Compound Graphic Instance ID','00700227':'Font Name',
  '00700228':'Font Name Type','00700229':'CSS Font Name',
  '00700230':'Rotation Angle','00700231':'Text Style Sequence',
  '00700232':'Line Style Sequence','00700233':'Fill Style Sequence',
  '00700234':'Graphic Group Sequence','00700241':'Text Color CIELab Value',
  '00700242':'Horizontal Alignment','00700243':'Vertical Alignment',
  '00700244':'Shadow Style','00700245':'Shadow Offset X','00700246':'Shadow Offset Y',
  '00700247':'Shadow Color CIELab Value','00700248':'Underlined',
  '00700249':'Bold','00700250':'Italic','00700251':'Pattern On Color CIELab Value',
  '00700252':'Pattern Off Color CIELab Value','00700253':'Line Thickness',
  '00700254':'Line Dashing Style','00700255':'Line Pattern',
  '00700256':'Fill Pattern','00700257':'Fill Mode','00700258':'Shadow Opacity',
  '00700261':'Gap Length','00700262':'Diameter of Visibility',
  '00700273':'Rotation Point','00700274':'Tick Alignment',
  '00700278':'Show Tick Label','00700279':'Tick Label Alignment',
  '00700282':'Compound Graphic Units','00700284':'Pattern On Opacity',
  '00700285':'Pattern Off Opacity','00700287':'Major Ticks Sequence',
  '00700288':'Tick Position','00700289':'Tick Label',
  '00700294':'Compound Graphic Type','00700295':'Graphic Group ID',
  '00700306':'Shape Type','00700308':'Registration Sequence',
  '00700309':'Matrix Registration Sequence','0070030A':'Matrix Sequence',
  '0070030C':'Frame of Reference Transformation Matrix Type',
  '0070030D':'Registration Type Code Sequence',
  '0070030F':'Fiducial Description','00700310':'Fiducial Identifier',
  '00700311':'Fiducial Identifier Code Sequence','00700312':'Contour Uncertainty Radius',
  '00700314':'Used Fiducials Sequence','00700318':'Graphic Coordinates Data Sequence',
  '0070031A':'Fiducial UID','0070031C':'Fiducial Set Sequence',
  '0070031E':'Fiducial Sequence','0070031F':'Fiducial 3D Point Sequence',
  '00700400':'Referenced Image Overlay Box Sequence',
  '00700401':'Referenced Spatial Registration Sequence',
  // --- Hanging Protocol (0072) ---
  '00720002':'Hanging Protocol Name','00720004':'Hanging Protocol Description',
  '00720006':'Hanging Protocol Level','00720008':'Hanging Protocol Creator',
  '0072000A':'Hanging Protocol Creation DateTime',
  '0072000C':'Hanging Protocol Definition Sequence',
  '0072000E':'Hanging Protocol User Identification Code Sequence',
  '00720010':'Hanging Protocol User Group Name','00720012':'Source Hanging Protocol Sequence',
  '00720014':'Number of Priors Referenced','00720020':'Image Sets Sequence',
  '00720022':'Image Set Selector Sequence','00720024':'Image Set Selector Usage Flag',
  '00720026':'Selector Attribute','00720028':'Selector Value Number',
  '00720030':'Time Based Image Sets Sequence','00720032':'Image Set Number',
  '00720034':'Image Set Selector Category','00720038':'Relative Time',
  '0072003A':'Relative Time Units','0072003C':'Abstract Prior Value',
  '0072003E':'Abstract Prior Code Sequence','00720040':'Image Set Label',
  '00720050':'Image Set Selector Sequence','00720052':'Selector Attribute VR',
  '00720054':'Selector Sequence Pointer','00720056':'Selector Sequence Pointer Private Creator',
  '00720060':'Selector AT Value','00720062':'Selector CS Value',
  '00720064':'Selector IS Value','00720066':'Selector LO Value',
  '00720068':'Selector LT Value','0072006A':'Selector PN Value',
  '0072006C':'Selector SH Value','0072006E':'Selector ST Value',
  '00720070':'Selector UT Value','00720072':'Selector DS Value',
  '00720074':'Selector FD Value','00720076':'Selector FL Value',
  '00720078':'Selector UL Value','0072007A':'Selector US Value',
  '0072007C':'Selector SL Value','0072007E':'Selector SS Value',
  '0072007F':'Selector UI Value','00720080':'Selector Code Sequence Value',
  '00720100':'Number of Screens','00720102':'Nominal Screen Definition Sequence',
  '00720104':'Number of Vertical Pixels','00720106':'Number of Horizontal Pixels',
  '00720108':'Display Environment Spatial Position',
  '0072010E':'Screen Minimum Grayscale Bit Depth',
  '0072010F':'Screen Minimum Color Bit Depth','00720110':'Application Maximum Repaint Time',
  '00720200':'Display Sets Sequence','00720202':'Display Set Number',
  '00720203':'Display Set Label','00720204':'Display Set Presentation Group',
  '00720206':'Display Set Presentation Group Description',
  '00720208':'Partial Data Display Handling','00720210':'Synchronized Scrolling Sequence',
  '00720212':'Display Set Scrolling Group','00720214':'Navigation Indicator Sequence',
  '00720216':'Navigation Display Set','00720218':'Reference Display Sets',
  '00720300':'Image Boxes Sequence','00720302':'Image Box Number',
  '00720304':'Image Box Layout Type','00720306':'Image Box Row Span',
  '00720308':'Image Box Column Span','0072030A':'Image Box Scroll Direction',
  '0072030C':'Image Box Small Scroll Type','0072030E':'Image Box Small Scroll Amount',
  '00720310':'Image Box Large Scroll Type','00720312':'Image Box Large Scroll Amount',
  '00720314':'Image Box Overlap Priority','00720316':'Cine Relative to Real-Time',
  '00720318':'Filter Operations Sequence','0072031A':'Filter-by Category',
  '0072031C':'Filter-by Attribute Present','0072031E':'Filter-by Operator',
  '00720320':'Structured Display Sequence','00720330':'Structured Display Background CIELab Value',
  '00720400':'Reformatting Operation Type',
  '00720402':'Reformatting Thickness','00720404':'Reformatting Interval',
  '00720406':'Reformatting Operation Initial View Direction',
  '00720432':'3D Rendering Type','00720520':'Sorting Operations Sequence',
  '00720600':'Sort-by Category','00720602':'Sorting Direction',
  '00720700':'Display Set Patient Orientation',
  '00720702':'VOI Type','00720704':'Pseudo-Color Type',
  '00720705':'Pseudo-Color Palette Instance Reference Sequence',
  '00720706':'Show Grayscale Inverted','00720710':'Show Image True Size Flag',
  '00720712':'Show Graphic Annotation Flag','00720714':'Show Patient Demographics Flag',
  '00720716':'Show Acquisition Techniques Flag',
  '00720717':'Display Set Horizontal Justification',
  '00720718':'Display Set Vertical Justification',
  // --- Procedure Protocol (0074) ---
  '00740120':'Continuation Start Meterset','00741000':'Procedural Step State',
  '00741002':'Performed Processing Parameters Sequence',
  '00741004':'Radiation Dose Value Sequence','00741006':'Double Exposure Meterset',
  '00741008':'Double Exposure Field Delta (Retired)',
  '0074100A':'Continuations Flag','0074100C':'Referenced Defined Protocol Sequence',
  '0074100E':'Referenced Performed Protocol Sequence',
  // --- Storage (0088) ---
  '00880130':'Storage Media File-Set ID','00880140':'Storage Media File-Set UID',
  '00880200':'Icon Image Sequence','00880904':'Topic Title',
  '00880906':'Topic Subject','00880910':'Topic Author','00880912':'Topic Keywords',
  // --- Authorization (0100) ---
  '01000410':'SOP Instance Status','01000420':'SOP Authorization DateTime',
  '01000424':'SOP Authorization Comment','01000426':'Authorization Equipment Certification Number',
  // --- Digital Signatures (0400) ---
  '04000005':'MAC ID Number','04000010':'MAC Calculation Transfer Syntax UID',
  '04000015':'MAC Algorithm','04000020':'Data Elements Signed',
  '04000100':'Digital Signature UID','04000105':'Digital Signature DateTime',
  '04000110':'Certificate Type','04000115':'Certificate of Signer',
  '04000120':'Signature','04000305':'Certified Timestamp Type',
  '04000310':'Certified Timestamp','04000401':'Digital Signature Purpose Code Sequence',
  '04000402':'Referenced Digital Signature Sequence',
  '04000403':'Referenced SOP Instance MAC Sequence',
  '04000404':'MAC','04000500':'Encrypted Attributes Sequence',
  '04000510':'Encrypted Content Transfer Syntax UID','04000520':'Encrypted Content',
  '04000550':'Modified Attributes Sequence','04000561':'Original Attributes Sequence',
  '04000562':'Attribute Modification DateTime','04000563':'Modifying System',
  '04000564':'Source of Previous Values','04000565':'Reason for the Attribute Modification',
  // --- Print (2000-2200) ---
  '20000010':'Number of Copies','20000020':'Print Priority',
  '20000030':'Medium Type','20000040':'Film Destination',
  '20000050':'Film Session Label','20000060':'Memory Allocation',
  '20000061':'Maximum Memory Allocation','20000062':'Color Image Printing Flag (Retired)',
  '20000063':'Collation Flag (Retired)','20000065':'Annotation Flag (Retired)',
  '20000067':'Image Overlay Flag (Retired)','20000069':'Presentation LUT Flag (Retired)',
  '200000A0':'Printer Characteristics Sequence (Retired)',
  '200000A1':'Printer Characteristics Sequence','20000500':'Referenced Film Box Sequence',
  '20000510':'Referenced Stored Print Sequence (Retired)',
  '20100010':'Image Display Format','20100030':'Annotation Display Format ID',
  '20100040':'Film Orientation','20100050':'Film Size ID',
  '20100052':'Printer Resolution ID','20100054':'Default Printer Resolution ID',
  '20100060':'Magnification Type','20100080':'Smoothing Type',
  '201000A6':'Default Magnification Type','201000A7':'Other Magnification Types Available',
  '201000A8':'Default Smoothing Type','201000A9':'Other Smoothing Types Available',
  '20100100':'Border Density','20100110':'Empty Image Density',
  '20100120':'Min Density','20100130':'Max Density',
  '20100140':'Trim','20100150':'Configuration Information',
  '20100152':'Configuration Information Description',
  '20100154':'Maximum Collated Films','20100155':'Illumination',
  '20100160':'Reflected Ambient Light','20100376':'Printer Pixel Spacing',
  '20100500':'Referenced Film Session Sequence',
  '20100510':'Referenced Image Box Sequence','20100520':'Referenced Basic Annotation Box Sequence',
  '20200010':'Image Box Position','20200020':'Polarity',
  '20200030':'Requested Image Size','20200040':'Requested Decimate/Crop Behavior',
  '20200050':'Requested Resolution ID','202000A0':'Requested Image Size Flag',
  '202000A2':'Decimate/Crop Result','20200110':'Basic Grayscale Image Sequence',
  '20200111':'Basic Color Image Sequence','20200130':'Referenced Image Overlay Box Sequence (Retired)',
  '20200140':'Referenced VOI LUT Box Sequence (Retired)',
  '20300010':'Annotation Position','20300020':'Text String',
  '20500020':'Presentation LUT Shape','20500500':'Referenced Presentation LUT Sequence',
  '21000010':'Execution Status','21000020':'Execution Status Info',
  '21000040':'Creation Date','21000050':'Creation Time',
  '21000070':'Originator','21000140':'Destination AE',
  '21000160':'Owner ID','21000170':'Number of Films',
  '21000500':'Referenced Print Job Sequence (Pull Stored Print) (Retired)',
  '21100010':'Printer Status','21100020':'Printer Status Info',
  '21100030':'Printer Name','21100099':'Print Queue ID (Retired)',
  '21200010':'Queue Status (Retired)','21200050':'Print Job ID Sequence (Retired)',
  '21200070':'Referenced Print Job ID Sequence (Pull Stored Print) (Retired)',
  '21300010':'Print Management Capabilities Sequence (Retired)',
  '21300015':'Printer Characteristics Sequence (Retired)',
  '21300030':'Film Box Content Sequence (Retired)',
  '21300040':'Image Box Content Sequence (Retired)',
  '21300050':'Annotation Content Sequence (Retired)',
  '21300060':'Image Overlay Box Content Sequence (Retired)',
  '21300080':'Presentation LUT Content Sequence (Retired)',
  '213000A0':'Proposed Study Sequence (Retired)',
  '213000C0':'Original Image Sequence (Retired)',
  '22000001':'Label Using Information Extracted From Instances',
  '22000002':'Label Text','22000003':'Label Style Selection',
  '22000004':'Media Disposition','22000005':'Barcode Value',
  '22000006':'Barcode Symbology','22000007':'Allow Media Splitting',
  '22000008':'Include Non-DICOM Objects','22000009':'Include Display Application',
  '2200000A':'Preserve Composite Instances After Media Creation',
  '2200000B':'Total Number of Pieces of Media Created',
  '2200000C':'Requested Media Application Profile',
  '2200000D':'Referenced Storage Media Sequence',
  '2200000E':'Failure Attributes','2200000F':'Allow Lossy Compression',
  '22000020':'Request Priority',
  // --- RT (3002-300E) ---
  '30020002':'RT Image Label','30020003':'RT Image Name',
  '30020004':'RT Image Description','30020005':'RT Image Type','30020006':'Reported Values Origin',
  '30020008':'RT Image Plane','3002000A':'X-Ray Image Receptor Translation',
  '3002000C':'X-Ray Image Receptor Angle','3002000D':'RT Image Orientation',
  '3002000E':'Image Plane Pixel Spacing','30020010':'RT Image Position',
  '30020011':'Radiation Machine Name','30020012':'Radiation Machine SAD',
  '30020013':'Radiation Machine SSD','30020014':'RT Image SID',
  '30020015':'Source to Reference Object Distance','30020016':'Radiation Machine Name',
  '30020020':'Referenced Beam Number','30020022':'Referenced Fraction Number',
  '30020024':'Fraction Number','30020025':'Exposure',
  '30020026':'Meterset Exposure','30020028':'Diaphragm Position',
  '30020029':'Fluence Map Sequence','3002002A':'Fluence Data Source',
  '3002002B':'Fluence Data Scale','3002002C':'Primary Fluence Mode Sequence',
  '3002002D':'Fluence Mode','3002002E':'Fluence Mode ID',
  '30040001':'DVH Type','30040002':'Dose Grid Scaling',
  '30040004':'Dose Type','30040005':'Spatial Transform of Dose',
  '30040006':'Dose Comment','30040008':'Normalization Point',
  '3004000A':'Dose Summation Type','3004000C':'Grid Frame Offset Vector',
  '3004000E':'Dose Grid Scaling','30040010':'RT Dose ROI Sequence',
  '30040012':'Dose Value','30040014':'Tissue Heterogeneity Correction',
  '30040040':'DVH Normalization Point','30040042':'DVH Normalization Dose Value',
  '30040050':'DVH Sequence','30040052':'DVH Dose Scaling',
  '30040054':'DVH Volume Units','30040056':'DVH Number of Bins',
  '30040058':'DVH Data','30040060':'DVH Referenced ROI Sequence',
  '30040062':'DVH ROI Contribution Type','30040070':'DVH Minimum Dose',
  '30040072':'DVH Maximum Dose','30040074':'DVH Mean Dose',
  '30060002':'Structure Set Label','30060004':'Structure Set Name',
  '30060006':'Structure Set Description','30060008':'Structure Set Date',
  '30060009':'Structure Set Time','30060010':'Referenced Frame of Reference Sequence',
  '30060012':'RT Referenced Study Sequence','30060014':'RT Referenced Series Sequence',
  '30060016':'Contour Image Sequence','30060020':'Structure Set ROI Sequence',
  '30060022':'ROI Number','30060024':'Referenced Frame of Reference UID',
  '30060026':'ROI Name','30060028':'ROI Description',
  '3006002A':'ROI Display Color','3006002C':'ROI Volume',
  '30060030':'RT Related ROI Sequence','30060033':'RT ROI Relationship',
  '30060036':'ROI Generation Algorithm','30060038':'ROI Generation Description',
  '30060039':'ROI Contour Sequence','30060040':'Contour Sequence',
  '30060042':'Contour Geometric Type','30060044':'Contour Slab Thickness',
  '30060045':'Contour Offset Vector','30060046':'Number of Contour Points',
  '30060048':'Contour Number','30060049':'Attached Contours',
  '30060050':'Contour Data','30060080':'RT ROI Observations Sequence',
  '30060082':'Observation Number','30060084':'Referenced ROI Number',
  '30060085':'ROI Observation Label','30060086':'RT ROI Identification Code Sequence',
  '30060088':'ROI Observation Description','300600A0':'Related RT ROI Observations Sequence',
  '300600A4':'RT ROI Interpreted Type','300600A6':'ROI Interpreter',
  '300600B0':'ROI Physical Properties Sequence','300600B2':'ROI Physical Property',
  '300600B4':'ROI Physical Property Value','300600B6':'ROI Elemental Composition Sequence',
  '300600B7':'ROI Elemental Composition Atomic Number',
  '300600B8':'ROI Elemental Composition Atomic Mass Fraction',
  '300600C0':'Frame of Reference Relationship Sequence',
  '300600C2':'Related Frame of Reference UID',
  '300600C4':'Frame of Reference Transformation Type',
  '300600C6':'Frame of Reference Transformation Matrix',
  '300600C8':'Frame of Reference Transformation Comment',
  '300A0002':'RT Plan Label','300A0003':'RT Plan Name',
  '300A0004':'RT Plan Description','300A0006':'RT Plan Date','300A0007':'RT Plan Time',
  '300A0009':'Treatment Protocols','300A000A':'Plan Intent',
  '300A000B':'Treatment Sites','300A000C':'RT Plan Geometry',
  '300A000E':'Prescription Description','300A0010':'Dose Reference Sequence',
  '300A0012':'Dose Reference Number','300A0013':'Dose Reference UID',
  '300A0014':'Dose Reference Structure Type','300A0015':'Nominal Beam Energy Unit',
  '300A0016':'Dose Reference Description','300A0018':'Dose Reference Point Coordinates',
  '300A001A':'Nominal Prior Dose','300A0020':'Dose Reference Type',
  '300A0021':'Constraint Weight','300A0022':'Delivery Warning Dose',
  '300A0023':'Delivery Maximum Dose','300A0025':'Target Minimum Dose',
  '300A0026':'Target Prescription Dose','300A0027':'Target Maximum Dose',
  '300A0028':'Target Underdose Volume Fraction',
  '300A002A':'Organ at Risk Full-volume Dose',
  '300A002B':'Organ at Risk Limit Dose',
  '300A002C':'Organ at Risk Maximum Dose',
  '300A002D':'Organ at Risk Overdose Volume Fraction',
  '300A0040':'Tolerance Table Sequence','300A0042':'Tolerance Table Number',
  '300A0043':'Tolerance Table Label','300A0044':'Gantry Angle Tolerance',
  '300A0046':'Beam Limiting Device Angle Tolerance',
  '300A0048':'Beam Limiting Device Tolerance Sequence',
  '300A004A':'Beam Limiting Device Position Tolerance',
  '300A004B':'Snout Position Tolerance','300A004C':'Patient Support Angle Tolerance',
  '300A004E':'Table Top Eccentric Angle Tolerance',
  '300A004F':'Table Top Pitch Angle Tolerance',
  '300A0050':'Table Top Roll Angle Tolerance',
  '300A0051':'Table Top Vertical Position Tolerance',
  '300A0052':'Table Top Longitudinal Position Tolerance',
  '300A0053':'Table Top Lateral Position Tolerance',
  '300A0055':'RT Plan Relationship','300A0070':'Fraction Group Sequence',
  '300A0071':'Fraction Group Number','300A0072':'Fraction Group Description',
  '300A0078':'Number of Fractions Planned',
  '300A0079':'Number of Fraction Pattern Digits Per Day',
  '300A007A':'Repeat Fraction Cycle Length','300A007B':'Fraction Pattern',
  '300A0080':'Number of Beams','300A00A0':'Number of Brachy Application Setups',
  '300A00A2':'Brachy Application Setup Dose Specification Point',
  '300A00A4':'Brachy Application Setup Dose',
  '300A00B0':'Beam Sequence','300A00B2':'Treatment Machine Name',
  '300A00B3':'Primary Dosimeter Unit','300A00B4':'Source-Axis Distance',
  '300A00B6':'Beam Limiting Device Sequence',
  '300A00B8':'RT Beam Limiting Device Type',
  '300A00BA':'Source to Beam Limiting Device Distance',
  '300A00BB':'Isocenter to Beam Limiting Device Distance',
  '300A00BC':'Number of Leaf/Jaw Pairs',
  '300A00BE':'Leaf Position Boundaries',
  '300A00C0':'Beam Number','300A00C2':'Beam Name',
  '300A00C3':'Beam Description','300A00C4':'Beam Type',
  '300A00C5':'Beam Delivery Duration Limit','300A00C6':'Radiation Type',
  '300A00C7':'High-Dose Technique Type',
  '300A00C8':'Reference Image Number','300A00CA':'Planned Verification Image Sequence',
  '300A00CC':'Imaging Device-Specific Acquisition Parameters',
  '300A00CE':'Treatment Delivery Type','300A00D0':'Number of Wedges',
  '300A00D1':'Wedge Sequence','300A00D2':'Wedge Number',
  '300A00D3':'Wedge Type','300A00D4':'Wedge ID',
  '300A00D5':'Wedge Angle','300A00D6':'Wedge Factor',
  '300A00D7':'Total Wedge Tray Water-Equivalent Thickness',
  '300A00D8':'Wedge Orientation','300A00D9':'Isocenter to Wedge Tray Distance',
  '300A00DA':'Source to Wedge Tray Distance','300A00DB':'Wedge Thin Edge Position',
  '300A00DC':'Bolus ID','300A00DD':'Bolus Description',
  '300A00DE':'Effective Wedge Angle','300A00E0':'Number of Compensators',
  '300E0002':'Approval Status','300E0004':'Review Date',
  '300E0005':'Review Time','300E0008':'Reviewer Name',
  // --- MAC Parameters (4FFE) ---
  '4FFE0001':'MAC Parameters Sequence',
  // --- Shared Functional Groups / Per-Frame (5200 / 5400) ---
  '52009229':'Shared Functional Groups Sequence',
  '52009230':'Per-Frame Functional Groups Sequence',
  '54000100':'Waveform Sequence','54000110':'Channel Minimum Value',
  '54000112':'Channel Maximum Value','54001004':'Waveform Bits Allocated',
  '54001006':'Waveform Sample Interpretation',
  '54001010':'Waveform Padding Value','54001020':'Waveform Data',
  // --- Overlay (6000-60FF) ---
  '60000010':'Overlay Rows','60000011':'Overlay Columns',
  '60000012':'Overlay Planes','60000015':'Number of Frames in Overlay',
  '60000022':'Overlay Description','60000040':'Overlay Type',
  '60000045':'Overlay Subtype','60000050':'Overlay Origin',
  '60000051':'Image Frame Origin','60000052':'Plane Origin (Retired)',
  '60000060':'Overlay Compression Code (Retired)',
  '60000061':'Overlay Compression Originator (Retired)',
  '60000062':'Overlay Compression Label (Retired)',
  '60000063':'Overlay Compression Description (Retired)',
  '60000066':'Overlay Compression Step Pointers (Retired)',
  '60000068':'Overlay Repeat Interval (Retired)',
  '60000069':'Overlay Bits Grouped (Retired)',
  '60000100':'Overlay Bits Allocated','60000102':'Overlay Bit Position',
  '60000110':'Overlay Format (Retired)','60000200':'Overlay Location (Retired)',
  '60000800':'Overlay Code Label (Retired)','60000802':'Overlay Number of Tables (Retired)',
  '60000803':'Overlay Code Table Location (Retired)',
  '60000804':'Overlay Bits For Code Word (Retired)',
  '60001001':'Overlay Activation Layer','60001100':'Overlay Descriptor - Gray (Retired)',
  '60001101':'Overlay Descriptor - Red (Retired)','60001102':'Overlay Descriptor - Green (Retired)',
  '60001103':'Overlay Descriptor - Blue (Retired)',
  '60001200':'Overlays - Gray (Retired)','60001201':'Overlays - Red (Retired)',
  '60001202':'Overlays - Green (Retired)','60001203':'Overlays - Blue (Retired)',
  '60003000':'Overlay Data','60004000':'Overlay Comments',
  // --- Special Item Tags ---
  'FFFEE000':'Item','FFFEE00D':'Item Delimitation Item',
  'FFFEE0DD':'Sequence Delimitation Item',
  'FFFC0000':'Data Set Trailing Padding','FFFF0000':'Item',
});




// Additional tags from DICOM standard (web sourced)
Object.assign(TAG_NAMES, {
'00020031': 'RTV Meta Information Version',
'00020032': 'RTV Communication SOP Class UID',
'00020033': 'RTV Communication SOP Instance UID',
'00020035': 'RTV Source Identifier',
'00020036': 'RTV Flow Identifier',
'00020037': 'RTV Flow RTP Sampling Rate',
'00020038': 'RTV Flow Actual Frame Duration',
'00080000': 'Identifying Group Length',
'00080017': 'Acquisition UID',
'00080019': 'Pyramid UID',
'0008001C': 'Synthetic Data',
'0008001D': 'Sensitive Content Code Sequence',
'00080040': 'Data Set Type',
'00080063': 'Anatomic Regions in Study Code Sequence',
'00080100': 'Code Value',
'00080101': 'Extended Code Value',
'00080102': 'Coding Scheme Designator',
'00080103': 'Coding Scheme Version',
'00080104': 'Code Meaning',
'00080105': 'Mapping Resource',
'00080106': 'Context Group Version',
'00080107': 'Context Group Local Version',
'00080108': 'Extended Code Meaning',
'00080109': 'Coding Scheme Resources Sequence',
'0008010A': 'Coding Scheme URL Type',
'0008010B': 'Context Group Extension Flag',
'0008010C': 'Coding Scheme UID',
'0008010D': 'Context Group Extension Creator UID',
'0008010E': 'Coding Scheme URL',
'0008010F': 'Context Identifier',
'00080110': 'Coding Scheme Identification Sequence',
'00080112': 'Coding Scheme Registry',
'00080114': 'Coding Scheme External ID',
'00080115': 'Coding Scheme Name',
'00080116': 'Coding Scheme Responsible Organization',
'00080117': 'Context UID',
'00080118': 'Mapping Resource UID',
'00080119': 'Long Code Value',
'00080120': 'URN Code Value',
'00080121': 'Equivalent Code Sequence',
'00080122': 'Mapping Resource Name',
'00080123': 'Context Group Identification Sequence',
'00080124': 'Mapping Resource Identification Sequence',
'00080201': 'Timezone Offset From UTC',
'00080220': 'Responsible Group Code Sequence',
'00080221': 'Equipment Modality',
'00080222': 'Manufacturer Related Model Group',
'00080300': 'Private Data Element Characteristics Sequence',
'00080301': 'Private Group Reference',
'00080302': 'Private Creator Reference',
'00080303': 'Block Identifying Information Status',
'00080304': 'Nonidentifying Private Elements',
'00080305': 'Deidentification Action Sequence',
'00080306': 'Identifying Private Elements',
'00080307': 'Deidentification Action',
'00080308': 'Private Data Element',
'00080309': 'Private Data Element Value Multiplicity',
'0008030A': 'Private Data Element Value Representation',
'0008030B': 'Private Data Element Number of Items',
'0008030C': 'Private Data Element Name',
'0008030D': 'Private Data Element Keyword',
'0008030E': 'Private Data Element Description',
'0008030F': 'Private Data Element Encoding',
'00080310': 'Private Data Element Definition Sequence',
'00080400': 'Scope of Inventory Sequence',
'00080401': 'Inventory Purpose',
'00080402': 'Inventory Instance Description',
'00080403': 'Inventory Level',
'00080404': 'Item Inventory DateTime',
'00080405': 'Removed From Operational Use',
'00080406': 'Reason for Removal Code Sequence',
'00080407': 'Stored Instance Base URI',
'00080408': 'Folder Access URI',
'00080409': 'File Access URI',
'0008040A': 'Container File Type',
'0008040B': 'Filename in Container',
'0008040C': 'File Offset in Container',
'0008040D': 'File Length in Container',
'0008040E': 'Stored Instance Transfer Syntax UID',
'0008040F': 'Extended Matching Mechanisms',
'00080410': 'Range Matching Sequence',
'00080411': 'List of UID Matching Sequence',
'00080412': 'Empty Value Matching Sequence',
'00080413': 'General Matching Sequence',
'00080414': 'Requested Status Interval',
'00080415': 'Retain Instances',
'00080416': 'Expiration DateTime',
'00080417': 'Transaction Status',
'00080418': 'Transaction Status Comment',
'00080419': 'File Set Access Sequence',
'0008041A': 'File Access Sequence',
'0008041B': 'Record Key',
'0008041C': 'Prior Record Key',
'0008041D': 'Metadata Sequence',
'0008041E': 'Updated Metadata Sequence',
'0008041F': 'Study Update DateTime',
'00080420': 'Inventory Access End Points Sequence',
'00080421': 'Study Access End Points Sequence',
'00080422': 'Incorporated Inventory Instance Sequence',
'00080423': 'Inventoried Studies Sequence',
'00080424': 'Inventoried Series Sequence',
'00080425': 'Inventoried Instances Sequence',
'00080426': 'Inventory Completion Status',
'00080427': 'Number of Study Records in Instance',
'00080428': 'Total Number of Study Records',
'00080429': 'Maximum Number of Records',
'00081000': 'Network ID',
'00081041': 'Institutional Department Type Code Sequence',
'00081088': 'Pyramid Description',
'00081112': 'Referenced Instances by SOP Class Sequence',
'00081134': 'Referenced Stereometric Instance Sequence',
'0008114C': 'Referenced Segmentation Sequence',
'0008114D': 'Referenced Surface Segmentation Sequence',
'00081156': 'Definition Source Sequence',
'00081161': 'Simple Frame List',
'00081162': 'Calculated Frame List',
'00081190': 'Retrieve URL',
'0008119A': 'Other Failures Sequence',
'0008119B': 'Failed Study Sequence',
'00081301': 'Principal Diagnosis Code Sequence',
'00081302': 'Primary Diagnosis Code Sequence',
'00081303': 'Secondary Diagnoses Code Sequence',
'00081304': 'Histological Diagnoses Code Sequence',
'00083002': 'Available Transfer Syntax UID',
'00100000': 'Patient Group Length',
'00100011': 'Person Names to Use Sequence',
'00100012': 'Name to Use',
'00100013': 'Name to Use Comment',
'00100014': 'Third Person Pronouns Sequence',
'00100015': 'Pronoun Code Sequence',
'00100016': 'Pronoun Comment',
'00100041': 'Gender Identity Sequence',
'00100201': 'Quality Control Subject Type Code Sequence',
'00120030': 'Clinical Trial Site ID',
'00120041': 'Issuer of Clinical Trial Subject ID',
'00120042': 'Clinical Trial Subject Reading ID',
'00120043': 'Clinical Trial Issuer of Subject Reading ID',
'00120050': 'Clinical Trial Time Point ID',
'00120054': 'Clinical Trial Time Point Type Code Sequence',
'00120055': 'Issuer of Clinical Trial Time Point ID',
'00120071': 'Clinical Trial Series ID',
'00120073': 'Issuer of Clinical Trial Series ID',
'00120086': 'Ethics Committee Approval Effectiveness Start Date',
'00120087': 'Ethics Committee Approval Effectiveness End Date',
'00181017': 'Hardcopy Device Manufacturer',
'00181070': 'Radiopharmaceutical Route',
'00184000': 'Acquisition Comments',
'00185000': 'Output Power',
'00185020': 'Processing Function',
'00185040': 'Total Gain',
'00189041': 'Receive Coil Manufacturer Name',
'00189042': 'MR Receive Coil Sequence',
'00189043': 'Receive Coil Type',
'00189044': 'Quadrature Receive Coil',
'00189045': 'Multi-Coil Definition Sequence',
'00189046': 'Multi-Coil Configuration',
'00189047': 'Multi-Coil Element Name',
'00189048': 'Multi-Coil Element Used',
'00189049': 'MR Transmit Coil Sequence',
'00189050': 'Transmit Coil Manufacturer Name',
'00189051': 'Transmit Coil Type',
'00189052': 'Spectral Width',
'00189053': 'Chemical Shift Reference',
'00189054': 'Volume Localization Technique',
'00189081': 'Partial Fourier',
'00189083': 'Metabolite Map Code Sequence',
'00189100': 'Resonant Nucleus',
'00189166': 'Bulk Motion Status',
'00189168': 'Parallel Reduction Factor Second In-plane',
'00189169': 'Cardiac Beat Rejection Technique',
'00189182': 'Gradient Output',
'00189183': 'Flow Compensation Direction',
'00189184': 'Tagging Delay',
'00189185': 'Respiratory Motion Compensation Technique Description',
'00189186': 'Respiratory Signal Source ID',
'00189195': 'Chemical Shift Minimum Integration Limit in Hz',
'00189196': 'Chemical Shift Maximum Integration Limit in Hz',
'00189197': 'MR Velocity Encoding Sequence',
'00189198': 'First Order Phase Correction',
'00189199': 'Water Referenced Phase Correction',
'00189200': 'MR Spectroscopy Acquisition Type',
'00189214': 'Respiratory Cycle Position',
'00189217': 'Velocity Encoding Maximum Value',
'00189218': 'Tag Spacing Second Dimension',
'00189219': 'Tag Angle Second Axis',
'00189220': 'Frame Acquisition Duration',
'00189226': 'MR Image Frame Type Sequence',
'00189227': 'MR Spectroscopy Frame Type Sequence',
'00189231': 'MR Acquisition Phase Encoding Steps in-plane',
'00189232': 'MR Acquisition Phase Encoding Steps out-of-plane',
'00189234': 'Spectroscopy Acquisition Phase Columns',
'00189236': 'Cardiac Cycle Position',
'00189239': 'Specific Absorption Rate Sequence',
'00189240': 'RF Echo Train Length',
'00189241': 'Gradient Echo Train Length',
'00189250': 'Arterial Spin Labeling Contrast',
'00189251': 'MR Arterial Spin Labeling Sequence',
'00189252': 'ASL Technique Description',
'00189253': 'ASL Slab Number',
'00189254': 'ASL Slab Thickness',
'00189255': 'ASL Slab Orientation',
'00189256': 'ASL Mid Slab Position',
'00189257': 'ASL Context',
'00189258': 'ASL Pulse Train Duration',
'00189259': 'ASL Crusher Flag',
'0018925A': 'ASL Crusher Flow Limit',
'0018925B': 'ASL Crusher Description',
'0018925C': 'ASL Bolus Cut-off Flag',
'0018925D': 'ASL Bolus Cut-off Timing Sequence',
'0018925E': 'ASL Bolus Cut-off Technique',
'0018925F': 'ASL Bolus Cut-off Delay Time',
'00189260': 'ASL Slab Sequence',
'00189295': 'Chemical Shift Minimum Integration Limit in ppm',
'00189296': 'Chemical Shift Maximum Integration Limit in ppm',
'00189297': 'Water Reference Acquisition',
'00189298': 'Echo Peak Position',
'00189301': 'CT Acquisition Type Sequence',
'00189302': 'Acquisition Type',
'00189303': 'Tube Angle',
'00189304': 'CT Acquisition Details Sequence',
'00189305': 'Revolution Time',
'00189306': 'Single Collimation Width',
'00189307': 'Total Collimation Width',
'00189308': 'CT Table Dynamics Sequence',
'00189309': 'Table Speed',
'0018930A': 'Table Feed per Rotation',
'00189311': 'Spiral Pitch Factor',
'00189312': 'CT Geometry Sequence',
'00189313': 'Data Collection Center (Patient)',
'00189314': 'CT Reconstruction Sequence',
'00189315': 'Reconstruction Algorithm',
'00189316': 'Convolution Kernel Group',
'00189317': 'Reconstruction Field of View',
'00189318': 'Reconstruction Target Center (Patient)',
'00189319': 'Reconstruction Angle',
'00189320': 'Image Filter',
'00189321': 'CT Exposure Sequence',
'00189322': 'Reconstruction Pixel Spacing',
'00189323': 'Exposure Modulation Type',
'00189324': 'Estimated Dose Saving',
'00189325': 'CT X-Ray Details Sequence',
'00189326': 'CT Position Sequence',
'00189327': 'Table Position',
'00189328': 'Exposure Time in ms',
'00189329': 'CT Image Frame Type Sequence',
'00189330': 'X-Ray Tube Current in mA',
'00189332': 'Exposure in mAs',
'00189333': 'Constant Volume Flag',
'00189334': 'Fluoroscopy Flag',
'00189335': 'Distance Source to Data Collection Center',
'00189337': 'Contrast/Bolus Agent Number',
'00189338': 'Contrast/Bolus Ingredient Code Sequence',
'00189340': 'Contrast Administration Profile Sequence',
'00189341': 'Contrast/Bolus Usage Sequence',
'00189342': 'Contrast/Bolus Agent Administered',
'00189343': 'Contrast/Bolus Agent Detected',
'00189344': 'Contrast/Bolus Agent Phase',
'00189345': 'CTDIvol',
'00189346': 'CTDI Phantom Type Code Sequence',
'00189351': 'Calcium Scoring Mass Factor Patient',
'00189352': 'Calcium Scoring Mass Factor Device',
'00189353': 'Energy Weighting Factor',
'00189360': 'CT Additional X-Ray Source Sequence',
'00189401': 'Projection Pixel Calibration Sequence',
'00189402': 'Distance Source to Isocenter',
'00189403': 'Distance Object to Table Top',
'00189404': 'Object Pixel Spacing in Center of Beam',
'00189405': 'Positioner Position Sequence',
'00189406': 'Table Position Sequence',
'00189407': 'Collimator Shape Sequence',
'00189410': 'Planes in Acquisition',
'00189412': 'XA/XRF Frame Characteristics Sequence',
'00189417': 'Frame Acquisition Sequence',
'00189420': 'X-Ray Receptor Type',
'00189423': 'Acquisition Protocol Name',
'00189424': 'Acquisition Protocol Description',
'00189425': 'Contrast/Bolus Ingredient Opaque',
'00189426': 'Distance Receptor Plane to Detector Housing',
'00189427': 'Intensifier Active Shape',
'00189428': 'Intensifier Active Dimension(s)',
'00189429': 'Physical Detector Size',
'00189430': 'Position of Isocenter Projection',
'00189432': 'Field of View Sequence',
'00189433': 'Field of View Description',
'00189434': 'Exposure Control Sensing Regions Sequence',
'00189435': 'Exposure Control Sensing Region Shape',
'00189436': 'Exposure Control Sensing Region Left Vertical Edge',
'00189437': 'Exposure Control Sensing Region Right Vertical Edge',
'00189438': 'Exposure Control Sensing Region Upper Horizontal Edge',
'00189439': 'Exposure Control Sensing Region Lower Horizontal Edge',
'00189440': 'Center of Circular Exposure Control Sensing Region',
'00189441': 'Radius of Circular Exposure Control Sensing Region',
'00189442': 'Vertices of the Polygonal Exposure Control Sensing Region',
'00189447': 'Column Angulation (Patient)',
'00189449': 'Beam Angle',
'00189451': 'Frame Detector Parameters Sequence',
'00189452': 'Calculated Anatomy Thickness',
'00189455': 'Calibration Sequence',
'00189456': 'Object Thickness Sequence',
'00189457': 'Plane Identification',
'00189461': 'Field of View Dimension(s) in Float',
'00189462': 'Isocenter Reference System Sequence',
'00189463': 'Positioner Isocenter Primary Angle',
'00189464': 'Positioner Isocenter Secondary Angle',
'00189465': 'Positioner Isocenter Detector Rotation Angle',
'00189466': 'Table X Position to Isocenter',
'00189467': 'Table Y Position to Isocenter',
'00189468': 'Table Z Position to Isocenter',
'00189469': 'Table Horizontal Rotation Angle',
'00189470': 'Table Head Tilt Angle',
'00189471': 'Table Cradle Tilt Angle',
'00189472': 'Frame Display Shutter Sequence',
'00189473': 'Acquired Image Area Dose Product',
'00189474': 'C-arm Positioner Tabletop Relationship',
'00189476': 'X-Ray Geometry Sequence',
'00189477': 'Irradiation Event Identification Sequence',
'00189504': 'X-Ray 3D Frame Type Sequence',
'00189506': 'Contributing Sources Sequence',
'00189507': 'X-Ray 3D Acquisition Sequence',
'00189508': 'Primary Positioner Scan Arc',
'00189509': 'Secondary Positioner Scan Arc',
'00189510': 'Primary Positioner Scan Start Angle',
'00189511': 'Secondary Positioner Scan Start Angle',
'00189514': 'Primary Positioner Increment',
'00189515': 'Secondary Positioner Increment',
'00189516': 'Start Acquisition DateTime',
'00189517': 'End Acquisition DateTime',
'00189518': 'Primary Positioner Increment Sign',
'00189519': 'Secondary Positioner Increment Sign',
'00189524': 'Application Name',
'00189525': 'Application Version',
'00189526': 'Application Manufacturer',
'00189527': 'Algorithm Type',
'00189528': 'Algorithm Description',
'00189530': 'X-Ray 3D Reconstruction Sequence',
'00189531': 'Reconstruction Description',
'00189538': 'Per Projection Acquisition Sequence',
'00189601': 'Diffusion b-matrix Sequence',
'00189602': 'Diffusion b-value XX',
'00189603': 'Diffusion b-value XY',
'00189604': 'Diffusion b-value XZ',
'00189605': 'Diffusion b-value YY',
'00189606': 'Diffusion b-value YZ',
'00189607': 'Diffusion b-value ZZ',
'00189701': 'Decay Correction DateTime',
'00189715': 'Start Density Threshold',
'00189716': 'Start Relative Density Difference Threshold',
'00189717': 'Start Cardiac Trigger Count Threshold',
'00189718': 'Start Respiratory Trigger Count Threshold',
'00189719': 'Termination Counts Threshold',
'00189720': 'Termination Density Threshold',
'00189721': 'Termination Relative Density Threshold',
'00189722': 'Termination Time Threshold',
'00189723': 'Termination Cardiac Trigger Count Threshold',
'00189724': 'Termination Respiratory Trigger Count Threshold',
'00189725': 'Detector Geometry',
'00189726': 'Transverse Detector Separation',
'00189727': 'Axial Detector Dimension',
'00189729': 'Radiopharmaceutical Agent Number',
'00189732': 'PET Frame Acquisition Sequence',
'00189733': 'PET Detector Motion Details Sequence',
'00189734': 'PET Table Dynamics Sequence',
'00189735': 'PET Position Sequence',
'00189736': 'PET Frame Correction Factors Sequence',
'00189737': 'Radiopharmaceutical Usage Sequence',
'00189738': 'Attenuation Correction Source',
'00189739': 'Number of Iterations',
'00189740': 'Number of Subsets',
'00189749': 'PET Reconstruction Sequence',
'00189751': 'PET Frame Type Sequence',
'00189755': 'Time of Flight Information Used',
'00189756': 'Reconstruction Type',
'00189758': 'Decay Corrected',
'00189759': 'Attenuation Corrected',
'00189760': 'Scatter Corrected',
'00189761': 'Dead Time Corrected',
'00189762': 'Gantry Motion Corrected',
'00189763': 'Patient Motion Corrected',
'00189764': 'Count Loss Normalization Corrected',
'00189765': 'Randoms Corrected',
'00189766': 'Non-uniform Radial Sampling Corrected',
'00189767': 'Sensitivity Calibrated',
'00189768': 'Detector Normalization Correction',
'00189769': 'Iterative Reconstruction Method',
'00189770': 'Attenuation Correction Temporal Relationship',
'00189771': 'Patient Physiological State Sequence',
'00189772': 'Patient Physiological State Code Sequence',
'00189801': 'Depth(s) of Focus',
'00189803': 'Excluded Intervals Sequence',
'00189804': 'Exclusion Start DateTime',
'00189805': 'Exclusion Duration',
'00189806': 'US Image Description Sequence',
'00189807': 'Image Data Type Sequence',
'00189808': 'Data Type',
'00189809': 'Transducer Scan Pattern Code Sequence',
'0018980B': 'Aliased Data Type',
'0018980C': 'Position Measuring Device Used',
'0018980D': 'Transducer Geometry Code Sequence',
'0018980E': 'Transducer Beam Steering Code Sequence',
'0018980F': 'Transducer Application Code Sequence',
'00189810': 'Zero Velocity Pixel Value',
'0018A001': 'Contributing Equipment Sequence',
'0018A002': 'Contribution DateTime',
'0018A003': 'Contribution Description',
'0020000D': 'Study Instance UID',
'0020000E': 'Series Instance UID',
'0020008A': 'Report Number',
'00203100': 'Source Image IDs',
'00203401': 'Modifying Device ID',
'00203402': 'Modified Image ID',
'00203403': 'Modified Image Date',
'00203404': 'Modifying Device Manufacturer',
'00203405': 'Modified Image Time',
'00203406': 'Modified Image Description',
'00204000': 'Image Comments',
'00205000': 'Original Image Identification',
'00205002': 'Original Image Identification Nomenclature',
'00280124': 'Float Pixel Padding Range Limit',
'00280125': 'Double Float Pixel Padding Range Limit',
'00281080': 'Gray Scale',
'0028135A': 'Spatial Locations Preserved',
'00281401': 'Data Frame Assignment Sequence',
'00281404': 'Blending LUT 1 Sequence',
'00281405': 'Blending LUT 1 Transfer Function',
'00281406': 'Blending Weight Constant',
'00281407': 'Blending Lookup Table Descriptor',
'00281408': 'Blending Lookup Table Data',
'0028140B': 'Enhanced Palette Color Lookup Table Sequence',
'0028140C': 'Blending LUT 2 Sequence',
'0028140D': 'Blending LUT 2 Transfer Function',
'0028140E': 'Data Path ID',
'0028140F': 'RGB LUT Transfer Function',
'00281410': 'Alpha LUT Transfer Function',
'00282000': 'ICC Profile',
'00282002': 'Color Space',
'00289099': 'Largest Monochrome Pixel Value',
'00289454': 'Mask Selection Mode',
'00289506': 'Pixel Shift Frame Range',
'00289507': 'LUT Frame Range',
'00289520': 'Image to Equipment Mapping Matrix',
'00289537': 'Equipment Coordinate System Identification',
'0032000A': 'Study Status ID',
'0032000C': 'Study Priority ID',
'00320012': 'Study ID Issuer',
'00320032': 'Study Verified Date',
'00320033': 'Study Verified Time',
'00320034': 'Study Read Date',
'00320035': 'Study Read Time',
'00321030': 'Reason for Study',
'00321031': 'Requesting Physician Identification Sequence',
'00321032': 'Requesting Physician',
'00321033': 'Requesting Service',
'00321034': 'Requesting Service Code Sequence',
'00321051': 'Study Completion Time',
'00380014': 'Issuer of Admission ID Sequence',
'0038001A': 'Scheduled Admission Date',
'0038001B': 'Scheduled Admission Time',
'0038001C': 'Scheduled Discharge Date',
'0038001D': 'Scheduled Discharge Time',
'0038001E': 'Scheduled Patient Institution Residence',
'003A0004': 'Waveform Originality',
'003A0209': 'Channel Source Modifiers Sequence',
'003A020C': 'Channel Derivation Description',
'003A0231': 'Waveform Display Background CIELab Value',
'00401001': 'Requested Procedure ID',
'00401002': 'Reason for the Requested Procedure',
'00401003': 'Requested Procedure Priority',
'00401004': 'Patient Transport Arrangements',
'00401005': 'Requested Procedure Location',
'00401008': 'Confidentiality Code',
'00401009': 'Reporting Priority',
'0040100A': 'Reason for Requested Procedure Code Sequence',
'00401010': 'Names of Intended Recipients of Results',
'00401011': 'Intended Recipients of Results Identification Sequence',
'00401012': 'Reason For Performed Procedure Code Sequence',
'00401101': 'Person Identification Code Sequence',
'00401400': 'Requested Procedure Comments',
'00402001': 'Reason for the Imaging Service Request',
'00402004': 'Issue Date of Imaging Service Request',
'00402005': 'Issue Time of Imaging Service Request',
'00402008': 'Order Entered By',
'00402010': 'Order Callback Phone Number',
'00402011': 'Order Callback Telecom Information',
'00402400': 'Imaging Service Request Comments',
'00403001': 'Confidentiality Constraint on Patient Data Description',
'00404001': 'General Purpose Scheduled Procedure Step Status',
'00404002': 'General Purpose Performed Procedure Step Status',
'00404003': 'General Purpose Scheduled Procedure Step Priority',
'00404004': 'Scheduled Processing Applications Code Sequence',
'00404005': 'Scheduled Procedure Step Start DateTime',
'00404006': 'Multiple Copies Flag',
'00404007': 'Performed Processing Applications Code Sequence',
'00404009': 'Human Performer Code Sequence',
'00404010': 'Scheduled Procedure Step Modification DateTime',
'00404011': 'Expected Completion DateTime',
'00404018': 'Scheduled Workitem Code Sequence',
'00404019': 'Performed Workitem Code Sequence',
'00404020': 'Input Availability Flag',
'00404021': 'Input Information Sequence',
'00404025': 'Scheduled Station Name Code Sequence',
'00404026': 'Scheduled Station Class Code Sequence',
'00404027': 'Scheduled Station Geographic Location Code Sequence',
'00404028': 'Performed Station Name Code Sequence',
'00404029': 'Performed Station Class Code Sequence',
'00404030': 'Performed Station Geographic Location Code Sequence',
'00404031': 'Requested Subsequent Workitem Code Sequence',
'00404033': 'Output Information Sequence',
'00404034': 'Scheduled Human Performers Sequence',
'00404035': 'Actual Human Performers Sequence',
'00404040': 'Raw Data Handling',
'00404041': 'Input Readiness State',
'00404050': 'Performed Procedure Step Start DateTime',
'00404051': 'Performed Procedure Step End DateTime',
'00404052': 'Procedure Step Cancellation DateTime',
'00404070': 'Output Destination Sequence',
'00404071': 'DICOM Storage Sequence',
'00404072': 'STOW-RS Storage Sequence',
'00404073': 'Storage URL',
'00404074': 'XDS Storage Sequence',
'00408302': 'Entrance Dose in mGy',
'00409092': 'Parametric Map Frame Type Sequence',
'00409094': 'Referenced Image Real World Value Mapping Sequence',
'00409096': 'Real World Value Mapping Sequence',
'00409098': 'Pixel Value Mapping Code Sequence',
'00409210': 'LUT Label',
'00409211': 'Real World Value Last Value Mapped',
'00409212': 'Real World Value LUT Data',
'00409213': 'Double Float Real World Value Last Value Mapped',
'00409214': 'Double Float Real World Value First Value Mapped',
'00409216': 'Real World Value First Value Mapped',
'00409220': 'Quantity Definition Sequence',
'00409224': 'Real World Value Intercept',
'00409225': 'Real World Value Slope'
});
// Binary-numeric VRs for standard tags used when VR is absent (Implicit VR files).
// Only US/SS/UL/SL/FL/FD entries — all string VRs (CS/DA/DS/IS/LO/PN/…) default to string().
const IMPLICIT_VR_NUMERIC = {
  // (0002) File Meta
  '00020000':'UL',
  // (0008) Identifying
  '00081197':'US',
  // (0018) Acquisition — US
  '0018106C':'UL','00181197':'US','00181244':'US','00181310':'US',
  '00181404':'US','00181622':'US','00181623':'US','00181624':'US',
  '00189127':'UL','00189234':'UL',
  '00189240':'US','00189241':'US','00189337':'US',
  '00189219':'SS',
  // (0018) Acquisition — FD (CT/MR floating-point parameters)
  '00189073':'FD','00189098':'FD',
  '00189104':'FD','00189105':'FD','00189106':'FD',
  '00189153':'FD','00189154':'FD','00189155':'FD',
  '00189168':'FD','00189181':'FD','00189182':'FD','00189184':'FD',
  '00189196':'FD','00189197':'FD',
  '00189217':'FD','00189218':'FD','00189220':'FD','00189232':'FD',
  '00189295':'FD',
  '00189303':'FD','00189305':'FD','00189306':'FD','00189307':'FD',
  '00189309':'FD','00189310':'FD','00189311':'FD','00189313':'FD',
  '00189317':'FD','00189318':'FD','00189319':'FD',
  '00189322':'FD','00189324':'FD',
  '00189327':'FD','00189328':'FD','00189330':'FD','00189332':'FD',
  '00189335':'FD',
  // (0020) Relationship — UL/FL/FD
  '00209057':'UL','00209128':'UL','00209157':'UL','00209228':'UL',
  '00209156':'US','00209162':'US','00209163':'US',
  '00209241':'FL','00209245':'FL','00209246':'FL','00209248':'FL',
  '00209251':'FD','00209252':'FD',
  '00209254':'FD','00209255':'FD','00209256':'FD','00209257':'FD',
  // (0028) Image Pixel — US/SS
  '00280002':'US','00280003':'US','00280006':'US',
  '00280010':'US','00280011':'US','00280012':'US','00280014':'US',
  '00280100':'US','00280101':'US','00280102':'US','00280103':'US',
  '00280104':'US','00280105':'US','00280106':'US','00280107':'US',
  '00280108':'US','00280109':'US','00280110':'US','00280111':'US',
  '00280120':'US','00280121':'US',
  '00281041':'SS','00283002':'SS',
  // (0040) Modality Worklist — FD
  '00409224':'FD','00409225':'FD',
  // (5400) Waveform
  '54000100':'US',
};

function tagIdFromKey(key) {
  // dicom-parser keys: 'x00280010' → '0028,0010'
  const h = key.replace(/^x/, '').toUpperCase();
  return `(${h.slice(0,4)},${h.slice(4)})`;
}

function tagNameFromKey(key, el) {
  const h = key.replace(/^x/, '').toUpperCase();
  if (TAG_NAMES[h]) return TAG_NAMES[h];
  // Fallback: show VR if available
  if (el && el.vr) return `[${el.vr}]`;
  // Private tags: odd group
  const group = parseInt(h.slice(0, 4), 16);
  if (group % 2 === 1) return '[Private Tag]';
  return '[Unknown]';
}

function allTagsRenderList(dataSet, filter) {
  const fl = filter.toLowerCase();
  const rows = [];
  const sortedKeys = Object.keys(dataSet.elements).sort((a, b) => {
    const ah = a.replace(/^x/, '').toUpperCase();
    const bh = b.replace(/^x/, '').toUpperCase();
    return ah.localeCompare(bh);
  });
  for (const key of sortedKeys) {
    const el  = dataSet.elements[key];
    const id  = tagIdFromKey(key);
    const name = tagNameFromKey(key, el);
    let val  = '';
    let binary = false;

    if (key === 'x7fe00010') {
      val = `[Pixel Data, ${el.length} bytes]`;
      binary = true;
    } else if (el.items) {
      val = `[Sequence, ${el.items.length} item(s)]`;
      binary = true;
    } else {
      const vr = (el.vr || '').toUpperCase();
      // Read multiple numeric values separated by '\'
      const readNums = (reader, bytesEach) => {
        try {
          const count = Math.max(1, Math.floor((el.length || bytesEach) / bytesEach));
          const parts = [];
          for (let i = 0; i < count; i++) {
            const v = reader(key, i);
            if (v !== undefined && v !== null) parts.push(Number.isInteger(v) ? v : v.toPrecision(6));
          }
          return parts.join(' \\ ');
        } catch (_) { return ''; }
      };

      if (vr === 'US')      val = readNums((k,i) => dataSet.uint16(k,i), 2);
      else if (vr === 'SS') val = readNums((k,i) => dataSet.int16(k,i),  2);
      else if (vr === 'UL') val = readNums((k,i) => dataSet.uint32(k,i), 4);
      else if (vr === 'SL') val = readNums((k,i) => dataSet.int32(k,i),  4);
      else if (vr === 'FL') val = readNums((k,i) => dataSet.float(k,i),  4);
      else if (vr === 'FD') val = readNums((k,i) => dataSet.double(k,i), 8);
      else if (vr === 'AT') {
        // Attribute Tag: pairs of uint16
        try {
          const g = dataSet.uint16(key, 0);
          const e2 = dataSet.uint16(key, 1);
          if (g !== undefined && e2 !== undefined)
            val = `(${g.toString(16).padStart(4,'0').toUpperCase()},${e2.toString(16).padStart(4,'0').toUpperCase()})`;
        } catch (_) {}
      } else if (el.length > 512) {
        val = `[Binary, ${el.length} bytes]`;
        binary = true;
      } else if (!el.vr) {
        // Implicit VR — look up the expected VR from the dictionary.
        // Only binary-numeric tags are listed; everything else defaults to string.
        const h = key.replace(/^x/, '').toUpperCase();
        const ivr = h.endsWith('0000') ? 'UL' : IMPLICIT_VR_NUMERIC[h];
        if      (ivr === 'US') val = readNums((k,i) => dataSet.uint16(k,i), 2);
        else if (ivr === 'SS') val = readNums((k,i) => dataSet.int16(k,i),  2);
        else if (ivr === 'UL') val = readNums((k,i) => dataSet.uint32(k,i), 4);
        else if (ivr === 'SL') val = readNums((k,i) => dataSet.int32(k,i),  4);
        else if (ivr === 'FL') val = readNums((k,i) => dataSet.float(k,i),  4);
        else if (ivr === 'FD') val = readNums((k,i) => dataSet.double(k,i), 8);
        else {
          // String VR (CS, DA, DS, IS, LO, PN, AS, UI …) or unknown private tag
          try { val = readDicomString(dataSet, key); } catch (_) {}
        }
      } else {
        // Explicit string VR (LO, SH, PN, CS, DA, TM, UI …)
        try { val = readDicomString(dataSet, key); } catch (_) {}
      }
    }

    if (fl && !id.toLowerCase().includes(fl) &&
               !name.toLowerCase().includes(fl) &&
               !val.toLowerCase().includes(fl)) continue;

    rows.push({ id, name, val, binary });
  }
  return rows;
}

let _allTagsDataSet = null;
let _allTagsRows    = [];   // last rendered rows, for context menu

function renderAllTagsList(filter) {
  if (!_allTagsDataSet) return;
  const list  = document.getElementById('allTagsList');
  const count = document.getElementById('allTagsCount');
  if (!list) return;

  _allTagsRows = allTagsRenderList(_allTagsDataSet, filter || '');
  count.textContent = `${_allTagsRows.length} 個 tag`;
  list.innerHTML = '';

  const frag = document.createDocumentFragment();
  _allTagsRows.forEach((r, i) => {
    const id  = document.createElement('span'); id.className  = 'tag-id';   id.textContent = r.id;   id.dataset.idx = i;
    const nm  = document.createElement('span'); nm.className  = 'tag-name'; nm.textContent = r.name; nm.dataset.idx = i;
    const val = document.createElement('span'); val.className = r.binary ? 'tag-val tag-binary' : 'tag-val'; val.textContent = r.val; val.dataset.idx = i;
    frag.appendChild(id); frag.appendChild(nm); frag.appendChild(val);
  });
  list.appendChild(frag);
  if (window._updateScrollIndicator) window._updateScrollIndicator();
}

function updateAllTagsPanel(dataSet) {
  _allTagsDataSet = dataSet;
  document.getElementById('allTagsSection').style.display = 'block';
  const input = document.getElementById('tagSearchInput');
  input.value = '';
  renderAllTagsList('');
  if (window._updateScrollIndicator) window._updateScrollIndicator();
}

document.addEventListener('DOMContentLoaded', () => {
  const input = document.getElementById('tagSearchInput');
  if (input) {
    input.addEventListener('input', (e) => renderAllTagsList(e.target.value));
  }

  // ---- Tag context menu ----
  const ctxMenu  = document.getElementById('tagCtxMenu');
  const tagsList = document.getElementById('allTagsList');
  let ctxRowIdx  = -1;

  const hideCtx = () => { ctxMenu.style.display = 'none'; };

  tagsList.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const target = e.target.closest('[data-idx]');
    ctxRowIdx = target ? parseInt(target.dataset.idx, 10) : -1;

    // Disable row/val options if no row found
    const hasRow = ctxRowIdx >= 0 && _allTagsRows[ctxRowIdx];
    document.getElementById('tagCtxCopyRow').style.opacity = hasRow ? '1' : '0.4';
    document.getElementById('tagCtxCopyRow').style.pointerEvents = hasRow ? 'auto' : 'none';
    document.getElementById('tagCtxCopyVal').style.opacity = hasRow ? '1' : '0.4';
    document.getElementById('tagCtxCopyVal').style.pointerEvents = hasRow ? 'auto' : 'none';

    ctxMenu.style.display = 'block';
    const x = Math.min(e.clientX, window.innerWidth  - ctxMenu.offsetWidth  - 4);
    const y = Math.min(e.clientY, window.innerHeight - ctxMenu.offsetHeight - 4);
    ctxMenu.style.left = x + 'px';
    ctxMenu.style.top  = y + 'px';
  });

  document.addEventListener('click',       hideCtx);
  document.addEventListener('contextmenu', (e) => { if (!tagsList.contains(e.target)) hideCtx(); });
  document.addEventListener('keydown',     (e) => { if (e.key === 'Escape') hideCtx(); });

  document.getElementById('tagCtxCopyAll').addEventListener('click', () => {
    const text = _allTagsRows.map(r => `${r.id}\t${r.name}\t${r.val}`).join('\n');
    navigator.clipboard.writeText(text).then(() => {
      statusBar.textContent = `已複製 ${_allTagsRows.length} 個 tag 到剪貼簿`;
    }).catch(() => { statusBar.textContent = '複製失敗'; });
    hideCtx();
  });

  document.getElementById('tagCtxCopyRow').addEventListener('click', () => {
    if (ctxRowIdx < 0) return;
    const r = _allTagsRows[ctxRowIdx];
    navigator.clipboard.writeText(`${r.id}\t${r.name}\t${r.val}`).then(() => {
      statusBar.textContent = `已複製: ${r.id} ${r.name}`;
    }).catch(() => { statusBar.textContent = '複製失敗'; });
    hideCtx();
  });

  document.getElementById('tagCtxCopyVal').addEventListener('click', () => {
    if (ctxRowIdx < 0) return;
    const r = _allTagsRows[ctxRowIdx];
    navigator.clipboard.writeText(r.val).then(() => {
      statusBar.textContent = `已複製值: ${r.val}`;
    }).catch(() => { statusBar.textContent = '複製失敗'; });
    hideCtx();
  });
});

// ==================== DICOM Loading ====================
/** Yield to the browser paint cycle so the status bar actually repaints. */
function yieldToUI() { return new Promise(r => requestAnimationFrame(r)); }

/** Apply rescale slope/intercept and compute pixel min/max in one pass. */
function applyRescale(rawPixels, slope, intercept) {
  const count = rawPixels.length;
  const modalityValues = new Float32Array(count);
  let pixMin =  Infinity;
  let pixMax = -Infinity;
  for (let i = 0; i < count; i++) {
    const v = rawPixels[i] * slope + intercept;
    modalityValues[i] = v;
    if (v < pixMin) pixMin = v;
    if (v > pixMax) pixMax = v;
  }
  return { modalityValues, pixMin, pixMax };
}

function extractRgbPixels(rawPixels, pixelCount, samplesPerPixel, planarConfig) {
  if (!rawPixels || samplesPerPixel < 3) return null;

  const rgb = new Uint8Array(pixelCount * 3);
  if (planarConfig === 1) {
    // RRR... GGG... BBB...
    const planeSize = pixelCount;
    for (let i = 0; i < pixelCount; i++) {
      const dst = i * 3;
      rgb[dst]     = rawPixels[i];
      rgb[dst + 1] = rawPixels[i + planeSize];
      rgb[dst + 2] = rawPixels[i + planeSize * 2];
    }
  } else {
    // RGBRGB...
    for (let i = 0; i < pixelCount; i++) {
      const src = i * samplesPerPixel;
      const dst = i * 3;
      rgb[dst]     = rawPixels[src];
      rgb[dst + 1] = rawPixels[src + 1];
      rgb[dst + 2] = rawPixels[src + 2];
    }
  }
  return rgb;
}

function rgbToLuma(rgbPixels) {
  const pixelCount = Math.floor(rgbPixels.length / 3);
  const gray = new Uint8Array(pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    const j = i * 3;
    // BT.601 luma approximation
    gray[i] = Math.round(
      rgbPixels[j] * 0.299 +
      rgbPixels[j + 1] * 0.587 +
      rgbPixels[j + 2] * 0.114
    );
  }
  return gray;
}

async function loadDicom(nodeBuffer, filePath) {
  // Release previous resources
  _allTagsDataSet = null;
  _allTagsRows    = [];
  histogramData    = null;
  histogramStats   = null;

  statusBar.textContent = '解析 DICOM 格式...';
  await yieldToUI();

  // Convert Node.js Buffer → plain Uint8Array (dicom-parser needs it)
  const uint8Array = new Uint8Array(
    nodeBuffer.buffer,
    nodeBuffer.byteOffset,
    nodeBuffer.byteLength
  );

  let dataSet;
  try {
    dataSet = dicomParser.parseDicom(uint8Array, { untilTag: undefined });
  } catch (err) {
    // Try again with accept undefined lengths (some DICOM use undefined sequence length)
    try {
      dataSet = dicomParser.parseDicom(uint8Array, { allowInvalidVRLength: true });
    } catch (err2) {
      throw new Error(`DICOM 解析失敗: ${err.message} | 重試: ${err2.message}`);
    }
  }

  // --- Required tags ---
  const rows = dataSet.uint16('x00280010');
  const cols = dataSet.uint16('x00280011');
  if (!rows || !cols) throw new Error('無法讀取影像尺寸 (Rows/Columns tags 缺失)');
  const MAX_DIM = 16384;
  if (rows > MAX_DIM || cols > MAX_DIM) {
    throw new Error(`影像尺寸過大 (${cols}×${rows})，上限為 ${MAX_DIM}×${MAX_DIM}`);
  }

  const bitsAllocated    = dataSet.uint16('x00280100') || 16;
  const bitsStored       = dataSet.uint16('x00280101') || bitsAllocated;
  const highBitRaw       = dataSet.uint16('x00280102');
  const highBit          = (highBitRaw !== undefined && highBitRaw !== null)
                             ? highBitRaw
                             : (bitsStored - 1);
  const pixelRepresentation = dataSet.uint16('x00280103') || 0; // 0=unsigned, 1=signed
  const samplesPerPixel  = dataSet.uint16('x00280002') || 1;
  const planarConfig     = dataSet.uint16('x00280006') || 0;

  // --- Rescale (optional tags) ---
  const rsStr = dataSet.string('x00281053');
  const riStr = dataSet.string('x00281052');
  const rescaleSlope     = (rsStr && !isNaN(parseFloat(rsStr))) ? parseFloat(rsStr) : 1;
  const rescaleIntercept = (riStr && !isNaN(parseFloat(riStr))) ? parseFloat(riStr) : 0;

  // --- Photometric Interpretation (0028,0004) ---
  const photoInterp = (dataSet.string('x00280004') || 'MONOCHROME2')
    .trim().toUpperCase().replace(/\0/g, '');
  const isRgbImage = photoInterp === 'RGB' && samplesPerPixel >= 3 && bitsAllocated <= 8;

  // --- Extended metadata ---
  const str = (tag) => readDicomString(dataSet, tag);
  const meta = {
    patientName:     formatDicomName(str('x00100010')),
    patientId:       str('x00100020'),
    patientBirth:    formatDicomDate(str('x00100030')),
    patientSex:      str('x00100040'),
    modality:        str('x00080060'),
    studyDate:       formatDicomDate(str('x00080020')),
    studyDesc:       str('x00081030'),
    seriesDesc:      str('x0008103e'),
    institutionName: str('x00080080'),
    manufacturer:    str('x00080070'),
    bodyPart:        str('x00180015'),
    instanceNum:     str('x00200013'),
    sliceLocation:   str('x00201041'),
    sliceThickness:  str('x00180050'),
    pixelSpacing:    str('x00280030'),
    kvp:             str('x00180060'),
    tubeCurrent:     str('x00181151'),
    exposureTime:    str('x00181150'),
    echoTime:        str('x00180081'),
    repTime:         str('x00180080'),
    flipAngle:       str('x00181314'),
    imageType:       str('x00080008'),
    transferSyntax:  getTransferSyntaxUID(dataSet),
    bitsAllocated:   String(bitsAllocated),
    photometric:     photoInterp,
    rows:            String(rows),
    cols:            String(cols),
    rescaleSlope:    rsStr || '1',
    rescaleIntercept:riStr || '0',
  };

  // --- Window / Level tags (may contain multiple values separated by '\') ---
  const wcRaw = dataSet.string('x00281050');
  const wwRaw = dataSet.string('x00281051');

  // --- Pixel data ---
  const pixelDataElement = dataSet.elements.x7fe00010;
  if (!pixelDataElement) throw new Error('找不到像素資料 (tag 7FE0,0010 不存在)');

  const pixelCount = rows * cols;
  const slope      = rescaleSlope !== 0 ? rescaleSlope : 1;
  const intercept  = rescaleIntercept;

  let modalityValues, pixMin, pixMax;
  let colorPixels = null;

  if (pixelDataElement.encapsulatedPixelData) {
    // ---- Compressed path ----
    const tsUID     = getTransferSyntaxUID(dataSet);
    const frameData = extractEncapsulatedFrame(dataSet, pixelDataElement);
    statusBar.textContent = '解碼壓縮影像...';
    await yieldToUI();

    const isJ2K = tsUID === '1.2.840.10008.1.2.4.90' || tsUID === '1.2.840.10008.1.2.4.91';
    if (isJ2K && !isRgbImage) {
      // Offload WASM decode + rescale to background worker so UI stays responsive
      const result = await decodeInWorker(frameData, bitsAllocated, pixelRepresentation, slope, intercept);
      modalityValues = new Float32Array(result.modalityBuf);
      pixMin         = result.pixMin;
      pixMax         = result.pixMax;
    } else {
      const decoded = await decodeCompressedFrame(frameData, tsUID, bitsAllocated, pixelRepresentation, samplesPerPixel);
      if (isRgbImage) {
        const rgb = extractRgbPixels(decoded.pixels, pixelCount, samplesPerPixel, planarConfig);
        if (rgb && rgb.length === pixelCount * 3) {
          colorPixels = rgb;
          ({ modalityValues, pixMin, pixMax } = applyRescale(rgbToLuma(rgb), slope, intercept));
        } else {
          ({ modalityValues, pixMin, pixMax } = applyRescale(decoded.pixels, slope, intercept));
        }
      } else {
        ({ modalityValues, pixMin, pixMax } = applyRescale(decoded.pixels, slope, intercept));
      }
    }
  } else {
    // ---- Uncompressed path ----
    const bytesPerPixel = Math.ceil(bitsAllocated / 8);
    const pixelByteLen  = pixelCount * samplesPerPixel * bytesPerPixel;
    const offset        = pixelDataElement.dataOffset;
    const src           = dataSet.byteArray;
    const available     = src.length - offset;
    if (available < pixelByteLen) {
      console.warn(`像素資料長度不足: 需要 ${pixelByteLen}, 可用 ${available}`);
      statusBar.textContent = `警告: 像素資料不完整 (需要 ${pixelByteLen} bytes, 僅有 ${available})`;
    }
    const pixelBytes = new Uint8Array(pixelByteLen);
    pixelBytes.set(src.subarray(offset, offset + Math.min(pixelByteLen, available)));

    let rawPixels;
    if (bitsAllocated <= 8) {
      rawPixels = pixelRepresentation === 1
        ? new Int8Array(pixelBytes.buffer)
        : new Uint8Array(pixelBytes.buffer);
    } else if (bitsAllocated <= 16) {
      rawPixels = pixelRepresentation === 1
        ? new Int16Array(pixelBytes.buffer)
        : new Uint16Array(pixelBytes.buffer);
    } else if (bitsAllocated <= 32) {
      rawPixels = new Int32Array(pixelBytes.buffer);
    } else {
      throw new Error(`不支援的位元深度: ${bitsAllocated}`);
    }
    statusBar.textContent = '處理像素資料...';
    await yieldToUI();
    if (isRgbImage) {
      const rgb = extractRgbPixels(rawPixels, pixelCount, samplesPerPixel, planarConfig);
      if (rgb && rgb.length === pixelCount * 3) {
        colorPixels = rgb;
        ({ modalityValues, pixMin, pixMax } = applyRescale(rgbToLuma(rgb), slope, intercept));
      } else {
        ({ modalityValues, pixMin, pixMax } = applyRescale(rawPixels, slope, intercept));
      }
    } else {
      ({ modalityValues, pixMin, pixMax } = applyRescale(rawPixels, slope, intercept));
    }
  }

  // Theoretical range based on High Bit and pixel representation
  let storedMin, storedMax;
  if (pixelRepresentation === 1) {
    storedMin = -Math.pow(2, highBit);
    storedMax =  Math.pow(2, highBit) - 1;
  } else {
    storedMin = 0;
    storedMax = Math.pow(2, highBit + 1) - 1;
  }
  let theoreticalMin = storedMin * slope + intercept;
  let theoreticalMax = storedMax * slope + intercept;
  if (slope < 0) {
    [theoreticalMin, theoreticalMax] = [theoreticalMax, theoreticalMin];
  }

  // Histogram axis range: extend actual min/max by 25%, clamp to theoretical limits
  const pixRange = (pixMax - pixMin) || 1;
  const ext      = pixRange * 0.25;
  const histXMin = Math.max(pixMin - ext, theoreticalMin);
  const histXMax = Math.min(pixMax + ext, theoreticalMax);

  // Parse W/C & W/W (tags may hold multiple values)
  let wc = wcRaw ? parseFloat(wcRaw.split('\\')[0]) : NaN;
  let ww = wwRaw ? parseFloat(wwRaw.split('\\')[0]) : NaN;
  if (isNaN(wc) || isNaN(ww) || ww <= 0) {
    wc = (pixMin + pixMax) / 2;
    ww = pixRange;
  }

  // --- Update global state ---
  state.pixelValues       = modalityValues;
  state.colorPixels       = colorPixels;
  state.imageWidth        = cols;
  state.imageHeight       = rows;
  state.windowCenter      = wc;
  state.windowWidth       = ww;
  state.originalWC        = wc;
  state.originalWW        = ww;
  state.pixelMin          = pixMin;
  state.pixelMax          = pixMax;
  state.histXMin          = histXMin;
  state.histXMax          = histXMax;
  const tsUID = getTransferSyntaxUID(dataSet);
  const renderPipeline = {
    // ① 像素解碼
    tsUID,
    isCompressed:       !!pixelDataElement.encapsulatedPixelData,
    isBigEndian:        tsUID === '1.2.840.10008.1.2.2',
    bitsAllocated,
    bitsStored,
    highBit,
    pixelRepresentation,
    samplesPerPixel,
    planarConfig,
    // ② Modality LUT
    rescaleSlope:       rescaleSlope !== 0 ? rescaleSlope : 1,
    rescaleIntercept,
    rescaleType:        readDicomString(dataSet, 'x00281054'),
    pixelMin:           pixMin,
    pixelMax:           pixMax,
    // ③ VOI LUT
    wcFromTag:          wc,
    wwFromTag:          ww,
    wcWwSource:         (wcRaw && wwRaw) ? 'DICOM Tag (0028,1050/1051)' : '自動計算（Tag 缺失）',
    wwExplanation:      readDicomString(dataSet, 'x00281055'),
    // ④ 光度詮釋
    photometric:        photoInterp,
    pixelAspectRatio:   readDicomString(dataSet, 'x00280034'),
  };

  state.photometricInterp = photoInterp;
  state.dicomMeta         = meta;
  state.renderPipeline    = renderPipeline;
  state.cursorPixelValue  = null;
  state.cursorImgX        = -1;
  state.cursorImgY        = -1;
  document.getElementById('monoRow').style.display =
    photoInterp === 'MONOCHROME1' ? 'flex' : 'none';

  histogramStats = calculateRawHistogramStats(modalityValues, slope, intercept);
  histogramData  = calculateHistogram(modalityValues, histXMin, histXMax, 256);

  if (offscreenCanvas) {
    offscreenCanvas.width = 0;
    offscreenCanvas.height = 0;
  }
  offscreenCanvas        = document.createElement('canvas');
  offscreenCanvas.width  = cols;
  offscreenCanvas.height = rows;

  statusBar.textContent = '渲染影像...';
  await yieldToUI();

  updateDicomInfoPanel(meta);
  updateRenderPipelinePanel(renderPipeline);
  updateAllTagsPanel(dataSet);
  fitImageToCanvas();
  renderAll();

  const fileName = filePath.replace(/\\/g, '/').split('/').pop();
  const spacing  = meta.pixelSpacing ? `  |  Spacing: ${formatSpacing(meta.pixelSpacing)} mm` : '';
  statusBar.textContent =
    `已載入: ${fileName}  |  ${meta.modality || '?'}  |  ${cols}×${rows}  |  ${bitsAllocated}-bit${spacing}`;
}

// ==================== Histogram Calculation ====================
function calculateRawHistogramStats(values, slope, intercept) {
  const countsByValue = new Map();

  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (!Number.isFinite(value)) continue;
    countsByValue.set(value, (countsByValue.get(value) || 0) + 1);
  }

  const sortedValues = Array.from(countsByValue.keys()).sort((a, b) => a - b);
  return {
    countsByValue,
    sortedValues,
    valueStep: Math.abs(slope) || 1,
    valueOffset: intercept || 0,
  };
}

function getRawHistogramPointAtValue(targetValue) {
  if (!histogramStats || !histogramStats.sortedValues.length) return null;

  const step = histogramStats.valueStep || 1;
  const offset = histogramStats.valueOffset || 0;
  let value = offset + Math.round((targetValue - offset) / step) * step;
  value = Math.fround(value);

  if (Math.abs(value - Math.round(value)) < 1e-6) {
    value = Math.round(value);
  }

  return { value, count: histogramStats.countsByValue.get(value) || 0 };
}

function formatHistogramValue(value) {
  if (!Number.isFinite(value)) return '?';
  if (Math.abs(value - Math.round(value)) < 1e-6) return Math.round(value).toString();
  const abs = Math.abs(value);
  const digits = abs >= 1000 ? 1 : abs >= 10 ? 2 : 3;
  return value.toFixed(digits).replace(/\.?0+$/, '');
}

function calculateHistogram(values, xMin, xMax, bins) {
  const counts = new Array(bins).fill(0);
  const range  = xMax - xMin;
  if (range === 0) return counts.map(() => ({ count: 0 }));

  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v < xMin || v > xMax) continue;
    const bin = Math.min(Math.floor((v - xMin) / range * bins), bins - 1);
    counts[bin]++;
  }

  return counts.map((count, i) => ({
    value: xMin + (i + 0.5) / bins * range,
    count,
  }));
}

// ==================== Window / Level → Offscreen Canvas ====================
function applyWindowLevelToOffscreen() {
  if (!offscreenCanvas || !state.pixelValues) return;

  const ctx     = offscreenCanvas.getContext('2d');
  if (!ctx) return;
  const imgData = ctx.createImageData(state.imageWidth, state.imageHeight);
  const data    = imgData.data;

  if (state.colorPixels) {
    const count = state.imageWidth * state.imageHeight;
    for (let i = 0; i < count; i++) {
      const src = i * 3;
      const dst = i * 4;
      data[dst]     = state.colorPixels[src];
      data[dst + 1] = state.colorPixels[src + 1];
      data[dst + 2] = state.colorPixels[src + 2];
      data[dst + 3] = 255;
    }
    ctx.putImageData(imgData, 0, 0);
    return;
  }

  const wc        = state.windowCenter;
  const ww        = Math.max(state.windowWidth, 1);
  const wMin      = wc - ww / 2;
  const doInvert  = (state.photometricInterp === 'MONOCHROME1' && state.invertMono1)
                  !== state.manualInvert; // XOR: manual toggle flips both cases

  for (let i = 0; i < state.pixelValues.length; i++) {
    const v  = state.pixelValues[i];
    let gray;
    if      (v <= wMin)      gray = 0;
    else if (v >= wMin + ww) gray = 255;
    else                     gray = Math.round((v - wMin) / ww * 255);

    if (doInvert) gray = 255 - gray;

    const idx      = i * 4;
    data[idx]      = gray;
    data[idx + 1]  = gray;
    data[idx + 2]  = gray;
    data[idx + 3]  = 255;
  }

  ctx.putImageData(imgData, 0, 0);
}

// ==================== Main Canvas Rendering ====================
function renderMainCanvas() {
  mainCtx.clearRect(0, 0, mainCanvas.width, mainCanvas.height);
  mainCtx.fillStyle = '#111111';
  mainCtx.fillRect(0, 0, mainCanvas.width, mainCanvas.height);

  if (!offscreenCanvas) {
    mainCtx.fillStyle = '#2a2a2a';
    mainCtx.font      = '16px sans-serif';
    mainCtx.textAlign = 'center';
    mainCtx.fillText(
      '請使用「檔案 > 載入」開啟 DICOM 檔案',
      mainCanvas.width / 2,
      mainCanvas.height / 2
    );
    return;
  }

  mainCtx.save();
  mainCtx.translate(state.tx, state.ty);
  mainCtx.scale(state.scale, state.scale);
  mainCtx.imageSmoothingEnabled = state.smoothInterp;
  mainCtx.imageSmoothingQuality = 'high';
  mainCtx.drawImage(offscreenCanvas, 0, 0);
  mainCtx.restore();

  if (state.showInfoOverlay && state.imageWidth) drawInfoOverlay();
  if (state.showRuler && state.imageWidth)        drawRuler();
  if (state.showPixelValue && state.cursorPixelValue !== null) drawPixelValueOverlay();
}

function fitImageToCanvas() {
  if (!state.imageWidth || !state.imageHeight) return;
  const cw    = mainCanvas.width;
  const ch    = mainCanvas.height;
  state.scale = Math.min(cw / state.imageWidth, ch / state.imageHeight);
  state.tx    = (cw - state.imageWidth  * state.scale) / 2;
  state.ty    = (ch - state.imageHeight * state.scale) / 2;
}

// ==================== Image Overlays ====================
/** Draw lines top-down from (x, y). Pass fromBottom=true to draw bottom-up. */
function overlayText(lines, x, y, align, fromBottom = false) {
  mainCtx.textAlign    = align;
  mainCtx.font         = '12px Consolas, monospace';
  mainCtx.shadowColor  = '#000';
  mainCtx.shadowBlur   = 4;
  const lineH = 15;
  const filtered = lines.filter(Boolean);
  filtered.forEach((line, i) => {
    const row = fromBottom ? filtered.length - 1 - i : i;
    mainCtx.fillStyle = 'rgba(255,255,255,0.85)';
    mainCtx.fillText(line, x, y - (fromBottom ? i * lineH : 0) + (fromBottom ? 0 : row * lineH));
  });
  mainCtx.shadowBlur = 0;
}

function drawInfoOverlay() {
  const m    = state.dicomMeta;
  const W    = mainCanvas.width;
  const H    = mainCanvas.height;
  const pad  = 10;
  const zoom = (state.scale * 100).toFixed(0) + '%';

  // Top-left: patient
  overlayText([
    m.patientName || '',
    m.patientId   ? `ID: ${m.patientId}` : '',
    [m.patientBirth, m.patientSex].filter(Boolean).join('  '),
  ], pad, pad + 13, 'left');

  // Top-right: study / series
  overlayText([
    m.modality    || '',
    m.studyDate   || '',
    m.seriesDesc  || m.studyDesc || '',
    m.bodyPart    ? `部位: ${m.bodyPart}` : '',
    m.institutionName || '',
  ], W - pad, pad + 13, 'right');

  // Bottom-left: W/C, W/W, zoom (drawn bottom-up)
  overlayText([
    `縮放: ${zoom}`,
    `WC: ${Math.round(state.windowCenter)}  WW: ${Math.round(state.windowWidth)}`,
    m.instanceNum   ? `影像: ${m.instanceNum}` : '',
    m.sliceLocation ? `Loc: ${parseFloat(m.sliceLocation).toFixed(1)} mm` : '',
  ], pad, H - pad, 'left', true);

  // Bottom-right: geometry (drawn bottom-up)
  overlayText([
    m.tubeCurrent ? `mA: ${m.tubeCurrent}` : '',
    m.kvp         ? `KVP: ${m.kvp} kV` : '',
    m.sliceThickness ? `層厚: ${m.sliceThickness} mm` : '',
    m.pixelSpacing   ? `間距: ${formatSpacing(m.pixelSpacing)} mm` : '',
    `${state.imageWidth} × ${state.imageHeight} px`,
  ], W - pad, H - pad, 'right', true);
}

function drawPixelValueOverlay() {
  if (state.cursorImgX < 0) return;
  const val = state.cursorPixelValue;
  const label = `(${state.cursorImgX}, ${state.cursorImgY})  HU: ${Number.isFinite(val) ? val.toFixed(0) : '?'}`;
  mainCtx.font         = '12px Consolas, monospace';
  mainCtx.textAlign    = 'left';
  mainCtx.shadowColor  = '#000';
  mainCtx.shadowBlur   = 4;
  mainCtx.fillStyle    = '#ffe066';
  mainCtx.fillText(label, 10, mainCanvas.height - 6);
  mainCtx.shadowBlur   = 0;
}

function drawRuler() {
  if (!state.dicomMeta.pixelSpacing) return;
  const parts = state.dicomMeta.pixelSpacing.split(/[\\/,]/);
  const mmPerPx = parseFloat(parts[0]) || 1;       // mm per source pixel
  const screenMmPerPx = mmPerPx * state.scale;      // mm per screen pixel

  // Choose a nice ruler length in mm
  const targetScreenPx = 120;
  const niceMm = [1,2,5,10,20,50,100,200,500];
  let rulerMm = niceMm[0];
  for (const m of niceMm) {
    rulerMm = m;
    if (m * screenMmPerPx >= targetScreenPx) break;  // wait — mm/screenPx, we need screenPx/mm
  }
  // screenPx = rulerMm / mmPerPx * state.scale
  const rulerPx = (rulerMm / mmPerPx) * state.scale;

  const x = 10, y = mainCanvas.height - 30;
  mainCtx.strokeStyle = 'rgba(255,255,255,0.8)';
  mainCtx.lineWidth   = 2;
  mainCtx.shadowColor = '#000';
  mainCtx.shadowBlur  = 3;
  mainCtx.beginPath();
  mainCtx.moveTo(x, y);     mainCtx.lineTo(x + rulerPx, y);
  mainCtx.moveTo(x, y - 5); mainCtx.lineTo(x, y + 5);
  mainCtx.moveTo(x + rulerPx, y - 5); mainCtx.lineTo(x + rulerPx, y + 5);
  mainCtx.stroke();
  mainCtx.shadowBlur  = 0;
  mainCtx.fillStyle   = 'rgba(255,255,255,0.9)';
  mainCtx.font        = '11px Consolas, monospace';
  mainCtx.textAlign   = 'center';
  mainCtx.fillText(`${rulerMm} mm`, x + rulerPx / 2, y - 7);
}

// ==================== Histogram Rendering ====================
function getNiceTicks(min, max, targetCount) {
  const range = max - min;
  if (range === 0) return [min];
  const roughStep  = range / targetCount;
  const magnitude  = Math.pow(10, Math.floor(Math.log10(Math.abs(roughStep))));
  const norm       = roughStep / magnitude;
  let niceNorm;
  if      (norm < 1.5) niceNorm = 1;
  else if (norm < 3.5) niceNorm = 2;
  else if (norm < 7.5) niceNorm = 5;
  else                 niceNorm = 10;
  const step  = niceNorm * magnitude;
  const first = Math.ceil(min / step - 1e-9) * step;
  const ticks = [];
  for (let t = first; t <= max + step * 1e-9; t += step) {
    const r = Math.round(t / step) * step;
    if (r >= min - step * 1e-9 && r <= max + step * 1e-9) ticks.push(r);
  }
  return ticks;
}

function renderHistogram() {
  const W     = histCanvas.width;
  const H     = histCanvas.height;
  const drawW = W - M.left - M.right;
  const drawH = H - M.top  - M.bottom;

  histCtx.clearRect(0, 0, W, H);
  histCtx.fillStyle = '#0d1117';
  histCtx.fillRect(0, 0, W, H);

  if (!histogramData || drawW <= 0 || drawH <= 0) {
    histCtx.fillStyle = '#484f58';
    histCtx.font      = '13px sans-serif';
    histCtx.textAlign = 'center';
    histCtx.fillText('無資料', W / 2, H / 2);
    return;
  }

  const xMin   = state.histXMin;
  const xMax   = state.histXMax;
  const xRange = xMax - xMin || 1;
  const valToX = (v) => M.left + (v - xMin) / xRange * drawW;

  const maxCount = Math.max(1, ...histogramData.map(d => d.count));
  const numBins  = histogramData.length;
  const binPxW   = drawW / numBins;

  // --- Histogram bars ---
  histCtx.fillStyle = '#1a5276';
  for (let i = 0; i < numBins; i++) {
    const count = histogramData[i].count;
    if (count <= 0) continue;
    const barH = Math.max(1, Math.sqrt(count / maxCount) * drawH);
    const x = M.left + (i / numBins) * drawW;
    const y = M.top + drawH - barH;
    histCtx.fillRect(x, y, Math.max(1, binPxW - 0.5), barH);
  }

  // --- Window overlay (yellow tinted region) ---
  const wMin   = state.windowCenter - state.windowWidth / 2;
  const wMax   = state.windowCenter + state.windowWidth / 2;
  const wxMin  = Math.max(valToX(wMin), M.left);
  const wxMax  = Math.min(valToX(wMax), M.left + drawW);

  if (wxMax > wxMin) {
    histCtx.fillStyle = 'rgba(255, 200, 0, 0.13)';
    histCtx.fillRect(wxMin, M.top, wxMax - wxMin, drawH);
  }

  // --- Left handle ---
  const lx = valToX(wMin);
  if (lx >= M.left - 2 && lx <= M.left + drawW + 2) {
    histCtx.strokeStyle = '#ffc800';
    histCtx.lineWidth   = 2;
    histCtx.beginPath();
    histCtx.moveTo(lx, M.top);
    histCtx.lineTo(lx, M.top + drawH);
    histCtx.stroke();
    // handle knob
    histCtx.fillStyle = '#ffc800';
    const ky = M.top + drawH / 2;
    histCtx.fillRect(lx - 5, ky - 10, 5, 20);
  }

  // --- Right handle ---
  const rx = valToX(wMax);
  if (rx >= M.left - 2 && rx <= M.left + drawW + 2) {
    histCtx.strokeStyle = '#ffc800';
    histCtx.lineWidth   = 2;
    histCtx.beginPath();
    histCtx.moveTo(rx, M.top);
    histCtx.lineTo(rx, M.top + drawH);
    histCtx.stroke();
    histCtx.fillStyle = '#ffc800';
    const ky = M.top + drawH / 2;
    histCtx.fillRect(rx, ky - 10, 5, 20);
  }

  // --- Center dashed line ---
  const wcX = valToX(state.windowCenter);
  if (wcX >= M.left && wcX <= M.left + drawW) {
    histCtx.strokeStyle = 'rgba(255, 200, 0, 0.45)';
    histCtx.lineWidth   = 1;
    histCtx.setLineDash([4, 4]);
    histCtx.beginPath();
    histCtx.moveTo(wcX, M.top);
    histCtx.lineTo(wcX, M.top + drawH);
    histCtx.stroke();
    histCtx.setLineDash([]);
  }

  // --- Axes ---
  histCtx.strokeStyle = '#30363d';
  histCtx.lineWidth   = 1;
  histCtx.beginPath();
  histCtx.moveTo(M.left, M.top);
  histCtx.lineTo(M.left, M.top + drawH);
  histCtx.lineTo(M.left + drawW, M.top + drawH);
  histCtx.stroke();

  // --- X-axis ticks and labels ---
  const ticks = getNiceTicks(xMin, xMax, 6);
  histCtx.fillStyle   = '#8b949e';
  histCtx.font        = '10px Consolas, monospace';
  histCtx.strokeStyle = '#30363d';
  histCtx.lineWidth   = 1;

  for (const tick of ticks) {
    const tx = valToX(tick);
    if (tx < M.left || tx > M.left + drawW) continue;
    histCtx.beginPath();
    histCtx.moveTo(tx, M.top + drawH);
    histCtx.lineTo(tx, M.top + drawH + 5);
    histCtx.stroke();

    histCtx.textAlign = 'center';
    const label = Number.isInteger(tick) ? tick.toString() : tick.toFixed(1);
    histCtx.fillText(label, tx, M.top + drawH + 16);
  }

  // --- WC / WW text in histogram ---
  histCtx.fillStyle = '#ffc800';
  histCtx.font      = 'bold 11px Consolas, monospace';
  histCtx.textAlign = 'left';
  histCtx.fillText(`WC: ${Math.round(state.windowCenter)}`, M.left + 6, M.top + 13);
  histCtx.fillText(`WW: ${Math.round(state.windowWidth)}`,  M.left + 6, M.top + 26);

  // --- Mouse crosshair + tooltip ---
  if (state.histCursorX !== null) {
    const cx = state.histCursorX;
    const cy = state.histCursorY;
    if (cx >= M.left && cx <= M.left + drawW && cy >= M.top && cy <= M.top + drawH) {
      const cursorValue = state.histXMin + (cx - M.left) / drawW * (state.histXMax - state.histXMin);
      const rawPoint = getRawHistogramPointAtValue(cursorValue);
      const xVal = rawPoint ? rawPoint.value : cursorValue;
      const yCount = rawPoint ? rawPoint.count : 0;

      // Crosshair lines
      histCtx.save();
      histCtx.strokeStyle = 'rgba(255,255,255,0.35)';
      histCtx.lineWidth   = 1;
      histCtx.setLineDash([3, 3]);
      histCtx.beginPath();
      histCtx.moveTo(cx, M.top);
      histCtx.lineTo(cx, M.top + drawH);
      histCtx.stroke();
      histCtx.beginPath();
      histCtx.moveTo(M.left, cy);
      histCtx.lineTo(M.left + drawW, cy);
      histCtx.stroke();
      histCtx.setLineDash([]);

      // Tooltip box
      const label1 = `X: ${formatHistogramValue(xVal)}`;
      const label2 = `Y: ${yCount}`;
      histCtx.font = '11px Consolas, monospace';
      const tw = Math.max(histCtx.measureText(label1).width, histCtx.measureText(label2).width);
      const bw = tw + 14;
      const bh = 34;
      let bx = cx + 10;
      let by = cy - bh - 6;
      if (bx + bw > M.left + drawW) bx = cx - bw - 10;
      if (by < M.top)               by = cy + 8;

      histCtx.fillStyle = 'rgba(13,17,23,0.85)';
      histCtx.strokeStyle = 'rgba(255,255,255,0.25)';
      histCtx.lineWidth = 1;
      histCtx.beginPath();
      histCtx.roundRect(bx, by, bw, bh, 4);
      histCtx.fill();
      histCtx.stroke();

      histCtx.fillStyle = '#e6edf3';
      histCtx.textAlign = 'left';
      histCtx.fillText(label1, bx + 7, by + 13);
      histCtx.fillText(label2, bx + 7, by + 27);
      histCtx.restore();
    }
  }
}

// ==================== Combined Render ====================
function renderAll() {
  applyWindowLevelToOffscreen();
  renderMainCanvas();
  renderHistogram();
  updateInfoDisplay();
}

function updateInfoDisplay() {
  wcDisplay.textContent = Math.round(state.windowCenter).toString();
  wwDisplay.textContent = Math.round(state.windowWidth).toString();
}

// ==================== Histogram Interaction ====================
function histValToX(v) {
  const drawW = histCanvas.width - M.left - M.right;
  return M.left + (v - state.histXMin) / (state.histXMax - state.histXMin) * drawW;
}

function histXToVal(x) {
  const drawW = histCanvas.width - M.left - M.right;
  return state.histXMin + (x - M.left) / drawW * (state.histXMax - state.histXMin);
}

function getHistMouseX(e) {
  const rect = histCanvas.getBoundingClientRect();
  return (e.clientX - rect.left) * (histCanvas.width / rect.width);
}

histCanvas.addEventListener('mousedown', (e) => {
  if (!histogramData) return;

  const mouseX  = getHistMouseX(e);
  const wMin    = state.windowCenter - state.windowWidth / 2;
  const wMax    = state.windowCenter + state.windowWidth / 2;
  const xWMin   = histValToX(wMin);
  const xWMax   = histValToX(wMax);
  const thresh  = 9;

  if      (Math.abs(mouseX - xWMin) <= thresh)              state.histDragging = 'left';
  else if (Math.abs(mouseX - xWMax) <= thresh)              state.histDragging = 'right';
  else if (mouseX > xWMin + thresh && mouseX < xWMax - thresh) state.histDragging = 'center';
  else return;

  state.histDragStartX  = mouseX;
  state.histDragStartWC = state.windowCenter;
  state.histDragStartWW = state.windowWidth;
  e.preventDefault();
});

histCanvas.addEventListener('mousemove', (e) => {
  const mouseX = getHistMouseX(e);
  const rect   = histCanvas.getBoundingClientRect();
  const scaleY = histCanvas.height / rect.height;
  const mouseY = (e.clientY - rect.top) * scaleY;
  state.histCursorX = mouseX;
  state.histCursorY = mouseY;

  if (!state.histDragging) {
    if (!histogramData) return;
    const wMin   = state.windowCenter - state.windowWidth / 2;
    const wMax   = state.windowCenter + state.windowWidth / 2;
    const xWMin  = histValToX(wMin);
    const xWMax  = histValToX(wMax);
    const thresh = 9;
    if (Math.abs(mouseX - xWMin) <= thresh || Math.abs(mouseX - xWMax) <= thresh) {
      histCanvas.style.cursor = 'ew-resize';
    } else if (mouseX > xWMin && mouseX < xWMax) {
      histCanvas.style.cursor = 'grab';
    } else {
      histCanvas.style.cursor = 'crosshair';
    }
    renderHistogram();
    return;
  }

  const dv = histXToVal(mouseX) - histXToVal(state.histDragStartX);

  if (state.histDragging === 'center') {
    state.windowCenter = state.histDragStartWC + dv;

  } else if (state.histDragging === 'left') {
    const origWMax = state.histDragStartWC + state.histDragStartWW / 2;
    const newWMin  = (state.histDragStartWC - state.histDragStartWW / 2) + dv;
    const newWW    = Math.max(1, origWMax - newWMin);
    state.windowWidth  = newWW;
    state.windowCenter = origWMax - newWW / 2;

  } else if (state.histDragging === 'right') {
    const origWMin = state.histDragStartWC - state.histDragStartWW / 2;
    const newWMax  = (state.histDragStartWC + state.histDragStartWW / 2) + dv;
    const newWW    = Math.max(1, newWMax - origWMin);
    state.windowWidth  = newWW;
    state.windowCenter = origWMin + newWW / 2;
  }

  renderAll();
});

// ==================== Main Canvas Events ====================
mainCanvas.addEventListener('wheel', (e) => {
  if (!e.ctrlKey || !offscreenCanvas) return;
  e.preventDefault();

  const rect       = mainCanvas.getBoundingClientRect();
  const mouseX     = e.clientX - rect.left;
  const mouseY     = e.clientY - rect.top;
  const factor     = e.deltaY > 0 ? 0.9 : 1.1;
  const newScale   = Math.max(0.02, Math.min(64, state.scale * factor));
  const scaleDelta = newScale / state.scale;

  state.tx    = mouseX - (mouseX - state.tx) * scaleDelta;
  state.ty    = mouseY - (mouseY - state.ty) * scaleDelta;
  state.scale = newScale;

  renderMainCanvas();
}, { passive: false });

mainCanvas.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || !offscreenCanvas) return;
  state.isPanning  = true;
  state.panStartX  = e.clientX;
  state.panStartY  = e.clientY;
  state.panStartTx = state.tx;
  state.panStartTy = state.ty;
  mainCanvas.style.cursor = 'grabbing';
  e.preventDefault();
});

mainCanvas.addEventListener('mousemove', (e) => {
  // Track pixel under cursor
  if (state.pixelValues && state.showPixelValue) {
    const rect  = mainCanvas.getBoundingClientRect();
    const cx    = e.clientX - rect.left;
    const cy    = e.clientY - rect.top;
    const ix    = Math.floor((cx - state.tx) / state.scale);
    const iy    = Math.floor((cy - state.ty) / state.scale);
    if (ix >= 0 && ix < state.imageWidth && iy >= 0 && iy < state.imageHeight) {
      state.cursorImgX       = ix;
      state.cursorImgY       = iy;
      state.cursorPixelValue = state.pixelValues[iy * state.imageWidth + ix];
    } else {
      state.cursorImgX       = -1;
      state.cursorPixelValue = null;
    }
  }

  if (!state.isPanning) {
    if (state.showPixelValue) renderMainCanvas();
    return;
  }
  state.tx = state.panStartTx + (e.clientX - state.panStartX);
  state.ty = state.panStartTy + (e.clientY - state.panStartY);
  renderMainCanvas();
});

mainCanvas.addEventListener('mouseleave', () => {
  state.cursorImgX       = -1;
  state.cursorPixelValue = null;
  if (state.showPixelValue) renderMainCanvas();
});

mainCanvas.addEventListener('mouseup', () => {
  state.isPanning = false;
  mainCanvas.style.cursor = 'default';
});

histCanvas.addEventListener('mouseleave', () => {
  state.histCursorX = null;
  state.histCursorY = null;
  renderHistogram();
});

// Global mouseup to end histogram drag even if cursor leaves canvas
document.addEventListener('mouseup', () => {
  if (state.histDragging) {
    state.histDragging = null;
    histCanvas.style.cursor = 'crosshair';
  }
  if (state.isPanning) {
    state.isPanning = false;
    mainCanvas.style.cursor = 'default';
  }
});

// ==================== Toggle Event Listeners ====================
document.getElementById('invertMonoCheck').addEventListener('change', (e) => {
  state.invertMono1 = e.target.checked;
  renderAll();
});

document.getElementById('showOverlayCheck').addEventListener('change', (e) => {
  state.showInfoOverlay = e.target.checked;
  renderMainCanvas();
});

document.getElementById('smoothInterpCheck').addEventListener('change', (e) => {
  state.smoothInterp = e.target.checked;
  renderMainCanvas();
});

document.getElementById('manualInvertCheck').addEventListener('change', (e) => {
  state.manualInvert = e.target.checked;
  renderAll();
});

document.getElementById('showPixelValueCheck').addEventListener('change', (e) => {
  state.showPixelValue = e.target.checked;
  if (!e.target.checked) { state.cursorPixelValue = null; state.cursorImgX = -1; }
  renderMainCanvas();
});

document.getElementById('showRulerCheck').addEventListener('change', (e) => {
  state.showRuler = e.target.checked;
  renderMainCanvas();
});

// ==================== Collapsible Sections ====================
document.querySelectorAll('.section-header[data-target]').forEach(header => {
  header.addEventListener('click', () => {
    const target  = document.getElementById(header.dataset.target);
    const chevron = header.querySelector('.chevron');
    const collapsed = target.classList.toggle('collapsed');
    chevron.classList.toggle('collapsed', collapsed);
  });
});

// ==================== Reset Button ====================
resetBtn.addEventListener('click', () => {
  if (!state.pixelValues) return;
  state.windowCenter = state.originalWC;
  state.windowWidth  = state.originalWW;
  renderAll();
});

// ==================== Canvas Sizing ====================
function resizeCanvases() {
  const mainRect = mainContainer.getBoundingClientRect();
  mainCanvas.width  = Math.max(1, Math.floor(mainRect.width));
  mainCanvas.height = Math.max(1, Math.floor(mainRect.height));

  const histRect = histContainer.getBoundingClientRect();
  histCanvas.width  = Math.max(1, Math.floor(histRect.width));
  histCanvas.height = Math.max(1, Math.floor(histRect.height));

  if (state.imageWidth) {
    fitImageToCanvas();
    applyWindowLevelToOffscreen();
    renderMainCanvas();
  } else {
    renderMainCanvas();
  }
  renderHistogram();
}

// Debounce resize to avoid excessive redraws
let resizeTimer = null;
const resizeObserver = new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(resizeCanvases, 30);
});
resizeObserver.observe(mainContainer);
resizeObserver.observe(histContainer);

// Initial layout
window.addEventListener('DOMContentLoaded', resizeCanvases);

// ==================== Panel Resize Divider (left | right) ====================
(function () {
  const divider  = document.getElementById('resizeDivider');
  const subPanel = document.getElementById('subPanel');
  const layout   = document.getElementById('layout');

  let dragging = false, startX = 0, startWidth = 0;

  divider.addEventListener('mousedown', (e) => {
    dragging   = true;
    startX     = e.clientX;
    startWidth = subPanel.offsetWidth;
    divider.classList.add('dragging');
    document.body.style.cursor     = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const dx = startX - e.clientX;
    const minW = 200, maxW = layout.offsetWidth - 200;
    subPanel.style.width = Math.max(minW, Math.min(maxW, startWidth + dx)) + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    divider.classList.remove('dragging');
    document.body.style.cursor     = '';
    document.body.style.userSelect = '';
    resizeCanvases();
  });
})();

// ==================== Hist / Controls Resize Divider (top | bottom) ====================
(function () {
  const divider     = document.getElementById('histDivider');
  const histCont    = document.getElementById('histContainer');
  const subPanel    = document.getElementById('subPanel');

  let dragging = false, startY = 0, startH = 0;

  divider.addEventListener('mousedown', (e) => {
    dragging  = true;
    startY    = e.clientY;
    startH    = histCont.offsetHeight;
    divider.classList.add('dragging');
    document.body.style.cursor     = 'row-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const dy   = e.clientY - startY;
    const minH = 60;
    const maxH = subPanel.offsetHeight - 120;
    histCont.style.height = Math.max(minH, Math.min(maxH, startH + dy)) + 'px';
    if (window._updateScrollIndicator) window._updateScrollIndicator();
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    divider.classList.remove('dragging');
    document.body.style.cursor     = '';
    document.body.style.userSelect = '';
    resizeCanvases();
    if (window._updateScrollIndicator) window._updateScrollIndicator();
  });
})();

// ==================== Scroll indicator: fade overlay when more content below ====================
(function () {
  const wrap = document.getElementById('controlsWrap');
  const area = document.getElementById('controlsArea');
  if (!wrap || !area) return;

  function updateScrollIndicator() {
    const hasMore = area.scrollHeight > area.clientHeight + 2 &&
                    area.scrollTop + area.clientHeight < area.scrollHeight - 2;
    wrap.classList.toggle('has-more', hasMore);
  }

  area.addEventListener('scroll', updateScrollIndicator, { passive: true });
  window.addEventListener('resize', updateScrollIndicator);
  window._updateScrollIndicator = updateScrollIndicator;
})();

// Spin up the decode worker and kick off WASM init inside it immediately,
// so both are ready before the user opens a file.
getDecodeWorker();
