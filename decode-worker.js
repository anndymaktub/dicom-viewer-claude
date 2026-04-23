'use strict';

// Cache WASM codec Promise so it's only initialised once per worker lifetime.
let _openJPEGPromise = null;

function getDecoder() {
  if (!_openJPEGPromise) {
    const factory = require('@cornerstonejs/codec-openjpeg');
    const fn = factory.default || factory;
    _openJPEGPromise = (typeof fn === 'function' ? fn() : Promise.resolve(fn));
  }
  return _openJPEGPromise;
}

// Begin WASM init immediately so it's ready when the first decode request arrives.
getDecoder().catch(() => {});

self.onmessage = async ({ data }) => {
  const { frameData, bitsAllocated, pixelRepresentation, slope, intercept } = data;
  try {
    const codec   = await getDecoder();
    const decoder = new codec.J2KDecoder();

    const frame  = new Uint8Array(frameData);
    const encBuf = decoder.getEncodedBuffer(frame.length);
    encBuf.set(frame);
    decoder.decode();

    const decodedBuf = decoder.getDecodedBuffer();
    const raw = new Uint8Array(decodedBuf.buffer, decodedBuf.byteOffset, decodedBuf.byteLength);
    const own = new Uint8Array(raw.length);
    own.set(raw);
    decoder.delete();

    let rawPixels;
    if (bitsAllocated <= 8) {
      rawPixels = pixelRepresentation === 1 ? new Int8Array(own.buffer) : own;
    } else {
      rawPixels = pixelRepresentation === 1
        ? new Int16Array(own.buffer)
        : new Uint16Array(own.buffer);
    }

    // Apply rescale slope/intercept and compute min/max in one pass.
    const count   = rawPixels.length;
    const modality = new Float32Array(count);
    let pixMin =  Infinity;
    let pixMax = -Infinity;
    for (let i = 0; i < count; i++) {
      const v = rawPixels[i] * slope + intercept;
      modality[i] = v;
      if (v < pixMin) pixMin = v;
      if (v > pixMax) pixMax = v;
    }

    // Transfer the buffer to avoid a copy back to the main thread.
    self.postMessage({ ok: true, modalityBuf: modality.buffer, pixMin, pixMax }, [modality.buffer]);
  } catch (err) {
    self.postMessage({ ok: false, message: err.message });
  }
};
