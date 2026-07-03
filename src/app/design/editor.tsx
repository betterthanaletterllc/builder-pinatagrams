"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Group,
  Image as KonvaImage,
  Layer,
  Line,
  Rect,
  Stage,
  Text,
  Transformer,
} from "react-konva";
import type Konva from "konva";
import type { LogoZone } from "@/lib/hub";
import {
  artboardPx,
  newDesign,
  newImageElement,
  newTextElement,
  TEXT_SWATCHES,
  type DesignDocument,
  type ImageElement,
} from "@/lib/design-document";

/**
 * Canvas-first editor. The canvas is the page; a toolbar sits above it and a
 * context bar appears under it for whatever is selected. Two view modes:
 *  - flat: the artboard fills the width (default on phones — the print zone
 *    on the box photo is too small to edit by thumb)
 *  - boxed: the artboard composited on the box photo at the hub's logoZone
 * The document stays in artboard pixels either way; export renders ONLY the
 * design group. On narrow screens text edits in a fixed bottom sheet (16px
 * input — no iOS focus-zoom); on wide screens it edits inline on the canvas.
 */

const MAX_STAGE_WIDTH = 760;
const NARROW = 520;
const SAFE_MARGIN_IN = 0.25;
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

function useImg(src: string | null): HTMLImageElement | null {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    if (!src) {
      setImg(null);
      return;
    }
    const i = new window.Image();
    i.crossOrigin = "anonymous"; // keep canvases untainted for export
    i.onload = () => setImg(i);
    i.src = src;
    return () => {
      i.onload = null;
    };
  }, [src]);
  return img;
}

function ImgEl({
  el,
  onSelect,
  onChange,
  refFn,
}: {
  el: ImageElement;
  onSelect: () => void;
  onChange: (p: Partial<ImageElement>) => void;
  refFn: (n: Konva.Node | null) => void;
}) {
  const img = useImg(el.src);
  return (
    <KonvaImage
      ref={refFn}
      image={img ?? undefined}
      x={el.x}
      y={el.y}
      width={el.width}
      height={el.height}
      rotation={el.rotation}
      scaleX={1}
      scaleY={1}
      draggable
      onMouseDown={onSelect}
      onTap={onSelect}
      onDragEnd={(e) =>
        onChange({ x: Math.round(e.target.x()), y: Math.round(e.target.y()) })
      }
      onTransformEnd={(e) => {
        const n = e.target;
        onChange({
          x: Math.round(n.x()),
          y: Math.round(n.y()),
          width: Math.max(20, Math.round(el.width * n.scaleX())),
          height: Math.max(20, Math.round(el.height * n.scaleY())),
          rotation: Math.round(n.rotation()),
        });
        n.scale({ x: 1, y: 1 });
      }}
    />
  );
}

export default function Editor({
  bodyStyleId,
  boxImageUrl,
  logoZone,
  onSave,
}: {
  bodyStyleId: string;
  boxImageUrl: string | null;
  logoZone: LogoZone | null;
  onSave?: (design: DesignDocument, preview: string) => void;
}) {
  const [doc, setDoc] = useState<DesignDocument>(() => newDesign(bodyStyleId));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"flat" | "boxed">("boxed");
  const userToggledView = useRef(false);
  const designRef = useRef<Konva.Group>(null);
  const trRef = useRef<Konva.Transformer>(null);
  const nodeRefs = useRef<Map<string, Konva.Node>>(new Map());
  const fileRef = useRef<HTMLInputElement>(null);

  const boxImg = useImg(boxImageUrl);
  const px = artboardPx(doc.artboard);
  const safePx = SAFE_MARGIN_IN * doc.artboard.dpi;

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
  }, [boxImg]);

  const isNarrow = stageW < NARROW;
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

  useEffect(() => {
    const tr = trRef.current;
    if (!tr) return;
    const node =
      selectedId && selectedId !== editingId
        ? nodeRefs.current.get(selectedId)
        : null;
    tr.nodes(node ? [node] : []);
    tr.getLayer()?.batchDraw();
  }, [selectedId, editingId, doc.elements, geo]);

  // Wait for the box photo — no flat-artboard flash.
  if (boxImageUrl && !boxImg) {
    return <p className="note">Setting up your box…</p>;
  }

  const patch = (id: string, p: Record<string, unknown>) =>
    setDoc((d) => ({
      ...d,
      elements: d.elements.map((el) =>
        el.id === id ? ({ ...el, ...p } as typeof el) : el,
      ),
    }));

  // dir +1 = forward (later in array = drawn on top), -1 = back.
  const moveLayer = (id: string, dir: 1 | -1) =>
    setDoc((d) => {
      const i = d.elements.findIndex((e) => e.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= d.elements.length) return d;
      const els = [...d.elements];
      [els[i], els[j]] = [els[j], els[i]];
      return { ...d, elements: els };
    });

  const addText = () => {
    const el = newTextElement(doc.artboard);
    setDoc((d) => ({ ...d, elements: [...d.elements, el] }));
    setSelectedId(el.id);
    setEditingId(el.id); // new text goes straight into typing mode
  };

  const onUpload = (file: File) => {
    if (file.size > MAX_UPLOAD_BYTES) {
      alert("Please pick an image under 8 MB.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const src = String(reader.result);
      const probe = new window.Image();
      probe.onload = () => {
        const el = newImageElement(
          doc.artboard,
          src,
          probe.naturalWidth,
          probe.naturalHeight,
        );
        setDoc((d) => ({ ...d, elements: [...d.elements, el] }));
        setSelectedId(el.id);
      };
      probe.src = src;
    };
    reader.readAsDataURL(file);
  };

  const removeEl = (id: string) => {
    nodeRefs.current.delete(id);
    setDoc((d) => ({ ...d, elements: d.elements.filter((e) => e.id !== id) }));
    if (selectedId === id) setSelectedId(null);
    if (editingId === id) setEditingId(null);
  };

  // Synchronous on purpose: requestAnimationFrame never fires in background
  // tabs, and Konva's toDataURL doesn't need a paint.
  const exportPng = (targetWidthPx: number): string | null => {
    trRef.current?.nodes([]);
    const g = designRef.current;
    if (!g) return null;
    return g.toDataURL({
      pixelRatio: targetWidthPx / (px.width * geo.scale),
    });
  };

  const downloadPreview = () => {
    setSelectedId(null);
    const uri = exportPng(px.width);
    if (!uri) return;
    const a = document.createElement("a");
    a.href = uri;
    a.download = `pinatagrams-${doc.bodyStyleId}-front.png`;
    a.click();
  };

  const useThisDesign = () => {
    setSelectedId(null);
    setEditingId(null);
    const preview = exportPng(480);
    if (preview && onSave) onSave(doc, preview);
  };

  const deselect = () => setSelectedId(null);
  const refFn = (id: string) => (n: Konva.Node | null) => {
    if (n) nodeRefs.current.set(id, n);
    else nodeRefs.current.delete(id);
  };

  const selected = doc.elements.find((e) => e.id === selectedId) ?? null;
  const editingEl = doc.elements.find(
    (e) => e.id === editingId && e.kind === "text",
  );

  return (
    <div className="editor-v4">
      <div className="editor-toolbar">
        <button className="btn" onClick={addText}>
          + Text
        </button>
        <button className="btn" onClick={() => fileRef.current?.click()}>
          + Photo
        </button>
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
              if (e.target === e.target.getStage()) deselect();
            }}
            onTouchStart={(e) => {
              if (e.target === e.target.getStage()) deselect();
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
                  onMouseDown={deselect}
                  onTap={deselect}
                />
                {doc.elements.map((el) =>
                  el.kind === "image" ? (
                    <ImgEl
                      key={el.id}
                      el={el}
                      refFn={refFn(el.id)}
                      onSelect={() => setSelectedId(el.id)}
                      onChange={(p) => patch(el.id, p)}
                    />
                  ) : (
                    <Text
                      key={el.id}
                      ref={refFn(el.id)}
                      // wide: inline overlay replaces the node while editing;
                      // narrow: the node stays visible as the live preview of
                      // what's typed in the bottom sheet
                      visible={isNarrow || el.id !== editingId}
                      text={el.text}
                      x={el.x}
                      y={el.y}
                      rotation={el.rotation}
                      fontSize={el.fontSizePx}
                      fontFamily={fontFamily}
                      fill={el.fill}
                      scaleX={1}
                      scaleY={1}
                      draggable
                      onMouseDown={() => setSelectedId(el.id)}
                      onTap={() => setSelectedId(el.id)}
                      onDblClick={() => setEditingId(el.id)}
                      onDblTap={() => setEditingId(el.id)}
                      onDragEnd={(e) =>
                        patch(el.id, {
                          x: Math.round(e.target.x()),
                          y: Math.round(e.target.y()),
                        })
                      }
                      onTransformEnd={(e) => {
                        const n = e.target;
                        patch(el.id, {
                          x: Math.round(n.x()),
                          y: Math.round(n.y()),
                          fontSizePx: Math.max(
                            24,
                            Math.round(el.fontSizePx * n.scaleY()),
                          ),
                          rotation: Math.round(n.rotation()),
                        });
                        n.scale({ x: 1, y: 1 });
                      }}
                    />
                  ),
                )}
              </Group>
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
                <Line
                  points={[
                    safePx, safePx,
                    px.width - safePx, safePx,
                    px.width - safePx, px.height - safePx,
                    safePx, px.height - safePx,
                    safePx, safePx,
                  ]}
                  stroke="#B3B9CE"
                  strokeWidth={1 / geo.scale}
                  dash={[12, 12]}
                />
              </Group>
              <Transformer
                ref={trRef}
                rotateEnabled
                keepRatio
                enabledAnchors={[
                  "top-left",
                  "top-right",
                  "bottom-left",
                  "bottom-right",
                ]}
                anchorSize={isNarrow ? 16 : 10}
                anchorCornerRadius={isNarrow ? 8 : 2}
                rotateAnchorOffset={isNarrow ? 34 : 24}
                anchorStroke="#627AE3"
                borderStroke="#627AE3"
              />
            </Layer>
          </Stage>

          {/* wide screens: edit text right on the canvas */}
          {!isNarrow && editingEl && editingEl.kind === "text" && (
            <textarea
              className="inline-text-edit"
              autoFocus
              value={editingEl.text}
              onChange={(e) => patch(editingEl.id, { text: e.target.value })}
              onBlur={() => setEditingId(null)}
              onKeyDown={(e) => {
                if (e.key === "Escape" || (e.key === "Enter" && !e.shiftKey)) {
                  e.preventDefault();
                  setEditingId(null);
                }
              }}
              style={{
                left: geo.gx + editingEl.x * geo.scale,
                top: geo.gy + editingEl.y * geo.scale,
                fontSize: editingEl.fontSizePx * geo.scale,
                fontFamily,
                color: editingEl.fill,
                width: Math.min(
                  stageW - (geo.gx + editingEl.x * geo.scale),
                  Math.max(
                    140,
                    editingEl.text.length * editingEl.fontSizePx * geo.scale * 0.62,
                  ),
                ),
              }}
            />
          )}
        </div>

        <p className="note">
          {selected
            ? "Drag to move · corners resize · double-tap text to edit"
            : boxed
              ? "This is the printed area on your box — tap anything to edit it."
              : "Your front graphic, edge to edge. Keep it inside the dashed safe line."}
        </p>
      </div>

      {selected && (
        <div className="context-bar">
          {selected.kind === "text" && (
            <>
              <button
                className="btn mini"
                onClick={() => setEditingId(selected.id)}
              >
                Edit text
              </button>
              {TEXT_SWATCHES.map((c) => (
                <button
                  key={c}
                  className={
                    "swatch" +
                    (selected.kind === "text" && selected.fill === c
                      ? " active"
                      : "")
                  }
                  style={{ background: c }}
                  onClick={() => patch(selected.id, { fill: c })}
                  title={c}
                />
              ))}
            </>
          )}
          <button
            className="btn mini"
            onClick={() => moveLayer(selected.id, 1)}
            title="Bring forward"
          >
            ⬆ Front
          </button>
          <button
            className="btn mini"
            onClick={() => moveLayer(selected.id, -1)}
            title="Send backward"
          >
            ⬇ Back
          </button>
          <button
            className="btn danger"
            onClick={() => removeEl(selected.id)}
            title="Remove"
          >
            ✕
          </button>
        </div>
      )}

      <div className="editor-cta">
        {onSave && (
          <button className="btn primary block" onClick={useThisDesign}>
            Use this design →
          </button>
        )}
        <button className="btn mini" onClick={downloadPreview}>
          Download print-size PNG
        </button>
      </div>

      {/* narrow screens: text edits in a bottom sheet (16px input, no iOS zoom) */}
      {isNarrow && editingEl && editingEl.kind === "text" && (
        <div className="edit-sheet">
          <textarea
            autoFocus
            rows={2}
            value={editingEl.text}
            onChange={(e) => patch(editingEl.id, { text: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                setEditingId(null);
              }
            }}
          />
          <button className="btn primary" onClick={() => setEditingId(null)}>
            Done
          </button>
        </div>
      )}
    </div>
  );
}
