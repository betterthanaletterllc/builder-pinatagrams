import { Resvg } from "@resvg/resvg-js";
import type { HubBodyStyle, HubCatalog } from "@/lib/hub";
import { withDpi } from "@/lib/print-png";
import { fontOptions } from "./fonts";
import { loadImage } from "./images";
import { LABEL, MIN_LABEL_ZONE_PX, boxSceneSvg, labelSvg, openSceneSvg } from "./scenes";

/**
 * Server-side art renderer — the Phase 0 "can this Vercel project render
 * print-ready art server-side?" probe, and the seed of the MCP's custom
 * art path (an agent's text design → the 2400 × 1170 label Paper prints).
 *
 * Renderer choice (2026-10-15), measured on Node 24 / Next 15.5:
 *  - @resvg/resvg-js (CHOSEN): a prebuilt native addon (napi-rs, per-
 *    platform optional package; Vercel pulls linux-x64-gnu). Takes font
 *    FILES directly — no fontconfig, no system fonts, no Times fallback —
 *    and embeds raster photos as data-URI <image>s. Deterministic bytes.
 *    An 1811² photo composite: ~25 ms parse, ~10 ms raster, ~85–400 ms
 *    PNG encode; RSS ≈ 120 MB. Its one gap: no WebP decoding (2.6.x), and
 *    the hub's box photos are WebP.
 *  - sharp: superb raster engine, but its SVG <text> goes through librsvg
 *    + fontconfig, which on Vercel means hand-rolled fonts.conf +
 *    FONTCONFIG_PATH + a writable cache dir — fragile and silent when it
 *    goes wrong. Used here ONLY to transcode WebP → PNG (Next 15 already
 *    ships it for next/image; declared explicitly so it's never a
 *    transitive accident).
 *  - satori + resvg: satori lays out JSX/CSS to SVG and then needs resvg
 *    anyway; the label is a text block on a photo, so satori adds a
 *    dependency and a layout engine (its own font parser, no WebP) for
 *    nothing we need.
 *
 * Only this module touches resvg's rasteriser; scenes.ts owns geometry.
 */

export type ProbeView = "box" | "label" | "open";
export const PROBE_VIEWS: readonly ProbeView[] = ["box", "label", "open"];

export const MAX_MESSAGE_CHARS = 120;
export const DEFAULT_MESSAGE = "Happy Birthday, Sam!";
export const RENDERER = "@resvg/resvg-js (fonts from files) + sharp (WebP → PNG only)";

/** An input problem the caller can answer with a 4xx. */
export class RenderInputError extends Error {}

export type RenderResult = {
  view: ProbeView;
  png: Buffer;
  width: number;
  height: number;
  ms: number;
  // box view: how wide the label zone came out (≥ MIN_LABEL_ZONE_PX)
  labelZonePx?: number;
};

// Poppins covers Latin (incl. extended) but has no emoji or CJK glyphs,
// and resvg has no fallback faces here — such characters would render as
// nothing. Refuse them loudly instead of printing a silent gap.
const RENDERABLE = /^[\p{Script=Latin}\p{N}\p{P}\p{Zs}+<=>|~^$€£¥]+$/u;

/** Collapse whitespace, drop control characters; null when nothing
 *  printable is left or the cap is exceeded. */
export function normalizeMessage(raw: string): string | null {
  const s = raw
    .replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!s || s.length > MAX_MESSAGE_CHARS) return null;
  return s;
}

export function messageProblem(message: string): string | null {
  if (!message) return `message is required (≤ ${MAX_MESSAGE_CHARS} characters)`;
  if (message.length > MAX_MESSAGE_CHARS) {
    return `message must be ${MAX_MESSAGE_CHARS} characters or fewer`;
  }
  if (!RENDERABLE.test(message)) {
    return "message may use Latin letters, numbers, punctuation and spaces only (no emoji)";
  }
  return null;
}

/** SVG string → PNG bytes at the SVG's own size. */
export function renderPng(svg: string): { png: Buffer; width: number; height: number } {
  const r = new Resvg(svg, {
    font: fontOptions(),
    fitTo: { mode: "original" },
    logLevel: "off",
  });
  const img = r.render();
  return { png: Buffer.from(img.asPng()), width: img.width, height: img.height };
}

export async function renderProbe(input: {
  style: HubBodyStyle;
  box?: HubCatalog["box"];
  message: string;
  view: ProbeView;
}): Promise<RenderResult> {
  const problem = messageProblem(input.message);
  if (problem) throw new RenderInputError(problem);
  const t0 = performance.now();
  const done = (r: Omit<RenderResult, "ms" | "view">): RenderResult => ({
    view: input.view,
    ...r,
    ms: Math.round(performance.now() - t0),
  });

  switch (input.view) {
    case "label": {
      const { svg } = labelSvg(input.message);
      const out = renderPng(svg);
      // The print file carries its physical size: 2400 × 1170 @ 300 DPI
      // reads as 8 × 3.9 in wherever it lands (print-png's pHYs stamp).
      return done({ ...out, png: Buffer.from(withDpi(out.png, LABEL.dpi)) });
    }
    case "box": {
      const { style } = input;
      if (!style.boxImageUrl || !style.logoZone) {
        throw new RenderInputError(`body style "${style.id}" has no box photo placement yet`);
      }
      const photo = await loadImage(style.boxImageUrl);
      const scene = boxSceneSvg({ photo, logoZone: style.logoZone, message: input.message });
      return done({ ...renderPng(scene.svg), labelZonePx: scene.labelZonePx });
    }
    case "open": {
      const { style, box } = input;
      if (!box?.interiorUrl || !box.messageZone) {
        throw new RenderInputError("the catalog has no box interior placement yet");
      }
      if (!style.cutoutUrl || !style.pinataZone) {
        throw new RenderInputError(`body style "${style.id}" has no cutout placement yet`);
      }
      const [interior, cutout] = await Promise.all([
        loadImage(box.interiorUrl),
        loadImage(style.cutoutUrl),
      ]);
      const scene = openSceneSvg({
        interior,
        cutout,
        pinataZone: style.pinataZone,
        messageZone: box.messageZone,
        message: input.message,
        targetWidth: MIN_LABEL_ZONE_PX,
      });
      return done(renderPng(scene.svg));
    }
    default:
      throw new RenderInputError(`view must be one of: ${PROBE_VIEWS.join(", ")}`);
  }
}

export { LABEL, MIN_LABEL_ZONE_PX } from "./scenes";
