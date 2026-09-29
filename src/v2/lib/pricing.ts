import type { Carrier } from "@/lib/delivery";
import { graphicTier, graphicTierCents, type CartLine, type GraphicChoice } from "@/lib/flow";
import { formatCents, type BuilderPricing, type HubFilling, type HubPrice } from "@/lib/hub";
import type { V2Addon } from "./types";

/**
 * DISPLAY prices for v2 — the same arithmetic as v1's dock and cart
 * (design-flow.tsx / cart-view.tsx): hub unit price + the graphic tier
 * (tiered variants only) + the filling's delta + add-ons, plus the carrier's
 * per-piñata ship rate. Checkout re-prices everything from the hub; nothing
 * here is ever sent to the server.
 */

export type PriceCtx = {
  unitPrice: HubPrice | null;
  pricing: BuilderPricing;
  tiered: boolean;
  uspsOffered: boolean;
  fillings: HubFilling[];
  addons: V2Addon[];
};

export type Piece = {
  graphic: GraphicChoice | null;
  filling: string | null;
  addons: string[];
};

/** Merchandise for ONE piñata (no shipping): base + tier + filling + add-ons. */
export function merchCents(p: Piece, ctx: PriceCtx): number | null {
  if (!ctx.unitPrice) return null;
  const tier = ctx.tiered ? graphicTierCents(p.graphic, ctx.pricing) : 0;
  const filling = ctx.fillings.find((f) => f.label === p.filling)?.priceCents ?? 0;
  const addons = p.addons.reduce(
    (s, id) => s + (ctx.addons.find((a) => a.id === id)?.priceCents ?? 0),
    0,
  );
  return ctx.unitPrice.unitPriceCents + tier + filling + addons;
}

/** One piñata, itemised the way the invoice itemises it: the piñata line
 *  (base + tier + filling) and each add-on as its own line. */
export function pieceBreakdown(
  p: Piece,
  ctx: PriceCtx,
): {
  base: number | null;
  tier: number;
  filling: number;
  addons: { id: string; label: string; cents: number }[];
} {
  const tier = ctx.tiered ? graphicTierCents(p.graphic, ctx.pricing) : 0;
  const filling = ctx.fillings.find((f) => f.label === p.filling)?.priceCents ?? 0;
  return {
    base: ctx.unitPrice ? ctx.unitPrice.unitPriceCents + tier + filling : null,
    tier,
    filling,
    addons: p.addons.flatMap((id) => {
      const a = ctx.addons.find((x) => x.id === id);
      return a ? [{ id: a.id, label: a.label, cents: a.priceCents }] : [];
    }),
  };
}

/** Per-piñata shipping for a carrier; null carrier on a two-carrier store =
 *  the CHEAPEST option (the honest "From" price before a carrier is picked). */
export function shipCents(carrier: Carrier | null, ctx: PriceCtx): number | null {
  const fedex = ctx.unitPrice?.shipPerUnitCents ?? null;
  const usps = ctx.pricing.uspsShipPerUnitCents;
  if (carrier === "usps") return usps;
  if (carrier === "fedex" || !ctx.uspsOffered) return fedex;
  return fedex === null ? null : Math.min(fedex, usps);
}

/** "$44.99 delivered" for one piñata, and whether it's a "From" price. */
export function deliveredCents(
  p: Piece,
  carrier: Carrier | null,
  ctx: PriceCtx,
): { cents: number | null; from: boolean } {
  const m = merchCents(p, ctx);
  const s = shipCents(carrier, ctx);
  return {
    cents: m !== null && s !== null ? m + s : null,
    from: ctx.uspsOffered && carrier === null,
  };
}

export function linePiece(l: CartLine): Piece {
  return { graphic: l.graphic, filling: l.filling, addons: l.addons ?? [] };
}

/** The price sheet (tap the price): one piñata itemised, delivered total. */
export function priceRows(
  p: Piece & { styleName: string },
  carrier: Carrier | null,
  ctx: PriceCtx,
): { rows: { label: string; value: string }[]; total: { label: string; value: string } } {
  const money = (c: number | null) => (c === null ? "—" : formatCents(c));
  const b = pieceBreakdown(p, ctx);
  const rows = [{ label: `${p.styleName} piñata`, value: money(ctx.unitPrice?.unitPriceCents ?? null) }];
  if (ctx.tiered && p.graphic) {
    rows.push({
      label:
        p.graphic.type === "custom"
          ? "Your own design"
          : graphicTier(p.graphic) === "classic"
            ? "Classic design"
            : "Library design",
      value: b.tier > 0 ? `+${formatCents(b.tier)}` : "Included",
    });
  }
  if (p.filling) {
    rows.push({ label: p.filling, value: b.filling > 0 ? `+${formatCents(b.filling)}` : "Included" });
  }
  for (const a of b.addons) rows.push({ label: a.label, value: `+${formatCents(a.cents)}` });
  const ship = shipCents(carrier, ctx);
  rows.push({
    label:
      carrier === "usps"
        ? "USPS First Class"
        : carrier === "fedex"
          ? "Guaranteed FedEx delivery"
          : "Delivery (you choose at the last step)",
    value: ship === null ? "—" : `${carrier ? "" : "from "}${formatCents(ship)}`,
  });
  const d = deliveredCents(p, carrier, ctx);
  return {
    rows,
    total: { label: d.from ? "Delivered, from" : "Delivered", value: money(d.cents) },
  };
}

/** The graphic's tier upcharge label on tiered stores: "Included" / "+$2.00". */
export function tierLabel(
  g: GraphicChoice,
  pricing: BuilderPricing,
): { text: string; included: boolean } {
  const cents = graphicTierCents(g, pricing);
  return cents > 0
    ? { text: `+${formatCents(cents)}`, included: false }
    : { text: "Included", included: true };
}
