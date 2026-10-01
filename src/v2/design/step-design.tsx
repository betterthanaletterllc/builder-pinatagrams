"use client";

import { forwardRef, type ReactNode } from "react";
import { CLASSIC_GRAPHIC, type GraphicChoice } from "@/lib/flow";
import {
  formatCents,
  type BuilderPricing,
  type HubBodyStyle,
  type HubGraphicCategory,
  type HubGraphicEntry,
} from "@/lib/hub";
import type { OccasionId } from "../lib/occasions";
import { tierLabel } from "../lib/pricing";
import type { OccasionStrip } from "../lib/types";
import { previewArt } from "../ui/box-thumb";
import { Chip } from "../ui/controls";
import { StepHeader } from "../ui/feedback";
import { Check, Pencil, Sparkle } from "../ui/icons";
import s from "./steps.module.css";

const STRIP_MAX = 12;

export function sameGraphic(a: GraphicChoice | null, b: GraphicChoice | null): boolean {
  if (!a || !b || a.type !== b.type) return false;
  if (a.type === "custom" || b.type === "custom") return a.type === "custom" && b.type === "custom";
  return a.design === b.design;
}

/** Hub-graphic titles are internal: customers see the art and the folder. */
function tileName(g: GraphicChoice, categories: HubGraphicCategory[], hub: HubGraphicEntry[]) {
  if (g.type === "custom") return "Your design";
  if (g.type === "hub") {
    const cat = hub.find((h) => h.design === g.design)?.category;
    return `${categories.find((c) => c.id === cat)?.label ?? "Piñatagram"} design`;
  }
  return g.title;
}

/**
 * Step 1 · Design — "Pick your design". Occasion chips filter a filmstrip of
 * best sellers (radio tiles: tapping swaps the art on the Stage at once, no
 * confirm screen). Tiered stores lead with the Classic (no extra cost, so no
 * badge) and label every other tile with its upcharge at the moment of
 * choice. "Make
 * your own" is a tile too — always second. Under the grid: the whole
 * occasion in the library, and the whole library.
 */
const StepDesign = forwardRef<
  HTMLHeadingElement,
  {
    graphic: GraphicChoice;
    style: HubBodyStyle;
    occasion: OccasionId | null;
    strips: OccasionStrip[];
    hubStrip: GraphicChoice[];
    hubGraphics: HubGraphicEntry[];
    hubCategories: HubGraphicCategory[];
    tiered: boolean;
    pricing: BuilderPricing;
    libraryCount: number;
    allowCustom: boolean;
    /** false on folders-only stores: they sell their own folders, not the Classic. */
    classic: boolean;
    onOccasion: (id: OccasionId) => void;
    onPick: (g: GraphicChoice) => void;
    /** The library, opened on the chosen occasion — or on everything. */
    onSeeAll: (occasion: OccasionId | null) => void;
    onLibraryIntent: () => void;
    onMakeOwn: () => void;
    banner?: ReactNode;
    status?: ReactNode;
  }
>(function StepDesign(p, h1Ref) {
  const active = p.strips.find((x) => x.id === p.occasion) ?? p.strips[0] ?? null;
  // Hub graphics can be limited to certain bodies.
  const wearable = (g: GraphicChoice) => {
    if (g.type !== "hub") return true;
    const rec = p.hubGraphics.find((h) => h.design === g.design);
    return !rec || rec.bodyStyles === "all" || rec.bodyStyles.includes(p.style.id);
  };
  let tiles: GraphicChoice[] = (active?.designs ?? p.hubStrip).filter(wearable);
  // The Classic is on offer everywhere but folders-only stores: first (and
  // included) on tiered stores, at the end on flat ones (same price there).
  if (p.classic) tiles = p.tiered ? [CLASSIC_GRAPHIC, ...tiles] : [...tiles, CLASSIC_GRAPHIC];
  tiles = tiles.filter((g, i) => tiles.findIndex((x) => sameGraphic(x, g)) === i);
  // The current pick is always visible and selected, even if it came from
  // the library, a deep link or the editor.
  if (!tiles.some((t) => sameGraphic(t, p.graphic))) tiles = [p.graphic, ...tiles];
  // one slot goes to the "Make your own" tile (second), so the grid stays full rows
  tiles = tiles.slice(0, p.allowCustom ? STRIP_MAX - 1 : STRIP_MAX);

  const stripLabel = active ? `${active.label} designs` : "Designs";
  const ownCents = p.tiered ? p.pricing.graphicCustomUpchargeCents : 0;
  const makeOwn = p.allowCustom ? (
    <button
      key="make-own"
      type="button"
      className={`${s.tile} ${s.makeOwn}`}
      onClick={p.onMakeOwn}
      data-priced={(ownCents > 0 && p.graphic.type !== "custom") || undefined}
    >
      <span className={s.makeOwnInner}>
        {p.graphic.type === "custom" ? <Pencil size={14} /> : <Sparkle size={14} />}
        <span className={s.makeOwnLabel}>
          {p.graphic.type === "custom" ? "Edit your design" : "Make your own"}
        </span>
      </span>
      {ownCents > 0 && p.graphic.type !== "custom" && (
        <span className={s.tier} data-included={false}>
          +{formatCents(ownCents)}
        </span>
      )}
    </button>
  ) : null;

  return (
    <div>
      {p.banner}
      <StepHeader ref={h1Ref} index={0} title="Pick your design" />

      {p.strips.length > 1 && (
        <div className={s.occasions} role="group" aria-label="What are you celebrating?">
          {p.strips.map((o) => (
            <Chip key={o.id} pressed={o.id === active?.id} onClick={() => p.onOccasion(o.id)}>
              {o.label}
            </Chip>
          ))}
        </div>
      )}

      <fieldset className={s.strip}>
        <legend className={s.srOnly}>{stripLabel}</legend>
        {tiles.flatMap((g, i) => {
          const selected = sameGraphic(g, p.graphic);
          const art = previewArt(g, 360);
          const tier = p.tiered ? tierLabel(g, p.pricing) : null;
          const key = g.type === "custom" ? "custom" : `${g.type}-${g.design}`;
          const tile = (
            <label
              key={key}
              className={`${s.tile}${g.type === "custom" ? " ph-no-capture" : ""}`}
              data-selected={selected}
            >
              <input
                type="radio"
                name="pg-design"
                className={s.srOnly}
                checked={selected}
                onChange={() => p.onPick(g)}
              />
              {art ? (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img
                  src={art}
                  alt={tileName(g, p.hubCategories, p.hubGraphics)}
                  width={360}
                  height={176}
                  loading={i < 6 ? "eager" : "lazy"}
                  decoding="async"
                />
              ) : (
                <span className={s.srOnly}>{tileName(g, p.hubCategories, p.hubGraphics)}</span>
              )}
              {/* only an upcharge gets a badge — a design at no extra cost
                  shows just its art */}
              {tier && !tier.included && <span className={s.tier}>{tier.text}</span>}
              <span className={s.tileCheck} aria-hidden="true">
                <Check size={12} />
              </span>
            </label>
          );
          return i === 0 && makeOwn ? [tile, makeOwn] : [tile];
        })}
      </fieldset>

      {p.libraryCount > 0 && (
        <div className={s.links}>
          {active && (
            <button
              type="button"
              className={s.linkBtn}
              onClick={() => p.onSeeAll(active.id)}
              onPointerEnter={p.onLibraryIntent}
              onFocus={p.onLibraryIntent}
              aria-haspopup="dialog"
            >
              See all {active.label} designs
            </button>
          )}
          <button
            type="button"
            className={s.linkBtn}
            onClick={() => p.onSeeAll(null)}
            onPointerEnter={p.onLibraryIntent}
            onFocus={p.onLibraryIntent}
            aria-haspopup="dialog"
          >
            See all {p.libraryCount.toLocaleString("en-US")} designs
          </button>
        </div>
      )}
      {p.status}
    </div>
  );
});

export default StepDesign;
