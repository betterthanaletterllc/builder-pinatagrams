"use client";

import {
  useCallback,
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
  designKey,
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
import {
  designFontFamily,
  fitFontSize,
  TEXT_LINE_HEIGHT,
  textBox,
  textCapacity,
  textFits,
} from "@/lib/design-render";
import { saveDesignArt } from "@/lib/design-upload";
import {
  beginEditorSession,
  clearEditorAutosave,
  loadEditorAutosave,
  saveEditorAutosave,
  type EditorAutosave,
} from "@/lib/editor-autosave";
import { track } from "@/lib/analytics";

/**
 * Template editor (v2 — replaced the freeform canvas). The label divides
 * into a fixed layout of boxes; each box holds ONE photo (cover-filled,
 * dragged — or slid with the framing slider — along its overflow axis) or
 * ONE text block (centered, auto-fit). Constraints over freedom: every
 * design fills the whole 8"×3.9" print area and looks intentional.
 *
 * Two view modes survive from v1:
 *  - flat: the artboard fills the width — the default everywhere (editing
 *    at label size is fiddly even with a mouse)
 *  - boxed: the artboard composited on the box photo at the hub's logoZone,
 *    the "On the box" preview toggle
 * The document stays in artboard pixels either way; export renders ONLY the
 * design group, cropped to the artboard region.
 *
 * No native dialogs: confirm()/alert() can silently no-op in Instagram's
 * in-app browser, so every question is asked inline.
 */

const MAX_STAGE_WIDTH = 760;
// Spoken names for the text-color swatches (lib/design-document).
const SWATCH_NAMES: Record<string, string> = {
  "#180D38": "Navy",
  "#627AE3": "Periwinkle",
  "#55A871": "Green",
  "#EB7C57": "Coral",
};
// Removing a box can be undone this long.
const UNDO_MS = 6000;
// Autosave debounce while editing.
const AUTOSAVE_MS = 800;
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
  // iOS caps the canvas memory a page may hold in total, and a detached
  // canvas isn't freed promptly: release it now, or a few big photos later
  // every encode fails as "data:,".
  canvas.width = canvas.height = 0;
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

const clamp = (v: number, min: number, max: number) =>
  Math.min(max, Math.max(min, v));

/**
 * Where a new photo starts inside its box. Wide photos center; TALL photos
 * (the ones that overflow vertically — most phone portraits) center on the
 * upper third, where faces usually are, instead of cropping to a midriff.
 */
function initialPhotoOffset(rect: SlotRect, natW: number, natH: number): number {
  const fit = coverFit(rect, natW, natH, 0.5);
  if (fit.axis !== "y") return 0.5;
  return clamp((fit.height / 3 - rect.h / 2) / fit.overY, 0, 1);
}

/** "a few minutes ago" / "yesterday" — for the Continue-your-design card. */
function sinceLabel(ts: number): string {
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 60) return "a few minutes ago";
  const days = Math.floor(mins / 1440);
  if (days < 1) return "earlier today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

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
  // Same box + fit the print render uses (lib/design-render) — the screen
  // and the printed file can't disagree about where the words sit.
  const { x, y, w, h } = textBox(rect);
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
        x={x}
        y={y}
        width={w}
        height={h}
        text={display}
        fontSize={fontSize}
        fontFamily={fontFamily}
        fill={slot.fill}
        opacity={empty ? 0.35 : 1}
        align="center"
        verticalAlign="middle"
        lineHeight={TEXT_LINE_HEIGHT}
        // Touch: ONE tap opens the text for editing (a double-tap is a
        // hidden gesture on a phone). Mouse: click selects, double-click
        // edits — Konva only fires `tap` for touch, so the two never mix.
        onMouseDown={onSelect}
        onTap={onEdit}
        onDblClick={onEdit}
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
  onDirtyChange,
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
  // immediately on save; the print file catches up) — including after a
  // Retry made from outside the editor (lib/design-upload owns the job).
  // docJson lets the receiver make sure the assets still match the design.
  onAssets?: (assets: DesignAssets, docJson: string) => void;
  // True while leaving would lose work (a fresh design with content, or
  // unsaved changes to an existing one) — the flow asks before discarding.
  onDirtyChange?: (dirty: boolean) => void;
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
  // Flat is where editing happens (phones AND desktop); "On the box" is the
  // preview toggle.
  const [viewMode, setViewMode] = useState<"flat" | "boxed">("flat");
  const savedDocJson = useRef(editable ? JSON.stringify(editable) : null);
  const designRef = useRef<Konva.Group>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const uploadTarget = useRef<number | null>(null);

  // Inline stand-ins for the old native dialogs.
  const [pendingTemplate, setPendingTemplate] = useState<TemplateId | null>(
    null,
  );
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // "Removed — Undo": the box's content and the layout it belonged to.
  const [undo, setUndo] = useState<{
    slot: number;
    content: SlotContent;
    template: TemplateId;
  } | null>(null);
  const undoTimer = useRef<number | undefined>(undefined);
  // The text sheet refused a keystroke (the words would print too small).
  const [textFull, setTextFull] = useState(false);
  // An autosaved design from an earlier visit, offered on entry.
  const [resume, setResume] = useState<EditorAutosave | null>(null);

  const { img: boxImg, failed: boxFailed } = useImg(boxImageUrl);
  const px = artboardPx(doc.artboard);
  const rects = useMemo(
    () => templateSlotRects(doc.template, doc.artboard),
    [doc.template, doc.artboard],
  );

  // Responsive stage width. The 2px is the .artboard-wrap border: a stage as
  // wide as the column overflowed it by exactly that and drew a scrollbar.
  const wrapRef = useRef<HTMLDivElement>(null);
  const [stageW, setStageW] = useState(MAX_STAGE_WIDTH - 2);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = () => {
      setStageW(Math.max(280, Math.min(MAX_STAGE_WIDTH, el.clientWidth) - 2));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
    // re-run when the loading gate lifts and the wrapper first renders
  }, [boxImg, boxFailed, picked]);

  /* --- autosave -------------------------------------------------------------
   * Debounced while editing, flushed when the tab hides or the editor
   * unmounts; cleared once the design is used. The session token (taken on
   * mount) lets the flow's "Discard" end this session so the unmount flush
   * can't bring the discarded design back. */
  const mode: "new" | "edit" = editable ? "edit" : "new";
  const baseKey = useMemo(
    () => (editable ? designKey(editable) : null),
    // the design this edit started from — fixed for the editor's lifetime
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const initialDoc = useRef(doc);
  const hasContent = doc.slots.some(Boolean);
  const dirty =
    picked && (editable ? doc !== initialDoc.current : hasContent);
  const sessionToken = useRef(0);
  const finished = useRef(false);
  const autosaveTimer = useRef<number | undefined>(undefined);
  const latest = useRef({ doc, dirty });
  useEffect(() => {
    latest.current = { doc, dirty };
  });

  const flushAutosave = useCallback(() => {
    window.clearTimeout(autosaveTimer.current);
    if (finished.current) return;
    const { doc: d, dirty: isDirty } = latest.current;
    if (isDirty) {
      void saveEditorAutosave(
        { doc: d, mode, baseKey, savedAt: Date.now() },
        sessionToken.current,
      );
    }
  }, [mode, baseKey]);

  useEffect(() => {
    sessionToken.current = beginEditorSession();
    track("editor_opened", { mode });
    // Offer an earlier unsaved design: a fresh one on a fresh entry, or
    // unsaved changes to THIS design when re-editing it.
    let live = true;
    void loadEditorAutosave().then((a) => {
      if (!live || !a) return;
      if (a.mode === "new" && !editable && a.doc.slots.some(Boolean)) {
        setResume(a);
      } else if (a.mode === "edit" && editable && a.baseKey === baseKey) {
        setResume(a);
      }
    });
    const onHide = () => {
      if (document.visibilityState === "hidden") flushAutosave();
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", flushAutosave);
    return () => {
      live = false;
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", flushAutosave);
      flushAutosave();
    };
    // mount/unmount only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!picked || finished.current) return;
    window.clearTimeout(autosaveTimer.current);
    autosaveTimer.current = window.setTimeout(() => {
      if (finished.current) return;
      if (dirty) {
        void saveEditorAutosave(
          { doc, mode, baseKey, savedAt: Date.now() },
          sessionToken.current,
        );
      } else if (!editable) {
        // a fresh design emptied back out — nothing worth resuming
        void clearEditorAutosave();
      }
    }, AUTOSAVE_MS);
    return () => window.clearTimeout(autosaveTimer.current);
    // doc identity changes on every edit
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, picked]);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(
    () => () => onDirtyChange?.(false),
    // unmount only
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  useEffect(() => () => window.clearTimeout(undoTimer.current), []);

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

  const fontFamily = useMemo(() => designFontFamily(), []);

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

  // Roughly how much text the box being edited holds at the smallest
  // legible print size — drives the sheet's character counter.
  const editingRect = editingText !== null ? rects[editingText] : undefined;
  const textRoom = useMemo(
    () => (editingRect ? textCapacity(editingRect, fontFamily) : 0),
    [editingRect, fontFamily, fontsReady],
  );
  useEffect(() => setTextFull(false), [editingText]);

  // Touch devices get "tap" wording; mice get "double-click".
  const coarsePointer = useMemo(
    () =>
      typeof window !== "undefined" &&
      !!window.matchMedia?.("(pointer: coarse)").matches,
    [],
  );

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

  // The shopper's ✕: clears the box and offers a few seconds of Undo.
  const removeSlot = (i: number) => {
    const content = doc.slots[i];
    if (!content) return;
    clearSlot(i);
    setUndo({ slot: i, content, template: doc.template });
    window.clearTimeout(undoTimer.current);
    undoTimer.current = window.setTimeout(() => setUndo(null), UNDO_MS);
  };

  const undoRemove = () => {
    if (!undo) return;
    window.clearTimeout(undoTimer.current);
    // Only while the box is still empty in the same layout — never clobber
    // something added since.
    if (doc.template === undo.template && doc.slots[undo.slot] === null) {
      setSlot(undo.slot, undo.content);
      setSelectedSlot(undo.slot);
    }
    setUndo(null);
  };

  const pickTemplate = (id: TemplateId) => {
    setDoc(newDesign(bodyStyleId, id));
    setPicked(true);
    setSelectedSlot(null);
    setEditingText(null);
    setMenuFor(null);
    setResume(null); // starting fresh answers "Continue your design?"
    track("editor_template_chosen", { template: id });
  };

  const applyTemplate = (id: TemplateId) => {
    const nextRects = templateSlotRects(id, doc.artboard);
    setDoc((d) => ({
      ...d,
      template: id,
      slots: nextRects.map((_, i) => d.slots[i] ?? null),
    }));
    setPendingTemplate(null);
    setSelectedSlot(null);
    setEditingText(null);
    setMenuFor(null);
    setUndo(null);
    track("editor_template_chosen", { template: id, switched: true });
  };

  const switchTemplate = (id: TemplateId) => {
    if (id === doc.template) {
      setPendingTemplate(null);
      return;
    }
    const nextRects = templateSlotRects(id, doc.artboard);
    const dropped = doc.slots.slice(nextRects.length).filter(Boolean).length;
    // Fewer boxes would drop content — ask inline first.
    if (dropped > 0) setPendingTemplate(id);
    else applyTemplate(id);
  };

  const requestPhoto = (i: number) => {
    uploadTarget.current = i;
    setMenuFor(null);
    setNotice(null);
    fileRef.current?.click();
  };

  const onUpload = async (file: File) => {
    const i = uploadTarget.current;
    if (i === null) return;
    if (file.size > MAX_UPLOAD_BYTES) {
      setNotice(
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
      const replaced = doc.slots[i]?.kind === "photo";
      setSlot(i, {
        kind: "photo",
        src: photo.src,
        natW: photo.w,
        natH: photo.h,
        offset: initialPhotoOffset(rects[i], photo.w, photo.h),
      });
      setSelectedSlot(i);
      setNotice(null);
      track("photo_added", { replaced });
    } catch {
      setNotice("That image couldn't be read — try a JPG or PNG.");
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
  const emptyCount = doc.slots.length - filledCount;

  // Text-sheet input: refuse a keystroke/paste that would push the words
  // under the smallest legible print size (the counter says why).
  const typeText = (i: number, next: string) => {
    const cur = doc.slots[i];
    const grew = cur?.kind === "text" && next.length > cur.text.length;
    if (grew && !textFits(next, rects[i], fontFamily)) {
      setTextFull(true);
      return;
    }
    setTextFull(false);
    patchSlot(i, { text: next });
  };

  const useThisDesign = () => {
    if (filledCount === 0) return;
    setSelectedSlot(null);
    setEditingText(null);
    setMenuFor(null);
    // A text box left empty (typing never started, or erased) goes back to
    // being an empty box — the canvas would otherwise export its "Your
    // text" placeholder into the print file.
    const cleaned = doc.slots.map((s) =>
      s?.kind === "text" && !s.text.trim() ? null : s,
    );
    if (cleaned.some((s, i) => s !== doc.slots[i])) {
      setDoc({ ...doc, slots: cleaned });
      if (cleaned.some(Boolean)) setConfirmEmpty(true);
      return;
    }
    // Empty boxes print blank — ask inline (confirmed via commitDesign).
    if (emptyCount > 0) {
      setConfirmEmpty(true);
      return;
    }
    commitDesign();
  };

  const commitDesign = () => {
    setConfirmEmpty(false);
    const preview = exportPng(480);
    if (!preview || !onSave) return;
    // The design leaves the editor now — its autosave has done its job.
    finished.current = true;
    window.clearTimeout(autosaveTimer.current);
    void clearEditorAutosave();
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
    // small preview. The print-resolution export happens NOW (it needs this
    // live stage) and hands off to lib/design-upload, which encodes, hashes
    // and uploads it outside this component: the job survives the unmount,
    // the flow shows its status, and Retry works from there. Add-to-cart
    // waits for it — a line never leaves without its print file.
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
    void saveDesignArt(doc, { canvas: full }).then((assets) =>
      onAssets?.(assets, docJson),
    );
  };

  const resumeDesign = () => {
    if (!resume) return;
    setDoc({ ...resume.doc, bodyStyleId });
    setPicked(true);
    setSelectedSlot(null);
    setEditingText(null);
    setMenuFor(null);
    setResume(null);
  };

  const dismissResume = () => {
    setResume(null);
    void clearEditorAutosave();
  };

  // "Continue your design?" — shown atop the picker (fresh) or the editor
  // (unsaved changes to this design).
  const resumeCard = resume ? (
    <div className="resume-card" role="region" aria-label="Unsaved design">
      <p className="resume-title">
        {resume.mode === "edit"
          ? "Continue your unsaved changes?"
          : "Continue your design?"}
      </p>
      <p className="note">
        {resume.mode === "edit" ? "You changed this design" : "You started one"}{" "}
        {sinceLabel(resume.savedAt)} (
        {(() => {
          const photos = resume.doc.slots.filter(
            (s) => s?.kind === "photo",
          ).length;
          const texts = resume.doc.slots.filter(
            (s) => s?.kind === "text",
          ).length;
          return [
            photos ? `${photos} photo${photos === 1 ? "" : "s"}` : null,
            texts ? `${texts} text box${texts === 1 ? "" : "es"}` : null,
          ]
            .filter(Boolean)
            .join(", ");
        })()}
        ) — pick up where you left off.
      </p>
      <div className="inline-actions">
        <button className="btn primary" onClick={resumeDesign}>
          Continue
        </button>
        <button className="btn" onClick={dismissResume}>
          {resume.mode === "edit" ? "Discard changes" : "Start fresh"}
        </button>
      </div>
    </div>
  ) : null;

  /* --- layout picker (fresh designs) ------------------------------------- */
  if (!picked) {
    return (
      <div className="editor-v4">
        {resumeCard}
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
  // A croppable photo is selected: it can be dragged, so the stage takes
  // over touch gestures (touch-action: none) — ONLY then, so a swipe over
  // the rest of the preview still scrolls the page.
  const framing = !!selectedFit && selectedFit.axis !== "none";

  // Print sharpness: cover-fitting a photo into its slot upscales it by
  // max(slot/natural); at the 300-DPI print that's an effective DPI of
  // dpi / scale. Flag it — never block (the customer can always use their
  // photo). Threshold 110, NOT 150: ingest's storage ladder floors big
  // photos at a 1280px long edge, which puts a portrait phone photo in a
  // full-width slot at ~120 effective DPI — fine at label size, and not
  // the customer's fault. 110 still catches genuinely small sources
  // (a 640×480 web grab ≈ 80 DPI).
  const DPI_WARN = 110;
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
              aria-pressed={!boxed}
              onClick={() => setViewMode("flat")}
            >
              Flat
            </button>
            <button
              className={"seg-btn" + (boxed ? " on" : "")}
              aria-pressed={boxed}
              onClick={() => setViewMode("boxed")}
            >
              On the box
            </button>
          </div>
        )}
      </div>

      {resumeCard}

      {pendingTemplate && (
        <div className="inline-confirm" role="group" aria-label="Switch layout?">
          <p>
            That layout has fewer boxes —{" "}
            {(() => {
              const n = doc.slots
                .slice(templateSlotRects(pendingTemplate, doc.artboard).length)
                .filter(Boolean).length;
              return n === 1 ? "one of your boxes" : `${n} of your boxes`;
            })()}{" "}
            will be removed.
          </p>
          <div className="inline-actions">
            <button
              className="btn primary"
              onClick={() => applyTemplate(pendingTemplate)}
            >
              Switch anyway
            </button>
            <button
              className="btn"
              autoFocus
              onClick={() => setPendingTemplate(null)}
            >
              Keep this layout
            </button>
          </div>
        </div>
      )}

      <div ref={wrapRef} className="editor-canvas-col">
        <div className="artboard-wrap">
          <Stage
            width={stageW}
            height={geo.stageH}
            style={framing ? { touchAction: "none" } : undefined}
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
                  onClick={() => removeSlot(i)}
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
          {framing
            ? `Drag your photo ${selectedFit!.axis === "x" ? "left or right" : "up or down"} — or use the slider below — to frame it.`
            : selected?.kind === "text"
              ? coarsePointer
                ? "Tap the text to edit it — it sizes itself to fit."
                : "Double-click the text to edit it — it sizes itself to fit."
              : boxed
                ? "This is the printed area on your box — tap a ＋ to fill a box."
                : "Your label, edge to edge — tap a ＋ to fill a box."}
        </p>
        {notice && (
          <div className="notice warn editor-notice" role="alert">
            <span>{notice}</span>
            <button className="link-btn" onClick={() => setNotice(null)}>
              OK
            </button>
          </div>
        )}
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
                  title={SWATCH_NAMES[c] ?? c}
                  aria-label={`Text color: ${SWATCH_NAMES[c] ?? c}`}
                  aria-pressed={selected.fill === c}
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
          {framing && selected.kind === "photo" && (
            // The single-pointer alternative to dragging (WCAG 2.5.7):
            // the same 0..1 offset the drag writes, as a plain slider.
            <label className="frame-slider">
              <span aria-hidden>
                {selectedFit!.axis === "x" ? "◀ Frame ▶" : "▲ Frame ▼"}
              </span>
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={Math.round(selected.offset * 100)}
                aria-label={
                  selectedFit!.axis === "x"
                    ? "Frame the photo, left to right"
                    : "Frame the photo, top to bottom"
                }
                onChange={(e) =>
                  patchSlot(selectedSlot, {
                    offset: clamp(Number(e.target.value) / 100, 0, 1),
                  })
                }
              />
            </label>
          )}
          <button
            className="btn danger"
            onClick={() => removeSlot(selectedSlot)}
            title="Remove"
            aria-label="Remove this box"
          >
            ✕
          </button>
        </div>
      )}

      <div className="editor-cta">
        {confirmEmpty && emptyCount > 0 && filledCount > 0 && (
          <div className="inline-confirm" role="group" aria-label="Empty boxes">
            <p>
              {emptyCount === 1 ? "One box is" : `${emptyCount} boxes are`}{" "}
              still empty and will print blank.
            </p>
            <div className="inline-actions">
              <button className="btn primary" onClick={commitDesign}>
                Use it anyway
              </button>
              <button
                className="btn"
                autoFocus
                onClick={() => setConfirmEmpty(false)}
              >
                Keep designing
              </button>
            </div>
          </div>
        )}
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

      {undo && (
        <div className="editor-toast" role="status">
          <span>Removed</span>
          <button className="link-btn" onClick={undoRemove}>
            Undo
          </button>
        </div>
      )}

      {/* text edits in a fixed bottom sheet (16px input, no iOS zoom); the
          canvas text above is the live preview of what's typed */}
      {editingSlot && editingText !== null && (
        <div className="edit-sheet">
          <div className="edit-sheet-field">
            <textarea
              autoFocus
              rows={2}
              placeholder="Type the words for the front"
              aria-label="Words for the front of the box"
              aria-describedby="edit-sheet-count"
              value={editingSlot.text}
              onChange={(e) => typeText(editingText, e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  doneEditingText();
                }
              }}
            />
            {/* The count is read on focus (describedby); only "full" is
                announced — not every keystroke. */}
            <span
              id="edit-sheet-count"
              className={"edit-count" + (textFull ? " full" : "")}
            >
              {`${editingSlot.text.length}/${Math.max(textRoom, editingSlot.text.length)} characters`}
            </span>
            <span className="edit-count full" role="status">
              {textFull ? "That's all that fits in this box" : ""}
            </span>
          </div>
          <button className="btn primary" onClick={doneEditingText}>
            Done
          </button>
        </div>
      )}
    </div>
  );
}
