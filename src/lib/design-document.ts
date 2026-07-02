/**
 * DesignDocument — THE contract of the whole builder. One JSON document is
 * rendered twice: low-res in the browser (react-konva preview/editing) and,
 * later, at full 300 DPI on the server (the authoritative print render).
 * The client submits this JSON at order time, never pixels — so everything
 * an element needs to reproduce EXACTLY must live here, and the schema is
 * versioned so old saved designs stay renderable.
 *
 * v1 scope: text elements only. Image/shape/graphic kinds arrive with the
 * upload + catalog milestones and will bump the version.
 */

export const DESIGN_DOC_VERSION = 1 as const;

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

export type TextElement = {
  id: string;
  kind: "text";
  text: string;
  // Position/size in ARTBOARD pixels (300 DPI space), never screen pixels.
  x: number;
  y: number;
  fontSizePx: number;
  fontFamily: string; // must be a font both renderers load (OFL set)
  fill: string;
  rotation: number; // degrees
};

export type ImageElement = {
  id: string;
  kind: "image";
  // v0: a data URL captured client-side. Becomes a Blob URL once the hardened
  // upload endpoint lands (size cap, magic-byte sniff, EXIF strip, Turnstile).
  src: string;
  x: number;
  y: number;
  width: number; // artboard px
  height: number;
  rotation: number;
};

export type DesignElement = TextElement | ImageElement;

export type DesignDocument = {
  version: typeof DESIGN_DOC_VERSION;
  bodyStyleId: string;
  artboard: Artboard;
  background: string;
  elements: DesignElement[];
};

// Brand palette offered as text-color swatches — the official base palette
// from design-system/colors_and_type.css.
export const TEXT_SWATCHES = [
  "#180D38", // navy
  "#627AE3", // periwinkle
  "#55A871", // green
  "#F6DE6B", // yellow
  "#F2A7B0", // pink
  "#EB7C57", // coral
  "#FFFFFF", // white
] as const;

export function newDesign(bodyStyleId: string): DesignDocument {
  return {
    version: DESIGN_DOC_VERSION,
    bodyStyleId,
    artboard: { ...DEFAULT_ARTBOARD },
    background: "#FFFFFF",
    elements: [],
  };
}

export function newImageElement(
  artboard: Artboard,
  src: string,
  naturalWidth: number,
  naturalHeight: number,
): ImageElement {
  const { width, height } = artboardPx(artboard);
  // Fit to ~55% of the artboard width, centered-ish.
  const w = Math.round(width * 0.55);
  const h = Math.round((w * naturalHeight) / naturalWidth);
  return {
    id: `i${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    kind: "image",
    src,
    x: Math.round((width - w) / 2),
    y: Math.round((height - h) / 2),
    width: w,
    height: h,
    rotation: 0,
  };
}

export function newTextElement(artboard: Artboard): TextElement {
  const { width, height } = artboardPx(artboard);
  return {
    id: `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    kind: "text",
    text: "Your text here",
    x: Math.round(width * 0.25),
    y: Math.round(height * 0.4),
    fontSizePx: 160,
    fontFamily: "Poppins",
    fill: TEXT_SWATCHES[0],
    rotation: 0,
  };
}
