import { describe, expect, it } from "vitest";
import { resolveDeliveryConfig } from "@/lib/delivery";
import { CLASSIC_GRAPHIC, type GraphicChoice } from "@/lib/flow";
import type { HubPrice } from "@/lib/hub";
import { pricingCtx } from "@/lib/order-pricing";
import { resolveVariantProfile } from "@/lib/variant";
import { computeOrder, type OrderPiece } from "./order";
import { deliveredCents, priceRows, type PriceCtx } from "./pricing";

/**
 * The builder's own quote — Step 4's order summary and the price sheet —
 * on builder.pinatagrams.com's live profile (2026-11-17: $50 all-in, free
 * FedEx, $5 paid guaranteed date). Their totals come from lib/order-pricing,
 * the function /api/checkout charges with; these pin what the customer sees.
 */

const PRICE: HubPrice = {
  productId: "pinata",
  qty: 1,
  unitPriceCents: 2999,
  shipPerUnitCents: 1500,
  unitDeliveredCents: 4499,
  orderTotalCents: 4499,
  moq: 15,
  meetsMoq: false,
  needsQuote: false,
  notes: [],
  asOf: "2026-11-17T00:00:00.000Z",
};
const PRICING = { graphicLibraryUpchargeCents: 200, graphicCustomUpchargeCents: 500, uspsShipPerUnitCents: 1000 };
const FLAT_50 = resolveVariantProfile({
  name: "flat-50-freeship",
  pricing: "flat",
  carriers: ["fedex"],
  flatPrice: { unitCents: 5000, shipCents: 0 },
  guaranteeCents: 500,
});

const ctx: PriceCtx = {
  ...pricingCtx(PRICE, FLAT_50, PRICING),
  fillings: [{ id: "candy", label: "Candy", blurb: "", priceCents: 0, imageUrl: null, addons: "all" }],
  addons: [{ id: "double-candy", label: "Double Candy", priceCents: 499, sku: "DOUBLE-FILLING", blurb: "", imageUrl: null }],
  allIn: true,
};

const LIBRARY: GraphicChoice = { type: "shopify", design: "HBD06", title: "Birthday", thumb: null, art: "https://cdn.shopify.com/x.png" };
const piece = (over: Partial<OrderPiece> = {}): OrderPiece => ({
  graphic: CLASSIC_GRAPHIC,
  filling: "Candy",
  addons: [],
  date: "2026-12-10",
  qty: 1,
  styleName: "Standard",
  boxImageUrl: null,
  logoZone: null,
  message: "",
  ...over,
});

const order = (current: OrderPiece) =>
  computeOrder({
    current,
    editing: null,
    cart: [],
    carrier: "fedex",
    uspsOffered: false,
    cfg: resolveDeliveryConfig(null),
    priceCtx: ctx,
    discounts: [],
    lineErrors: {},
  });

describe("the builder's quote on the $50 flat profile", () => {
  it("order summary: $50 a piñata whatever the design, free FedEx", () => {
    const v = order(piece({ graphic: LIBRARY, qty: 2, addons: ["double-candy"] }));
    expect(v.views[0].merchCents).toBe(10000);
    expect(v.shipLabel).toBe("Free FedEx delivery");
    expect(v.shipTotal).toBe(0);
    expect(v.guarantee).toBeNull();
    expect(v.total).toBe(10000 + 2 * 499);
  });

  it("order summary: the guaranteed date is its own row, $5 a piñata, in the total", () => {
    const v = order(piece({ qty: 3, guaranteed: true }));
    expect(v.guarantee).toEqual({ label: "Guaranteed delivery date ×3", cents: 1500 });
    expect(v.total).toBe(15000 + 1500);
    expect(v.views[0].arrives).toMatch(/· guaranteed$/);
  });

  it("price sheet: one piñata itemised, delivered total", () => {
    const sheet = priceRows({ graphic: CLASSIC_GRAPHIC, filling: "Candy", addons: [], guaranteed: true, styleName: "Standard" }, "fedex", ctx);
    expect(sheet.rows).toEqual([
      { label: "Standard piñata", value: "$50.00" },
      { label: "Free FedEx delivery", value: "Free" },
      { label: "Guaranteed delivery date", value: "+$5.00" },
    ]);
    expect(sheet.total).toEqual({ label: "Delivered", value: "$55.00" });
    expect(deliveredCents({ graphic: LIBRARY, filling: "Candy", addons: [] }, "fedex", ctx)).toEqual({ cents: 5000, from: false });
  });
});
