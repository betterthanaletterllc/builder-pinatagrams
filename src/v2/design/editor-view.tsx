"use client";

import dynamic from "next/dynamic";
import { forwardRef } from "react";
import { isCurrentDesign, type DesignDocument } from "@/lib/design-document";
import type { DesignAssets, GraphicChoice } from "@/lib/flow";
import type { HubBodyStyle } from "@/lib/hub";
import { Callout, Skeleton } from "../ui/feedback";
import { Close } from "../ui/icons";
import f from "./flow.module.css";

// The editor (Konva) is its own chunk, fetched only when the shopper opens
// "Make your own" — never on first load.
const EditorShell = dynamic(() => import("@/app/design/editor-shell"), {
  ssr: false,
  loading: () => (
    <div aria-busy="true" style={{ display: "grid", gap: 12 }}>
      <Skeleton height={44} />
      <Skeleton height={260} />
    </div>
  ),
});

/**
 * "Make your own": the existing editor (EditorShell), full-screen inside
 * the flow and history-backed (Back closes it). Re-opening an existing
 * custom design edits it in place with its uploaded assets, so an unchanged
 * re-save reuses the print file instead of re-uploading.
 */
const EditorView = forwardRef<
  HTMLHeadingElement,
  {
    style: HubBodyStyle;
    graphic: GraphicChoice | null;
    retry: boolean;
    onClose: () => void;
    onSave: (design: DesignDocument, preview: string, assets: DesignAssets) => void;
    onAssets: (assets: DesignAssets, docJson: string) => void;
  }
>(function EditorView({ style, graphic, retry, onClose, onSave, onAssets }, h1Ref) {
  const existing =
    graphic?.type === "custom" && isCurrentDesign(graphic.design) ? graphic : null;
  return (
    <section className={f.editorView}>
      <div className={f.editorHead}>
        <button type="button" className={f.iconBtn} onClick={onClose} aria-label="Close the editor">
          <Close size={24} />
        </button>
        <h1 ref={h1Ref} tabIndex={-1} className={f.editorTitle}>
          {existing ? "Edit your design" : "Make your own"}
        </h1>
      </div>
      {retry && (
        <div style={{ marginBottom: 12 }}>
          <Callout tone="warning">
            Your design didn&apos;t finish saving. Tap &ldquo;Use this design&rdquo; to save it
            again.
          </Callout>
        </div>
      )}
      <EditorShell
        key={existing ? "edit" : "new"}
        bodyStyleId={style.id}
        boxImageUrl={style.boxImageUrl}
        logoZone={style.logoZone}
        initialDesign={existing ? existing.design : null}
        initialAssets={
          existing
            ? {
                art: existing.art ?? null,
                designUrl: existing.designUrl ?? null,
                artSha256: existing.artSha256 ?? null,
              }
            : null
        }
        onSave={onSave}
        onAssets={onAssets}
      />
    </section>
  );
});

export default EditorView;
