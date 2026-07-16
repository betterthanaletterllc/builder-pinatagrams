"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { Group, Image as KonvaImage, Layer, Rect, Stage, Text } from "react-konva";
import Konva from "konva";
import type { LogoZone } from "@/lib/hub";
import type { DesignAssets } from "@/lib/flow";
import {
  artboardPx,
  coverFit,
  DEFAULT_ARTBOARD,
  isCurrentDesign,
  newDesign,
  templateSlotRects,
  TEMPLATES,
  TEXT_SWATCHES,
  type DesignDocument,
  type PhotoSlot,
  type SlotContent,
  type SlotRect,
  type TemplateId,
  type TextSlot,
} from "@/lib/design-document";
import { toPrintBlob } from "@/lib/print-png";

/**
 * Template editor (v2 — replaced the freeform canvas). The label divides
 * into a fixed layout of boxes; each box holds ONE photo (cover-filled,
 * dragged along its overflow axis to frame) or ONE text block (centered,
 * auto-fit). Constraints over freedom: every design fills the whole
 * 8"×3.9" print area and looks intentional.
 *
 * Two view modes survive from v1:
 *  - flat: the artboard fills the width (default on phones)
 *  - boxed: the artboard composited on the box photo at the hub's logoZone
 * The document stays in artboard pixels either way; export renders ONLY the
 * design group, cropped to the artboard region.
 */

const MAX_STAGE_WIDTH = 760;
const NARROW = 520;
// Decode-sanity bound only — real camera files never get near this. Photo
// SIZE is never a reason to refuse an upload; ingestPhoto compresses
// whatever it's given down to a bounded data URL.
const MAX_UPLOAD_BYTES = 80 * 1024 * 1024;

function useImg(src: string | null): {
  img: HTMLImageElement | null;
  failed: boolean;
} {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
    if (!src) {
      setImg(null);
      return;
    }
    const i = new window.Image();
    i.crossOrigin = "anonymous"; // keep canvases untainted for export
    i.onload = () => setImg(i);
    i.onerror = () => setFailed(true);
    i.src = src;
    return () => {
      i.onload = null;
      i.onerror = null;
    };
  }, [src]);
  return { img, failed };
}

/**
 * Ingest an upload into a bounded data URL. Photos ride inside the design
 * document through sessionStorage (draft) and localStorage (cart), both
 * ~5 MB quotas — so every photo must come out SMALL, and ingest must never
 * fail on size (compress harder instead of refusing).
 *
 * Dimensions: downscale so the image still COVERS the full 2400×1170
 * artboard (8"×3.9" @300dpi) — full print resolution even if the photo
 * later moves to a whole-label slot. Never upscale; a hard long-edge
 * bound also tames panoramas the cover rule wouldn't shrink.
 *
 * Encoding: JPEG unless the image ACTUALLY contains transparent pixels
 * (scanned, not guessed from the container — phone PNGs are usually just
 * photos, and a lossless 2400px photo is megabytes). Then a byte ladder:
 * quality rungs at each size, then dimensions, until under the per-photo
 * cap. The floor rung always returns — an upload can degrade, never fail.
 */
const INGEST_COVER_W = 2400;
const INGEST_COVER_H = 1170;
// Photos ride the design doc into sessionStorage (draft) and localStorage
// (cart), which charge ~2 bytes per UTF-16 char and bottom out around
// 2.6M chars (Safari's 5 MB). Caps are therefore in dataURL CHARS:
// 4 capped JPEG photos + preview + JSON ≈ 2.4M chars — inside the
// tightest real quota. Real-alpha images (usually flat logos that
// compress far below this anyway) get a little more room.
const INGEST_CAP_CHARS = 550_000;
const INGEST_CAP_CHARS_PNG = 900_000;
// Absolute long-edge bound: shrinks panoramas/scroll-captures the cover
// rule alone wouldn't touch, and keeps every canvas far inside iOS
// Safari's canvas-area limit (a silent-failure zone).
const INGEST_LONG_EDGE = 3200;

function encodeCanvas(
  img: HTMLImageElement,
  w: number,
  h: number,
  type: string,
  quality?: number,
): string {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w));
  canvas.height = Math.max(1, Math.round(h));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no-2d-context");
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const out = canvas.toDataURL(type, quality);
  // Over-limit canvases fail SILENTLY as "data:," — surface, don't store.
  if (out.length < 100) throw new Error("undecodable");
  return out;
}

/** True only if the decoded image has actually-transparent pixels. */
function hasRealAlpha(img: HTMLImageElement): boolean {
  const canvas = document.createElement("canvas");
  canvas.width = 32;
  canvas.height = 32;
  const ctx = canvas.getContext("2d");
  if (!ctx) return false;
  ctx.drawImage(img, 0, 0, 32, 32);
  try {
    const data = ctx.getImageData(0, 0, 32, 32).data;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] < 250) return true;
    }
  } catch {
    // tainted canvas can't happen for local files; play safe anyway
    return true;
  }
  return false;
}

async function ingestPhoto(
  file: File,
): Promise<{ src: string; w: number; h: number }> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new window.Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("undecodable"));
      i.src = url;
    });
    // Smallest size that still covers the full artboard at print res,
    // bounded by the absolute long edge (never upscale).
    const natW = img.naturalWidth;
    const natH = img.naturalHeight;
    const cover = Math.max(INGEST_COVER_W / natW, INGEST_COVER_H / natH);
    const scale = Math.min(
      Math.min(1, cover),
      INGEST_LONG_EDGE / Math.max(natW, natH),
    );
    let w = Math.max(1, Math.round(natW * scale));
    let h = Math.max(1, Math.round(natH * scale));
    // Shrink toward (never past) a long-edge floor.
    const shrink = (floor: number) => {
      const f = Math.max(0.85, floor / Math.max(w, h));
      w = Math.max(1, Math.round(w * f));
      h = Math.max(1, Math.round(h * f));
    };

    const alpha =
      (file.type === "image/png" || file.type === "image/webp") &&
      hasRealAlpha(img);

    if (alpha) {
      // Real transparency: PNG, stepping dimensions (quality isn't a PNG
      // knob). Flat logos land far under the cap at full size.
      let out = encodeCanvas(img, w, h, "image/png");
      while (out.length > INGEST_CAP_CHARS_PNG && Math.max(w, h) > 1000) {
        shrink(1000);
        out = encodeCanvas(img, w, h, "image/png");
      }
      if (out.length > INGEST_CAP_CHARS_PNG) {
        // Photographic content with alpha (e.g. iOS subject cutouts):
        // lossy WebP keeps the transparency at JPEG-ish sizes. Safari
        // can't ENCODE WebP and silently falls back to PNG — detect by
        // prefix; if so the oversized PNG stands (rare; eats storage
        // headroom but never fails the upload).
        const webp = encodeCanvas(img, w, h, "image/webp", 0.75);
        if (webp.startsWith("data:image/webp")) out = webp;
      }
      return { src: out, w, h };
    }

    // JPEG: quality rungs at each size, then shrink and try again. The
    // floor rung accepts whatever it yields — ingest NEVER fails on size.
    // Terminates: dimensions decrease geometrically to the floor.
    for (;;) {
      for (const q of [0.8, 0.7, 0.62]) {
        const out = encodeCanvas(img, w, h, "image/jpeg", q);
        if (out.length <= INGEST_CAP_CHARS) return { src: out, w, h };
      }
      if (Math.max(w, h) <= 1280) break;
      shrink(1280);
    }
    return { src: encodeCanvas(img, w, h, "image/jpeg", 0.55), w, h };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Largest font size (px) whose wrapped height fits the box AND whose widest
 *  single word fits on one line — so words wrap whole and are never broken
 *  mid-word (Konva's "word" wrap otherwise splits a word too wide to fit). */
function fitFontSize(
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
    lineHeight: 1.15,
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

const clamp = (v: number, min: number, max: number) =>
  Math.min(max, Math.max(min, v));

/* --- slot renderers ----------------------------------------------------------- */

function PhotoSlotEl({
  slot,
  rect,
  gx,
  gy,
  scale,
  onSelect,
  onOffset,
}: {
  slot: PhotoSlot;
  rect: SlotRect;
  gx: number;
  gy: number;
  scale: number;
  onSelect: () => void;
  onOffset: (offset: number) => void;
}) {
  const { img } = useImg(slot.src);
  const fit = coverFit(rect, slot.natW, slot.natH, slot.offset);
  // Drag stays on the overflow axis: local x ∈ [rect.x − overX, rect.x],
  // y likewise. dragBoundFunc works in ABSOLUTE stage coords, so convert
  // through the design group's transform (gx/gy + scale).
  const aMinX = gx + (rect.x - fit.overX) * scale;
  const aMaxX = gx + rect.x * scale;
  const aMinY = gy + (rect.y - fit.overY) * scale;
  const aMaxY = gy + rect.y * scale;
  return (
    <Group clip={{ x: rect.x, y: rect.y, width: rect.w, height: rect.h }}>
      <KonvaImage
        image={img ?? undefined}
        x={fit.x}
        y={fit.y}
        width={fit.width}
        height={fit.height}
        draggable={fit.axis !== "none"}
        onMouseDown={onSelect}
        onTap={onSelect}
        onDragStart={onSelect}
        dragBoundFunc={(pos) => ({
          x: clamp(pos.x, aMinX, aMaxX),
          y: clamp(pos.y, aMinY, aMaxY),
        })}
        onDragEnd={(e) => {
          const n = e.target;
          const next =
            fit.axis === "x"
              ? (rect.x - n.x()) / fit.overX
              : fit.axis === "y"
                ? (rect.y - n.y()) / fit.overY
                : slot.offset;
          onOffset(clamp(next, 0, 1));
        }}
      />
    </Group>
  );
}

function TextSlotEl({
  slot,
  rect,
  fontFamily,
  fontsReady,
  onSelect,
  onEdit,
}: {
  slot: TextSlot;
  rect: SlotRect;
  fontFamily: string;
  fontsReady: boolean;
  onSelect: () => void;
  onEdit: () => void;
}) {
  const pad = Math.round(Math.min(rect.w, rect.h) * 0.08);
  const w = rect.w - pad * 2;
  const h = rect.h - pad * 2;
  const empty = slot.text.trim() === "";
  const display = empty ? "Your text" : slot.text;
  // fontsReady in the deps re-fits once Poppins loads (its metrics differ
  // from the fallback the first fit may have measured).
  const fontSize = useMemo(
    () => fitFontSize(display, w, h, fontFamily),
    [display, w, h, fontFamily, fontsReady],
  );
  return (
    <Group clip={{ x: rect.x, y: rect.y, width: rect.w, height: rect.h }}>
      <Text
        x={rect.x + pad}
        y={rect.y + pad}
        width={w}
        height={h}
        text={display}
        fontSize={fontSize}
        fontFamily={fontFamily}
        fill={slot.fill}
        opacity={empty ? 0.35 : 1}
        align="center"
        verticalAlign="middle"
        lineHeight={1.15}
        onMouseDown={onSelect}
        onTap={onSelect}
        onDblClick={onEdit}
        onDblTap={onEdit}
      />
    </Group>
  );
}

/** Mini wireframe of a template's boxes (picker cards + toolbar switcher). */
function TmplMini({ id }: { id: TemplateId }) {
  const { width: W, height: H } = artboardPx(DEFAULT_ARTBOARD);
  const rects = templateSlotRects(id, DEFAULT_ARTBOARD);
  return (
    <span className="tmpl-mini" aria-hidden>
      {rects.map((r, i) => (
        <span
          key={i}
          style={{
            left: `${(r.x / W) * 100}%`,
            top: `${(r.y / H) * 100}%`,
            width: `${(r.w / W) * 100}%`,
            height: `${(r.h / H) * 100}%`,
          }}
        />
      ))}
    </span>
  );
}

/* --- the editor ---------------------------------------------------------------- */

export default function Editor({
  bodyStyleId,
  boxImageUrl,
  logoZone,
  onSave,
  onAssets,
  initialDesign,
  initialAssets,
}: {
  bodyStyleId: string;
  boxImageUrl: string | null;
  logoZone: LogoZone | null;
  onSave?: (
    design: DesignDocument,
    preview: string,
    assets: DesignAssets,
  ) => void;
  // Fires when the BACKGROUND print upload finishes (the flow advances
  // immediately on save; the print file catches up). docJson lets the
  // receiver make sure the assets still match the current design.
  onAssets?: (assets: DesignAssets, docJson: string) => void;
  // Re-editing an existing design ("Edit graphic") — photos and text intact.
  initialDesign?: DesignDocument | null;
  // The assets already uploaded for initialDesign — an unchanged re-save
  // reuses them instead of re-exporting and re-uploading. Partial: designs
  // saved before the sha256 stamp have no hash and must NOT reuse.
  initialAssets?: Partial<DesignAssets> | null;
}) {
  // v1 freeform documents can't open here — they start fresh at the picker
  // (the flow keeps their old flattened art unless they save a new design).
  const editable =
    initialDesign && isCurrentDesign(initialDesign) ? initialDesign : null;
  const [doc, setDoc] = useState<DesignDocument>(
    () => editable ?? newDesign(bodyStyleId),
  );
  // Fresh designs start at the layout picker; edits skip straight in.
  const [picked, setPicked] = useState(!!editable);
  const [selectedSlot, setSelectedSlot] = useState<number | null>(null);
  const [editingText, setEditingText] = useState<number | null>(null);
  const [menuFor, setMenuFor] = useState<number | null>(null);
  const [viewMode, setViewMode] = useState<"flat" | "boxed">("boxed");
  const savedDocJson = useRef(editable ? JSON.stringify(editable) : null);
  const userToggledView = useRef(false);
  const designRef = useRef<Konva.Group>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const uploadTarget = useRef<number | null>(null);

  const { img: boxImg, failed: boxFailed } = useImg(boxImageUrl);
  const px = artboardPx(doc.artboard);
  const rects = useMemo(
    () => templateSlotRects(doc.template, doc.artboard),
    [doc.template, doc.artboard],
  );

  // Responsive stage width; phones default to flat editing (the boxed print
  // zone is too small to work in by thumb).
  const wrapRef = useRef<HTMLDivElement>(null);
  const [stageW, setStageW] = useState(MAX_STAGE_WIDTH);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = () => {
      const w = Math.max(280, Math.min(MAX_STAGE_WIDTH, el.clientWidth));
      setStageW(w);
      if (!userToggledView.current && w < NARROW) setViewMode("flat");
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
    // re-run when the loading gate lifts and the wrapper first renders
  }, [boxImg, boxFailed, picked]);

  const canBox = !!(boxImg && logoZone);
  const boxed = viewMode === "boxed" && canBox;

  const geo = useMemo(() => {
    if (boxed && boxImg && logoZone) {
      const stageH = Math.round((stageW * boxImg.height) / boxImg.width);
      const zone = {
        x: logoZone.x * stageW,
        y: logoZone.y * stageH,
        w: logoZone.w * stageW,
        h: logoZone.h * stageH,
      };
      const s = Math.min(zone.w / px.width, zone.h / px.height);
      return {
        stageH,
        scale: s,
        gx: zone.x + (zone.w - px.width * s) / 2,
        gy: zone.y + (zone.h - px.height * s) / 2,
      };
    }
    const s = stageW / px.width;
    return {
      stageH: Math.round(px.height * s),
      scale: s,
      gx: 0,
      gy: 0,
    };
  }, [boxed, boxImg, logoZone, px.width, px.height, stageW]);

  const fontFamily = useMemo(() => {
    const v = getComputedStyle(document.body)
      .getPropertyValue("--font-poppins")
      .trim();
    return v || "sans-serif";
  }, []);

  // Text auto-fit measures against whatever font is loaded NOW; if Poppins
  // isn't ready yet it measures the fallback and the size (baked into the
  // exported print art) can clip. Flip this once fonts finish loading so the
  // fit — and the export — recompute against the real metrics.
  const [fontsReady, setFontsReady] = useState(false);
  useEffect(() => {
    let live = true;
    const done = () => live && setFontsReady(true);
    if (typeof document !== "undefined" && document.fonts?.ready) {
      document.fonts.ready.then(done);
    } else {
      done();
    }
    return () => {
      live = false;
    };
  }, []);

  // Slot index whose photo is currently being ingested (shows a spinner).
  const [uploadingSlot, setUploadingSlot] = useState<number | null>(null);

  // Wait for the box photo — no flat-artboard flash. If it FAILS, proceed in
  // flat mode rather than gating forever. (All hooks live ABOVE this gate.)
  if (boxImageUrl && !boxImg && !boxFailed) {
    return <p className="note">Setting up your box…</p>;
  }

  const setSlot = (i: number, content: SlotContent) =>
    setDoc((d) => ({
      ...d,
      slots: d.slots.map((s, j) => (j === i ? content : s)),
    }));

  const patchSlot = (i: number, p: Partial<PhotoSlot> & Partial<TextSlot>) =>
    setDoc((d) => ({
      ...d,
      slots: d.slots.map((s, j) => {
        if (j !== i || s === null) return s;
        return { ...s, ...p } as SlotContent;
      }),
    }));

  const clearSlot = (i: number) => {
    setSlot(i, null);
    if (selectedSlot === i) setSelectedSlot(null);
    if (editingText === i) setEditingText(null);
  };

  const pickTemplate = (id: TemplateId) => {
    setDoc(newDesign(bodyStyleId, id));
    setPicked(true);
    setSelectedSlot(null);
    setEditingText(null);
    setMenuFor(null);
  };

  const switchTemplate = (id: TemplateId) => {
    if (id === doc.template) return;
    const nextRects = templateSlotRects(id, doc.artboard);
    const dropped = doc.slots.slice(nextRects.length).filter(Boolean).length;
    if (
      dropped > 0 &&
      !confirm(
        "This layout has fewer boxes — the extra content will be removed. Switch anyway?",
      )
    ) {
      return;
    }
    setDoc((d) => ({
      ...d,
      template: id,
      slots: nextRects.map((_, i) => d.slots[i] ?? null),
    }));
    setSelectedSlot(null);
    setEditingText(null);
    setMenuFor(null);
  };

  const requestPhoto = (i: number) => {
    uploadTarget.current = i;
    setMenuFor(null);
    fileRef.current?.click();
  };

  const onUpload = async (file: File) => {
    const i = uploadTarget.current;
    if (i === null) return;
    if (file.size > MAX_UPLOAD_BYTES) {
      alert(
        "That file is unusually huge — export it as a normal JPG or PNG and try again.",
      );
      return;
    }
    // Show "Adding your photo…" and let it PAINT before ingestPhoto's encode
    // (which runs on the main thread and can freeze the UI for a second or
    // two on a big phone photo — otherwise it just looks broken).
    setUploadingSlot(i);
    await new Promise((r) => setTimeout(r, 40));
    try {
      // ingestPhoto never fails on size — it compresses to fit. Its output
      // dims ARE the encoded image's dims (no second decode needed).
      const photo = await ingestPhoto(file);
      setSlot(i, {
        kind: "photo",
        src: photo.src,
        natW: photo.w,
        natH: photo.h,
        offset: 0.5,
      });
      setSelectedSlot(i);
    } catch {
      alert("That image couldn't be read — try a JPG or PNG.");
    } finally {
      setUploadingSlot(null);
    }
  };

  const addTextTo = (i: number) => {
    setSlot(i, { kind: "text", text: "", fill: TEXT_SWATCHES[0] });
    setMenuFor(null);
    setSelectedSlot(i);
    setEditingText(i); // straight into typing
  };

  const doneEditingText = () => {
    if (editingText !== null) {
      const s = doc.slots[editingText];
      // an abandoned empty text box goes back to being an empty slot
      if (s?.kind === "text" && s.text.trim() === "") clearSlot(editingText);
    }
    setEditingText(null);
  };

  // Synchronous on purpose: requestAnimationFrame never fires in background
  // tabs, and Konva's toDataURL doesn't need a paint.
  const exportPng = (targetWidthPx: number): string | null => {
    const g = designRef.current;
    if (!g) return null;
    // Crop to the ARTBOARD region (stage coords), never Konva's default
    // content bounding box — see the shrunk-image bug (2026-07-05).
    return g.toDataURL({
      x: geo.gx,
      y: geo.gy,
      width: px.width * geo.scale,
      height: px.height * geo.scale,
      pixelRatio: targetWidthPx / (px.width * geo.scale),
    });
  };

  const filledCount = doc.slots.filter(Boolean).length;

  const useThisDesign = () => {
    if (filledCount === 0) return;
    const emptyCount = doc.slots.length - filledCount;
    if (
      emptyCount > 0 &&
      !confirm(
        `${emptyCount === 1 ? "One box is" : `${emptyCount} boxes are`} still empty and will print blank — continue anyway?`,
      )
    ) {
      return;
    }
    setSelectedSlot(null);
    setEditingText(null);
    setMenuFor(null);
    const preview = exportPng(480);
    if (!preview || !onSave) return;
    const docJson = JSON.stringify(doc);

    // Nothing changed since the last save → the uploaded print file is
    // still exactly right; reuse it instead of re-exporting/re-uploading.
    // The reuse also requires the stored hash: designs saved before the
    // sha256 stamp existed must fall through to a fresh export + upload —
    // that re-save is how a pre-stamp cart line becomes checkoutable.
    if (
      docJson === savedDocJson.current &&
      initialAssets?.art &&
      initialAssets?.artSha256
    ) {
      onSave(doc, preview, {
        art: initialAssets.art,
        designUrl: initialAssets.designUrl ?? null,
        artSha256: initialAssets.artSha256,
      });
      return;
    }

    // Advance the flow IMMEDIATELY — the confirm screen only needs the
    // small preview. The print-resolution export + Blob upload run in the
    // background (closures outlive this component) and patch the flow via
    // onAssets when done. Upload failure → checkout's PENDING fallback.
    const g = designRef.current;
    const full = g
      ? g.toCanvas({
          x: geo.gx,
          y: geo.gy,
          width: px.width * geo.scale,
          height: px.height * geo.scale,
          pixelRatio: px.width / (px.width * geo.scale),
        })
      : null;
    onSave(doc, preview, { art: null, designUrl: null, artSha256: null });

    if (!full) return;
    const hasPhoto = doc.slots.some((s) => s?.kind === "photo");
    const format = hasPhoto ? "image/jpeg" : "image/png";
    void (async () => {
      try {
        // Exactly artboard-sized (2400×1170) with real 300-DPI metadata, so
        // the file measures 8"×3.9" in print tools instead of 72-DPI-huge.
        const printBlob = await toPrintBlob(
          full,
          px.width,
          px.height,
          doc.artboard.dpi,
          format,
        );
        // Hash the exact bytes being uploaded (post-DPI-stamp) — Paper
        // re-hashes what it downloads from the blob and refuses a mismatch.
        // A digest failure lands in the catch below: art stays null and
        // checkout refuses the line, same as an upload failure.
        const digest = await crypto.subtle.digest(
          "SHA-256",
          await printBlob.arrayBuffer(),
        );
        const artSha256 = Array.from(new Uint8Array(digest))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
        const { upload } = await import("@vercel/blob/client");
        const id =
          typeof crypto !== "undefined" && crypto.randomUUID
            ? crypto.randomUUID()
            : `${doc.bodyStyleId}-${doc.slots.length}-${preview.length}`;
        const [put, sidecar] = await Promise.all([
          upload(
            `builder-art/${id}/front.${hasPhoto ? "jpg" : "png"}`,
            printBlob,
            {
              access: "public",
              handleUploadUrl: "/api/art/upload",
              contentType: format,
            },
          ),
          upload(
            `builder-art/${id}/design.json`,
            new Blob([docJson], { type: "application/json" }),
            {
              access: "public",
              handleUploadUrl: "/api/art/upload",
              contentType: "application/json",
            },
          ),
        ]);
        onAssets?.(
          { art: put.url, designUrl: sidecar.url, artSha256 },
          docJson,
        );
      } catch {
        // art stays null — checkout refuses the line until a re-save
        // succeeds; the design itself is safe in the document
      }
    })();
  };

  /* --- layout picker (fresh designs) ------------------------------------- */
  if (!picked) {
    return (
      <div className="editor-v4">
        <p className="tmpl-heading">How should your label split?</p>
        <div className="tmpl-grid">
          {TEMPLATES.map((t) => (
            <button
              key={t.id}
              className="tmpl-card"
              onClick={() => pickTemplate(t.id)}
            >
              <TmplMini id={t.id} />
              <span className="tmpl-label">{t.label}</span>
            </button>
          ))}
        </div>
        <p className="note">
          Each box holds a photo or some text — you can switch layouts later.
        </p>
      </div>
    );
  }

  /* --- the editor ---------------------------------------------------------- */
  const selected = selectedSlot !== null ? (doc.slots[selectedSlot] ?? null) : null;
  const editingSlot =
    editingText !== null && doc.slots[editingText]?.kind === "text"
      ? (doc.slots[editingText] as TextSlot)
      : null;

  const slotCss = (r: SlotRect): CSSProperties => ({
    left: geo.gx + r.x * geo.scale,
    top: geo.gy + r.y * geo.scale,
    width: r.w * geo.scale,
    height: r.h * geo.scale,
  });

  const selectedFit =
    selected?.kind === "photo" && selectedSlot !== null
      ? coverFit(rects[selectedSlot], selected.natW, selected.natH, selected.offset)
      : null;

  // Print sharpness: cover-fitting a photo into its slot upscales it by
  // max(slot/natural); at the 300-DPI print that's an effective DPI of
  // dpi / scale. Below ~150 DPI it can look soft, so flag it — never block
  // (the customer can always use their photo).
  const DPI_WARN = 150;
  const lowResSlots = rects.map((r, i) => {
    const c = doc.slots[i];
    if (!c || c.kind !== "photo") return false;
    const scale = Math.max(r.w / Math.max(1, c.natW), r.h / Math.max(1, c.natH));
    return doc.artboard.dpi / scale < DPI_WARN;
  });
  const anyLowRes = lowResSlots.some(Boolean);

  return (
    <div className="editor-v4">
      <div className="editor-toolbar">
        <div className="tmpl-switch" role="group" aria-label="Layout">
          {TEMPLATES.map((t) => (
            <button
              key={t.id}
              className={"tmpl-switch-btn" + (doc.template === t.id ? " on" : "")}
              title={t.label}
              aria-label={t.label}
              onClick={() => switchTemplate(t.id)}
            >
              <TmplMini id={t.id} />
            </button>
          ))}
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onUpload(f);
            e.target.value = "";
          }}
        />
        {canBox && (
          <div className="seg">
            <button
              className={"seg-btn" + (!boxed ? " on" : "")}
              onClick={() => {
                userToggledView.current = true;
                setViewMode("flat");
              }}
            >
              Flat
            </button>
            <button
              className={"seg-btn" + (boxed ? " on" : "")}
              onClick={() => {
                userToggledView.current = true;
                setViewMode("boxed");
              }}
            >
              On the box
            </button>
          </div>
        )}
      </div>

      <div ref={wrapRef} className="editor-canvas-col">
        <div className="artboard-wrap">
          <Stage
            width={stageW}
            height={geo.stageH}
            onMouseDown={(e) => {
              if (e.target === e.target.getStage()) setSelectedSlot(null);
            }}
            onTouchStart={(e) => {
              if (e.target === e.target.getStage()) setSelectedSlot(null);
            }}
          >
            {boxed && (
              <Layer listening={false}>
                <KonvaImage
                  image={boxImg ?? undefined}
                  width={stageW}
                  height={geo.stageH}
                />
              </Layer>
            )}
            <Layer>
              <Group
                ref={designRef}
                x={geo.gx}
                y={geo.gy}
                scaleX={geo.scale}
                scaleY={geo.scale}
                clip={{ x: 0, y: 0, width: px.width, height: px.height }}
              >
                <Rect
                  width={px.width}
                  height={px.height}
                  fill={doc.background}
                  onMouseDown={() => setSelectedSlot(null)}
                  onTap={() => setSelectedSlot(null)}
                />
                {rects.map((r, i) => {
                  const c = doc.slots[i];
                  if (!c) return null;
                  return c.kind === "photo" ? (
                    <PhotoSlotEl
                      key={i}
                      slot={c}
                      rect={r}
                      gx={geo.gx}
                      gy={geo.gy}
                      scale={geo.scale}
                      onSelect={() => setSelectedSlot(i)}
                      onOffset={(offset) => patchSlot(i, { offset })}
                    />
                  ) : (
                    <TextSlotEl
                      key={i}
                      slot={c}
                      rect={r}
                      fontFamily={fontFamily}
                      fontsReady={fontsReady}
                      onSelect={() => setSelectedSlot(i)}
                      onEdit={() => {
                        setSelectedSlot(i);
                        setEditingText(i);
                      }}
                    />
                  );
                })}
              </Group>
              {/* artboard outline + selected-slot highlight (not exported) */}
              <Group
                x={geo.gx}
                y={geo.gy}
                scaleX={geo.scale}
                scaleY={geo.scale}
                listening={false}
              >
                <Rect
                  width={px.width}
                  height={px.height}
                  stroke="#627AE3"
                  strokeWidth={(boxed ? 2 : 1.5) / geo.scale}
                />
                {selectedSlot !== null && (
                  <Rect
                    x={rects[selectedSlot].x}
                    y={rects[selectedSlot].y}
                    width={rects[selectedSlot].w}
                    height={rects[selectedSlot].h}
                    stroke="#627AE3"
                    strokeWidth={3 / geo.scale}
                  />
                )}
              </Group>
            </Layer>
          </Stage>

          {/* DOM overlays: ＋ on empty boxes, action menu, per-box controls */}
          {rects.map((r, i) => {
            const c = doc.slots[i];
            if (c) return null;
            return menuFor === i ? (
              <div key={i} className="slot-menu" style={slotCss(r)}>
                <button className="btn" onClick={() => requestPhoto(i)}>
                  📷 A photo
                </button>
                <button className="btn" onClick={() => addTextTo(i)}>
                  ✏️ Some text
                </button>
              </div>
            ) : (
              <button
                key={i}
                className="slot-add"
                style={slotCss(r)}
                onClick={() => setMenuFor(i)}
              >
                <span className="slot-plus">＋</span>
                <span className="slot-hint">photo or text</span>
              </button>
            );
          })}
          {rects.map((r, i) => {
            const c = doc.slots[i];
            if (!c) return null;
            return (
              <div
                key={`chips${i}`}
                className="slot-chips"
                style={{
                  left: geo.gx + (r.x + r.w) * geo.scale - 6,
                  top: geo.gy + r.y * geo.scale + 6,
                }}
              >
                {c.kind === "photo" ? (
                  <button
                    title="Replace photo"
                    aria-label="Replace photo"
                    onClick={() => requestPhoto(i)}
                  >
                    ↺
                  </button>
                ) : (
                  <button
                    title="Edit text"
                    aria-label="Edit text"
                    onClick={() => {
                      setSelectedSlot(i);
                      setEditingText(i);
                    }}
                  >
                    ✏️
                  </button>
                )}
                <button
                  title="Remove"
                  aria-label="Remove this box"
                  onClick={() => clearSlot(i)}
                >
                  ✕
                </button>
              </div>
            );
          })}
          {rects.map((r, i) =>
            lowResSlots[i] ? (
              <div
                key={`warn${i}`}
                className="slot-warn"
                style={{
                  left: geo.gx + r.x * geo.scale + 6,
                  top: geo.gy + (r.y + r.h) * geo.scale - 26,
                }}
                title="This photo may look blurry printed this large"
              >
                ⚠ low-res
              </div>
            ) : null,
          )}
          {uploadingSlot !== null && rects[uploadingSlot] && (
            <div
              className="slot-uploading"
              style={slotCss(rects[uploadingSlot])}
              role="status"
            >
              <span className="mini-spinner" aria-hidden />
              Adding your photo…
            </div>
          )}
        </div>

        <p className="note">
          {selectedFit && selectedFit.axis !== "none"
            ? `Drag your photo ${selectedFit.axis === "x" ? "left or right" : "up or down"} to frame it.`
            : selected?.kind === "text"
              ? "Double-tap the text to edit it — it sizes itself to fit."
              : boxed
                ? "This is the printed area on your box — tap a ＋ to fill a box."
                : "Your label, edge to edge — tap a ＋ to fill a box."}
        </p>
        {anyLowRes && (
          <p className="note dpi-warn">
            ⚠ A photo you added is lower-resolution than ideal for this size and
            may look a little soft in print. You can still use it — or tap ↺ to
            swap in a sharper one.
          </p>
        )}
      </div>

      {selected && selectedSlot !== null && (
        <div className="context-bar">
          {selected.kind === "text" && (
            <>
              <button
                className="btn mini"
                onClick={() => setEditingText(selectedSlot)}
              >
                Edit text
              </button>
              {TEXT_SWATCHES.map((c) => (
                <button
                  key={c}
                  className={
                    "swatch" + (selected.fill === c ? " active" : "")
                  }
                  style={{ background: c }}
                  onClick={() => patchSlot(selectedSlot, { fill: c })}
                  title={c}
                />
              ))}
            </>
          )}
          {selected.kind === "photo" && (
            <button
              className="btn mini"
              onClick={() => requestPhoto(selectedSlot)}
            >
              ↺ Replace photo
            </button>
          )}
          <button
            className="btn danger"
            onClick={() => clearSlot(selectedSlot)}
            title="Remove"
          >
            ✕
          </button>
        </div>
      )}

      <div className="editor-cta">
        {onSave && (
          <button
            className="btn primary block"
            disabled={filledCount === 0}
            title={filledCount === 0 ? "Fill a box first" : undefined}
            onClick={useThisDesign}
          >
            Use this design →
          </button>
        )}
      </div>

      {/* text edits in a fixed bottom sheet (16px input, no iOS zoom); the
          canvas text above is the live preview of what's typed */}
      {editingSlot && editingText !== null && (
        <div className="edit-sheet">
          <textarea
            autoFocus
            rows={2}
            placeholder="Type your message…"
            value={editingSlot.text}
            onChange={(e) => patchSlot(editingText, { text: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                doneEditingText();
              }
            }}
          />
          <button className="btn primary" onClick={doneEditingText}>
            Done
          </button>
        </div>
      )}
    </div>
  );
}
