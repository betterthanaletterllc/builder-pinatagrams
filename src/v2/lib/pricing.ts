import type { Carrier } from "@/lib/delivery";
import { graphicTier, graphicTierCents, type CartLine, type GraphicChoice } from "@/lib/flow";
import { formatCents, type BuilderPricing, type HubFilling, type HubPrice } from "@/lib/hub";
import {
  guaranteeUnitCents,
  pinataUnitCents,
  priceOrder,
  shipPerUnitCents,
  shippingLabel,
  tierUpchargeCents,
  type PricedLine,
} from "@/lib/order-pricing";
import { GUARANTEE_LABEL } from "@/lib/order-rules";
import type { V2Addon } from "./types";

/**
 * DISPLAY prices for v2: hub unit price + the graphic tier (tiered variants
 * only) + the filling's delta + add-ons, plus the carrier's per-piñata ship
 * rate and any paid guarantee — added up by lib/order-pricing, the same
 * function /api/checkout charges with and the ordering MCP quotes with.
 * Checkout re-prices everything from the hub; nothing here is ever sent to
 * the server.
 */

export type PriceCtx = {
  unitPrice: HubPrice | null;
  pricing: BuilderPricing;
  tiered: boolean;
  uspsOffered: boolean;
  fillings: HubFilling[];
  addons: V2Addon[];
  /** All-in storefront: the filling is part of the one price — the sheet
   *  lists it only when it costs extra. */
  allIn?: boolean;
  /** Paid guaranteed delivery date, cents per piñata (null = not offered). */
  guaranteeCents?: number | null;
};

export type Piece = {
  graphic: GraphicChoice | null;
  filling: string | null;
  addons: string[];
  /** The paid guaranteed date (FedEx, where offered). */
  guaranteed?: boolean;
};

/** The guarantee's price for this piece on this carrier (0 = none). */
export function guaranteeFor(p: Piece, carrier: Carrier | null, ctx: PriceCtx): number {
  return guaranteeUnitCents(p.guaranteed, carrier, ctx);
}

/** The piece as the one pricing function reads it. */
export function pricedPiece(p: Piece, ctx: PriceCtx, qty = 1): PricedLine {
  const b = pieceBreakdown(p, ctx);
  return {
    qty,
    tierCents: b.tier,
    fillingCents: b.filling,
    addons: b.addons.map((a) => ({ id: a.id, label: a.label, priceCents: a.cents })),
    guaranteed: p.guaranteed,
  };
}

/** "Free" for a $0 delivery line, else the money. */
export function shipMoney(cents: number): string {
  return cents === 0 ? "Free" : formatCents(cents);
}

/** Merchandise for ONE piñata (no shipping): base + tier + filling + add-ons. */
export function merchCents(p: Piece, ctx: PriceCtx): number | null {
  const b = pieceBreakdown(p, ctx);
  return b.base === null ? null : b.base + b.addons.reduce((s, a) => s + a.cents, 0);
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
  const tier = tierUpchargeCents(graphicTier(p.graphic), ctx.pricing, ctx.tiered);
  const filling = ctx.fillings.find((f) => f.label === p.filling)?.priceCents ?? 0;
  return {
    base: pinataUnitCents(ctx, tier, filling),
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
  return shipPerUnitCents(carrier, ctx);
}

/** "$44.99 delivered" for one piñata, and whether it's a "From" price. */
export function deliveredCents(
  p: Piece,
  carrier: Carrier | null,
  ctx: PriceCtx,
): { cents: number | null; from: boolean } {
  return {
    cents: priceOrder([pricedPiece(p, ctx)], carrier, ctx)?.totalCents ?? null,
    from: ctx.uspsOffered && carrier === null,
  };
}

export function linePiece(l: CartLine): Piece {
  return { graphic: l.graphic, filling: l.filling, addons: l.addons ?? [], guaranteed: l.guaranteed };
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
  if (p.filling && !(ctx.allIn && b.filling === 0)) {
    rows.push({ label: p.filling, value: b.filling > 0 ? `+${formatCents(b.filling)}` : "Included" });
  }
  for (const a of b.addons) rows.push({ label: a.label, value: `+${formatCents(a.cents)}` });
  const ship = shipCents(carrier, ctx);
  rows.push({
    label: carrier ? shippingLabel(carrier, ship) : "Delivery (you choose at the last step)",
    value: ship === null ? "—" : `${carrier ? "" : "from "}${shipMoney(ship)}`,
  });
  const g = guaranteeFor(p, carrier, ctx);
  if (g > 0) rows.push({ label: GUARANTEE_LABEL, value: `+${formatCents(g)}` });
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
