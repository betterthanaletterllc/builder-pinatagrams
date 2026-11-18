import type { Carrier } from "./delivery";
import type { GraphicTier } from "./flow";
import type { BuilderPricing, HubPrice } from "./hub";
import { priceForVariant, type VariantProfile } from "./variant";

/**
 * THE order price. One module for every place a Piñatagram order is priced:
 *
 *   - the builder's own quote (v2/lib/pricing.ts price sheet, v2/lib/order.ts
 *     order summary) — what the customer sees,
 *   - /api/checkout — what Shopify's invoice charges,
 *   - the ordering MCP's price_order (lib/mcp-tools/price.ts) — what an
 *     agent quotes, and create_checkout's preview, which is price_order's.
 *
 * The MCP once copied this arithmetic and fell behind the builder (the $50
 * flat profile, the $5 guaranteed date). Nothing outside this file adds up a
 * piñata, its shipping or its guarantee: a price change made here reaches all
 * three, and a test that pins one pins the others.
 *
 * Pure arithmetic, no network, safe in the browser: every input is already
 * resolved from the hub by the caller (which validates its own way — the
 * route sells what it was given, price_order refuses fractional cents).
 */

/** The prices a storefront sells at: the hub price with the storefront's
 *  all-in price laid over it (priceForVariant), the hub's builder pricing
 *  block, and the profile switches that change the money. */
export type PricingCtx = {
  /** null = not known yet (the builder's display before the hub answers). */
  unitPrice: Pick<HubPrice, "unitPriceCents" | "shipPerUnitCents"> | null;
  pricing: BuilderPricing;
  /** Tiered profiles charge the graphic tier; flat ones price every graphic the same. */
  tiered: boolean;
  /** The profile offers USPS (a carrier choice). */
  uspsOffered: boolean;
  /** Paid guaranteed delivery date, cents per piñata (null = not offered). FedEx only. */
  guaranteeCents?: number | null;
};

/** The storefront's pricing context from what the hub answered — with the
 *  profile's all-in price laid over the hub price, the way every reader of
 *  the base price must see it. A price that can't be sold (missing, zero,
 *  negative shipping) leaves unitPrice null: never sell at zero. */
export function pricingCtx(
  rawPrice: HubPrice | null,
  variant: Pick<VariantProfile, "flatPrice" | "pricing" | "carriers" | "guaranteeCents">,
  pricing: BuilderPricing,
): PricingCtx & { unitPrice: HubPrice | null } {
  const price = priceForVariant(rawPrice, variant);
  const sellable =
    !!price &&
    Number.isFinite(price.unitPriceCents) &&
    price.unitPriceCents > 0 &&
    Number.isFinite(price.shipPerUnitCents) &&
    price.shipPerUnitCents >= 0;
  return {
    unitPrice: sellable ? price : null,
    pricing,
    tiered: variant.pricing === "tiered",
    uspsOffered: variant.carriers.includes("usps"),
    guaranteeCents: variant.guaranteeCents,
  };
}

/** The graphic tier's upcharge: 0 on a flat profile and for the Classic
 *  default; else the hub's library or custom upcharge. */
export function tierUpchargeCents(
  tier: GraphicTier | null,
  pricing: BuilderPricing,
  tiered: boolean,
): number {
  if (!tiered) return 0;
  if (tier === "custom") return pricing.graphicCustomUpchargeCents;
  if (tier === "library") return pricing.graphicLibraryUpchargeCents;
  return 0;
}

/** One piñata's price before add-ons and shipping: base + tier + filling.
 *  null while the base price isn't known. */
export function pinataUnitCents(
  ctx: Pick<PricingCtx, "unitPrice">,
  tierCents: number,
  fillingCents: number,
): number | null {
  return ctx.unitPrice ? ctx.unitPrice.unitPriceCents + tierCents + fillingCents : null;
}

/** Per-piñata shipping for a carrier: FedEx from the (profile-adjusted) hub
 *  price, USPS from the pricing block. A null carrier on a two-carrier store
 *  is the CHEAPEST option (the honest "From" price before one is picked). */
export function shipPerUnitCents(carrier: Carrier | null, ctx: PricingCtx): number | null {
  const fedex = ctx.unitPrice?.shipPerUnitCents ?? null;
  const usps = ctx.pricing.uspsShipPerUnitCents;
  if (carrier === "usps") return usps;
  if (carrier === "fedex" || !ctx.uspsOffered) return fedex;
  return fedex === null ? null : Math.min(fedex, usps);
}

/** The guarantee's price for one piñata (0 = none): only when the piñata
 *  asked for it, the profile prices it, and it isn't travelling USPS. */
export function guaranteeUnitCents(
  guaranteed: boolean | undefined,
  carrier: Carrier | null,
  ctx: Pick<PricingCtx, "guaranteeCents">,
): number {
  return guaranteed && carrier !== "usps" && ctx.guaranteeCents ? ctx.guaranteeCents : 0;
}

/** Add-on as pricing reads it — a HubAddon, or the builder's display copy. */
export type AddonLike = { id: string; label: string; priceCents: number };

/** One piñata line as pricing sees it: everything already resolved. */
export type PricedLine<A extends AddonLike = AddonLike> = {
  qty: number;
  tierCents: number;
  fillingCents: number;
  addons: A[];
  guaranteed?: boolean;
};

export type OrderPrice<A extends AddonLike = AddonLike> = {
  /** Per line, in order: one piñata's price and the line's (× qty). */
  lines: { unitCents: number; lineCents: number }[];
  /** One line per add-on id across the order (Shopify's add-on product
   *  lines), in first-seen order: unit price × every piñata carrying it. */
  addonLines: { addon: A; qty: number; cents: number }[];
  units: number;
  /** Piñata lines + add-on lines. */
  merchandiseCents: number;
  shipPerUnitCents: number;
  /** The carrier's rate × units. */
  shippingCents: number;
  guaranteedUnits: number;
  guaranteeCents: number;
  /** What Shopify's ONE shipping line charges: shipping + the guarantees. */
  shippingLineCents: number;
  /** Merchandise + the shipping line, before tax and discount codes. */
  totalCents: number;
};

/**
 * Price one shipment (one address = one draft order = one shipping line).
 * null when the base price or the carrier's rate isn't known yet.
 */
export function priceOrder<A extends AddonLike>(
  lines: PricedLine<A>[],
  carrier: Carrier | null,
  ctx: PricingCtx,
): OrderPrice<A> | null {
  const ship = shipPerUnitCents(carrier, ctx);
  if (!ctx.unitPrice || ship === null) return null;
  const priced = lines.map((l) => {
    const unitCents = pinataUnitCents(ctx, l.tierCents, l.fillingCents)!;
    return { unitCents, lineCents: unitCents * l.qty };
  });
  const byAddon = new Map<string, { addon: A; qty: number }>();
  for (const l of lines) {
    for (const a of l.addons) {
      byAddon.set(a.id, { addon: a, qty: (byAddon.get(a.id)?.qty ?? 0) + l.qty });
    }
  }
  const addonLines = [...byAddon.values()].map(({ addon, qty }) => ({
    addon,
    qty,
    cents: addon.priceCents * qty,
  }));
  const units = lines.reduce((s, l) => s + l.qty, 0);
  const guaranteedUnits = lines.reduce(
    (s, l) => s + (guaranteeUnitCents(l.guaranteed, carrier, ctx) > 0 ? l.qty : 0),
    0,
  );
  const guaranteeCents = guaranteedUnits * (ctx.guaranteeCents ?? 0);
  const merchandiseCents =
    priced.reduce((s, l) => s + l.lineCents, 0) + addonLines.reduce((s, a) => s + a.cents, 0);
  const shippingCents = ship * units;
  const shippingLineCents = shippingCents + guaranteeCents;
  return {
    lines: priced,
    addonLines,
    units,
    merchandiseCents,
    shipPerUnitCents: ship,
    shippingCents,
    guaranteedUnits,
    guaranteeCents,
    shippingLineCents,
    totalCents: merchandiseCents + shippingLineCents,
  };
}

/** The delivery row's name, as the order summary, the price sheet and the
 *  MCP quote all show it (shipCents null = not priced yet). */
export function shippingLabel(carrier: Carrier, shipCents: number | null): string {
  if (carrier === "usps") return "USPS First Class";
  return shipCents === 0 ? "Free FedEx delivery" : "FedEx delivery";
}
