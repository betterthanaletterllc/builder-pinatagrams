/**
 * Typed client for the hub's PUBLIC read API (admin.betterthanaletter.com).
 * The hub is the source of truth for catalog, availability and pricing; the
 * builder is a READER of the public plane only. These types mirror exactly
 * what /api/public/* returns — customer-safe fields, no COGS, availability
 * as a boolean. If a field isn't here, the builder shouldn't want it.
 *
 * One thing the builder decides for itself: which of the hub's body styles
 * it offers at all (styleOffered below — the hub lists every style the
 * business stocks, and not all of them are sold here).
 */

export const HUB_URL =
  process.env.NEXT_PUBLIC_HUB_URL ?? "https://admin.betterthanaletter.com";

// Every hub read is time-boxed: a hung hub must degrade (fallback data, a
// "—" price, no discount preview), never hang a page render or a tap.
export const HUB_TIMEOUT_MS = 3000;
const DISCOUNT_TIMEOUT_MS = 5000; // client → our /api/discount proxy → hub

/** An abort signal that fires after `ms` — AbortSignal.timeout where it
 *  exists, a timer elsewhere (older iOS Safari lacks it, and a throw there
 *  would read as "no discount" forever). */
export function hubTimeout(ms = HUB_TIMEOUT_MS): AbortSignal | undefined {
  try {
    if (typeof AbortSignal.timeout === "function") return AbortSignal.timeout(ms);
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), ms);
    return ctrl.signal;
  } catch {
    return undefined;
  }
}

export type LogoZone = { x: number; y: number; w: number; h: number };

// Label placements measured on box photos the hub serves without one (the
// admin /catalog "Box placement" wasn't set), keyed by the photo's path.
// Photos aren't all framed alike — Green's box is smaller and higher than
// the rest — so a placement belongs to its photo, never borrowed.
const MEASURED_LOGO_ZONES: Record<string, LogoZone> = {
  // front panel x 224–836, y 656–952 of 1080 × 1080 (2026-09-30)
  "/catalog/boxes/green.png": { x: 0.2074, y: 0.6074, w: 0.5667, h: 0.2741 },
};

function measuredZone(photoUrl: string): LogoZone | null {
  try {
    return MEASURED_LOGO_ZONES[new URL(photoUrl).pathname] ?? null;
  } catch {
    return null;
  }
}

/**
 * A style whose box photo is in the hub but whose label placement isn't
 * (Green, 2026-09-30) showed a blank label — no zone, no design on the box.
 * It gets its photo's measured placement; with none, it's shown like a
 * style without a photo (the piñata over its label) rather than with the
 * design at a guessed spot. The hub's own placement always wins.
 */
export function withBoxZones(styles: HubBodyStyle[]): HubBodyStyle[] {
  if (!styles.some((b) => b.boxImageUrl && !b.logoZone)) return styles;
  return styles.map((b) => {
    if (!b.boxImageUrl || b.logoZone) return b;
    const zone = measuredZone(b.boxImageUrl);
    return zone ? { ...b, logoZone: zone } : { ...b, boxImageUrl: null };
  });
}

/**
 * Hub body styles this builder does not offer.
 *
 * The hub's catalog is every style the business stocks. Its "active" tick
 * (admin /catalog) is what lists a style on the hub's own Inventory page, in
 * its stock digest and its alerts — and, with the same tick, on every site
 * that reads the hub. So a style that is stocked but not sold HERE stays
 * ticked there, and is left out here.
 *
 * Nathan, 2026-11-15, when two of them turned up in the journey's style
 * picker and on the staff page Paper frames: "Chonky and checkered should
 * not appear on the builder. chonky never should because it is a completely
 * different product and has different options and checkered shouldn't until
 * we have a photo".
 *
 * NEVER — the Chonky: a bigger piñata in its own box, with its own options
 * and its own price ("Every piñata is 11 inches tall" is not true of it).
 * Any hub style whose id or name says Chonky, so that a second one
 * ("chonky-pink", "chonky2") does not walk in the way the first did. Mind
 * the other edge of that: a style NAMED with the word — "Standard (not the
 * Chonky)" — is left out as well, so a name in the hub is not only a label.
 *
 * NOT YET — the Checkered, by hub id. It comes back when ALL of these are
 * true, and not before; each one missing is an empty tile or a dead end:
 *   1. its cut-out is in the hub's store (catalog/cutouts/checkered.png).
 *      The style sheet and the Stage draw that file; without it the tile is
 *      an empty frame — the photo "until we have a photo" was about;
 *   2. its box photo AND the label placement on it are set in the hub's
 *      /catalog (on 2026-11-15 the box picture there is a mock-up, with no
 *      placement);
 *   3. the Custom Built Piñatagram product in Shopify has a CUSTOM-CHECKERED
 *      variant. Without it nobody can buy one — which is how these two sat
 *      in the picker on 2026-11-15, checkout answering "temporarily
 *      unavailable". Since then a style without its variant is not listed
 *      at all (lib/sellable), so this step alone would bring the Checkered
 *      back were it not for the list below: steps 1 and 2 are why it is on
 *      that list;
 *   4. then take "checkered" out of NOT_YET_OFFERED and out of
 *      tests/styles.test.mjs and tests/sellable.test.mjs (both expect it to
 *      be left out), drop the "for now" / "not yet" about it from README.md
 *      (two places) and app/embed/design/page.tsx, and put one through a
 *      REAL checkout: the answer has to carry an invoice link. A deployment
 *      without the Shopify keys answers `dryRun` before it ever looks for
 *      the variant, and proves nothing about step 3. (A variant made a
 *      moment ago can take ten to twenty minutes to show in the picker —
 *      lib/sellable says why. Adding its SKU to SEEN_IN_STORE there spares
 *      a just-started server a short wait: do that only AFTER the variant
 *      exists in the store — the server log says when the list needs it.)
 *   5. the quote tool keeps its own copy of this rule (quote repo:
 *      src/lib/styles-offered.ts, with its own "comes back when"). Lift it
 *      there in the same go, or the Checkered is back here and still hidden
 *      there.
 *
 * What it covers: every page as it loads (the style pickers, ?style=, the
 * home page, the staff embed), and checkout, which refuses a line that
 * names one. A piñata saved in a shopper's browser before a style left
 * still shows in their order; the journey gives it another body, out loud,
 * when it is opened (STYLE_GONE_NOTE in v2/lib/restore).
 *
 * This list is the styles left out BY NAME. The other half of "what is sold
 * here" needs no list: a hub style the store has no variant for is not
 * listed either (lib/sellable, lib/sellable-server getSellableCatalog).
 */
export const NOT_YET_OFFERED: ReadonlySet<string> = new Set(["checkered"]);

// "chonky" with no letter against it, in an id or a name: chonky,
// chonky-pink, chonky2, "Chonky Donkey" — not "chonkyish".
const CHONKY = /(^|[^a-z])chonky([^a-z]|$)/i;

/** Does this builder offer the hub's style? */
export function styleOffered(
  style: { id?: unknown; name?: unknown } | null | undefined,
): boolean {
  const id = String(style?.id ?? "").trim().toLowerCase();
  if (CHONKY.test(id) || CHONKY.test(String(style?.name ?? ""))) return false;
  return !NOT_YET_OFFERED.has(id);
}

/** The hub's body styles, minus the ones this builder does not offer. */
export function offeredStyles<T extends { id: string; name?: string }>(
  styles: readonly T[],
): T[] {
  return styles.filter((s) => styleOffered(s));
}

export type HubBodyStyle = {
  id: string;
  name: string;
  imageUrl: string | null;
  boxImageUrl: string | null;
  logoZone: LogoZone | null;
  // Admin-placed position of this piñata inside the open-box interior photo.
  pinataZone?: LogoZone | null;
  // Hub-hosted transparent cutout (catalog/cutouts/{id}.png) for the box scene.
  cutoutUrl?: string | null;
  inStock: boolean;
};

// Optional per-piñata extras (e.g. Double Candy). label doubles as the
// _addons token Paper reads off the order; priceCents is the retail price.
export type HubAddon = {
  id: string;
  label: string;
  priceCents: number;
  sku: string | null;
};

// What goes INSIDE — hub-controlled (photo, blurb, price delta, add-on
// rules). label doubles as the _fillings token Paper reads; `addons` says
// which add-ons this filling permits ("none" = it fills the whole box).
export type HubFilling = {
  id: string;
  label: string;
  blurb: string;
  priceCents: number; // 0 = included in the piñata price
  imageUrl: string | null;
  addons: "all" | "none" | string[];
};

// A resolved discount code for the cart's PREVIEW. The real discount is a
// native Shopify code the builder applies to the draft (Shopify enforces
// value / min / usage / once-per-customer / expiry) — this rule is only to
// show an estimated reduced total; the invoice is the source of truth.
export type HubDiscount = {
  code: string;
  kind: "order" | "shipping"; // shipping = free shipping
  type: "percent" | "fixed"; // order only
  value: number; // percent 1–100, or CENTS for fixed (order only)
  minSubtotalCents: number; // 0 = no minimum
  // paired order code: ALSO zeroes shipping (one code, product + shipping)
  freeShipping?: boolean;
  // Shopify-native free-shipping codes can be scoped to "shipping rates
  // under $X" — CENTS, absent = uncapped (every hub-minted code).
  maxShippingCents?: number;
};

/**
 * Resolve a discount code against the hub (through the builder's own
 * rate-limited /api/discount proxy — same origin, no CORS). Returns null
 * for unknown/inactive codes; never throws (a lookup blip = no discount).
 * Client-only (uses a relative URL).
 */
export async function resolveDiscount(
  code: string,
): Promise<HubDiscount | null> {
  const clean = code.trim().toUpperCase();
  if (!clean) return null;
  try {
    const res = await fetch("/api/discount", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: clean }),
      signal: hubTimeout(DISCOUNT_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const j = await res.json();
    return (j?.discount as HubDiscount | null) ?? null;
  } catch {
    return null;
  }
}

/** PREVIEW estimate of the cents a code saves (0 if the min isn't met).
 *  Shipping codes zero out the shipping; order codes take %/$ off the
 *  merchandise. The real discount is the native Shopify code applied to the
 *  draft — Shopify computes the invoice total, so this only drives the
 *  cart's estimate and the customer confirms the true total before paying. */
export function discountAmountCents(
  d: HubDiscount | null,
  merchandiseCents: number,
  shippingCents: number,
): number {
  if (!d || merchandiseCents < d.minSubtotalCents) return 0;
  // A capped code covers shipping only when the rate is strictly UNDER the
  // cap — Shopify's own "applies to shipping rates under $X" semantics.
  const shipCovered =
    d.maxShippingCents == null || shippingCents < d.maxShippingCents;
  if (d.kind === "shipping") return shipCovered ? shippingCents : 0;
  const off =
    d.type === "percent"
      ? Math.round((merchandiseCents * d.value) / 100)
      : d.value;
  // paired code: the one code takes the merchandise off AND the shipping
  return (
    Math.min(off, merchandiseCents) +
    (d.freeShipping && shipCovered ? shippingCents : 0)
  );
}

/**
 * Builder pricing knobs (hub /pricing → served on the catalog): version-B
 * graphic tiers — the Classic Piñatagrams default sells at the base retail
 * price, a library pick and a custom design each add a flat upcharge — plus
 * the USPS First Class ship rate (FedEx comes from /api/public/price).
 */
export type BuilderPricing = {
  graphicLibraryUpchargeCents: number;
  graphicCustomUpchargeCents: number;
  uspsShipPerUnitCents: number;
};

const DEFAULT_BUILDER_PRICING: BuilderPricing = {
  graphicLibraryUpchargeCents: 200,
  graphicCustomUpchargeCents: 500,
  uspsShipPerUnitCents: 650,
};

/** Merge the hub's (possibly partial/absent) pricing block over defaults. */
export function resolveBuilderPricing(raw: unknown): BuilderPricing {
  const r = (raw ?? {}) as Partial<Record<keyof BuilderPricing, unknown>>;
  const cents = (v: unknown, fb: number) =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : fb;
  return {
    graphicLibraryUpchargeCents: cents(
      r.graphicLibraryUpchargeCents,
      DEFAULT_BUILDER_PRICING.graphicLibraryUpchargeCents,
    ),
    graphicCustomUpchargeCents: cents(
      r.graphicCustomUpchargeCents,
      DEFAULT_BUILDER_PRICING.graphicCustomUpchargeCents,
    ),
    uspsShipPerUnitCents: cents(
      r.uspsShipPerUnitCents,
      DEFAULT_BUILDER_PRICING.uspsShipPerUnitCents,
    ),
  };
}

// A graphic uploaded in the hub (admin /catalog → "Hub graphics") — no
// Shopify product behind it. `art` + `artSha256` live on the BUILDER's blob
// store (permanent library/ prefix) and ride orders through the same
// fingerprinted rail as custom designs. The catalog serves ONLY the folders
// this storefront may sell (public + granted), so everything here shelves.
// `title` is INTERNAL (hub organization + order rails) — customers only
// ever see the art and the folder label.
export type HubGraphicEntry = {
  design: string; // H0001-style code
  title: string;
  category: string;
  bodyStyles: "all" | string[];
  art: string;
  artSha256: string;
  thumb: string;
};

export type HubGraphicCategory = { id: string; label: string };

/** Parse the catalog's hubGraphics/graphicCategories defensively — absent on
 *  older hub deploys, malformed rows dropped. */
export function resolveHubGraphics(raw: unknown): HubGraphicEntry[] {
  return (Array.isArray(raw) ? raw : [])
    .filter((g): g is Record<string, unknown> => !!g && typeof g === "object")
    .map((g) => ({
      design: String(g.design ?? ""),
      title: String(g.title ?? ""),
      category: String(g.category ?? ""),
      bodyStyles:
        Array.isArray(g.bodyStyles) && g.bodyStyles.length
          ? g.bodyStyles.map(String)
          : ("all" as const),
      art: String(g.art ?? ""),
      artSha256: String(g.artSha256 ?? ""),
      thumb: String(g.thumb ?? ""),
    }))
    .filter((g) => g.design && g.title && g.art && g.artSha256);
}

export function resolveGraphicCategories(raw: unknown): HubGraphicCategory[] {
  return (Array.isArray(raw) ? raw : [])
    .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
    .map((c) => ({
      id: String(c.id ?? ""),
      label: String(c.label ?? ""),
    }))
    .filter((c) => c.id && c.label);
}

export type HubCatalog = {
  bodyStyles: HubBodyStyle[];
  // Global box-interior config (gift-message step); absent on older deploys.
  box?: {
    interiorUrl: string | null;
    messageZone: LogoZone | null;
    // percent padding keeping message text inside the card's border art
    messageCardPadding?: { x: number; y: number } | null;
  };
  // Active add-ons from the hub's Pricing page; absent on older deploys.
  addons?: HubAddon[];
  // Active fillings from the hub's Pricing page; absent or empty → the
  // builder's compiled list applies (resolveFillings in lib/flow).
  fillings?: HubFilling[];
  // Landing-page hero images (admin /pricing → "Landing page"); absent on
  // older hub deploys — the builder falls back to its single-image hero.
  landing?: {
    logo?: string | null;
    images?: { id: string; label: string; url: string }[];
  };
  // Hub-uploaded graphics + categories; parse with resolveHubGraphics /
  // resolveGraphicCategories — absent on older hub deploys.
  hubGraphics?: unknown;
  graphicCategories?: unknown;
  // Builder pricing knobs (graphic tiers + USPS rate); parse with
  // resolveBuilderPricing — absent on older hub deploys.
  pricing?: unknown;
  // The variant profile resolved for the ?host=/?variant= the fetch carried;
  // parse with resolveVariantProfile (lib/variant) — absent on older hubs.
  variant?: unknown;
  // Delivery calendars (admin /delivery); parse with resolveDeliveryConfig —
  // absent or partial blocks fall back to the compiled defaults.
  delivery?: unknown;
  asOf: string;
  // Set by getCatalog (never by the hub) when the live fetch failed and this
  // is the last copy that succeeded on this server instance. Fine to RENDER
  // (checkout re-prices from the hub itself); anything authoritative must
  // not rely on it.
  stale?: { reason: string; fetchedAt: string };
};

export type HubPriceInput = {
  qty: number;
  fill: "filled" | "empty";
  bodyType: "standard" | "custom_color" | "custom_shape";
  graphicType: "stock" | "custom";
  mode: "individual" | "one_location";
  carrier: "standard" | "priority";
  productId?: string;
};

export type HubPrice = {
  productId: string;
  qty: number;
  unitPriceCents: number;
  shipPerUnitCents: number;
  unitDeliveredCents: number;
  orderTotalCents: number;
  moq: number | null;
  meetsMoq: boolean;
  needsQuote: boolean;
  notes: string[];
  asOf: string;
};

/** Build the catalog URL, optionally scoped to a variant resolution: `host`
 *  (production — the hostname the customer visited / checkout's own Host) or
 *  `previewVariant` (non-production ?variant= override, resolved by name). */
export function catalogUrl(opts?: {
  host?: string | null;
  previewVariant?: string | null;
}): string {
  const q = new URLSearchParams();
  if (opts?.previewVariant) q.set("variant", opts.previewVariant);
  else if (opts?.host) q.set("host", opts.host);
  const qs = q.toString();
  return `${HUB_URL}/api/public/catalog${qs ? `?${qs}` : ""}`;
}

// Last catalog that fetched OK, per catalog URL (= per host / previewed
// variant), in this server instance's memory. NOT a cache layer — it's only
// read when the live fetch fails — so c97a4bf's one-cache-layer rule
// stands: every render still asks the hub first.
const lastGoodCatalog = new Map<string, { catalog: HubCatalog; at: number }>();
const LAST_GOOD_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const LAST_GOOD_MAX_KEYS = 32; // a handful of hosts; bounded regardless

/** Server-side catalog fetch. Deliberately UNCACHED here: the hub's edge
 *  cache is the one and only cache layer. Stacking Next's data cache on top
 *  made config edits (folder renames, variant flips) crawl — under sparse
 *  traffic each stale-while-revalidate layer serves one-visit-old data, so
 *  every page view advanced only one layer. One layer = edits land in the
 *  hub cache window (~1–2 min), and a hub blip still degrades to the edge's
 *  stale copy rather than an error.
 *
 *  Capped at HUB_TIMEOUT_MS. When the hub is slow or down, the last copy
 *  this instance fetched for the same host is returned instead, marked
 *  `stale` (≤ 24h old); with no such copy it throws, as before.
 *
 *  bodyStyles is the hub's list minus the styles this builder does not
 *  offer (styleOffered), in the hub's order — the stale copy included.
 *
 *  A page that lists styles to CHOOSE from does not call this: it calls
 *  lib/sellable-server's getSellableCatalog, which also leaves out the
 *  styles the store has no variant for. */
export async function getCatalog(opts?: {
  host?: string | null;
  previewVariant?: string | null;
}): Promise<HubCatalog> {
  const url = catalogUrl(opts);
  try {
    const res = await fetch(url, { cache: "no-store", signal: hubTimeout() });
    if (!res.ok) throw new Error(`hub catalog: HTTP ${res.status}`);
    const catalog = (await res.json()) as HubCatalog;
    if (!Array.isArray(catalog?.bodyStyles)) {
      throw new Error("hub catalog: malformed response");
    }
    catalog.bodyStyles = withBoxZones(offeredStyles(catalog.bodyStyles));
    lastGoodCatalog.delete(url); // re-insert = most recent last
    lastGoodCatalog.set(url, { catalog, at: Date.now() });
    if (lastGoodCatalog.size > LAST_GOOD_MAX_KEYS) {
      lastGoodCatalog.delete(lastGoodCatalog.keys().next().value!);
    }
    return catalog;
  } catch (err) {
    const good = lastGoodCatalog.get(url);
    if (!good || Date.now() - good.at > LAST_GOOD_MAX_AGE_MS) throw err;
    const reason =
      err instanceof Error
        ? err.name === "TimeoutError" || err.name === "AbortError"
          ? `hub catalog: timed out after ${HUB_TIMEOUT_MS}ms`
          : err.message
        : String(err);
    const fetchedAt = new Date(good.at).toISOString();
    console.warn(`[hub] ${reason}; serving the last-known-good catalog from ${fetchedAt}`);
    return { ...good.catalog, stale: { reason, fetchedAt } };
  }
}

/** Server- or client-side price quote, time-boxed like every hub read.
 *  Null on any failure — callers show "—" and retry, never block the flow.
 *  Prices are display-only everywhere but checkout, which re-prices. */
export async function fetchHubPrice(
  input: HubPriceInput,
  init?: { signal?: AbortSignal },
): Promise<HubPrice | null> {
  try {
    const signal = init?.signal
      ? anySignal([init.signal, hubTimeout()])
      : hubTimeout();
    const res = await fetch(priceUrl(input), { cache: "no-store", signal });
    if (!res.ok) return null;
    const p = (await res.json()) as HubPrice;
    return Number.isFinite(p?.unitPriceCents) ? p : null;
  } catch {
    return null;
  }
}

/** Abort when ANY of the signals does (AbortSignal.any where supported). */
function anySignal(signals: (AbortSignal | undefined)[]): AbortSignal | undefined {
  const live = signals.filter((s): s is AbortSignal => !!s);
  if (typeof AbortSignal.any === "function") return AbortSignal.any(live);
  const ctrl = new AbortController();
  for (const s of live) {
    if (s.aborted) ctrl.abort();
    else s.addEventListener("abort", () => ctrl.abort(), { once: true });
  }
  return ctrl.signal;
}

/* ---- Reviews (hub /api/public/reviews) -------------------------------- */

// One published review, minimally typed — only the fields the builder
// renders. Reviews are USER-GENERATED CONTENT: render as escaped text only
// (default JSX), never as HTML.
export type HubReview = {
  id: string;
  name: string;
  rating: number; // 1–5
  title: string | null;
  body: string;
  verified: boolean;
  incentivized: boolean; // true → visible FTC disclosure badge REQUIRED
  reply: string | null; // merchant reply — shop-authored, customer-safe
  media: { url: string; kind: string }[];
  createdAt: string;
  // Provenance for the pooled corpus: what this reviewer actually bought.
  // Render nothing when null — never a generic product name.
  purchased: { title: string; bodyStyleId: string | null } | null;
};

export type HubReviews = {
  // Ratings are BRAND-POOLED — the scope label must render in the same
  // visual unit as any aggregate number (the API's own display contract).
  scope: { label: string };
  aggregate: { rating: number; count: number };
  reviews: HubReview[];
  asOf: string;
};

/** Server-side reviews fetch; same base URL + short cache as the catalog.
 *  Null on ANY failure — review UI is a bonus, the page renders without it.
 *  `offset` pages through the newest-first corpus (hub caps limit at 100);
 *  aggregate/scope always describe the WHOLE corpus, not the page. */
export async function getReviews(opts?: {
  limit?: number;
  offset?: number;
}): Promise<HubReviews | null> {
  try {
    const q = new URLSearchParams();
    if (opts?.limit) q.set("limit", String(opts.limit));
    if (opts?.offset) q.set("offset", String(opts.offset));
    const qs = q.size ? `?${q}` : "";
    // 4s cap: reviews are optional, so a hung hub must time out into the null
    // fallback instead of blocking the homepage render.
    const res = await fetch(`${HUB_URL}/api/public/reviews${qs}`, {
      next: { revalidate: 60 },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as HubReviews;
    if (
      !j ||
      typeof j.aggregate?.rating !== "number" ||
      typeof j.aggregate?.count !== "number" ||
      typeof j.scope?.label !== "string" ||
      !Array.isArray(j.reviews)
    )
      return null;
    return j;
  } catch {
    return null;
  }
}

/** URL builder shared by server and client fetches. */
export function priceUrl(input: HubPriceInput): string {
  const q = new URLSearchParams({
    qty: String(input.qty),
    fill: input.fill,
    bodyType: input.bodyType,
    graphicType: input.graphicType,
    mode: input.mode,
    carrier: input.carrier,
  });
  if (input.productId) q.set("productId", input.productId);
  return `${HUB_URL}/api/public/price?${q}`;
}

export function formatCents(cents: number): string {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
}
