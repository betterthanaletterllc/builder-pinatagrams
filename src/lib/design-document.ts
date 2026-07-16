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
  // A cover-filled photo overflows its box on exactly one axis; sliding
  // along it is the only framing control — that's the point.
  offset: number;
};

export type TextSlot = {
  kind: "text";
  text: string;
  fill: string;
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

// Brand palette offered as text-color swatches — the official base palette
// from design-system/colors_and_type.css.
// No white: text always sits on the white artboard background, so a white
// swatch would print blank — an invisible-text trap.
export const TEXT_SWATCHES = [
  "#180D38", // navy
  "#627AE3", // periwinkle
  "#55A871", // green
  "#F6DE6B", // yellow
  "#F2A7B0", // pink
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
