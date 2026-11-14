/**
 * DesignDocument — THE contract of the whole builder. One JSON document is
 * rendered twice: low-res in the browser (react-konva preview/editing) and,
 * later, at full 300 DPI on the server (the authoritative print render).
 * The client submits this JSON at order time, never pixels — so everything
 * an element needs to reproduce EXACTLY must live here, and the schema is
 * versioned so old saved designs stay renderable.
 *
 * v2 = TEMPLATE model (replaced the v1 freeform canvas): the label divides
 * into a fixed layout of side-by-side boxes ("slots"); each slot holds one
 * photo (cover-filled, slid along its overflow axis to frame) or one text
 * block (centered, auto-fit). Every output fills the full 8"×3.9" print
 * area — no dead air, no overhangs.
 */

export const DESIGN_DOC_VERSION = 2 as const;

// Default print artboard: 8" × 3.9" @ 300 DPI (2400 × 1170 px). Per-body-style
// artboards become a hub catalog field when styles need different dimensions.
export const DEFAULT_ARTBOARD = { widthIn: 8, heightIn: 3.9, dpi: 300 };

export type Artboard = typeof DEFAULT_ARTBOARD;

export function artboardPx(a: Artboard): { width: number; height: number } {
  return {
    width: Math.round(a.widthIn * a.dpi),
    height: Math.round(a.heightIn * a.dpi),
  };
}

/* --- templates ---------------------------------------------------------------
 * A template is a row of column widths (relative units). Slots are computed
 * from the artboard at runtime so a future per-style artboard "just works".
 * -------------------------------------------------------------------------- */

export type TemplateId =
  | "whole"
  | "halves"
  | "third-left"
  | "third-right"
  | "thirds"
  | "photo-plus-two"
  | "banner"
  | "quarters";

export const TEMPLATES: { id: TemplateId; label: string }[] = [
  { id: "whole", label: "Whole label" },
  { id: "halves", label: "Two halves" },
  { id: "third-left", label: "Small + big" },
  { id: "third-right", label: "Big + small" },
  { id: "thirds", label: "Three boxes" },
  { id: "photo-plus-two", label: "Big + two stacked" },
  { id: "banner", label: "Banner + two" },
  { id: "quarters", label: "Four boxes" },
];

// White gutter between boxes (artboard px ≈ 1.7 mm at 300 DPI) so photos
// don't collide edge-to-edge in print.
export const SLOT_GUTTER_PX = 20;

export type SlotRect = { x: number; y: number; w: number; h: number };

/** Full-height columns with the given width ratios. */
function colRects(cols: number[], W: number, H: number): SlotRect[] {
  const units = cols.reduce((s, c) => s + c, 0);
  const unitW = (W - (cols.length - 1) * SLOT_GUTTER_PX) / units;
  const rects: SlotRect[] = [];
  let x = 0;
  for (const c of cols) {
    rects.push({ x: Math.round(x), y: 0, w: Math.round(unitW * c), h: H });
    x += unitW * c + SLOT_GUTTER_PX;
  }
  // pin the last box to the artboard's right edge (rounding drift)
  const last = rects[rects.length - 1];
  last.w = W - last.x;
  return rects;
}

export function templateSlotRects(id: TemplateId, artboard: Artboard): SlotRect[] {
  const { width: W, height: H } = artboardPx(artboard);
  const G = SLOT_GUTTER_PX;
  switch (id) {
    case "halves":
      return colRects([1, 1], W, H);
    case "third-left":
      return colRects([1, 2], W, H);
    case "third-right":
      return colRects([2, 1], W, H);
    case "thirds":
      return colRects([1, 1, 1], W, H);
    // Big photo on the left, two stacked boxes on the right — photo plus a
    // name up top and a message below.
    case "photo-plus-two": {
      const left = Math.round(((W - G) * 2) / 3);
      const rx = left + G;
      const topH = Math.round((H - G) / 2);
      return [
        { x: 0, y: 0, w: left, h: H },
        { x: rx, y: 0, w: W - rx, h: topH },
        { x: rx, y: topH + G, w: W - rx, h: H - topH - G },
      ];
    }
    // Full-width strip up top (a "HAPPY BIRTHDAY" headline), two boxes under.
    case "banner": {
      const bh = Math.round(H * 0.34);
      const by = bh + G;
      const cw = Math.round((W - G) / 2);
      return [
        { x: 0, y: 0, w: W, h: bh },
        { x: 0, y: by, w: cw, h: H - by },
        { x: cw + G, y: by, w: W - cw - G, h: H - by },
      ];
    }
    // 2×2 grid — four landscape boxes.
    case "quarters": {
      const cw = Math.round((W - G) / 2);
      const rh = Math.round((H - G) / 2);
      return [
        { x: 0, y: 0, w: cw, h: rh },
        { x: cw + G, y: 0, w: W - cw - G, h: rh },
        { x: 0, y: rh + G, w: cw, h: H - rh - G },
        { x: cw + G, y: rh + G, w: W - cw - G, h: H - rh - G },
      ];
    }
    case "whole":
    default:
      return colRects([1], W, H);
  }
}

/* --- slot contents ----------------------------------------------------------- */

export type PhotoSlot = {
  kind: "photo";
  // Downscaled data URL (Blob URL once the hardened upload lands).
  src: string;
  // Natural dimensions of src — cover-fit math needs them without decoding.
  natW: number;
  natH: number;
  // 0..1 position along the OVERFLOW axis (0 = start, 0.5 = centered).
  // At zoom 1 a cover-filled photo overflows its box on exactly one axis;
  // sliding along it is the framing control. (Read only while fx/fy are
  // absent — see photoFrame.)
  offset: number;
  // Optional, added 2026-11 (absent = the original behaviour, so every
  // saved design renders exactly as before):
  /** 1 = just covers the box; above 1 crops closer, below 1 shrinks the
   *  photo inside its box (the background shows around it). */
  zoom?: number;
  /** Quarter turns, clockwise. */
  rot?: 0 | 90 | 180 | 270;
  /** 0..1 framing on each axis once zoomed/rotated/dragged freely. */
  fx?: number;
  fy?: number;
};

/** The text styles on offer — brand fonts only (design-system
 *  colors_and_type.css): Poppins regular, Poppins bold, Arbotek display. */
export type TextFont = "classic" | "bold" | "party";

export const TEXT_FONTS: { id: TextFont; label: string }[] = [
  { id: "classic", label: "Classic" },
  { id: "bold", label: "Bold" },
  { id: "party", label: "Party" },
];

export type TextSlot = {
  kind: "text";
  text: string;
  fill: string;
  /** Absent = "classic" (every design saved before fonts existed). */
  font?: TextFont;
};

export type SlotContent = PhotoSlot | TextSlot | null;

export type DesignDocument = {
  version: typeof DESIGN_DOC_VERSION;
  bodyStyleId: string;
  artboard: Artboard;
  background: string;
  template: TemplateId;
  // Same length/order as templateSlotRects(template); null = empty box.
  slots: SlotContent[];
};

/** Older documents (v1 freeform) can't open in the template editor. */
export function isCurrentDesign(d: unknown): d is DesignDocument {
  return (
    !!d &&
    typeof d === "object" &&
    (d as DesignDocument).version === DESIGN_DOC_VERSION &&
    Array.isArray((d as DesignDocument).slots)
  );
}

/**
 * A design's identity for matching an upload to the piñata it belongs to:
 * the whole document EXCEPT bodyStyleId. The flow re-stamps bodyStyleId
 * with the current style (the body can be swapped after designing), so two
 * copies of the same design can legitimately disagree on it. Spreading keeps
 * the key order, so equal designs always serialize identically.
 */
export function designKey(doc: DesignDocument): string {
  return JSON.stringify({ ...doc, bodyStyleId: "" });
}

/**
 * Cover-fit a photo into its box: scale to cover, then slide along the one
 * axis that overflows. Returns draw geometry in artboard px.
 */
export function coverFit(
  slot: SlotRect,
  natW: number,
  natH: number,
  offset: number,
): {
  x: number;
  y: number;
  width: number;
  height: number;
  overX: number;
  overY: number;
  axis: "x" | "y" | "none";
} {
  const scale = Math.max(slot.w / Math.max(1, natW), slot.h / Math.max(1, natH));
  const width = natW * scale;
  const height = natH * scale;
  const overX = width - slot.w;
  const overY = height - slot.h;
  const axis = overX > 1 ? "x" : overY > 1 ? "y" : "none";
  return {
    x: slot.x - overX * offset,
    y: slot.y - overY * offset,
    width,
    height,
    overX,
    overY,
    axis,
  };
}

/** Photo zoom never goes past this (a 4× crop of a phone photo is already
 *  soft at label size — the low-res warning says so). */
export const MAX_PHOTO_ZOOM = 4;
/** …nor under this: a fifth of "just covers the box" (a small photo with
 *  the label background around it). */
export const MIN_PHOTO_ZOOM = 0.2;

/** Whether a photo has left the original one-axis framing. */
export function isFreeFrame(p: PhotoSlot): boolean {
  return Math.abs((p.zoom ?? 1) - 1) > 0.001 || (p.rot ?? 0) !== 0 || p.fx !== undefined || p.fy !== undefined;
}

/**
 * Where a photo sits in its box — ONE function for the editor and the print
 * render. Scale = cover the box (after any quarter turn) × zoom; the scaled
 * photo's bounding box then overflows by overX/overY, and fx/fy (0..1) pick
 * which part shows. Zoomed below 1 it is SMALLER than the box (overX/overY
 * negative): fx/fy then place it inside, 0 = left/top, 1 = right/bottom. Photos that were never zoomed, turned or freely dragged
 * use the original framing: `offset` along the one overflowing axis —
 * identical to coverFit, so saved designs print as they always did.
 *
 * Draw it as a Konva image centred on (cx, cy): width dw, height dh,
 * offsetX dw/2, offsetY dh/2, rotation rot.
 */
export function photoFrame(
  rect: SlotRect,
  p: PhotoSlot,
): {
  cx: number;
  cy: number;
  dw: number;
  dh: number;
  rot: number;
  bw: number;
  bh: number;
  overX: number;
  overY: number;
  fx: number;
  fy: number;
  /** drawn px per source px (print sharpness = dpi / scale) */
  scale: number;
} {
  const rot = p.rot ?? 0;
  const zoom = Math.min(MAX_PHOTO_ZOOM, Math.max(MIN_PHOTO_ZOOM, p.zoom ?? 1));
  const natW = Math.max(1, p.natW);
  const natH = Math.max(1, p.natH);
  const turned = rot === 90 || rot === 270;
  const w0 = turned ? natH : natW;
  const h0 = turned ? natW : natH;
  const scale = Math.max(rect.w / w0, rect.h / h0) * zoom;
  const bw = w0 * scale;
  const bh = h0 * scale;
  // negative when the photo is smaller than the box on that axis
  const overX = bw - rect.w;
  const overY = bh - rect.h;
  let fx: number;
  let fy: number;
  if (isFreeFrame(p)) {
    fx = p.fx ?? 0.5;
    fy = p.fy ?? 0.5;
  } else {
    // coverFit's rule exactly: the offset applies on both axes (only one
    // overflows, so it slides along that one)
    fx = p.offset;
    fy = p.offset;
  }
  fx = Math.min(1, Math.max(0, fx));
  fy = Math.min(1, Math.max(0, fy));
  return {
    cx: rect.x - overX * fx + bw / 2,
    cy: rect.y - overY * fy + bh / 2,
    dw: natW * scale,
    dh: natH * scale,
    rot,
    bw,
    bh,
    overX,
    overY,
    fx,
    fy,
    scale,
  };
}

// Brand palette offered as text-color swatches — the official base palette
// from design-system/colors_and_type.css.
// No white: text always sits on the white artboard background, so a white
// swatch would print blank — an invisible-text trap. Yellow (#F6DE6B, 1.3:1
// on white) and pink (#F2A7B0, 2:1) are gone for the same reason: pale text
// on a white label reads as a smudge in print. Designs saved with them still
// render as saved; they just aren't offered anymore.
export const TEXT_SWATCHES = [
  "#180D38", // navy
  "#627AE3", // periwinkle
  "#55A871", // green
  "#EB7C57", // coral
] as const;

export function newDesign(
  bodyStyleId: string,
  template: TemplateId = "whole",
): DesignDocument {
  return {
    version: DESIGN_DOC_VERSION,
    bodyStyleId,
    artboard: { ...DEFAULT_ARTBOARD },
    background: "#FFFFFF",
    template,
    slots: templateSlotRects(template, DEFAULT_ARTBOARD).map(() => null),
  };
}
