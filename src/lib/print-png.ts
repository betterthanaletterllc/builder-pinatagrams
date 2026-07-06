/**
 * Print-file normalization. Canvas exports are print-hostile in two ways:
 * pixelRatio rounding drifts a pixel or two off the artboard size, and
 * browsers write NO density metadata — so a 2400×1170 export opens as
 * 33"×16" at the default 72 DPI in print tools. This redraws the export at
 * the exact artboard pixel size and stamps a pHYs chunk with the real DPI,
 * making the PNG physically 8" × 3.9" wherever it lands.
 */

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// CRC32 (PNG flavor) for the injected chunk.
let crcTable: Uint32Array | null = null;
function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Return a copy of the PNG with a pHYs density chunk right after IHDR
 * (replacing any existing one). Non-PNG bytes come back untouched.
 */
export function withDpi(png: Uint8Array, dpi: number): Uint8Array {
  for (let i = 0; i < PNG_SIG.length; i++) {
    if (png[i] !== PNG_SIG[i]) return png;
  }

  const ppm = Math.round(dpi / 0.0254); // PNG stores pixels per METER
  // chunk = length(4) + "pHYs"(4) + x-ppm(4) + y-ppm(4) + unit(1) + crc(4)
  const chunk = new Uint8Array(21);
  const dv = new DataView(chunk.buffer);
  dv.setUint32(0, 9);
  chunk.set([0x70, 0x48, 0x59, 0x73], 4); // "pHYs"
  dv.setUint32(8, ppm);
  dv.setUint32(12, ppm);
  chunk[16] = 1; // unit: meters
  dv.setUint32(17, crc32(chunk.subarray(4, 17)));

  const parts: Uint8Array[] = [png.subarray(0, 8)];
  let pos = 8;
  let inserted = false;
  while (pos + 8 <= png.length) {
    const len = new DataView(png.buffer, png.byteOffset + pos, 4).getUint32(0);
    const name = String.fromCharCode(
      png[pos + 4],
      png[pos + 5],
      png[pos + 6],
      png[pos + 7],
    );
    const end = Math.min(pos + 12 + len, png.length);
    if (name !== "pHYs") parts.push(png.subarray(pos, end));
    if (name === "IHDR" && !inserted) {
      parts.push(chunk);
      inserted = true;
    }
    pos = end;
  }
  if (!inserted) return png; // no IHDR found — malformed, don't touch it

  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/**
 * Set the JFIF density fields of a canvas-encoded JPEG to a real DPI.
 * Canvas JPEGs open with the APP0 JFIF segment at a fixed offset:
 * SOI(2) + FFE0 marker(2) + length(2) + "JFIF\0"(5) + version(2), then
 * units(1) + Xdensity(2) + Ydensity(2). Anything else comes back untouched.
 */
export function withJpegDpi(jpg: Uint8Array, dpi: number): Uint8Array {
  const isJfif =
    jpg[0] === 0xff &&
    jpg[1] === 0xd8 &&
    jpg[2] === 0xff &&
    jpg[3] === 0xe0 &&
    jpg[6] === 0x4a && // J
    jpg[7] === 0x46 && // F
    jpg[8] === 0x49 && // I
    jpg[9] === 0x46 && // F
    jpg[10] === 0x00;
  if (!isJfif) return jpg;
  const out = jpg.slice();
  out[13] = 1; // units: dots per inch
  out[14] = (dpi >> 8) & 0xff;
  out[15] = dpi & 0xff;
  out[16] = (dpi >> 8) & 0xff;
  out[17] = dpi & 0xff;
  return out;
}

/**
 * Encode a canvas at EXACTLY width×height px with real DPI metadata.
 * format "image/jpeg" for photo designs (~8× smaller upload than PNG at
 * print-indistinguishable q0.9), "image/png" for crisp text-only designs.
 */
export async function toPrintBlob(
  src: HTMLCanvasElement,
  width: number,
  height: number,
  dpi: number,
  format: "image/png" | "image/jpeg",
): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context");
  // JPEG has no alpha — flatten onto white rather than black
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(src, 0, 0, width, height);
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("encode failed"))),
      format,
      format === "image/jpeg" ? 0.9 : undefined,
    ),
  );
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const stamped =
    format === "image/png" ? withDpi(bytes, dpi) : withJpegDpi(bytes, dpi);
  // cast: TS widens .buffer to ArrayBufferLike (SharedArrayBuffer) — ours
  // always comes from arrayBuffer(), a plain ArrayBuffer
  return new Blob([stamped as BlobPart], { type: format });
}
