import "server-only";
import collectionsFile from "../../../public/collections.json";
import graphicsFile from "../../../public/graphics.json";
import popularFile from "../../../public/popular.json";
import { CLASSIC_GRAPHIC, type GraphicChoice } from "@/lib/flow";
import type { HubBodyStyle, HubGraphicEntry } from "@/lib/hub";
import { EXCLUDED_PREFIXES, occasionOf } from "@/lib/library-data";
import type { VariantProfile } from "@/lib/variant";
import { BEST_SELLER_BODIES, designPrefix } from "./defaults";
import {
  activeOccasions,
  libraryLabelsFor,
  OCCASION_BODY_HINTS,
  occasionDef,
  type OccasionId,
} from "./occasions";
import type { LibraryChoice, OccasionStrip } from "./types";

/**
 * Server-only lookups over the library data files (public/graphics.json,
 * popular.json, collections.json). Deep links, filmstrips and the "natural
 * body" of a design are all resolved HERE, during the server render, so the
 * ~400 KB manifest never ships to a phone just to open on the right design.
 * Every lookup honours the storefront's variant.library ("all" / "birthday" /
 * "none") — a deep link can't surface a design the storefront doesn't sell.
 */

type ManifestGraphic = {
  design: string;
  title: string;
  thumb: string | null;
  art: string | null;
  message?: string | null;
};
type ManifestProduct = { design: string; bodyStyle?: string };

const MANIFEST = graphicsFile as unknown as {
  graphics: ManifestGraphic[];
  products?: ManifestProduct[];
};
const POPULAR: string[] = (
  (popularFile as unknown as { ranking?: { design: string }[] }).ranking ?? []
).map((r) => r.design);
const BIRTHDAY_EXTRA = new Set(
  (collectionsFile as unknown as { birthday?: string[] }).birthday ?? [],
);

const RANK = new Map(POPULAR.map((d, i) => [d, i]));
// Most-sold first; unranked designs keep manifest order (sort is stable).
const byPopularity = (a: ManifestGraphic, b: ManifestGraphic) =>
  (RANK.get(a.design) ?? 1e6) - (RANK.get(b.design) ?? 1e6);

// Every sellable Shopify design (client one-offs excluded, as in the library).
const SELLABLE = MANIFEST.graphics.filter(
  (g) => !!g.art && !EXCLUDED_PREFIXES.has(designPrefix(g.design)),
);

const isBirthday = (design: string) =>
  occasionOf(design) === "Birthday" || BIRTHDAY_EXTRA.has(design);

function toChoice(g: ManifestGraphic): LibraryChoice {
  return {
    type: "shopify",
    design: g.design,
    title: g.title,
    thumb: g.thumb,
    art: g.art,
    message: g.message ?? null,
  };
}

function hubChoice(h: HubGraphicEntry): GraphicChoice {
  return {
    type: "hub",
    design: h.design,
    title: h.title,
    thumb: h.thumb,
    art: h.art,
    artSha256: h.artSha256,
  };
}

/** The Shopify library this storefront sells. */
export function libraryFor(variant: VariantProfile): ManifestGraphic[] {
  if (variant.library === "none") return [];
  if (variant.library === "birthday") return SELLABLE.filter((g) => isBirthday(g.design));
  return SELLABLE;
}

/** The storefront's best sellers, in sales order (home's best-seller row). */
export function bestSellers(variant: VariantProfile, n: number): LibraryChoice[] {
  const lib = new Map(libraryFor(variant).map((g) => [g.design, g]));
  return POPULAR.map((d) => lib.get(d))
    .filter((g): g is ManifestGraphic => !!g)
    .slice(0, n)
    .map(toChoice);
}

/** "See all N designs": the storefront's library plus its hub folders. */
export function libraryCount(variant: VariantProfile, hub: HubGraphicEntry[]): number {
  return libraryFor(variant).length + hub.length;
}

/** A deep-linked design code → a sellable graphic, or null (rejected). */
export function resolveDesign(
  code: string,
  variant: VariantProfile,
  hub: HubGraphicEntry[],
): GraphicChoice | null {
  const c = code.trim().toUpperCase();
  if (!/^[A-Z0-9]{2,24}$/.test(c)) return null;
  // The branded Classic prices at tier 0 everywhere (checkout matches by
  // code) — except folders-only stores, which sell their folders and nothing else.
  if (c === CLASSIC_GRAPHIC.design) return variant.library === "none" ? null : CLASSIC_GRAPHIC;
  // hubGraphics already holds only the folders this storefront may sell.
  const h = hub.find((x) => x.design === c);
  if (h) return hubChoice(h);
  const g = libraryFor(variant).find((x) => x.design === c);
  return g ? toChoice(g) : null;
}

const STRIP_DESIGNS = 11; // + the Classic tile = 12

function designsForOccasion(
  id: OccasionId,
  lib: ManifestGraphic[],
  now: Date,
): ManifestGraphic[] {
  if (id === "birthday") return lib.filter((g) => isBirthday(g.design)).sort(byPopularity);
  const labels = libraryLabelsFor(id, now);
  if (id !== "holidays") {
    return lib.filter((g) => labels.includes(occasionOf(g.design))).sort(byPopularity);
  }
  // Holidays: nearest holiday first, interleaved so one crowded holiday
  // doesn't push the next one off the strip.
  const perHoliday = labels.map((label) =>
    lib.filter((g) => occasionOf(g.design) === label).sort(byPopularity),
  );
  const out: ManifestGraphic[] = [];
  for (let i = 0; out.length < lib.length; i++) {
    let added = false;
    for (const list of perHoliday) {
      if (list[i]) {
        out.push(list[i]);
        added = true;
      }
    }
    if (!added) break;
  }
  return out;
}

/** The filmstrip per occasion chip showing today (empty chips dropped). */
export function occasionStrips(variant: VariantProfile, now = new Date()): OccasionStrip[] {
  const lib = libraryFor(variant);
  // A birthday-only store shows the Birthday chip alone: Thank you / Just
  // because would only repeat its birthday designs.
  return activeOccasions(now)
    .filter((def) => variant.library !== "birthday" || def.id === "birthday")
    .map((def) => ({
      id: def.id,
      label: def.label,
      designs: designsForOccasion(def.id, lib, now).slice(0, STRIP_DESIGNS).map(toChoice),
    }))
    .filter((s) => s.designs.length > 0);
}

/** Folders-only storefronts (library "none"): the hub graphics ARE the strip. */
export function hubStrip(hub: HubGraphicEntry[]): GraphicChoice[] {
  return hub.slice(0, STRIP_DESIGNS + 1).map(hubChoice);
}

/** Which chip a design belongs to (so the strip opens on its occasion). */
export function occasionForDesign(
  g: GraphicChoice,
  strips: OccasionStrip[],
  now = new Date(),
): OccasionId | null {
  if (g.type !== "shopify" || g.design === CLASSIC_GRAPHIC.design) return null;
  if (isBirthday(g.design) && strips.some((s) => s.id === "birthday")) return "birthday";
  const label = occasionOf(g.design);
  const hit = strips.find((s) => libraryLabelsFor(s.id, now).includes(label));
  return hit?.id ?? null;
}

/**
 * Graphic default when no design was deep-linked: the Classic on tiered
 * stores (a library default would pre-select a paid upcharge), else the
 * occasion's #1 seller, else the overall #1, else whatever the store sells.
 */
export function defaultGraphic(
  variant: VariantProfile,
  strips: OccasionStrip[],
  occasion: OccasionId | null,
  hubList: GraphicChoice[],
): GraphicChoice {
  if (variant.pricing === "tiered") return CLASSIC_GRAPHIC;
  const strip = occasion ? strips.find((s) => s.id === occasion) : undefined;
  if (strip?.designs[0]) return strip.designs[0];
  const lib = libraryFor(variant);
  const top =
    POPULAR.map((d) => lib.find((g) => g.design === d)).find(Boolean) ?? lib[0];
  if (top) return toChoice(top);
  return hubList[0] ?? CLASSIC_GRAPHIC;
}

// The body a design was made for, from the retail product it was sold as —
// only the THEMED bodies count (a birthday design sold on Googly says
// nothing; one sold on Vampire does).
const THEMED_BODIES: Record<string, string> = {
  VAMPIRE: "vampire",
  REINDEER: "reindeer",
  GRAD: "grad",
  PRIDE: "pride",
  "STAR SPANGLED": "star-spangled",
  NURSE: "nurse",
  DOCTOR: "doctor",
  MONEY: "money",
};
const PRODUCT_BODY = new Map<string, string>();
for (const p of MANIFEST.products ?? []) {
  const body = THEMED_BODIES[(p.bodyStyle ?? "").trim().toUpperCase()];
  if (body && !PRODUCT_BODY.has(p.design)) PRODUCT_BODY.set(p.design, body);
}

/** The design's natural body (Halloween → vampire, Christmas → reindeer,
 *  grad/nurse/doctor/money/pride/July 4th designs → theirs), or null. */
export function naturalBody(g: GraphicChoice): string | null {
  if (g.type !== "shopify" || g.design === CLASSIC_GRAPHIC.design) return null;
  const fromProduct = PRODUCT_BODY.get(g.design);
  if (fromProduct) return fromProduct;
  const byOccasion = OCCASION_BODY_HINTS[occasionOf(g.design)];
  if (byOccasion) return byOccasion;
  const t = g.title.toLowerCase();
  if (/\bgrad(uat\w*)?\b/.test(t)) return "grad";
  if (/\bnurses?\b/.test(t)) return "nurse";
  if (/\bdoctor'?s?\b/.test(t)) return "doctor";
  if (/\bmoney\b/.test(t)) return "money";
  return null;
}

/**
 * Body style by context: a valid in-stock ?style= → the design's natural
 * body → the occasion's → the best in-stock seller (Googly, Pink Unicorn,
 * Standard) → the first in-stock body. A hub graphic limited to some bodies
 * keeps the choice within them. Never dead-ends while anything is in stock.
 */
export function defaultStyle(
  styles: HubBodyStyle[],
  opts: { styleParam?: string; graphic: GraphicChoice; occasion: OccasionId | null },
  hub: HubGraphicEntry[],
): { id: string; source: "deeplink" | "default" } | null {
  const hubRec =
    opts.graphic.type === "hub" ? hub.find((h) => h.design === opts.graphic.design) : undefined;
  const wearable = (s: HubBodyStyle) =>
    s.inStock &&
    (!hubRec || hubRec.bodyStyles === "all" || hubRec.bodyStyles.includes(s.id));
  const ok = styles.filter(wearable);
  const has = (id: string | null | undefined) => (id ? ok.find((s) => s.id === id) : undefined);

  const explicit = has(opts.styleParam);
  if (explicit) return { id: explicit.id, source: "deeplink" };
  const hinted =
    has(naturalBody(opts.graphic)) ??
    has(opts.occasion ? occasionDef(opts.occasion).bodyHint : null);
  if (hinted) return { id: hinted.id, source: "default" };
  for (const id of BEST_SELLER_BODIES) {
    const s = has(id);
    if (s) return { id: s.id, source: "default" };
  }
  return ok[0] ? { id: ok[0].id, source: "default" } : null;
}
