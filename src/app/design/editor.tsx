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
 * Canvas editor: the design artboard overlaid on the chosen style's BOX photo
 * at the hub's logoZone. The document stays in artboard pixels; the Group
 * carries the zone transform. Export renders ONLY the design group.
 *
 * Editing model: click selects (drag/resize/rotate via Transformer),
 * double-click a text opens an in-place editor. Element order = layer order
 * (later = on top); the sidebar can move elements forward/back.
 */

const STAGE_WIDTH = 760;
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
  const designRef = useRef<Konva.Group>(null);
  const trRef = useRef<Konva.Transformer>(null);
  const nodeRefs = useRef<Map<string, Konva.Node>>(new Map());
  const fileRef = useRef<HTMLInputElement>(null);

  const boxImg = useImg(boxImageUrl);
  const px = artboardPx(doc.artboard);
  const safePx = SAFE_MARGIN_IN * doc.artboard.dpi;

  const geo = useMemo(() => {
    if (boxImg && logoZone) {
      const stageH = Math.round((STAGE_WIDTH * boxImg.height) / boxImg.width);
      const zone = {
        x: logoZone.x * STAGE_WIDTH,
        y: logoZone.y * stageH,
        w: logoZone.w * STAGE_WIDTH,
        h: logoZone.h * stageH,
      };
      const s = Math.min(zone.w / px.width, zone.h / px.height);
      return {
        stageH,
        scale: s,
        gx: zone.x + (zone.w - px.width * s) / 2,
        gy: zone.y + (zone.h - px.height * s) / 2,
        boxed: true,
      };
    }
    const s = STAGE_WIDTH / px.width;
    return {
      stageH: Math.round(px.height * s),
      scale: s,
      gx: 0,
      gy: 0,
      boxed: false,
    };
  }, [boxImg, logoZone, px.width, px.height]);

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
  }, [selectedId, editingId, doc.elements]);

  // Wait for the box photo — rendering the flat artboard first then jumping
  // to the boxed layout is exactly the flash we're avoiding.
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
  // tabs, and Konva's toDataURL doesn't need a paint — just detach the
  // transformer handles imperatively so they can't leak into the export.
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

  const editingEl = doc.elements.find(
    (e) => e.id === editingId && e.kind === "text",
  );

  return (
    <div className="editor-grid">
      <div>
        <div className="artboard-wrap">
          <Stage
            width={STAGE_WIDTH}
            height={geo.stageH}
            onMouseDown={(e) => {
              if (e.target === e.target.getStage()) deselect();
            }}
          >
            {geo.boxed && (
              <Layer listening={false}>
                <KonvaImage
                  image={boxImg ?? undefined}
                  width={STAGE_WIDTH}
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
                      visible={el.id !== editingId}
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
                  strokeWidth={2 / geo.scale}
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
                anchorStroke="#627AE3"
                borderStroke="#627AE3"
              />
            </Layer>
          </Stage>

          {editingEl && editingEl.kind === "text" && (
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
                  STAGE_WIDTH - (geo.gx + editingEl.x * geo.scale),
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
          {geo.boxed
            ? "Your design on the box it ships in. Double-click text to edit it; drag the corners to resize."
            : `Artboard: ${doc.artboard.widthIn}″ × ${doc.artboard.heightIn}″ at ${doc.artboard.dpi} DPI.`}
        </p>
      </div>

      <aside className="panel">
        <h2>Your design</h2>
        <div className="el-controls">
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
        </div>

        {[...doc.elements].reverse().map((el) => (
          <div
            key={el.id}
            className={"el-row" + (el.id === selectedId ? " selected" : "")}
            onClick={() => setSelectedId(el.id)}
          >
            {el.kind === "text" ? (
              <>
                <input
                  value={el.text}
                  onChange={(e) => patch(el.id, { text: e.target.value })}
                />
                <div className="el-controls">
                  {TEXT_SWATCHES.map((c) => (
                    <button
                      key={c}
                      className={"swatch" + (el.fill === c ? " active" : "")}
                      style={{ background: c }}
                      onClick={() => patch(el.id, { fill: c })}
                      title={c}
                    />
                  ))}
                </div>
              </>
            ) : (
              <div className="el-controls">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img className="el-thumb" src={el.src} alt="uploaded" />
                <span className="note" style={{ margin: 0, flex: 1 }}>
                  Photo
                </span>
              </div>
            )}
            <div className="el-controls">
              <button
                className="btn mini"
                onClick={() => moveLayer(el.id, 1)}
                title="Bring forward (on top)"
              >
                ⬆ Front
              </button>
              <button
                className="btn mini"
                onClick={() => moveLayer(el.id, -1)}
                title="Send backward (behind)"
              >
                ⬇ Back
              </button>
              <button
                className="btn danger"
                onClick={() => removeEl(el.id)}
                title="Remove"
              >
                ✕
              </button>
            </div>
          </div>
        ))}

        {doc.elements.length === 0 && (
          <p className="note">Nothing here yet — add text or upload a photo.</p>
        )}

        <div className="editor-actions">
          {onSave && (
            <button className="btn primary block" onClick={useThisDesign}>
              Use this design →
            </button>
          )}
          <button className="btn" onClick={downloadPreview}>
            Download print-size preview
          </button>
        </div>
      </aside>
    </div>
  );
}
