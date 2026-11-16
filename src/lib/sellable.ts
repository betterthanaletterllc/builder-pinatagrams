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
 * box photo and label placement there, and add a variant to the product
 * whose SKU is EXACTLY what customSkuFor gives for the hub's id — capitals,
 * spaces where the id has hyphens, nothing before or after ("glitter" →
 * CUSTOM-GLITTER, "star-spangled" → CUSTOM-STAR SPANGLED). A near miss
 * ("Custom-Glitter", a trailing space) is no variant at all, here as at
 * checkout, and nothing on screen says so — only the server log does
 * ("[sellable] not listed …"). The style is then listed by itself, usually
 * within ten to twenty minutes: each server keeps the store's list ten
 * minutes and shows the one it has while it fetches the next.
 * The styles lib/hub's styleOffered leaves out stay out whatever the store has.
 *
 * When the store's list is NOT KNOWN — a deployment without the store's keys
 * (local, previews), or a server that has just started while the store is
 * slow or down — every style is listed, as before this rule: a blip must not
 * empty the picker, and checkout still refuses what it cannot sell.
 *
 * A page does not wait on the store when it has anything to go by: a list
 * it holds (up to a day old) is used at once and refreshed behind the page;
 * a server that holds none goes by SEEN_IN_STORE when that covers every
 * style the hub lists; only otherwise does it wait, briefly.
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
  const special = Object.hasOwn(SKU_SUFFIX_SPECIAL, styleId) ? SKU_SUFFIX_SPECIAL[styleId] : null;
  return `CUSTOM-${special ?? styleId.toUpperCase().replace(/-/g, " ")}`;
}

/** The store's answer: the product's variant ids, by SKU. */
export type VariantsBySku = ReadonlyMap<string, string>;
/** Anything that can say whether the store has a SKU (a map of them, a set). */
export type SkuList = { has(sku: string): boolean };

/**
 * The product's variants as the store had them on 2026-11-15 (read from the
 * store that day; tests/sellable.test.mjs holds the same list).
 *
 * Only a shortcut, never the rule: a server that has just started and holds
 * no answer from the store yet goes by this list INSTEAD OF WAITING for one —
 * but only while it covers every style the hub lists, so it can never hide a
 * style, and the store is still asked behind the page. A style that is not
 * on it (a new one) makes such a server wait for the store's own answer;
 * adding its SKU here takes that wait away again, nothing more. The one
 * thing it can get wrong: a variant deleted since still counts on a server's
 * first page — checkout refuses it and says so.
 */
export const SEEN_IN_STORE: ReadonlySet<string> = new Set([
  "CUSTOM-STANDARD",
  "CUSTOM-GOOGLY",
  "CUSTOM-TROPICAL",
  "CUSTOM-PRIDE",
  "CUSTOM-NURSE",
  "CUSTOM-DOCTOR",
  "CUSTOM-GRAD",
  "CUSTOM-STAR SPANGLED",
  "CUSTOM-REINDEER",
  "CUSTOM-VAMPIRE",
  "CUSTOM-CAMO",
  "CUSTOM-WHITE UNICORN",
  "CUSTOM-PINK UNICORN",
  "CUSTOM-RED",
  "CUSTOM-BLUE",
  "CUSTOM-PURPLE",
  "CUSTOM-ORANGE",
  "CUSTOM-GREEN",
  "CUSTOM-MONEY",
]);

/** The SKUs of these styles; a row that is not a style has none. */
export function styleSkus(styles: readonly ({ id?: unknown } | null | undefined)[]): string[] {
  return styles.flatMap((s) => (typeof s?.id === "string" ? [customSkuFor(s.id)] : []));
}

/**
 * The styles that can be sold: those whose variant the store has, in their
 * order. `variants` null = the store's list is not known: every style passes.
 * A SKU matches exactly, as it must at checkout — "Custom-Googly" is not
 * CUSTOM-GOOGLY there either.
 */
export function sellableStyles<T extends { id: string }>(
  styles: readonly T[],
  variants: SkuList | null,
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
  variants: SkuList | null,
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

/**
 * What the server log is told about a catalog that came out of
 * withSellableStyles — the only place a hidden style is ever mentioned.
 * null = nothing was left out. `key` is the same for the same situation, so
 * a caller can say it once and not on every page view.
 */
export function sellableNote(
  result: { leftOut: readonly ({ id?: unknown } | null | undefined)[]; disbelieved: boolean },
  listed: number,
): { key: string; level: "warn" | "error"; line: string } | null {
  if (result.disbelieved) {
    return {
      key: "disbelieved",
      level: "error",
      line: `[sellable] the store's variants match none of the hub's ${listed} body styles — listing them all; checkout answers "couldn't reach our store". Check the SKUs on the Custom Built Piñatagram product (CUSTOM-{BODY}).`,
    };
  }
  if (result.leftOut.length === 0) return null;
  const names = result.leftOut
    .map((s) => (typeof s?.id === "string" ? `${s.id} (needs SKU ${JSON.stringify(customSkuFor(s.id))})` : "a row with no id"))
    .join(", ");
  return {
    key: names,
    level: "warn",
    line: `[sellable] not listed — active in the hub, no variant on the Custom Built Piñatagram product: ${names}`,
  };
}

/* --- the store's list, remembered ------------------------------------------- */

/** How long an answer from the store is used without asking again. */
export const VARIANTS_TTL_MS = 10 * 60_000;
/** How long the last answer may still decide what the PAGES list when the
 *  store cannot be asked (checkout never sells from a list older than the
 *  TTL). The same day lib/hub keeps its last good catalog. */
export const VARIANTS_KEEP_MS = 24 * 60 * 60_000;
/** After the store failed to answer, the pages leave it alone this long —
 *  a store that is down is not asked again on every page view. Checkout
 *  always asks. */
export const DISPLAY_RETRY_MS = 30_000;
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
  /** What a page can go by without asking anyone: the last answer, if it is
   *  at most VARIANTS_KEEP_MS old, and whether it is past its ten minutes. */
  held(): { variants: VariantsBySku; stale: boolean } | null;
  /** Ask the store on the pages' behalf — unless there is no point: the list
   *  is within its ten minutes, or the store failed to answer moments ago.
   *  Returns the open question (this one, or one already on its way), for
   *  the caller to keep its server alive on; null when none was needed.
   *  Never rejects. */
  refresh(): Promise<VariantsBySku | null> | null;
  /** The open question's answer, if it comes within what is left of
   *  `waitMs` counted from when the question was put — so a hung store costs
   *  one page that long, not every page. null: no question open, too slow,
   *  failed, or an empty answer. */
  answerWithin(waitMs: number): Promise<VariantsBySku | null>;
};

type Open = { answer: Promise<VariantsBySku | null>; since: number };

/**
 * The store's list of variants, kept in this server process's memory.
 * `lookup` asks the store: a map (possibly empty) is its answer, null or a
 * throw is "could not be read". Only a real, non-empty answer is kept — an
 * empty or failed one kept here would go on refusing orders and hiding
 * styles for ten minutes after the fix.
 *
 * Checkouts that ask at the same moment share one question, and so do pages.
 * A page may ride on a checkout's question; a checkout never rides on a
 * page's — nothing waits for a page's question once the page has gone, and
 * an order must not hang on that.
 */
export function createVariantBook(
  lookup: () => Promise<VariantsBySku | null>,
  opts: { now?: () => number; ttlMs?: number; keepMs?: number; retryMs?: number } = {},
): VariantBook {
  const now = opts.now ?? Date.now;
  const ttlMs = opts.ttlMs ?? VARIANTS_TTL_MS;
  const keepMs = opts.keepMs ?? VARIANTS_KEEP_MS;
  const retryMs = opts.retryMs ?? DISPLAY_RETRY_MS;
  let good: { at: number; bySku: VariantsBySku } | null = null;
  let failedAt: number | null = null;
  let forCheckout: Open | null = null;
  let forPages: Open | null = null;

  const ask = (): Promise<VariantsBySku | null> =>
    Promise.resolve()
      .then(lookup)
      .then(
        (bySku) => {
          if (bySku && bySku.size > 0) {
            good = { at: now(), bySku };
            failedAt = null;
          } else {
            failedAt = now();
          }
          return bySku ?? null;
        },
        () => {
          failedAt = now();
          return null;
        },
      );

  const askForCheckout = (): Promise<VariantsBySku | null> => {
    if (forCheckout) return forCheckout.answer;
    const answer = ask().finally(() => {
      if (forCheckout?.answer === answer) forCheckout = null;
    });
    forCheckout = { answer, since: now() };
    return answer;
  };

  const fresh = () => (good && now() - good.at < ttlMs ? good.bySku : null);

  return {
    current: async () => fresh() ?? askForCheckout(),
    recheck: async () =>
      good && now() - good.at < RECHECK_MIN_MS ? good.bySku : askForCheckout(),
    held: () =>
      good && now() - good.at < keepMs
        ? { variants: good.bySku, stale: now() - good.at >= ttlMs }
        : null,
    refresh: () => {
      if (fresh()) return null;
      const open = forPages ?? forCheckout;
      if (open) return open.answer;
      if (failedAt !== null && now() - failedAt < retryMs) return null;
      const answer = ask().finally(() => {
        if (forPages?.answer === answer) forPages = null;
      });
      forPages = { answer, since: now() };
      return answer;
    },
    answerWithin: async (waitMs) => {
      const open = forPages ?? forCheckout;
      if (!open) return null;
      const left = waitMs - (now() - open.since);
      if (left <= 0) return null;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), left);
      });
      const answer = await Promise.race([open.answer, late]);
      clearTimeout(timer);
      return answer && answer.size > 0 ? answer : null;
    },
  };
}

/**
 * Which list a page goes by, in order: the list the book holds (fresh, or
 * the last one there was — never waited for); else SEEN_IN_STORE, when it
 * covers every style about to be listed; else the store's answer to the
 * question already open, if it comes in time; else null — not known.
 * The caller has already called book.refresh(): this never asks by itself.
 */
export async function variantsForDisplay(input: {
  book: Pick<VariantBook, "held" | "answerWithin">;
  styles: readonly ({ id?: unknown } | null | undefined)[];
  seen: SkuList;
  waitMs: number;
}): Promise<{ variants: SkuList | null; from: "store" | "last" | "seen" | "unknown" }> {
  const held = input.book.held();
  if (held) return { variants: held.variants, from: held.stale ? "last" : "store" };
  if (styleSkus(input.styles).every((sku) => input.seen.has(sku))) {
    return { variants: input.seen, from: "seen" };
  }
  const answer = await input.book.answerWithin(input.waitMs);
  return answer ? { variants: answer, from: "store" } : { variants: null, from: "unknown" };
}

/* --- checkout's two decisions ------------------------------------------------- */

/**
 * The list checkout goes by. A body that is not on the first list may be
 * missing from a list that is minutes old (its variant added since): the
 * store is asked once more — `recheck` — before a piñata is refused for it.
 * The second answer counts only if it is a list; unreadable or empty, the
 * first one stands. Nothing is asked twice when every body is there, or when
 * there was no list to begin with.
 */
export async function variantsForCheckout(
  first: VariantsBySku | null,
  lineSkus: readonly string[],
  recheck: () => Promise<VariantsBySku | null>,
): Promise<VariantsBySku | null> {
  if (!first || first.size === 0) return first;
  if (lineSkus.every((sku) => first.has(sku))) return first;
  const second = await recheck();
  return second && second.size > 0 ? second : first;
}

/**
 * What checkout does with that list, before anything is created.
 *   go: false — the store's trouble, not any one piñata's: the list could
 *     not be read ("unreadable"), the product has no variant at all
 *     ("empty"), or it has variants and none is for a style sold here
 *     ("matches-nothing" — SKUs renamed; telling a shopper to swap the body
 *     would send them round in a circle). The customer hears "couldn't reach
 *     our store".
 *   go: true — `missing` are the SKUs of the piñatas whose body has no
 *     variant; each is refused by name. Empty = every piñata can be sold.
 */
export function checkoutVariantVerdict(input: {
  variants: VariantsBySku | null;
  /** The SKUs of every style the catalog offers. */
  offeredSkus: readonly string[];
  /** The SKU of each piñata in the cart, in order. */
  lineSkus: readonly string[];
}):
  | { go: false; why: "unreadable" | "empty" | "matches-nothing" }
  | { go: true; missing: string[] } {
  const { variants } = input;
  if (!variants) return { go: false, why: "unreadable" };
  if (variants.size === 0) return { go: false, why: "empty" };
  if (!input.offeredSkus.some((sku) => variants.has(sku))) {
    return { go: false, why: "matches-nothing" };
  }
  return { go: true, missing: [...new Set(input.lineSkus.filter((sku) => !variants.has(sku)))] };
}
