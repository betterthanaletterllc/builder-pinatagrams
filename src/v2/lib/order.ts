import type { Carrier, DeliveryConfig } from "@/lib/delivery";
import type { CartLine, GraphicChoice } from "@/lib/flow";
import { discountAmountCents, formatCents, type HubDiscount, type LogoZone } from "@/lib/hub";
import { arrivalText, dateProblemText } from "./dates";
import { pieceBreakdown, shipCents, type PriceCtx } from "./pricing";

/**
 * The order as Step 4 shows it: every piñata (the one in progress first),
 * shipping, code previews and the total. Pure — the same numbers feed the
 * summary, the ActionBar and begin_checkout's value. DISPLAY ONLY: Shopify's
 * invoice (priced server-side from the hub) is the true total.
 */

/** Customer-facing name; hub-graphic titles are internal. */
export function designName(g: GraphicChoice): string {
  return g.type === "custom" ? "Your design" : g.type === "hub" ? "Your graphic" : g.title;
}

export function excerpt(message: string, n = 36): string {
  const one = message.replace(/\s+/g, " ").trim();
  return one.length > n ? `“${one.slice(0, n).trimEnd()}…”` : `“${one}”`;
}

/** One piñata's display fields, from a cart line or the live draft. */
export type OrderPiece = {
  graphic: GraphicChoice;
  filling: string;
  addons: string[];
  date: string;
  qty: number;
  styleName: string;
  boxImageUrl: string | null;
  logoZone: LogoZone | null;
  message: string;
};

export type LineView = {
  id: string; // a cart line id, or "current" for the new piñata in progress
  current: boolean; // the piñata being built or edited right now
  tag?: string; // "This piñata" / "Editing"
  title: string;
  box: { boxImageUrl: string | null; logoZone: LogoZone | null; graphic: GraphicChoice };
  details: string;
  arrives: string | null;
  qty: number;
  merchCents: number | null; // piñata + tier + filling, × qty
  addonRows: { label: string; cents: number }[]; // × qty
  problem: string | null; // its date doesn't work with the order's carrier
  error: string | null; // what checkout said about this line
};

export type OrderView = {
  views: LineView[];
  units: number;
  shipLabel: string;
  shipTotal: number | null;
  codeRows: { label: string; cents: number }[];
  notes: { code: string; text: string }[];
  total: number | null;
  from: boolean; // no carrier chosen yet: the total is a "from" price
};

export function pieceFromLine(l: CartLine): OrderPiece {
  return {
    graphic: l.graphic,
    filling: l.filling,
    addons: l.addons ?? [],
    date: l.deliveryDate,
    qty: l.qty,
    styleName: l.styleName,
    boxImageUrl: l.boxImageUrl,
    logoZone: l.logoZone,
    message: l.message,
  };
}

export function computeOrder(input: {
  /** A NEW piñata in progress (not in the cart yet). */
  current: OrderPiece | null;
  /** A cart line being edited: shown with its live, unsaved values.
   *  `resumed` (reopened by going Back from the order step) reads as the
   *  piñata in progress, not "Editing". */
  editing: { lineId: string; piece: OrderPiece; resumed?: boolean } | null;
  cart: CartLine[];
  carrier: Carrier | null;
  uspsOffered: boolean;
  cfg: DeliveryConfig;
  priceCtx: PriceCtx;
  discounts: HubDiscount[];
  lineErrors: Record<string, string>;
}): OrderView {
  const { carrier, cfg, priceCtx } = input;
  const lineCarrier: Carrier = carrier ?? "fedex";
  const ship = shipCents(carrier, priceCtx);
  const views: LineView[] = [];
  let merchandise = 0;
  let units = 0;

  const add = (id: string, p: OrderPiece, kind: "current" | "editing" | "line") => {
    const b = pieceBreakdown({ graphic: p.graphic, filling: p.filling, addons: p.addons }, priceCtx);
    units += p.qty;
    if (b.base !== null) merchandise += (b.base + b.addons.reduce((s, a) => s + a.cents, 0)) * p.qty;
    // Every line re-checked against the ORDER's carrier (a switch, or a
    // date gone stale overnight) — named on its row, fixed per line. The
    // piñata in progress is checked by its own date section instead.
    const problem = kind === "line" && carrier ? dateProblemText(p.date, cfg, carrier) : null;
    views.push({
      id,
      current: kind !== "line",
      tag: kind === "current" ? "This piñata" : kind === "editing" ? "Editing" : undefined,
      title: `${designName(p.graphic)} · ${p.styleName}`,
      box: { boxImageUrl: p.boxImageUrl, logoZone: p.logoZone, graphic: p.graphic },
      details: [p.filling, p.message ? excerpt(p.message) : null].filter(Boolean).join(" · "),
      arrives: p.date && !problem ? arrivalText(p.date, lineCarrier, cfg) : null,
      qty: p.qty,
      merchCents: b.base === null ? null : b.base * p.qty,
      addonRows: b.addons.map((a) => ({ label: a.label, cents: a.cents * p.qty })),
      problem,
      error: input.lineErrors[id] ?? null,
    });
  };

  if (input.current) add("current", input.current, "current");
  for (const l of input.cart) {
    if (input.editing && l.id === input.editing.lineId) {
      add(l.id, { ...input.editing.piece, qty: l.qty }, input.editing.resumed ? "current" : "editing");
    } else {
      add(l.id, pieceFromLine(l), "line");
    }
  }

  const known = !!priceCtx.unitPrice && ship !== null;
  const shipTotal = ship !== null ? ship * units : null;
  // A PREVIEW of each code with the cart's rules: an order code comes off
  // the merchandise, a shipping code off shipping; one that doesn't apply
  // says why. Shopify applies the real discount.
  const codeRows: { label: string; cents: number }[] = [];
  const notes: { code: string; text: string }[] = [];
  let off = 0;
  if (known) {
    for (const d of input.discounts) {
      if (merchandise < d.minSubtotalCents) {
        notes.push({ code: d.code, text: `${d.code} needs a ${formatCents(d.minSubtotalCents)} minimum.` });
        continue;
      }
      if (d.kind === "shipping" && d.maxShippingCents != null && shipTotal! >= d.maxShippingCents) {
        notes.push({
          code: d.code,
          text: `${d.code} only covers shipping under ${formatCents(d.maxShippingCents)}.`,
        });
        continue;
      }
      const cents = discountAmountCents(d, merchandise, shipTotal!);
      if (cents > 0) {
        off += cents;
        codeRows.push({ label: d.code, cents });
      }
    }
  }

  return {
    views,
    units,
    shipLabel:
      carrier === "usps"
        ? "USPS First Class"
        : carrier === "fedex"
          ? "FedEx delivery"
          : "Shipping",
    shipTotal,
    codeRows,
    notes,
    total: known ? merchandise + shipTotal! - off : null,
    from: input.uspsOffered && carrier === null,
  };
}
