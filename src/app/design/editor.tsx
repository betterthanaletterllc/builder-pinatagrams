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
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

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
 * Downscale + recompress an upload before it becomes a data URL. Raw photos
 * ride inside the design document all the way to /api/checkout, and Vercel
 * caps request bodies at ~4.5 MB — a phone photo embedded as base64 would
 * make the cart permanently un-checkoutable. 1600px JPEG keeps well clear
 * while still exceeding what the print zone needs from a photo layer.
 */
async function downscaleToDataUrl(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new window.Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("undecodable"));
      i.src = url;
    });
    const MAX = 1600;
    const scale = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no-2d-context");
    ctx.drawImage(img, 0, 0, w, h);
    // JPEG unless the image likely has transparency (png keeps alpha).
    const wantsAlpha = file.type === "image/png" || file.type === "image/webp";
    return wantsAlpha
      ? canvas.toDataURL("image/png")
      : canvas.toDataURL("image/jpeg", 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Largest font size (px) whose wrapped height fits the box. */
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
  while (size > 30 && probe.height() > h) {
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
  onSelect,
  onEdit,
}: {
  slot: TextSlot;
  rect: SlotRect;
  fontFamily: string;
  onSelect: () => void;
  onEdit: () => void;
}) {
  const pad = Math.round(Math.min(rect.w, rect.h) * 0.08);
  const w = rect.w - pad * 2;
  const h = rect.h - pad * 2;
  const empty = slot.text.trim() === "";
  const display = empty ? "Your text" : slot.text;
  const fontSize = useMemo(
    () => fitFontSize(display, w, h, fontFamily),
    [display, w, h, fontFamily],
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
    assets: { art: string | null; designUrl: string | null },
  ) => void;
  // Fires when the BACKGROUND print upload finishes (the flow advances
  // immediately on save; the print file catches up). docJson lets the
  // receiver make sure the assets still match the current design.
  onAssets?: (
    assets: { art: string | null; designUrl: string | null },
    docJson: string,
  ) => void;
  // Re-editing an existing design ("Edit graphic") — photos and text intact.
  initialDesign?: DesignDocument | null;
  // The assets already uploaded for initialDesign — an unchanged re-save
  // reuses them instead of re-exporting and re-uploading.
  initialAssets?: { art: string | null; designUrl: string | null } | null;
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
      alert("Please pick an image under 8 MB.");
      return;
    }
    try {
      const src = await downscaleToDataUrl(file);
      const probe = new window.Image();
      probe.onload = () => {
        setSlot(i, {
          kind: "photo",
          src,
          natW: probe.naturalWidth,
          natH: probe.naturalHeight,
          offset: 0.5,
        });
        setSelectedSlot(i);
      };
      probe.onerror = () =>
        alert("That image couldn't be read — try a JPG or PNG.");
      probe.src = src;
    } catch {
      alert("That image couldn't be read — try a JPG or PNG.");
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
    if (docJson === savedDocJson.current && initialAssets?.art) {
      onSave(doc, preview, {
        art: initialAssets.art,
        designUrl: initialAssets.designUrl ?? null,
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
    onSave(doc, preview, { art: null, designUrl: null });

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
        onAssets?.({ art: put.url, designUrl: sidecar.url }, docJson);
      } catch {
        // stay on the PENDING fallback — the design itself is safe
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
                  <button title="Replace photo" onClick={() => requestPhoto(i)}>
                    ↺
                  </button>
                ) : (
                  <button
                    title="Edit text"
                    onClick={() => {
                      setSelectedSlot(i);
                      setEditingText(i);
                    }}
                  >
                    ✏️
                  </button>
                )}
                <button title="Remove" onClick={() => clearSlot(i)}>
                  ✕
                </button>
              </div>
            );
          })}
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
