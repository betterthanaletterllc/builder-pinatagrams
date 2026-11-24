import sharp from "sharp";
import type { LogoZone } from "@/lib/hub";
import { renderPng } from "./index";
import { pngSize, type RasterImage } from "./images";
import { FONT_FAMILY } from "./fonts";
import { INK } from "./scenes";
import { layoutText, num, textBlockSvg, escapeXml } from "./text";

/**
 * Staff mockups: a design on every body style, closed (front label on the
 * box photo) and open (the piñata in the interior with the inside-flap card
 * and message) — the storefront's BoxPreview drawn server-side, so a chat
 * assistant can show it as an image.
 *
 * Geometry mirrors BoxPreview (src/app/design/box-preview.tsx):
 *  - closed: the box photo, the front art contain-fit and centred in the
 *    style's logoZone (.box-art { object-fit: contain });
 *  - open: the interior photo; the piñata cutout width-fit and bottom-
 *    anchored in pinataZone; in the catalog's messageZone a white rounded
 *    card with the flap art STRETCHED over it (stretchSvg / object-fit:
 *    fill), and the message centred inside the card's padding (hub
 *    messageCardPadding, percent of the card; the text box stops at 78% of
 *    the card's height to stay clear of the logo strip). With no flap art
 *    the card is plain white with 6% / 4% padding (.flap-message).
 *
 * Each scene is rendered to PNG by resvg at tile size; the sheet is laid
 * out by sharp (raster compositing only — every glyph comes from resvg and
 * the bundled Poppins, never from sharp's fontconfig).
 */

export type MockupView = "closed" | "open";

export type ClosedSceneInput = {
  photo: RasterImage;
  logoZone: LogoZone;
  /** Front art; null shows the bare box. */
  art: RasterImage | null;
};

export type OpenSceneInput = {
  interior: RasterImage;
  cutout: RasterImage | null;
  pinataZone: LogoZone | null;
  messageZone: LogoZone;
  /** Inside-flap card art; null = a plain white card. */
  card: RasterImage | null;
  /** Percent of the card (hub messageCardPadding); default 12 / 7. */
  cardPadding?: { x: number; y: number } | null;
  message: string;
};

const SVG_NS = 'xmlns="http://www.w3.org/2000/svg"';
const DEFAULT_CARD_PADDING = { x: 12, y: 7 };
const CARD_TEXT_HEIGHT = 0.78;
const PLAIN_PADDING = { x: 6, y: 4 };

function href(img: RasterImage): string {
  return `data:${img.mime};base64,${img.bytes.toString("base64")}`;
}

function image(
  img: RasterImage,
  r: { x: number; y: number; w: number; h: number },
  fit: "none" | "xMidYMid meet" | "xMidYMax meet",
): string {
  return `<image href="${href(img)}" x="${num(r.x)}" y="${num(r.y)}" width="${num(r.w)}" height="${num(r.h)}" preserveAspectRatio="${fit}"/>`;
}

/** Closed box at `width` px wide. */
export function closedSceneSvg(input: ClosedSceneInput, width: number): string {
  const { photo, logoZone: z, art } = input;
  const W = width;
  const H = Math.round((width * photo.height) / photo.width);
  const zone = { x: z.x * W, y: z.y * H, w: z.w * W, h: z.h * H };
  return (
    `<svg ${SVG_NS} width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    image(photo, { x: 0, y: 0, w: W, h: H }, "none") +
    (art ? image(art, zone, "xMidYMid meet") : "") +
    `</svg>`
  );
}

/** Open box at `width` px wide. */
export function openSceneSvg(input: OpenSceneInput, width: number): string {
  const { interior, cutout, pinataZone: pz, messageZone: mz, card } = input;
  const W = width;
  const H = Math.round((width * interior.height) / interior.width);

  let pinata = "";
  if (cutout && pz) {
    const pw = pz.w * W;
    const ph = pw * (cutout.height / cutout.width);
    pinata = image(cutout, { x: pz.x * W, y: (pz.y + pz.h) * H - ph, w: pw, h: ph }, "xMidYMax meet");
  }

  const c = { x: mz.x * W, y: mz.y * H, w: mz.w * W, h: mz.h * H };
  const pad = card ? (input.cardPadding ?? DEFAULT_CARD_PADDING) : PLAIN_PADDING;
  const padX = (c.w * pad.x) / 100;
  const padY = (c.h * pad.y) / 100;
  const inner = card ? c.h * CARD_TEXT_HEIGHT : c.h;
  const box = { x: c.x + padX, y: c.y + padY, w: c.w - padX * 2, h: inner - padY * 2 };
  const message = input.message.trim();
  const text =
    message && box.w > 0 && box.h > 0
      ? textBlockSvg(
          layoutText(message, box, {
            weight: 400,
            maxSize: Math.max(8, Math.round(c.h * 0.2)),
            minSize: 6,
          }),
          box,
          { weight: 400, fill: INK },
        )
      : "";
  const r = Math.max(2, W * 0.004);

  return (
    `<svg ${SVG_NS} width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<defs><clipPath id="card"><rect x="${num(c.x)}" y="${num(c.y)}" width="${num(c.w)}" height="${num(c.h)}" rx="${num(r)}"/></clipPath></defs>` +
    image(interior, { x: 0, y: 0, w: W, h: H }, "none") +
    pinata +
    `<rect x="${num(c.x)}" y="${num(c.y)}" width="${num(c.w)}" height="${num(c.h)}" rx="${num(r)}" fill="#ffffff"/>` +
    `<g clip-path="url(#card)">${card ? image(card, c, "none") : ""}${text}</g>` +
    `</svg>`
  );
}

// ------------------------------------------------------------------ sheet

export type SheetTile = {
  caption: string;
  /** Optional second caption line (e.g. "out of stock"). */
  note?: string;
  /** Rendered scene PNGs, shown left to right. */
  scenes: Buffer[];
};

export const SHEET = {
  gap: 24,
  sceneGap: 12,
  margin: 32,
  captionH: 56,
  titleH: 96,
  background: "#f6f2ee",
} as const;

function textPng(lines: { text: string; size: number; weight: 400 | 600; fill: string }[], w: number, h: number): Buffer {
  let y = 0;
  const spans = lines
    .map((l) => {
      y += l.size * 1.25;
      return `<text x="0" y="${num(y - l.size * 0.3)}" font-family="${FONT_FAMILY}" font-weight="${l.weight}" font-size="${l.size}" fill="${l.fill}">${escapeXml(l.text)}</text>`;
    })
    .join("");
  return renderPng(`<svg ${SVG_NS} width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${spans}</svg>`).png;
}

/**
 * Lay tiles out in `columns`, captions above each, a title on top; JPEG out
 * (photos compress ~10× better than PNG, and chat hosts cap image bytes).
 */
export async function composeSheet(
  tiles: SheetTile[],
  opts: { columns: number; title: string; subtitle?: string },
): Promise<{ jpeg: Buffer; width: number; height: number }> {
  const sized = tiles.map((t) => {
    const dims = t.scenes.map((s) => pngSize(s));
    const w = dims.reduce((a, d) => a + d.width, 0) + SHEET.sceneGap * Math.max(0, dims.length - 1);
    const h = Math.max(...dims.map((d) => d.height));
    return { ...t, dims, w, h };
  });
  const cols = Math.max(1, Math.min(opts.columns, sized.length));
  const cellW = Math.max(...sized.map((t) => t.w));
  const cellH = Math.max(...sized.map((t) => t.h)) + SHEET.captionH;
  const rows = Math.ceil(sized.length / cols);
  const W = SHEET.margin * 2 + cols * cellW + (cols - 1) * SHEET.gap;
  const H = SHEET.margin * 2 + SHEET.titleH + rows * cellH + (rows - 1) * SHEET.gap;

  const layers: sharp.OverlayOptions[] = [
    {
      input: textPng(
        [
          { text: opts.title, size: 30, weight: 600, fill: INK },
          ...(opts.subtitle ? [{ text: opts.subtitle, size: 18, weight: 400 as const, fill: "#5b5470" }] : []),
        ],
        W - SHEET.margin * 2,
        SHEET.titleH,
      ),
      left: SHEET.margin,
      top: SHEET.margin,
    },
  ];
  sized.forEach((t, i) => {
    const x0 = SHEET.margin + (i % cols) * (cellW + SHEET.gap);
    const y0 = SHEET.margin + SHEET.titleH + Math.floor(i / cols) * (cellH + SHEET.gap);
    layers.push({
      input: textPng(
        [
          { text: t.caption, size: 22, weight: 600, fill: INK },
          ...(t.note ? [{ text: t.note, size: 15, weight: 400 as const, fill: "#a23b3b" }] : []),
        ],
        cellW,
        SHEET.captionH,
      ),
      left: x0,
      top: y0,
    });
    let x = x0;
    t.scenes.forEach((s, j) => {
      layers.push({ input: s, left: Math.round(x), top: y0 + SHEET.captionH });
      x += t.dims[j].width + SHEET.sceneGap;
    });
  });

  const jpeg = await sharp({
    create: { width: W, height: H, channels: 3, background: SHEET.background },
  })
    .composite(layers)
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer();
  return { jpeg, width: W, height: H };
}

/** Downscale a raster input once to about the size it is drawn at (resvg
 *  parses every embedded byte per scene; a 1080² photo drawn at 480 px
 *  doesn't need to be). */
export async function fitRaster(img: RasterImage, maxWidth: number): Promise<RasterImage> {
  if (img.width <= maxWidth) return img;
  const out = await sharp(img.bytes).resize({ width: Math.round(maxWidth) }).png().toBuffer();
  return { mime: "image/png", bytes: out, ...pngSize(out) };
}
