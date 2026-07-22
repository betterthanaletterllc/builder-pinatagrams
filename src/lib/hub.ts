/**
 * Typed client for the hub's PUBLIC read API (admin.betterthanaletter.com).
 * The hub is the source of truth for catalog, availability and pricing; the
 * builder is a READER of the public plane only. These types mirror exactly
 * what /api/public/* returns — customer-safe fields, no COGS, availability
 * as a boolean. If a field isn't here, the builder shouldn't want it.
 */

export const HUB_URL =
  process.env.NEXT_PUBLIC_HUB_URL ?? "https://admin.betterthanaletter.com";

export type LogoZone = { x: number; y: number; w: number; h: number };

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
  if (d.kind === "shipping") return shippingCents; // free shipping
  const off =
    d.type === "percent"
      ? Math.round((merchandiseCents * d.value) / 100)
      : d.value;
  // paired code: the one code takes the merchandise off AND the shipping
  return Math.min(off, merchandiseCents) + (d.freeShipping ? shippingCents : 0);
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
  // Builder pricing knobs (graphic tiers + USPS rate); parse with
  // resolveBuilderPricing — absent on older hub deploys.
  pricing?: unknown;
  // Delivery calendars (admin /delivery); parse with resolveDeliveryConfig —
  // absent or partial blocks fall back to the compiled defaults.
  delivery?: unknown;
  asOf: string;
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

/** Server-side catalog fetch; short cache so admin edits land in ~2 minutes. */
export async function getCatalog(): Promise<HubCatalog> {
  const res = await fetch(`${HUB_URL}/api/public/catalog`, {
    next: { revalidate: 60 },
  });
  if (!res.ok) throw new Error(`hub catalog: HTTP ${res.status}`);
  return res.json();
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
