/**
 * What this builder can SELL.
 *
 * Every piñata is sold as one variant of the store's "Custom Built
 * Piñatagram" product: one variant per body style, SKU CUSTOM-{BODY}. Paper
 * derives the body style from that SKU exactly like legacy orders (spaces
 * not hyphens — its parser splits on the LAST hyphen), Shopify reporting
 * sees a real product, and the invoice shows its image. A style with no such
 * variant cannot go on an invoice: checkout refuses it, loudly — a custom
 * line item without a SKU would strand the order for Paper.
 *
 * So the style pickers list a hub style only when the store has its variant.
 * Before this (2026-11-15) the hub's "active" tick alone put a style in the
 * picker — and that tick is also what lists a style on the hub's own
 * Inventory page. Two styles ticked there sat in the picker with nobody able
 * to buy one: checkout answered "temporarily unavailable — try again in a
 * minute", for good. Nathan, asked whether the builder should show only the
 * styles it can sell: "Yes, build that".
 *
 * To sell a new style here: tick it active in the hub, give it its cut-out,
 * box photo and label placement there, and add its CUSTOM-{BODY} variant to
 * the product. It is then listed by itself, within ten minutes
 * (VARIANTS_TTL_MS). The styles lib/hub's styleOffered leaves out stay out
 * whatever the store has.
 *
 * When the store's list is NOT KNOWN — a deployment without the store's keys
 * (local, previews), or the store slow or down with no earlier answer to go
 * by — every style is listed, as before this rule: a blip must not empty the
 * picker, and checkout still refuses what it cannot sell.
 *
 * Import-free on purpose: the server pages, checkout and the node tests all
 * load this file. The part that talks to the store is lib/sellable-server.
 */

export const CUSTOM_PRODUCT_GID = "gid://shopify/Product/7741496623202";

// The two bodies the store (and Paper) know by another name than the hub's
// id. lib/embed's BODY_TOKEN_SPECIAL is the other copy of this table;
// tests/sellable.test.mjs holds the two together.
const SKU_SUFFIX_SPECIAL: Record<string, string> = {
  "white-uni": "WHITE UNICORN",
  "pink-uni": "PINK UNICORN",
};

/** The SKU a body style is sold under: CUSTOM-{BODY}. */
export function customSkuFor(styleId: string): string {
  return `CUSTOM-${SKU_SUFFIX_SPECIAL[styleId] ?? styleId.toUpperCase().replace(/-/g, " ")}`;
}

/** The store's answer: the product's variant ids, by SKU. */
export type VariantsBySku = ReadonlyMap<string, string>;

/**
 * The styles that can be sold: those whose variant the store has, in their
 * order. `variants` null = the store's list is not known: every style passes.
 * A SKU matches exactly, as it must at checkout — "Custom-Googly" is not
 * CUSTOM-GOOGLY there either.
 */
export function sellableStyles<T extends { id: string }>(
  styles: readonly T[],
  variants: Pick<VariantsBySku, "has"> | null,
): T[] {
  if (!variants) return [...styles];
  return styles.filter((s) => typeof s?.id === "string" && variants.has(customSkuFor(s.id)));
}

/**
 * A catalog with only the styles that can be sold. The catalog handed in is
 * never changed (lib/hub keeps it as its last good copy): one that loses a
 * style is a new object.
 *
 * `leftOut` names what went, for the log. `disbelieved`: the store's list
 * matched NONE of the catalog's styles — a product whose SKUs were all
 * renamed, say. That list is not believed and nothing is left out: an empty
 * picker is the site down, and checkout says what is wrong either way.
 */
export function withSellableStyles<S extends { id: string }, C extends { bodyStyles: S[] }>(
  catalog: C,
  variants: Pick<VariantsBySku, "has"> | null,
): { catalog: C; leftOut: S[]; disbelieved: boolean } {
  if (!variants) return { catalog, leftOut: [], disbelieved: false };
  const kept = sellableStyles(catalog.bodyStyles, variants);
  if (kept.length === catalog.bodyStyles.length) {
    return { catalog, leftOut: [], disbelieved: false };
  }
  if (kept.length === 0) return { catalog, leftOut: [], disbelieved: true };
  const keeping = new Set(kept);
  return {
    catalog: { ...catalog, bodyStyles: kept } as C,
    leftOut: catalog.bodyStyles.filter((s) => !keeping.has(s)),
    disbelieved: false,
  };
}

/* --- the store's list, remembered ------------------------------------------- */

/** How long an answer from the store is used without asking again. */
export const VARIANTS_TTL_MS = 10 * 60_000;
/** How long the last answer may still decide what the PAGES list when the
 *  store cannot be asked (checkout never sells from a list older than the
 *  TTL). The same day lib/hub keeps its last good catalog. */
export const VARIANTS_KEEP_MS = 24 * 60 * 60_000;
// A second look this soon after an answer would ask the store the same thing.
const RECHECK_MIN_MS = 5_000;

export type VariantBook = {
  /** Checkout's read. The list, if it is at most VARIANTS_TTL_MS old; else a
   *  new answer. null = the store could not be read (the customer retries).
   *  An empty map is a real answer: the product has no variant with a SKU. */
  current(): Promise<VariantsBySku | null>;
  /** Checkout's second look, before it refuses a body that is not on a list
   *  that may be minutes old (a variant added since): a new answer whatever
   *  the list's age — unless it is seconds old. null = could not be read. */
  recheck(): Promise<VariantsBySku | null>;
  /** The pages' read. The list, if it is at most VARIANTS_TTL_MS old; else a
   *  new answer if the store gives one within `waitMs`; else the last answer
   *  there was (up to VARIANTS_KEEP_MS old); else null — not known. Never
   *  an empty list: a store that says "no variants" is not believed here. */
  forDisplay(waitMs: number): Promise<VariantsBySku | null>;
};

/**
 * The store's list of variants, kept in this server instance's memory.
 * `lookup` asks the store: a map (possibly empty) is its answer, null or a
 * throw is "could not be read". Only a real, non-empty answer is kept — an
 * empty or failed one kept here would go on refusing orders and hiding
 * styles for ten minutes after the fix. Callers that ask at the same moment
 * share one question.
 */
export function createVariantBook(
  lookup: () => Promise<VariantsBySku | null>,
  opts: { now?: () => number; ttlMs?: number; keepMs?: number } = {},
): VariantBook {
  const now = opts.now ?? Date.now;
  const ttlMs = opts.ttlMs ?? VARIANTS_TTL_MS;
  const keepMs = opts.keepMs ?? VARIANTS_KEEP_MS;
  let good: { at: number; bySku: VariantsBySku } | null = null;
  let asking: Promise<VariantsBySku | null> | null = null;

  const ask = (): Promise<VariantsBySku | null> => {
    if (asking) return asking;
    const p: Promise<VariantsBySku | null> = Promise.resolve()
      .then(lookup)
      .then(
        (bySku) => {
          if (bySku && bySku.size > 0) good = { at: now(), bySku };
          return bySku ?? null;
        },
        () => null,
      )
      .finally(() => {
        if (asking === p) asking = null;
      });
    asking = p;
    return p;
  };

  const fresh = () => (good && now() - good.at < ttlMs ? good.bySku : null);

  return {
    current: async () => fresh() ?? ask(),
    recheck: async () => (good && now() - good.at < RECHECK_MIN_MS ? good.bySku : ask()),
    forDisplay: async (waitMs) => {
      const known = fresh();
      if (known) return known;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<"late">((resolve) => {
        timer = setTimeout(() => resolve("late"), waitMs);
      });
      const answer = await Promise.race([ask(), late]);
      clearTimeout(timer);
      if (answer !== "late" && answer && answer.size > 0) return answer;
      // Slow, down, or an empty answer: what the store last said, if it said
      // anything within the day. (A slow answer still lands in the book when
      // it comes, for the next page.)
      return good && now() - good.at < keepMs ? good.bySku : null;
    },
  };
}
