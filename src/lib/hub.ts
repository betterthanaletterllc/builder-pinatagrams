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
