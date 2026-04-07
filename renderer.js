'use strict';

const { ipcRenderer } = require('electron');
const fs = require('fs');
const dicomParser = require('dicom-parser');
const { version } = require('./package.json');

// ==================== State ====================
const state = {
  // Image data
  pixelValues: null,      // Float32Array of modality values (after rescale)
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

// Histogram data: Array of { value, count }
let histogramData = null;

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
  // Preferred: use dicom-parser built-in helper
  try {
    const frame = dicomParser.readEncapsulatedImageFrame(dataSet, element, 0);
    if (frame && frame.length > 0) return frame;
  } catch (_) { /* fall through */ }

  // Fallback: scan items for JPEG/J2K start-of-image markers
  if (element.items) {
    for (const item of element.items) {
      if (!item.length || item.length < 4) continue;
      const d = dataSet.byteArray;
      const off = item.dataOffset;
      // JPEG SOI = FF D8  |  JPEG Lossless SOF = FF C3  |  J2K SOC = FF 4F
      if (d[off] === 0xFF &&
          (d[off + 1] === 0xD8 || d[off + 1] === 0xC3 || d[off + 1] === 0x4F)) {
        return dataSet.byteArray.slice(off, off + item.length);
      }
    }
    // Last resort: skip BOT (item 0) and use item 1
    if (element.items.length > 1) {
      const it = element.items[1];
      return dataSet.byteArray.slice(it.dataOffset, it.dataOffset + it.length);
    }
    if (element.items.length === 1) {
      const it = element.items[0];
      return dataSet.byteArray.slice(it.dataOffset, it.dataOffset + it.length);
    }
  }

  throw new Error('無法從封裝像素資料中提取影像幀（找不到 BOT 或 fragments）');
}

// ---- JPEG 2000 singleton ----
let _openJPEGInstance = null;

async function getOpenJPEGDecoder() {
  if (_openJPEGInstance) return _openJPEGInstance;
  let factory;
  try {
    factory = require('@cornerstonejs/codec-openjpeg');
  } catch (e) {
    throw new Error('缺少 @cornerstonejs/codec-openjpeg，請執行 npm install');
  }
  const fn = factory.default || factory;
  _openJPEGInstance = await (typeof fn === 'function' ? fn() : fn);
  return _openJPEGInstance;
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
async function decodeCompressedFrame(frameData, tsUID, bitsAllocated, pixelRepresentation) {
  // ---- JPEG Baseline (Process 1 & 2-4) ----
  if (tsUID === '1.2.840.10008.1.2.4.50' || tsUID === '1.2.840.10008.1.2.4.51') {
    let jpegJs;
    try { jpegJs = require('jpeg-js'); }
    catch (e) { throw new Error('缺少 jpeg-js 模組，請執行 npm install'); }

    const decoded = jpegJs.decode(Buffer.from(frameData), { useTArray: true });
    // jpeg-js always outputs RGBA; for grayscale, R=G=B
    const pixelCount = decoded.width * decoded.height;
    const gray = new Uint8Array(pixelCount);
    for (let i = 0; i < pixelCount; i++) {
      gray[i] = decoded.data[i * 4]; // R channel
    }
    return { pixels: gray, width: decoded.width, height: decoded.height };
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
    k.innerHTML = tag
      ? `${key}<span class="rp-tag">(${tag})</span>`
      : key;
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
  for (const key of Object.keys(dataSet.elements)) {
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
    } else if (el.length > 256) {
      val = `[Binary, ${el.length} bytes]`;
      binary = true;
    } else {
      try { val = (dataSet.string(key) || '').trim().replace(/\0/g, ''); } catch (_) {}
      if (!val) {
        try {
          const n = dataSet.uint16(key);
          if (n !== undefined) val = String(n);
        } catch (_) {}
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

function renderAllTagsList(filter) {
  if (!_allTagsDataSet) return;
  const list  = document.getElementById('allTagsList');
  const count = document.getElementById('allTagsCount');
  if (!list) return;

  const rows = allTagsRenderList(_allTagsDataSet, filter || '');
  count.textContent = `${rows.length} 個 tag`;
  list.innerHTML = '';

  const frag = document.createDocumentFragment();
  for (const r of rows) {
    const id  = document.createElement('span'); id.className  = 'tag-id';   id.textContent = r.id;
    const nm  = document.createElement('span'); nm.className  = 'tag-name'; nm.textContent = r.name;
    const val = document.createElement('span'); val.className = r.binary ? 'tag-val tag-binary' : 'tag-val'; val.textContent = r.val;
    frag.appendChild(id); frag.appendChild(nm); frag.appendChild(val);
  }
  list.appendChild(frag);
}

function updateAllTagsPanel(dataSet) {
  _allTagsDataSet = dataSet;
  document.getElementById('allTagsSection').style.display = 'block';
  const input = document.getElementById('tagSearchInput');
  input.value = '';
  renderAllTagsList('');
}

document.addEventListener('DOMContentLoaded', () => {
  const input = document.getElementById('tagSearchInput');
  if (input) {
    input.addEventListener('input', (e) => renderAllTagsList(e.target.value));
  }
});

// ==================== DICOM Loading ====================
async function loadDicom(nodeBuffer, filePath) {
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
      throw new Error(`DICOM 解析失敗: ${err.message}`);
    }
  }

  // --- Required tags ---
  const rows = dataSet.uint16('x00280010');
  const cols = dataSet.uint16('x00280011');
  if (!rows || !cols) throw new Error('無法讀取影像尺寸 (Rows/Columns tags 缺失)');

  const bitsAllocated    = dataSet.uint16('x00280100') || 16;
  const bitsStored       = dataSet.uint16('x00280101') || bitsAllocated;
  const highBitRaw       = dataSet.uint16('x00280102');
  const highBit          = (highBitRaw !== undefined && highBitRaw !== null)
                             ? highBitRaw
                             : (bitsStored - 1);
  const pixelRepresentation = dataSet.uint16('x00280103') || 0; // 0=unsigned, 1=signed

  // --- Rescale (optional tags) ---
  const rsStr = dataSet.string('x00281053');
  const riStr = dataSet.string('x00281052');
  const rescaleSlope     = (rsStr && !isNaN(parseFloat(rsStr))) ? parseFloat(rsStr) : 1;
  const rescaleIntercept = (riStr && !isNaN(parseFloat(riStr))) ? parseFloat(riStr) : 0;

  // --- Photometric Interpretation (0028,0004) ---
  const photoInterp = (dataSet.string('x00280004') || 'MONOCHROME2')
    .trim().toUpperCase().replace(/\0/g, '');

  // --- Extended metadata ---
  const str = (tag) => (dataSet.string(tag) || '').trim().replace(/\0/g, '');
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
  let rawPixels;

  if (pixelDataElement.encapsulatedPixelData) {
    // ---- Compressed path ----
    const tsUID     = getTransferSyntaxUID(dataSet);
    const frameData = extractEncapsulatedFrame(dataSet, pixelDataElement);
    const decoded   = await decodeCompressedFrame(frameData, tsUID, bitsAllocated, pixelRepresentation);
    rawPixels       = decoded.pixels;
  } else {
    // ---- Uncompressed path ----
    const bytesPerPixel = Math.ceil(bitsAllocated / 8);
    const pixelByteLen  = pixelCount * bytesPerPixel;
    const offset        = pixelDataElement.dataOffset;
    const src           = dataSet.byteArray;
    const available     = src.length - offset;
    if (available < pixelByteLen) {
      console.warn(`像素資料長度不足: 需要 ${pixelByteLen}, 可用 ${available}`);
    }
    const pixelBytes = new Uint8Array(pixelByteLen);
    pixelBytes.set(src.subarray(offset, offset + Math.min(pixelByteLen, available)));

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
  }

  // Apply Rescale Slope / Intercept → modality values
  // Guard: if slope is 0 (bad tag), treat as 1
  const slope     = rescaleSlope !== 0 ? rescaleSlope : 1;
  const intercept = rescaleIntercept;
  const modalityValues = new Float32Array(pixelCount);
  let pixMin =  Infinity;
  let pixMax = -Infinity;
  for (let i = 0; i < pixelCount; i++) {
    const v = rawPixels[i] * slope + intercept;
    modalityValues[i] = v;
    if (v < pixMin) pixMin = v;
    if (v > pixMax) pixMax = v;
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
    samplesPerPixel:    dataSet.uint16('x00280002') || 1,
    planarConfig:       dataSet.uint16('x00280006') || 0,
    // ② Modality LUT
    rescaleSlope:       rescaleSlope !== 0 ? rescaleSlope : 1,
    rescaleIntercept,
    rescaleType:        (dataSet.string('x00281054') || '').trim().replace(/\0/g, ''),
    pixelMin:           pixMin,
    pixelMax:           pixMax,
    // ③ VOI LUT
    wcFromTag:          wc,
    wwFromTag:          ww,
    wcWwSource:         (wcRaw && wwRaw) ? 'DICOM Tag (0028,1050/1051)' : '自動計算（Tag 缺失）',
    wwExplanation:      (dataSet.string('x00281055') || '').trim().replace(/\0/g, ''),
    // ④ 光度詮釋
    photometric:        photoInterp,
    pixelAspectRatio:   (dataSet.string('x00280034') || '').trim().replace(/\0/g, ''),
  };

  state.photometricInterp = photoInterp;
  state.dicomMeta         = meta;
  state.renderPipeline    = renderPipeline;
  state.cursorPixelValue  = null;
  state.cursorImgX        = -1;
  state.cursorImgY        = -1;
  document.getElementById('monoRow').style.display =
    photoInterp === 'MONOCHROME1' ? 'flex' : 'none';

  histogramData = calculateHistogram(modalityValues, histXMin, histXMax, 256);

  offscreenCanvas        = document.createElement('canvas');
  offscreenCanvas.width  = cols;
  offscreenCanvas.height = rows;

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
  const imgData = ctx.createImageData(state.imageWidth, state.imageHeight);
  const data    = imgData.data;
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
  const parts = state.dicomMeta.pixelSpacing.replace(/\\/g, '\\').split(/[\\,]/);
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
    const barH = (histogramData[i].count / maxCount) * drawH;
    if (barH < 0.5) continue;
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

// ==================== Panel Resize Divider ====================
(function () {
  const divider  = document.getElementById('resizeDivider');
  const subPanel = document.getElementById('subPanel');
  const layout   = document.getElementById('layout');
  let dragging   = false;
  let startX     = 0;
  let startWidth = 0;

  divider.addEventListener('mousedown', (e) => {
    dragging   = true;
    startX     = e.clientX;
    startWidth = subPanel.offsetWidth;
    divider.classList.add('dragging');
    document.body.style.cursor    = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const dx      = startX - e.clientX;          // dragging left → panel grows
    const minW    = 200;
    const maxW    = layout.offsetWidth - 200;
    const newWidth = Math.max(minW, Math.min(maxW, startWidth + dx));
    subPanel.style.width = newWidth + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    divider.classList.remove('dragging');
    document.body.style.cursor    = '';
    document.body.style.userSelect = '';
    resizeCanvases();
  });
})();
