"use client";

import { forwardRef, useState, type ReactNode } from "react";
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
import { Button, Chip } from "../ui/controls";
import { StepHeader } from "../ui/feedback";
import { Check, Pencil, Photo, Search } from "../ui/icons";
import { useLongPress } from "../ui/long-press";
import QuickLook from "../ui/quick-look";
import s from "./steps.module.css";

// Up to 24 tiles: 8 full rows of 3 on a phone (the "Make your own" tile
// takes one slot). The strips are served 23 deep (catalog-server).
const STRIP_MAX = 24;

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

/** One design tile: a real radio; press-and-hold opens the quick look. */
function DesignTile({
  g,
  index,
  selected,
  name,
  tier,
  onPick,
  onPeek,
}: {
  g: GraphicChoice;
  index: number;
  selected: boolean;
  name: string;
  tier: { text: string; included: boolean } | null;
  onPick: () => void;
  onPeek: () => void;
}) {
  const hold = useLongPress<HTMLLabelElement>(onPeek);
  const art = previewArt(g, 360);
  return (
    <label
      className={`${s.tile}${g.type === "custom" ? " ph-no-capture" : ""}`}
      data-selected={selected}
      {...hold}
    >
      <input
        type="radio"
        name="pg-design"
        className={s.srOnly}
        checked={selected}
        onChange={onPick}
      />
      {art ? (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img
          src={art}
          alt={name}
          width={360}
          height={176}
          loading={index < 6 ? "eager" : "lazy"}
          decoding="async"
          draggable={false}
        />
      ) : (
        <span className={s.srOnly}>{name}</span>
      )}
      {/* only an upcharge gets a badge — a design at no extra cost shows
          just its art */}
      {tier && !tier.included && <span className={s.tier}>{tier.text}</span>}
      <span className={s.tileCheck} aria-hidden="true">
        <Check size={12} />
      </span>
    </label>
  );
}

/**
 * Step 1 · Design — "Pick your design". A search field opens the whole
 * library ready to type; occasion chips filter a grid of best sellers
 * (radio tiles: tapping swaps the art on the Stage at once, no confirm
 * screen; press-and-hold shows a design up close). Tiered stores lead with
 * the Classic (no extra cost, so no badge) and label every other tile with
 * its upcharge at the moment of choice. "Make your own" is a tile too —
 * first on all-in stores, else second. Under the grid: the whole occasion
 * in the library, and the whole library.
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
    /** The library, opened with the cursor in its search field. */
    onSearch: () => void;
    onLibraryIntent: () => void;
    onMakeOwn: () => void;
    /** All-in storefronts: "Make your own" leads the grid (else second). */
    makeOwnFirst?: boolean;
    banner?: ReactNode;
    status?: ReactNode;
  }
>(function StepDesign(p, h1Ref) {
  const [peek, setPeek] = useState<GraphicChoice | null>(null);
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
  // one slot goes to the "Make your own" tile, so the grid stays full rows
  tiles = tiles.slice(0, p.allowCustom ? STRIP_MAX - 1 : STRIP_MAX);

  const stripLabel = active ? `${active.label} designs` : "Designs";
  const ownCents = p.tiered ? p.pricing.graphicCustomUpchargeCents : 0;
  const editing = p.graphic.type === "custom";
  // Their own photo is the thing no library design can do — so this tile
  // is filled and pictured, never a dashed afterthought.
  const makeOwn = p.allowCustom ? (
    <button
      key="make-own"
      type="button"
      className={`${s.tile} ${s.makeOwn}`}
      onClick={p.onMakeOwn}
      data-priced={(ownCents > 0 && !editing) || undefined}
    >
      <span className={s.makeOwnInner}>
        {editing ? <Pencil size={18} /> : <Photo size={20} />}
        <span className={s.makeOwnLabel}>{editing ? "Edit your design" : "Your photo"}</span>
        {!editing && <span className={s.makeOwnSub}>Make your own</span>}
      </span>
      {ownCents > 0 && !editing && (
        <span className={s.tier} data-included={false}>
          +{formatCents(ownCents)}
        </span>
      )}
    </button>
  ) : null;

  const peekArt = peek
    ? peek.type === "custom"
      ? peek.preview || null
      : previewArt(peek, 1400)
    : null;

  return (
    <div>
      {p.banner}
      <StepHeader ref={h1Ref} index={0} title="Pick your design" />

      {p.libraryCount > 0 && (
        <button
          type="button"
          className={s.searchField}
          onClick={p.onSearch}
          onPointerEnter={p.onLibraryIntent}
          onPointerDown={p.onLibraryIntent}
          onFocus={p.onLibraryIntent}
          aria-haspopup="dialog"
        >
          <Search size={18} />
          <span>Search {p.libraryCount.toLocaleString("en-US")} designs</span>
        </button>
      )}

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
          const key = g.type === "custom" ? "custom" : `${g.type}-${g.design}`;
          const tile = (
            <DesignTile
              key={key}
              g={g}
              index={i}
              selected={sameGraphic(g, p.graphic)}
              name={tileName(g, p.hubCategories, p.hubGraphics)}
              tier={p.tiered ? tierLabel(g, p.pricing) : null}
              onPick={() => p.onPick(g)}
              onPeek={() => setPeek(g)}
            />
          );
          if (i === 0 && makeOwn) return p.makeOwnFirst ? [makeOwn, tile] : [tile, makeOwn];
          return [tile];
        })}
      </fieldset>
      <p className={s.holdTip}>Tip: press and hold a design to see it up close.</p>

      {p.libraryCount > 0 && (
        <div className={s.browse}>
          {active && (
            <Button
              variant="secondary"
              block
              onClick={() => p.onSeeAll(active.id)}
              onPointerEnter={p.onLibraryIntent}
              onFocus={p.onLibraryIntent}
              aria-haspopup="dialog"
            >
              See all {active.label} designs
            </Button>
          )}
          <Button
            variant="secondary"
            block
            className={s.browseAll}
            onClick={() => p.onSeeAll(null)}
            onPointerEnter={p.onLibraryIntent}
            onFocus={p.onLibraryIntent}
            aria-haspopup="dialog"
          >
            Browse all {p.libraryCount.toLocaleString("en-US")} designs
          </Button>
        </div>
      )}
      {p.status}

      <QuickLook
        art={peekArt}
        name={peek ? tileName(peek, p.hubCategories, p.hubGraphics) : ""}
        selected={!!peek && sameGraphic(peek, p.graphic)}
        onUse={() => {
          const g = peek;
          setPeek(null);
          if (g) p.onPick(g);
        }}
        onClose={() => setPeek(null)}
      />
    </div>
  );
});

export default StepDesign;
