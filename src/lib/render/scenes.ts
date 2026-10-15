import type { LogoZone } from "@/lib/hub";
import type { RasterImage } from "./images";
import { layoutText, num, textBlockSvg } from "./text";

/**
 * The SVG scenes the probe renders. Geometry mirrors the storefront:
 *  - the LABEL artboard is lib/design-document's DEFAULT_ARTBOARD —
 *    8 × 3.9 in at 300 DPI = 2400 × 1170 px (the file Paper prints);
 *    text padding / minimum size follow lib/design-render;
 *  - the closed BOX is BoxPreview's composite: the box photo with the
 *    label contain-fit into the hub's logoZone (.box-art { object-fit:
 *    contain }), here as a nested <svg viewBox> with xMidYMid meet;
 *  - the OPEN box is BoxPreview's message step: the interior photo, the
 *    piñata cutout width-fit and bottom-anchored in pinataZone
 *    (.box-pinata { height: auto }), and the message on a white card in
 *    the hub's messageZone (.flap-message padding 4% / 6%).
 *
 * DPI assumption: only the label is a print file (300 DPI, stamped by the
 * caller). The box scenes are mockups; the closed box is sized so the
 * label zone is ≥ MIN_LABEL_ZONE_PX wide, i.e. the 8-inch label appears at
 * ≥ 150 px/in on the mockup (1200 / 8).
 */

export const INK = "#180d38"; // globals.css --ink (navy)
export const LABEL = { widthIn: 8, heightIn: 3.9, dpi: 300, w: 2400, h: 1170 } as const;
export const MIN_LABEL_ZONE_PX = 1200;

// lib/design-render: TEXT_PAD_MIN_PX / MIN_TEXT_PX / fitFontSize's start.
const TEXT_PAD_MIN_PX = 60;
const MIN_TEXT_PX = 48;
const MAX_TEXT_PX = 260;

const SVG_NS = 'xmlns="http://www.w3.org/2000/svg"';

function imageTag(
  img: RasterImage,
  x: number,
  y: number,
  w: number,
  h: number,
  fit: "none" | "xMidYMid meet" | "xMidYMax meet" = "none",
): string {
  const href = `data:${img.mime};base64,${img.bytes.toString("base64")}`;
  return `<image href="${href}" x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" preserveAspectRatio="${fit}"/>`;
}

/** Label-artboard content (2400 × 1170 user units): white, the message in
 *  Poppins SemiBold, auto-fit and centred — a text-only custom design. */
export function labelArtInner(message: string): string {
  const pad = Math.max(TEXT_PAD_MIN_PX, Math.round(Math.min(LABEL.w, LABEL.h) * 0.08));
  const box = { x: pad, y: pad, w: LABEL.w - pad * 2, h: LABEL.h - pad * 2 };
  const layout = layoutText(message, box, {
    weight: 600,
    maxSize: Math.min(Math.round(box.h * 0.5), MAX_TEXT_PX),
    minSize: MIN_TEXT_PX,
  });
  return (
    `<rect width="${LABEL.w}" height="${LABEL.h}" fill="#ffffff"/>` +
    textBlockSvg(layout, box, { weight: 600, fill: INK })
  );
}

/** The print file itself: exactly 2400 × 1170 px. */
export function labelSvg(message: string): { svg: string; width: number; height: number } {
  return {
    svg: `<svg ${SVG_NS} width="${LABEL.w}" height="${LABEL.h}" viewBox="0 0 ${LABEL.w} ${LABEL.h}">${labelArtInner(message)}</svg>`,
    width: LABEL.w,
    height: LABEL.h,
  };
}

/** The closed box: photo + label in the logo zone (contain-fit, centred). */
export function boxSceneSvg(args: {
  photo: RasterImage;
  logoZone: LogoZone;
  message: string;
}): { svg: string; width: number; height: number; labelZonePx: number } {
  const { photo, logoZone: z } = args;
  const scale = Math.max(1, MIN_LABEL_ZONE_PX / (z.w * photo.width));
  const W = Math.round(photo.width * scale);
  const H = Math.round(photo.height * scale);
  const zx = z.x * W;
  const zy = z.y * H;
  const zw = z.w * W;
  const zh = z.h * H;
  const svg =
    `<svg ${SVG_NS} width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    imageTag(photo, 0, 0, W, H) +
    `<svg x="${num(zx)}" y="${num(zy)}" width="${num(zw)}" height="${num(zh)}" ` +
    `viewBox="0 0 ${LABEL.w} ${LABEL.h}" preserveAspectRatio="xMidYMid meet">` +
    labelArtInner(args.message) +
    `</svg></svg>`;
  return { svg, width: W, height: H, labelZonePx: Math.round(zw) };
}

/** The open box: interior + piñata cutout in pinataZone + message card. */
export function openSceneSvg(args: {
  interior: RasterImage;
  cutout: RasterImage;
  pinataZone: LogoZone;
  messageZone: LogoZone;
  message: string;
  targetWidth?: number;
}): { svg: string; width: number; height: number } {
  const { interior, cutout, pinataZone: pz, messageZone: mz } = args;
  const scale = (args.targetWidth ?? MIN_LABEL_ZONE_PX) / interior.width;
  const W = Math.round(interior.width * scale);
  const H = Math.round(interior.height * scale);

  // Width-fit, bottom-anchored: the height follows the cutout's own aspect
  // (zone.h only records the footprint), exactly like .box-pinata.
  const pw = pz.w * W;
  const ph = pw * (cutout.height / cutout.width);
  const px = pz.x * W;
  const py = (pz.y + pz.h) * H - ph;

  // The message card: white, rounded, text inside 4% / 6% padding.
  const card = { x: mz.x * W, y: mz.y * H, w: mz.w * W, h: mz.h * H };
  const padX = card.w * 0.06;
  const padY = card.h * 0.04;
  const box = { x: card.x + padX, y: card.y + padY, w: card.w - padX * 2, h: card.h - padY * 2 };
  const layout = layoutText(args.message, box, {
    weight: 400,
    maxSize: Math.round(box.h * 0.5),
    minSize: 12,
  });

  const svg =
    `<svg ${SVG_NS} width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<defs><clipPath id="card"><rect x="${num(box.x)}" y="${num(box.y)}" width="${num(box.w)}" height="${num(box.h)}"/></clipPath></defs>` +
    imageTag(interior, 0, 0, W, H) +
    imageTag(cutout, px, py, pw, ph, "xMidYMax meet") +
    `<rect x="${num(card.x)}" y="${num(card.y)}" width="${num(card.w)}" height="${num(card.h)}" rx="4" fill="#ffffff"/>` +
    `<g clip-path="url(#card)">${textBlockSvg(layout, box, { weight: 400, fill: INK })}</g>` +
    `</svg>`;
  return { svg, width: W, height: H };
}
