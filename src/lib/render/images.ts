import sharp from "sharp";
import { hubTimeout } from "@/lib/hub";

/**
 * Raster inputs for the renderer: the hub's box photos, interior photo and
 * piñata cutouts. resvg (2.6.x) decodes PNG, JPEG and GIF inside an SVG
 * <image>, but NOT WebP — and the hub serves every box photo as WebP
 * (catalog/boxes/*.webp, 1080 × 1080). sharp, which Next 15 already ships
 * for next/image, transcodes those to lossless PNG; it is used for nothing
 * else. PNG and JPEG bytes are embedded exactly as fetched.
 *
 * Every image is cached per server instance (bounded) so a warm instance
 * renders without re-fetching, and in-flight fetches are shared.
 */

export type RasterImage = {
  mime: "image/png" | "image/jpeg";
  bytes: Buffer;
  width: number;
  height: number;
};

// The probe is a PUBLIC route: it only ever fetches the hub's own Vercel
// Blob stores (where the catalog's photos live), never an arbitrary URL.
const ALLOWED_HOST = /\.public\.blob\.vercel-storage\.com$/i;
const MAX_BYTES = 6 * 1024 * 1024; // Green's PNG box photo is ~0.7 MB
const FETCH_TIMEOUT_MS = 8000;
const CACHE_MAX = 32; // the catalog has ~19 styles + interior + cutouts
const MAX_INPUT_PIXELS = 30e6; // sharp decode bound (1080² is 1.2 MP)

const cache = new Map<string, RasterImage>();
const inflight = new Map<string, Promise<RasterImage>>();

export function imageHostAllowed(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && ALLOWED_HOST.test(u.hostname);
  } catch {
    return false;
  }
}

/** Fetch + normalise an image once per instance (LRU-ish, bounded). */
export async function loadImage(url: string): Promise<RasterImage> {
  const hit = cache.get(url);
  if (hit) {
    cache.delete(url); // re-insert = most recently used last
    cache.set(url, hit);
    return hit;
  }
  let p = inflight.get(url);
  if (!p) {
    p = fetchImage(url).finally(() => inflight.delete(url));
    inflight.set(url, p);
  }
  const img = await p;
  cache.set(url, img);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  return img;
}

async function fetchImage(url: string): Promise<RasterImage> {
  if (!imageHostAllowed(url)) {
    throw new Error(`render: image host not allowed: ${url}`);
  }
  const res = await fetch(url, {
    cache: "no-store",
    signal: hubTimeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`render: image fetch HTTP ${res.status}: ${url}`);
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_BYTES) throw new Error(`render: image too large: ${url}`);
  const raw = Buffer.from(await res.arrayBuffer());
  if (raw.length > MAX_BYTES) throw new Error(`render: image too large: ${url}`);
  return normalizeImage(raw);
}

/** Bytes → something resvg can embed, with its pixel size. Exported for
 *  tests (and any caller that already has the bytes). */
export async function normalizeImage(raw: Buffer): Promise<RasterImage> {
  switch (sniff(raw)) {
    case "png":
      return { mime: "image/png", bytes: raw, ...pngSize(raw) };
    case "jpeg":
      return { mime: "image/jpeg", bytes: raw, ...jpegSize(raw) };
    case "webp": {
      const png = await sharp(raw, { limitInputPixels: MAX_INPUT_PIXELS })
        .png({ compressionLevel: 6 })
        .toBuffer();
      return { mime: "image/png", bytes: png, ...pngSize(png) };
    }
    default:
      throw new Error("render: unsupported image format (PNG, JPEG or WebP)");
  }
}

function sniff(b: Buffer): "png" | "jpeg" | "webp" | "unknown" {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return "png";
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (
    b.length >= 12 &&
    b.toString("ascii", 0, 4) === "RIFF" &&
    b.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "webp";
  }
  return "unknown";
}

/** IHDR is always the first chunk: width at byte 16, height at 20. */
export function pngSize(b: Buffer): { width: number; height: number } {
  if (b.length < 24 || b.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error("render: malformed PNG");
  }
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

/** Walk the JPEG marker segments to the first SOFn frame header. */
function jpegSize(b: Buffer): { width: number; height: number } {
  let pos = 2;
  while (pos + 9 < b.length) {
    if (b[pos] !== 0xff) {
      pos++;
      continue;
    }
    const marker = b[pos + 1];
    if (marker === 0xff) {
      pos++;
      continue;
    }
    // SOF0–SOF15 carry the frame size; C4 (DHT), C8 (JPG) and CC (DAC) don't.
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      return { height: b.readUInt16BE(pos + 5), width: b.readUInt16BE(pos + 7) };
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      pos += 2; // standalone markers have no length
      continue;
    }
    pos += 2 + b.readUInt16BE(pos + 2);
  }
  throw new Error("render: malformed JPEG (no frame header)");
}

/** Test seam: forget every cached image on this instance. */
export function clearImageCache(): void {
  cache.clear();
}
