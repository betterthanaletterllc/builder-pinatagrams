import { Resvg } from "@resvg/resvg-js";
import { FONT_FAMILY, fontOptions, type FontWeight } from "./fonts";

/**
 * Text layout for server-side art: measure with resvg itself (the same
 * engine that draws the final PNG, so what is measured is what prints),
 * wrap words whole, and shrink until the block fits its box — the server
 * twin of lib/design-render's fitFontSize (Konva, browser only).
 *
 * Measuring: each distinct word is measured ONCE at a reference size and
 * scaled linearly (resvg lays glyphs out unhinted, so advances scale
 * exactly — verified: 200 px / 100 px width ratio 1.99). ~1.5 ms per word
 * with font files; results are cached per instance.
 */

export const LINE_HEIGHT = 1.15; // = lib/design-render TEXT_LINE_HEIGHT

const MEASURE_SIZE = 100;
const MEASURE_CANVAS = 40_000; // wider than any word; never rasterised
const WIDTH_CACHE_MAX = 4096;
// Linear scaling of ink widths is exact bar sub-pixel rounding; a touch of
// slack keeps a line that measured "just fits" from kissing the box edge.
const SAFETY = 1.02;

const widthCache = new Map<string, number>();

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Compact, deterministic number formatting for SVG attributes. */
export function num(v: number): string {
  return String(Math.round(v * 100) / 100);
}

/** Ink extent (left bearing + glyphs) of `text` at MEASURE_SIZE px. */
function measure(text: string, weight: FontWeight): number {
  const key = `${weight}:${text}`;
  const hit = widthCache.get(key);
  if (hit !== undefined) return hit;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${MEASURE_CANVAS}" height="${MEASURE_SIZE * 2}">` +
    `<text x="0" y="${MEASURE_SIZE}" font-family="${FONT_FAMILY}" font-weight="${weight}" ` +
    `font-size="${MEASURE_SIZE}" xml:space="preserve">${escapeXml(text)}</text></svg>`;
  const bb = new Resvg(svg, { font: fontOptions(), logLevel: "off" }).innerBBox();
  const w = bb ? bb.x + bb.width : 0;
  if (widthCache.size >= WIDTH_CACHE_MAX) {
    widthCache.delete(widthCache.keys().next().value!);
  }
  widthCache.set(key, w);
  return w;
}

/** Advance of one space: "a a" minus "aa" (bearings cancel). */
function spaceAdvance(weight: FontWeight): number {
  return Math.max(0, measure("a a", weight) - measure("aa", weight));
}

export type TextLayout = {
  size: number; // px
  lines: string[];
  fits: boolean; // false = still too big at minSize (rendered anyway)
};

function wrap(words: string[], widths: number[], space: number, maxW: number): string[] {
  const lines: string[] = [];
  let line: string[] = [];
  let lineW = 0;
  words.forEach((w, i) => {
    const add = line.length ? space + widths[i] : widths[i];
    if (line.length && lineW + add > maxW) {
      lines.push(line.join(" "));
      line = [w];
      lineW = widths[i];
    } else {
      line.push(w);
      lineW += add;
    }
  });
  if (line.length) lines.push(line.join(" "));
  return lines;
}

/**
 * Largest size from `maxSize` down (×0.9 steps, like fitFontSize) at which
 * every word fits on a line AND the wrapped block fits the box height.
 * Words are never broken; the whole thing is deterministic.
 */
export function layoutText(
  text: string,
  box: { w: number; h: number },
  opts: { weight: FontWeight; maxSize: number; minSize: number },
): TextLayout {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return { size: opts.minSize, lines: [], fits: true };
  const base = words.map((w) => measure(w, opts.weight));
  const space = spaceAdvance(opts.weight);
  const widest = Math.max(...base);

  let size = Math.max(opts.minSize, Math.round(opts.maxSize));
  for (;;) {
    const k = (size / MEASURE_SIZE) * SAFETY;
    const lines = wrap(words, base.map((w) => w * k), space * k, box.w);
    const fits = widest * k <= box.w && lines.length * size * LINE_HEIGHT <= box.h;
    if (fits || size <= opts.minSize) return { size, lines, fits };
    size = Math.max(opts.minSize, Math.floor(size * 0.9));
  }
}

/**
 * The laid-out block as SVG, centred in `box`: one <tspan> per line, each
 * line's em-centre on its line-box centre (dominant-baseline="central" —
 * what Konva's verticalAlign "middle" does in the editor).
 */
export function textBlockSvg(
  layout: TextLayout,
  box: { x: number; y: number; w: number; h: number },
  opts: { weight: FontWeight; fill: string },
): string {
  if (!layout.lines.length) return "";
  const lh = layout.size * LINE_HEIGHT;
  const top = box.y + (box.h - layout.lines.length * lh) / 2;
  const cx = box.x + box.w / 2;
  const spans = layout.lines
    .map(
      (line, i) =>
        `<tspan x="${num(cx)}" y="${num(top + lh * i + lh / 2)}" dominant-baseline="central">${escapeXml(line)}</tspan>`,
    )
    .join("");
  return (
    `<text font-family="${FONT_FAMILY}" font-weight="${opts.weight}" font-size="${layout.size}" ` +
    `fill="${opts.fill}" text-anchor="middle" dominant-baseline="central">${spans}</text>`
  );
}
