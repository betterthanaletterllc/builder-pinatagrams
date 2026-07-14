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

// A resolved discount code (from the hub via the builder's /api/discount).
// The builder only ever handles the CODE + this resolved rule — the amount
// is recomputed server-side at checkout, never trusted from the client.
export type HubDiscount = {
  code: string;
  type: "percent" | "fixed";
  value: number; // percent 1–100, or CENTS for fixed
  minSubtotalCents: number; // 0 = no minimum
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

/** Cents saved by a discount on a merchandise subtotal (0 if it doesn't
 *  qualify). Powers the cart preview. Exact for single-destination orders
 *  and for fixed codes (the server's per-draft fixed shares sum to this);
 *  a percent code split across MULTIPLE destinations can differ by a cent
 *  or two, since Shopify rounds the percentage on each draft independently.
 *  Either way the customer confirms the real total on each Shopify invoice
 *  before paying — this is a preview, the invoice is the truth. */
export function discountCents(
  d: HubDiscount | null,
  subtotalCents: number,
): number {
  if (!d || subtotalCents < d.minSubtotalCents) return 0;
  const off =
    d.type === "percent"
      ? Math.round((subtotalCents * d.value) / 100)
      : d.value;
  return Math.min(off, subtotalCents);
}

export type HubCatalog = {
  bodyStyles: HubBodyStyle[];
  // Global box-interior config (gift-message step); absent on older deploys.
  box?: {
    interiorUrl: string | null;
    messageZone: LogoZone | null;
  };
  // Active add-ons from the hub's Pricing page; absent on older deploys.
  addons?: HubAddon[];
  // Active fillings from the hub's Pricing page; absent or empty → the
  // builder's compiled list applies (resolveFillings in lib/flow).
  fillings?: HubFilling[];
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
