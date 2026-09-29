import Konva from "konva";
import {
  artboardPx,
  coverFit,
  templateSlotRects,
  type DesignDocument,
  type SlotRect,
} from "./design-document";

/**
 * Text layout + the headless print render for template designs. ONE home
 * for the geometry the editor draws on screen AND the print file is made
 * from, so the two can't drift apart.
 *
 * The editor still exports the print canvas from its live stage (the path
 * every custom order has printed from). renderDesignCanvas is the fallback
 * for when no live stage exists — a retry after the page reloaded, or a
 * restored piñata whose upload never finished — rebuilding the exact same
 * node tree from the DesignDocument alone.
 *
 * Client-only (Konva needs a DOM canvas). Import it dynamically from code
 * that also renders on the server.
 */

// Every text box renders at this line height (editor + print).
export const TEXT_LINE_HEIGHT = 1.15;

// Breathing room between text and its box edge, in artboard px. The 8% rule
// alone left ~32 px (0.1") in the banner strip — too tight for a trim edge —
// so no box gets less than 60 px (0.2" at 300 DPI).
export const TEXT_PAD_MIN_PX = 60;

// Smallest legible PRINTED text: 48 artboard px ≈ 11.5 pt at 300 DPI. The
// auto-fit may still shrink older designs below this (they render as saved),
// but typing that would push a box under it is refused.
export const MIN_TEXT_PX = 48;

// Hard ceiling on one box's text — a label isn't a letter (the gift message
// goes inside the lid).
const MAX_TEXT_CHARS = 300;

/** The text area inside a slot, after padding. */
export function textBox(rect: SlotRect): {
  x: number;
  y: number;
  w: number;
  h: number;
} {
  const pad = Math.max(
    TEXT_PAD_MIN_PX,
    Math.round(Math.min(rect.w, rect.h) * 0.08),
  );
  return {
    x: rect.x + pad,
    y: rect.y + pad,
    w: rect.w - pad * 2,
    h: rect.h - pad * 2,
  };
}

/** Largest font size (px) whose wrapped height fits the box AND whose widest
 *  single word fits on one line — so words wrap whole and are never broken
 *  mid-word (Konva's "word" wrap otherwise splits a word too wide to fit). */
export function fitFontSize(
  text: string,
  w: number,
  h: number,
  fontFamily: string,
): number {
  let size = Math.min(Math.round(h * 0.5), 260);
  const probe = new Konva.Text({
    text,
    width: w,
    fontFamily,
    fontSize: size,
    lineHeight: TEXT_LINE_HEIGHT,
  });
  const words = text.split(/\s+/).filter(Boolean);
  const widestWord = () =>
    words.reduce((m, word) => Math.max(m, probe.measureSize(word).width), 0);
  while (size > 16 && (probe.height() > h || widestWord() > w)) {
    size = Math.floor(size * 0.9);
    probe.fontSize(size);
  }
  probe.destroy();
  return size;
}

/** Whether this text still prints at a legible size in the slot. */
export function textFits(
  text: string,
  rect: SlotRect,
  fontFamily: string,
): boolean {
  if (text.length > MAX_TEXT_CHARS) return false;
  if (!text.trim()) return true;
  const b = textBox(rect);
  return fitFontSize(text, b.w, b.h, fontFamily) >= MIN_TEXT_PX;
}

/**
 * Roughly how many characters of ordinary words fit the slot at the minimum
 * legible size — the editor's character counter. An estimate on purpose
 * (real text with very long words fits less); textFits stays the gate.
 */
export function textCapacity(rect: SlotRect, fontFamily: string): number {
  const b = textBox(rect);
  const sample = "Happy birthday to my favorite person in the whole world ";
  const fits = (n: number) => {
    const t = sample.repeat(Math.ceil(n / sample.length)).slice(0, n).trim();
    return fitFontSize(t, b.w, b.h, fontFamily) >= MIN_TEXT_PX;
  };
  if (fits(MAX_TEXT_CHARS)) return MAX_TEXT_CHARS;
  let lo = 1;
  let hi = MAX_TEXT_CHARS;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** The brand body font (next/font's generated Poppins family). */
export function designFontFamily(): string {
  if (typeof document === "undefined") return "sans-serif";
  const v = getComputedStyle(document.body)
    .getPropertyValue("--font-poppins")
    .trim();
  return v || "sans-serif";
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const i = new window.Image();
    i.crossOrigin = "anonymous"; // keep the canvas untainted for export
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error("photo-decode"));
    i.src = src;
  });
}

/**
 * Render the design at print resolution (artboard px, e.g. 2400×1170) from
 * the document alone — the same nodes the editor draws (clipped slots,
 * cover-fit photos, centered auto-fit text) on a DETACHED group, so no stage
 * or layer canvas is ever allocated (a 2400px stage at 3× DPR would blow
 * iOS Safari's canvas budget). Empty text boxes print blank — never the
 * editor's "Your text" placeholder.
 */
export async function renderDesignCanvas(
  doc: DesignDocument,
): Promise<HTMLCanvasElement> {
  const { width, height } = artboardPx(doc.artboard);
  const rects = templateSlotRects(doc.template, doc.artboard);
  const fontFamily = designFontFamily();
  // The auto-fit must measure Poppins, not a fallback face.
  try {
    await document.fonts?.load(`${MIN_TEXT_PX}px ${fontFamily}`);
    await document.fonts?.ready;
  } catch {
    // font API missing/refused — measure with whatever is loaded
  }
  const images = await Promise.all(
    doc.slots.map((s) => (s?.kind === "photo" ? loadImage(s.src) : null)),
  );

  const group = new Konva.Group({
    clip: { x: 0, y: 0, width, height },
  });
  try {
    group.add(new Konva.Rect({ width, height, fill: doc.background }));
    rects.forEach((r, i) => {
      const c = doc.slots[i];
      if (!c) return;
      const slot = new Konva.Group({
        clip: { x: r.x, y: r.y, width: r.w, height: r.h },
      });
      if (c.kind === "photo") {
        const img = images[i];
        if (!img) return;
        const fit = coverFit(r, c.natW, c.natH, c.offset);
        slot.add(
          new Konva.Image({
            image: img,
            x: fit.x,
            y: fit.y,
            width: fit.width,
            height: fit.height,
          }),
        );
      } else {
        if (!c.text.trim()) return;
        const b = textBox(r);
        slot.add(
          new Konva.Text({
            x: b.x,
            y: b.y,
            width: b.w,
            height: b.h,
            text: c.text,
            fontSize: fitFontSize(c.text, b.w, b.h, fontFamily),
            fontFamily,
            fill: c.fill,
            align: "center",
            verticalAlign: "middle",
            lineHeight: TEXT_LINE_HEIGHT,
          }),
        );
      }
      group.add(slot);
    });
    return group.toCanvas({ x: 0, y: 0, width, height, pixelRatio: 1 });
  } finally {
    group.destroy();
  }
}
