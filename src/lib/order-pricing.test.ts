import { describe, expect, it } from "vitest";
import type { HubPrice } from "./hub";
import {
  guaranteeUnitCents,
  priceOrder,
  pricingCtx,
  shipPerUnitCents,
  shippingLabel,
  tierUpchargeCents,
} from "./order-pricing";
import { resolveVariantProfile } from "./variant";

/**
 * lib/order-pricing — THE order price. The builder's quote, /api/checkout and
 * the ordering MCP's price_order all add up through it (the differential and
 * golden tests pin the route and price_order against each other); these pin
 * the arithmetic itself on the profiles that matter.
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

// The hub's two live profiles on 2026-11-17.
const FLAT_50 = resolveVariantProfile({
  name: "flat-50-freeship",
  pricing: "flat",
  carriers: ["fedex"],
  flatPrice: { unitCents: 5000, shipCents: 0 },
  guaranteeCents: 500,
  resolvedVia: "host",
});
const DEFAULT = resolveVariantProfile({ name: "default", pricing: "tiered", carriers: ["fedex", "usps"] });

const DOUBLE_CANDY = { id: "double-candy", label: "Double Candy", priceCents: 499 };

describe("pricingCtx — the storefront's prices", () => {
  it("lays the all-in price over the hub price ($50, free FedEx)", () => {
    const ctx = pricingCtx(PRICE, FLAT_50, PRICING);
    expect(ctx.unitPrice).toMatchObject({ unitPriceCents: 5000, shipPerUnitCents: 0, unitDeliveredCents: 5000 });
    expect(ctx).toMatchObject({ tiered: false, uspsOffered: false, guaranteeCents: 500 });
  });

  it("keeps the price book on a profile without one", () => {
    const ctx = pricingCtx(PRICE, DEFAULT, PRICING);
    expect(ctx.unitPrice).toMatchObject({ unitPriceCents: 2999, shipPerUnitCents: 1500 });
    expect(ctx).toMatchObject({ tiered: true, uspsOffered: true, guaranteeCents: null });
  });

  it("never sells at zero: a missing, zero or negative-shipping price is unknown", () => {
    expect(pricingCtx(null, DEFAULT, PRICING).unitPrice).toBeNull();
    expect(pricingCtx({ ...PRICE, unitPriceCents: 0 }, DEFAULT, PRICING).unitPrice).toBeNull();
    expect(pricingCtx({ ...PRICE, shipPerUnitCents: -1 }, DEFAULT, PRICING).unitPrice).toBeNull();
  });
});

describe("the parts", () => {
  it("graphic tier: 0 on a flat profile and for the Classic default", () => {
    expect(tierUpchargeCents("library", PRICING, false)).toBe(0);
    expect(tierUpchargeCents("custom", PRICING, false)).toBe(0);
    expect(tierUpchargeCents("classic", PRICING, true)).toBe(0);
    expect(tierUpchargeCents("library", PRICING, true)).toBe(200);
    expect(tierUpchargeCents("custom", PRICING, true)).toBe(500);
    expect(tierUpchargeCents(null, PRICING, true)).toBe(0);
  });

  it("shipping: the carrier's rate, and the cheaper one as the 'from' price before a carrier is picked", () => {
    const ctx = pricingCtx(PRICE, DEFAULT, PRICING);
    expect(shipPerUnitCents("fedex", ctx)).toBe(1500);
    expect(shipPerUnitCents("usps", ctx)).toBe(1000);
    expect(shipPerUnitCents(null, ctx)).toBe(1000);
    expect(shipPerUnitCents(null, pricingCtx(PRICE, FLAT_50, PRICING))).toBe(0);
  });

  it("the guarantee: asked for, priced by the profile, and not USPS", () => {
    const flat = pricingCtx(PRICE, FLAT_50, PRICING);
    expect(guaranteeUnitCents(true, "fedex", flat)).toBe(500);
    expect(guaranteeUnitCents(true, null, flat)).toBe(500);
    expect(guaranteeUnitCents(true, "usps", flat)).toBe(0);
    expect(guaranteeUnitCents(false, "fedex", flat)).toBe(0);
    expect(guaranteeUnitCents(true, "fedex", pricingCtx(PRICE, DEFAULT, PRICING))).toBe(0);
  });

  it("names the delivery row as the order summary does", () => {
    expect(shippingLabel("fedex", 0)).toBe("Free FedEx delivery");
    expect(shippingLabel("fedex", 1500)).toBe("FedEx delivery");
    expect(shippingLabel("fedex", null)).toBe("FedEx delivery");
    expect(shippingLabel("usps", 1000)).toBe("USPS First Class");
  });
});

describe("priceOrder — one shipment", () => {
  it("the $50 flat profile: $50 a piñata whatever the design, free FedEx, $5 per guaranteed piñata on the shipping line", () => {
    const ctx = pricingCtx(PRICE, FLAT_50, PRICING);
    const tier = tierUpchargeCents("custom", PRICING, ctx.tiered);
    const p = priceOrder(
      [
        { qty: 2, tierCents: tier, fillingCents: 0, addons: [DOUBLE_CANDY], guaranteed: true },
        { qty: 1, tierCents: 0, fillingCents: 150, addons: [DOUBLE_CANDY] },
      ],
      "fedex",
      ctx,
    )!;
    expect(p.lines).toEqual([
      { unitCents: 5000, lineCents: 10000 },
      { unitCents: 5150, lineCents: 5150 },
    ]);
    expect(p.addonLines).toEqual([{ addon: DOUBLE_CANDY, qty: 3, cents: 1497 }]);
    expect(p).toMatchObject({
      units: 3,
      merchandiseCents: 10000 + 5150 + 1497,
      shipPerUnitCents: 0,
      shippingCents: 0,
      guaranteedUnits: 2,
      guaranteeCents: 1000,
      shippingLineCents: 1000,
      totalCents: 10000 + 5150 + 1497 + 1000,
    });
  });

  it("the tiered two-carrier profile: tier upcharges, USPS rate, no guarantee", () => {
    const ctx = pricingCtx(PRICE, DEFAULT, PRICING);
    const p = priceOrder(
      [{ qty: 2, tierCents: tierUpchargeCents("library", PRICING, ctx.tiered), fillingCents: 0, addons: [], guaranteed: true }],
      "usps",
      ctx,
    )!;
    expect(p.lines).toEqual([{ unitCents: 3199, lineCents: 6398 }]);
    expect(p).toMatchObject({ shippingCents: 2000, guaranteedUnits: 0, shippingLineCents: 2000, totalCents: 8398 });
  });

  it("unknown while the base price is", () => {
    expect(priceOrder([{ qty: 1, tierCents: 0, fillingCents: 0, addons: [] }], "fedex", pricingCtx(null, DEFAULT, PRICING))).toBeNull();
  });
});
