import "server-only";
import { getCatalog, type HubCatalog } from "./hub";
import {
  createVariantBook,
  CUSTOM_PRODUCT_GID,
  customSkuFor,
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
 * Two readers, one book:
 *   - checkout attaches every piñata to its variant (customVariants), and
 *     looks once more before it refuses one (recheckCustomVariants);
 *   - the pages list only the styles that have one (getSellableCatalog).
 */

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

// A page waits this long for the store before it lists every style as it
// did before (lib/sellable: "not known"). The hub read beside it has 3s.
const DISPLAY_WAIT_MS = 1500;

// What was last said to the log, so one situation is said once per server
// instance, not once per page view.
let lastSaid = "";
function say(key: string, line: () => void): void {
  if (key === lastSaid) return;
  lastSaid = key;
  if (key) line();
}

/**
 * The hub's catalog as the style pickers list it: lib/hub's getCatalog (the
 * hub's styles minus the ones this builder does not offer), minus the styles
 * the store has no variant for. Throws when getCatalog throws; the store
 * being slow or down never does — the styles are then all listed.
 *
 * Every page that lists body styles to choose from reads this. The staff
 * editor (/embed/design) reads getCatalog instead: it shows the box of the
 * body an order already has, sold here or not.
 */
export async function getSellableCatalog(opts?: {
  host?: string | null;
  previewVariant?: string | null;
}): Promise<HubCatalog> {
  const [catalog, variants] = await Promise.all([
    getCatalog(opts),
    shopifyCreds() ? book.forDisplay(DISPLAY_WAIT_MS) : null,
  ]);
  const { catalog: sellable, leftOut, disbelieved } = withSellableStyles(catalog, variants);
  if (disbelieved) {
    say("disbelieved", () =>
      console.error(
        `[sellable] the store's variants match none of the hub's ${catalog.bodyStyles.length} body styles — listing them all; checkout will refuse them. Check the SKUs on the Custom Built Piñatagram product (CUSTOM-{BODY}).`,
      ),
    );
  } else {
    const names = leftOut.map((s) => `${s.id} (${customSkuFor(s.id)})`).join(", ");
    say(names, () =>
      console.warn(
        `[sellable] not listed — active in the hub, no variant on the Custom Built Piñatagram product: ${names}`,
      ),
    );
  }
  return sellable;
}
