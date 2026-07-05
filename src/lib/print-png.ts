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

/** Redraw a dataURL export at EXACTLY width×height px and stamp its DPI. */
export async function toPrintPngBlob(
  dataUrl: string,
  width: number,
  height: number,
  dpi: number,
): Promise<Blob> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error("export image failed to decode"));
    i.src = dataUrl;
  });
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context");
  ctx.drawImage(img, 0, 0, width, height);
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("PNG encode failed"))),
      "image/png",
    ),
  );
  const bytes = new Uint8Array(await blob.arrayBuffer());
  // cast: TS widens .buffer to ArrayBufferLike (SharedArrayBuffer) — ours
  // always comes from arrayBuffer(), a plain ArrayBuffer
  return new Blob([withDpi(bytes, dpi) as BlobPart], { type: "image/png" });
}
