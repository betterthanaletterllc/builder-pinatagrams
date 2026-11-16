import "server-only";
import { after } from "next/server";
import { getCatalog, type HubCatalog } from "./hub";
import {
  createVariantBook,
  CUSTOM_PRODUCT_GID,
  SEEN_IN_STORE,
  sellableNote,
  variantsForDisplay,
  withSellableStyles,
  type VariantsBySku,
} from "./sellable";
import { shopifyCreds, shopifyGraphql, shopifyTokenScope } from "./shopify";

/**
 * The store's side of "what this builder can sell" (lib/sellable has the
 * whole story): the Custom Built Piñatagram product's variants, asked for
 * with the same Admin client checkout uses, and the catalog the pages list
 * their body styles from.
 *
 * Two readers of one book — per server process. Where a page and checkout
 * run in different ones, each keeps its own, which changes nothing but how
 * often the store is asked:
 *   - checkout attaches every piñata to its variant (customVariants), and
 *     looks once more before it refuses one (recheckCustomVariants);
 *   - the pages list only the styles that have one (getSellableCatalog).
 */

// What the store was last heard to have, so the log says it when it is first
// learned and when it changes — not on every lookup.
let lastLearned = "";

/** One round trip: every variant of the product, by SKU. null = the store
 *  could not be read, or this deployment has no keys for it. */
async function lookupCustomVariants(): Promise<VariantsBySku | null> {
  const creds = shopifyCreds();
  if (!creds) return null;
  try {
    const r = await shopifyGraphql<{
      product: {
        variants: {
          nodes: { id: string; sku: string | null }[];
          pageInfo: { hasNextPage: boolean };
        };
      } | null;
    }>(
      creds,
      `query($id: ID!) {
        product(id: $id) {
          variants(first: 100) { nodes { id sku } pageInfo { hasNextPage } }
        }
      }`,
      { id: CUSTOM_PRODUCT_GID },
    );
    if (r.status !== 200 || r.errors) {
      // Scope trouble is the #1 setup failure, so "Access denied" also logs
      // what the cached token carries (scope handles are config, not secrets).
      const raw = JSON.stringify(r.body);
      console.error(`custom variant lookup failed (HTTP ${r.status})`, raw);
      if (raw?.includes("Access denied")) {
        console.error(`custom variant lookup: token scopes: ${shopifyTokenScope() || "(none)"}`);
      }
      return null;
    }
    const variants = r.data?.product?.variants;
    if (variants?.pageInfo?.hasNextPage) {
      // More body styles than one page: the ones past it would read as "not
      // sold here". Nowhere near (19 on 2026-11-15) — say so if it happens.
      console.error("custom variant lookup: the product has more than 100 variants — only the first 100 were read");
    }
    const bySku = new Map<string, string>();
    for (const n of variants?.nodes ?? []) {
      if (n?.sku) bySku.set(n.sku, n.id);
    }
    const learned = [...bySku.keys()].sort().join("|");
    if (learned !== lastLearned) {
      lastLearned = learned;
      console.log(
        `[sellable] the store has ${bySku.size} variant${bySku.size === 1 ? "" : "s"} of the Custom Built Piñatagram product`,
      );
    }
    return bySku;
  } catch (e) {
    console.error(`custom variant lookup failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

const book = createVariantBook(lookupCustomVariants);

/** Checkout's list of variant ids by SKU: at most ten minutes old. null =
 *  the store is unreachable or unreadable (retry); a map missing a SKU = that
 *  body is not sold here. */
export const customVariants = (): Promise<VariantsBySku | null> => book.current();

/** Checkout's second look before refusing a body that is not on its list —
 *  a variant added since the list was read is found here. */
export const recheckCustomVariants = (): Promise<VariantsBySku | null> => book.recheck();

// A page that has NOTHING to go by — no list held, and a style the hub lists
// that SEEN_IN_STORE does not know — waits this long for the store before it
// lists every style as it did before (lib/sellable: "not known"). The hub
// read beside it has 3s. Every other page does not wait at all.
const DISPLAY_WAIT_MS = 1500;

/** Keep this server alive until the store's answer has landed in the book:
 *  the page that asked has usually been sent by then. */
function keepAliveFor(question: Promise<unknown>): void {
  try {
    after(() => question);
  } catch {
    // Not inside a request (a build step, a test): the question simply runs.
  }
}

// What was last said to the log, so one situation is said once per server
// process, not once per page view.
let lastSaid = "";

/**
 * The hub's catalog as the style pickers list it: lib/hub's getCatalog (the
 * hub's styles minus the ones this builder does not offer), minus the styles
 * the store has no variant for. Throws when getCatalog throws; the store
 * being slow or down never does — see lib/sellable for what is listed then.
 *
 * Every page that lists body styles to choose from reads this. The staff
 * editor (/embed/design) reads getCatalog instead: it shows the box of the
 * body an order already has, sold here or not.
 */
export async function getSellableCatalog(opts?: {
  host?: string | null;
  previewVariant?: string | null;
}): Promise<HubCatalog> {
  // No keys for the store (local, previews): the hub's list, as ever.
  if (!shopifyCreds()) return getCatalog(opts);

  // Put beside the hub read, not after it; and only when there is a point —
  // no list within its ten minutes, and the store not just found down.
  const question = book.refresh();
  if (question) keepAliveFor(question);

  const catalog = await getCatalog(opts);
  const { variants } = await variantsForDisplay({
    book,
    styles: catalog.bodyStyles,
    seen: SEEN_IN_STORE,
    waitMs: DISPLAY_WAIT_MS,
  });
  const result = withSellableStyles(catalog, variants);
  const note = sellableNote(result, catalog.bodyStyles.length);
  if ((note?.key ?? "") !== lastSaid) {
    lastSaid = note?.key ?? "";
    if (note) (note.level === "error" ? console.error : console.warn)(note.line);
  }
  return result.catalog;
}
