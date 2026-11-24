import { Resvg } from "@resvg/resvg-js";
import sharp from "sharp";
import { hubTimeout } from "@/lib/hub";
import { fontOptions } from "./fonts";

/**
 * Raster inputs for the renderer: the hub's box photos, interior photo and
 * piñata cutouts — and, for the staff mockup tool, design art (front labels
 * and inside-flap cards). resvg (2.6.x) decodes PNG, JPEG and GIF inside an
 * SVG <image>, but NOT WebP — and the hub serves every box photo as WebP
 * (catalog/boxes/*.webp, 1080 × 1080). sharp, which Next 15 already ships
 * for next/image, transcodes those to lossless PNG. PNG and JPEG bytes are
 * embedded exactly as fetched; SVG art (most flap cards) is cleaned by
 * `sanitizeSvg` (nothing may reach outside the file) and rasterised to PNG
 * on its own (`rasterizeSvg` says why).
 *
 * Two fetch policies:
 *  - "hub" (default): only the hub's own Vercel Blob stores — what the
 *    PUBLIC render probe may ever fetch. Raster only.
 *  - "art": any public https host (Shopify's CDN, the hub's blob, a link a
 *    staff member pastes), SVG allowed. Used ONLY behind the staff MCP
 *    secret; IP literals, internal names and odd ports are still refused,
 *    and a redirect must land on an allowed host too.
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

export type ImagePolicy = "hub" | "art";

const HUB_HOST = /\.public\.blob\.vercel-storage\.com$/i;
const LIMITS: Record<ImagePolicy, number> = {
  hub: 6 * 1024 * 1024, // Green's PNG box photo is ~0.7 MB
  art: 15 * 1024 * 1024, // print art is up to ~2400 × 1170 PNG
};
const FETCH_TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 3;
const CACHE_MAX = 64; // ~21 styles + interior + cutouts + a few designs
const MAX_INPUT_PIXELS = 30e6; // sharp decode bound (1080² is 1.2 MP)
const MAX_SVG_SIDE = 20_000;

const cache = new Map<string, RasterImage>();
const inflight = new Map<string, Promise<RasterImage>>();

export function imageHostAllowed(url: string, policy: ImagePolicy = "hub"): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  if (policy === "hub") return HUB_HOST.test(host);
  // art: a public DNS name only — no IP literals, no single-label or
  // internal names, nothing on a non-default port.
  if (u.port && u.port !== "443") return false;
  if (host.startsWith("[") || /^[\d.]+$/.test(host)) return false;
  if (!host.includes(".")) return false;
  if (/(^|\.)(localhost|local|internal|intranet|lan|home|corp)$/.test(host)) return false;
  return true;
}

/** Fetch + normalise an image once per instance (LRU-ish, bounded). */
export async function loadImage(url: string, policy: ImagePolicy = "hub"): Promise<RasterImage> {
  const key = `${policy}|${url}`;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key); // re-insert = most recently used last
    cache.set(key, hit);
    return hit;
  }
  let p = inflight.get(key);
  if (!p) {
    p = fetchImage(url, policy, 0).finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  const img = await p;
  cache.set(key, img);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  return img;
}

async function fetchImage(url: string, policy: ImagePolicy, hops: number): Promise<RasterImage> {
  if (!imageHostAllowed(url, policy)) {
    throw new Error(`render: image host not allowed: ${url}`);
  }
  const res = await fetch(url, {
    cache: "no-store",
    signal: hubTimeout(FETCH_TIMEOUT_MS),
    // A redirect could leave the allowed hosts; follow it only by hand.
    redirect: "manual",
  });
  if (res.status >= 300 && res.status < 400) {
    const next = res.headers.get("location");
    if (!next || hops >= MAX_REDIRECTS) {
      throw new Error(`render: image redirects too often: ${url}`);
    }
    return fetchImage(new URL(next, url).toString(), policy, hops + 1);
  }
  if (!res.ok) throw new Error(`render: image fetch HTTP ${res.status}: ${url}`);
  const max = LIMITS[policy];
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > max) throw new Error(`render: image too large: ${url}`);
  const raw = Buffer.from(await res.arrayBuffer());
  if (raw.length > max) throw new Error(`render: image too large: ${url}`);
  return normalizeImage(raw, { allowSvg: policy === "art" });
}

/** Bytes → something resvg can embed, with its pixel size. Exported for
 *  tests (and any caller that already has the bytes). */
export async function normalizeImage(
  raw: Buffer,
  opts: { allowSvg?: boolean } = {},
): Promise<RasterImage> {
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
    case "svg": {
      if (!opts.allowSvg) break;
      return rasterizeSvg(sanitizeSvg(raw.toString("utf8")));
    }
  }
  throw new Error(
    `render: unsupported image format (PNG, JPEG or WebP${opts.allowSvg ? " or SVG" : ""})`,
  );
}

function sniff(b: Buffer): "png" | "jpeg" | "webp" | "svg" | "unknown" {
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
  const head = b.toString("utf8", 0, Math.min(b.length, 4096)).replace(/^﻿/, "");
  if (/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(head)) {
    return "svg";
  }
  return "unknown";
}

/**
 * Make fetched SVG art self-contained: no scripts, no event handlers, no
 * DOCTYPE/entities, and no reference that resolves outside the file (resvg
 * would try a bare path on the server's disk). Only same-file (#id) and
 * data:image references survive. Exported for tests.
 */
export function sanitizeSvg(svg: string): string {
  return svg
    .replace(/<\?xml[^>]*>/gi, "")
    .replace(/<!DOCTYPE[^[>]*(\[[\s\S]*?\])?\s*>/gi, "")
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<script\b[^>]*\/>/gi, "")
    .replace(/<foreignObject\b[\s\S]*?<\/foreignObject\s*>/gi, "")
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*')/gi, "")
    .replace(
      /\s(xlink:href|href)\s*=\s*("([^"]*)"|'([^']*)')/gi,
      (m: string, _attr: string, _quoted: string, dq?: string, sq?: string) => {
        const v = String(dq ?? sq ?? "").trim();
        return v.startsWith("#") || /^data:image\//i.test(v) ? m : "";
      },
    )
    .replace(/@import[^;]*;?/gi, "")
    .replace(/url\(\s*(?!['"]?#)[^)]*\)/gi, "none");
}

/**
 * SVG art → PNG, rendered on its own. Embedding the SVG itself as an
 * <image> in a scene does NOT work for most cards: resvg 2.6 drops the
 * raster pictures (masked logos, confetti PNGs) inside a nested SVG image,
 * leaving a blank white card — rendered standalone they draw correctly.
 * The longest side lands on SVG_RASTER_PX, plenty for a mockup.
 */
export const SVG_RASTER_PX = 2000;
function rasterizeSvg(svg: string): RasterImage {
  const size = svgSize(svg);
  const fit =
    size.width >= size.height
      ? ({ mode: "width", value: SVG_RASTER_PX } as const)
      : ({ mode: "height", value: SVG_RASTER_PX } as const);
  const img = new Resvg(svg, { font: fontOptions(), fitTo: fit, logLevel: "off" }).render();
  const png = Buffer.from(img.asPng());
  return { mime: "image/png", bytes: png, width: img.width, height: img.height };
}

/** An SVG's intended pixel size: width/height when absolute, else the viewBox. */
export function svgSize(svg: string): { width: number; height: number } {
  const tag = /<svg\b[^>]*>/i.exec(svg)?.[0] ?? "";
  const attr = (n: string) =>
    new RegExp(`\\s${n}\\s*=\\s*["']\\s*([\\d.]+)\\s*(px)?\\s*["']`, "i").exec(tag)?.[1];
  const vb = /\sviewBox\s*=\s*["']([^"']+)["']/i
    .exec(tag)?.[1]
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  const hasVb = !!vb && vb.length === 4;
  const w = Number(attr("width") ?? (hasVb ? vb![2] : NaN));
  const h = Number(attr("height") ?? (hasVb ? vb![3] : NaN));
  if (!(w > 0 && h > 0 && w <= MAX_SVG_SIDE && h <= MAX_SVG_SIDE)) {
    throw new Error("render: SVG art has no usable size (width/height or viewBox)");
  }
  return { width: w, height: h };
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
