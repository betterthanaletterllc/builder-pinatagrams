"use client";

import Image from "next/image";
import type { ReactNode } from "react";
import BoxPreview from "@/app/design/box-preview";
import type { GraphicChoice } from "@/lib/flow";
import type { HubBodyStyle } from "@/lib/hub";
import type { BoxInterior, StepId } from "../lib/types";
import { previewArt } from "../ui/box-thumb";
import { Skeleton } from "../ui/feedback";
import { ZoomIn } from "../ui/icons";
import f from "./flow.module.css";

// The brand confetti message card (Confetti Birthday's graphics/message):
// custom designs and hub graphics preview AND print on it (v1's rule —
// design-flow.tsx DEFAULT_MESSAGE_CARD).
const DEFAULT_MESSAGE_CARD =
  "https://cdn.shopify.com/s/files/1/1116/8788/files/HBD01-GOOGLY_message_graphic.svg?v=1696183772";

/** The inside-flap card a graphic prints its message on. */
export function messageCardFor(g: GraphicChoice | null): string | null {
  if (!g) return null;
  return g.type === "shopify" ? (g.message ?? null) : DEFAULT_MESSAGE_CARD;
}

/**
 * The Stage: the real box photo with the chosen art composited on it
 * (BoxPreview, shared with v1), on every step. The Card step opens the box
 * to show the message printed inside the lid. Step 1 adds a band UNDER the
 * photo — the body chip ("Googly · Change") and the zoom control — so
 * nothing ever sits on the piñata or the box.
 */
export default function Stage({
  step,
  style,
  graphic,
  message,
  filling,
  box,
  onBody,
  onZoom,
  loading,
  empty,
}: {
  step: StepId;
  style: HubBodyStyle | null;
  graphic: GraphicChoice | null;
  message: string;
  filling: string | null;
  box: BoxInterior | null;
  onBody?: () => void;
  onZoom?: () => void;
  loading?: boolean;
  empty?: ReactNode;
}) {
  const mode = step === "card" ? "open" : "closed";
  // Session replay: the gift message printed on the flap is masked, and a
  // shopper's own design (their photos) is never recorded.
  const privateArt = graphic?.type === "custom";
  const showBody = !loading && step === "design" && !!style && !!onBody;
  const showZoom = !loading && step === "design" && !!graphic && !!onZoom;
  return (
    <div
      className={`${f.stage}${privateArt ? " ph-no-capture" : ""}`}
      data-step={step}
      data-bar={showBody || showZoom || undefined}
    >
      <div className={f.stageView}>
        {loading ? (
          <Skeleton width="62%" height="78%" radius={16} />
        ) : style ? (
          <div className={f.stageBox} data-mode={mode} data-ph-mask>
            <BoxPreview
              // A new body resets the preview's image-fallback state.
              key={style.id}
              styleName={style.name}
              boxImageUrl={style.boxImageUrl}
              logoZone={style.logoZone}
              artUrl={previewArt(graphic)}
              message={message}
              filling={filling}
              deliveryDate={null}
              mode={mode}
              variant="bare"
              interiorUrl={box?.interiorUrl}
              messageZone={box?.messageZone}
              messageCard={messageCardFor(graphic)}
              messagePadding={box?.messageCardPadding}
              pinataSrc={style.cutoutUrl ?? `/pinatas/${style.id}.png`}
              pinataFallback={style.imageUrl}
              pinataZone={style.pinataZone ?? null}
            />
          </div>
        ) : (
          <div className={f.stageEmpty}>{empty}</div>
        )}
      </div>

      {(showBody || showZoom) && (
        <div className={f.stageBar}>
          {showBody && style && (
            <button type="button" className={f.bodyChip} onClick={onBody} aria-haspopup="dialog">
              <span className={f.srOnly}>Piñata style: </span>
              <span className={f.bodyChipArt} aria-hidden="true">
                <Image
                  src={style.cutoutUrl ?? `/pinatas/${style.id}.png`}
                  alt=""
                  width={64}
                  height={64}
                  sizes="32px"
                />
              </span>
              <strong>{style.name}</strong>
              <span aria-hidden="true">·</span>
              <span className={f.bodyChipChange}>Change</span>
            </button>
          )}
          {showZoom && (
            <button type="button" className={f.zoomBtn} onClick={onZoom} aria-haspopup="dialog">
              <ZoomIn size={18} />
              <span className={f.zoomMobile}>Zoom</span>
              <span className={f.zoomDesk}>8 × 3.9 in label · Zoom</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
