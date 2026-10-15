/**
 * Shared INPUTS and FROZEN EXPECTATIONS for the two checkout goldens:
 *   src/lib/checkout-golden.test.ts       — the dry-run payload shape
 *   src/lib/checkout-golden-live.test.ts  — the live DraftOrderInput shape
 *
 * Both drive the REAL /api/checkout handler against the recorded hub fixtures
 * in this folder. Everything money- or contract-bearing below is a LITERAL.
 * Change a literal only when the Paper contract changes on purpose (and
 * Paper is released to match).
 *
 * Fixtures (recorded 2026-10-15 from the live hub):
 *   hub-catalog.json  GET https://admin.betterthanaletter.com/api/public/catalog?host=builder.pinatagrams.com
 *   hub-price.json    GET https://admin.betterthanaletter.com/api/public/price?qty=1&fill=filled&bodyType=standard&graphicType=custom&mode=individual&carrier=standard
 *
 * Two documented adjustments to the SERVED catalog (never to the recorded
 * files):
 *   - the live hub lists every filling at 0¢, so "School Fun Pack" is served
 *     at 150¢ to exercise the filling delta in the composition;
 *   - the live hub has a single add-on, so a second one ("Chonky", 999¢,
 *     SKU CHONKY) is served to exercise the ", " separator of Add-ons /
 *     _addons and the one-aggregated-line-per-add-on rule.
 *
 * Clock for both goldens: 2026-10-15 18:00Z (13:00 America/Chicago, a
 * Thursday), so date validation and the "Arrives" strings are deterministic.
 */
import { HUB_URL } from "@/lib/hub";
import hubCatalogFixture from "./hub-catalog.json";
import hubPriceFixture from "./hub-price.json";

export const HOST = "builder.pinatagrams.com";
export const CLOCK = "2026-10-15T18:00:00Z";
export const FIXED_PRICE_QUERY =
  "qty=1&fill=filled&bodyType=standard&graphicType=custom&mode=individual&carrier=standard";
export const BLOB = "https://yrfds6n4iwscziqm.public.blob.vercel-storage.com";

/* ---------------------------------------------------------------------------
 * The hub, as served to the route
 * ------------------------------------------------------------------------- */

export const FILLING_DELTA_CENTS = 150;
export const CHONKY_ADDON = {
  id: "chonky",
  label: "Chonky",
  priceCents: 999,
  sku: "CHONKY",
  blurb: "",
  imageUrl: "",
};

export type ServedCatalog = typeof hubCatalogFixture;

/** Recorded catalog + the two documented adjustments. A fresh clone per call. */
export function servedCatalog(): ServedCatalog {
  const c = structuredClone(hubCatalogFixture) as ServedCatalog;
  const sfp = c.fillings.find((f) => f.label === "School Fun Pack");
  if (!sfp) throw new Error("fixture drift: School Fun Pack missing from hub-catalog.json");
  sfp.priceCents = FILLING_DELTA_CENTS;
  if (c.addons.length !== 1 || c.addons[0].id !== "double-candy")
    throw new Error("fixture drift: hub-catalog.json addons should be exactly [double-candy]");
  c.addons.push(CHONKY_ADDON);
  return c;
}

export const hubPrice = hubPriceFixture;
export const FREE_SHIPPING_CODE = "FREESHIP";

/** The hub side of a fetch stub: the served catalog, the fixed price, and the
 *  discount describe (a free-shipping rule for FREE_SHIPPING_CODE, nothing for
 *  any other code). null = not a hub URL — the caller decides (Shopify stub or
 *  a loud rejection). */
export function hubResponse(url: URL): Response | null {
  if (url.origin !== new URL(HUB_URL).origin) return null;
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  if (url.pathname === "/api/public/catalog") return json(servedCatalog());
  if (url.pathname === "/api/public/price") return json(hubPrice);
  if (url.pathname === "/api/public/discount") {
    return url.searchParams.get("code") === FREE_SHIPPING_CODE
      ? json({ discount: { kind: "shipping", minSubtotalCents: 0 } })
      : json({ discount: null });
  }
  return null;
}

/* ---------------------------------------------------------------------------
 * Composition inputs — read from the fixtures so the arithmetic in the
 * goldens is visible; the EXPECTED amounts below are still literal.
 * ------------------------------------------------------------------------- */

export const UNIT = hubPriceFixture.unitPriceCents; // 2999
export const FEDEX_SHIP = hubPriceFixture.shipPerUnitCents; // 1500
export const LIB_UP = hubCatalogFixture.pricing.graphicLibraryUpchargeCents; // 200
export const CUSTOM_UP = hubCatalogFixture.pricing.graphicCustomUpchargeCents; // 500
export const USPS_SHIP = hubCatalogFixture.pricing.uspsShipPerUnitCents; // 675
export const DOUBLE_CANDY = hubCatalogFixture.addons[0].priceCents; // 499
export const CHONKY = CHONKY_ADDON.priceCents; // 999

export const money = (cents: number) => (cents / 100).toFixed(2);

/** The composed amounts, literal. */
export const LINE_A_UNIT = "33.49"; // base 2999 + library tier 200 + School Fun Pack delta 150
export const LINE_B_UNIT = "29.99"; // base 2999 + Classic tier 0 + Candy delta 0
export const LINE_C_UNIT = "34.99"; // base 2999 + custom tier 500 + Dog Treats delta 0
export const DOUBLE_CANDY_UNIT = "4.99";
export const CHONKY_UNIT = "9.99";
export const FEDEX_SHIPPING_TOTAL = "45.00"; // FedEx 2-Day per unit × 3 units: 1500 × 3
export const USPS_SHIPPING_TOTAL = "6.75"; // USPS per unit × 1 unit: 675

/* ---------------------------------------------------------------------------
 * Carts (the request bodies)
 * ------------------------------------------------------------------------- */

export const AUSTIN = {
  name: "Jane Doe",
  address1: "123 Main St",
  address2: "Apt 4",
  city: "Austin",
  province: "TX",
  zip: "78701",
  phone: "5125550100",
};
export const PORTLAND = {
  name: "Grandma",
  address1: "9 Elm Street",
  address2: "",
  city: "Portland",
  province: "OR",
  zip: "97201",
  phone: "",
};

export const HBD02_ART =
  "https://cdn.shopify.com/s/files/1/1116/8788/files/HBD02-TROPICAL_front_graphic.png?v=1728858478";
export const CLASSIC_ART =
  "https://cdn.shopify.com/s/files/1/1116/8788/files/STANDARD_front.png?v=1728860086";
export const CUSTOM_ART = `${BLOB}/art/golden-test-print.png`;
export const CUSTOM_JSON = `${BLOB}/art/golden-test-design.json`;
export const CUSTOM_SHA = "9f2c1e7b4a6d8c0e3b5f7a9d1c3e5b7f9a1c3e5b7d9f1a3c5e7b9d1f3a5c7e9b";

/** 320 characters. Checkout caps `message` with str(v, 300) = slice THEN
 *  trim; char 300 here is a letter ("…ahead o|f you…"), so the trim is a
 *  no-op and exactly the first 300 characters survive (MESSAGE_300). */
export const MESSAGE_320 =
  "Congrats on the new job, Alex! We are so proud of you and everything you have worked for this year. Enjoy every piece of candy inside this box, keep the pinata on your desk, and remember that the whole family is cheering for you from Portland. Here is to the next chapter and every single win ahead of you, kiddo. Love a";
export const MESSAGE_300 =
  "Congrats on the new job, Alex! We are so proud of you and everything you have worked for this year. Enjoy every piece of candy inside this box, keep the pinata on your desk, and remember that the whole family is cheering for you from Portland. Here is to the next chapter and every single win ahead o";

/** Visit ids the client may send; written as order-level attributes. */
export const ANALYTICS = {
  phDistinctId: "0199c1f0-7d2e-7a3b-9c4d-5e6f7a8b9c0d",
  phSessionId: "0199c1f0-8e3f-7b4c-ad5e-6f7a8b9c0d1e",
  gaClientId: "GA1.1.1234567890.1760544000",
  fbp: "fb.1.1760544000000.1234567890",
  fbc: "fb.1.1760544000000.IwAR2abcDEFghiJKLmnoPQRstuVWXyz",
};

/** FedEx: a library design + filling delta + TWO add-ons (qty 2) and the
 *  Classic default on a unicorn body (qty 1, no add-ons), one address → one
 *  draft, 3 units. Sends the analytics block. */
export const FEDEX_BODY = {
  lines: [
    {
      id: "line-a",
      styleId: "googly",
      styleName: "Googly",
      boxImageUrl: null,
      logoZone: null,
      graphic: {
        type: "shopify",
        design: "HBD02",
        title: "Fun Birthday Piñatagram",
        thumb: null,
        art: HBD02_ART,
      },
      message: "Happy birthday, Sam!",
      filling: "School Fun Pack",
      addons: ["double-candy", "chonky"],
      deliveryDate: "2026-10-29",
      carrier: "fedex",
      address: AUSTIN,
      qty: 2,
    },
    {
      id: "line-b",
      styleId: "white-uni",
      styleName: "White Uni",
      boxImageUrl: null,
      logoZone: null,
      graphic: {
        type: "shopify",
        design: "STANDARD",
        title: "Classic Piñatagrams",
        thumb: null,
        art: CLASSIC_ART,
      },
      message: "",
      filling: "Candy",
      deliveryDate: "2026-10-29",
      carrier: "fedex",
      address: AUSTIN,
      qty: 1,
    },
  ],
  analytics: ANALYTICS,
};

/** USPS: one custom design (Blob art + sha + sidecar) on a unicorn body with
 *  a message over the cap. No analytics block. */
export const USPS_BODY = {
  lines: [
    {
      id: "line-c",
      styleId: "pink-uni",
      styleName: "Pink Uni",
      boxImageUrl: null,
      logoZone: null,
      graphic: {
        type: "custom",
        design: { v: 1, layers: [] }, // the editor document; checkout never reads it
        preview: "",
        art: CUSTOM_ART,
        designUrl: CUSTOM_JSON,
        artSha256: CUSTOM_SHA,
      },
      message: MESSAGE_320,
      filling: "Dog Treats",
      deliveryDate: "2026-11-05",
      carrier: "usps",
      address: PORTLAND,
      qty: 1,
    },
  ],
};

/* ---------------------------------------------------------------------------
 * Expected payload pieces — LITERAL
 * ------------------------------------------------------------------------- */

export type Attr = { key: string; value: string };

export const TAGS = ["builder", "variant-default"];

/** Order-level forensics, in emission order; `nonce` is the caller's matcher
 *  (or the exact value). The five analytics keys follow only when the client
 *  sent them (FEDEX_BODY does, USPS_BODY doesn't). */
export function orderAttrs(nonce: unknown, withAnalytics: boolean) {
  return [
    { key: "_builderHost", value: "builder.pinatagrams.com" },
    { key: "_builderFlow", value: "v2" },
    { key: "_builderVariant", value: "default (tiered/fedex+usps)" },
    { key: "_builderCatalog", value: "2026-10-15T14:38:44.115Z" },
    { key: "_builderNonce", value: nonce },
    ...(withAnalytics
      ? [
          { key: "_phDistinctId", value: ANALYTICS.phDistinctId },
          { key: "_phSessionId", value: ANALYTICS.phSessionId },
          { key: "_gaClientId", value: ANALYTICS.gaClientId },
          { key: "_fbp", value: ANALYTICS.fbp },
          { key: "_fbc", value: ANALYTICS.fbc },
        ]
      : []),
  ];
}

export const FEDEX_GROUP = {
  groupKey: "jane doe|123 main st|apt 4|austin|tx|78701",
  shipTo: "Jane Doe — 123 Main St, Austin, TX 78701",
};
export const USPS_GROUP = {
  groupKey: "grandma|9 elm street||portland|or|97201",
  shipTo: "Grandma — 9 Elm Street, Portland, OR 97201",
};

export const SHIP_TO_AUSTIN = {
  firstName: "Jane",
  lastName: "Doe",
  address1: "123 Main St",
  address2: "Apt 4",
  city: "Austin",
  province: "TX",
  zip: "78701",
  countryCode: "US",
  phone: "5125550100",
};
export const SHIP_TO_PORTLAND = {
  // one-word recipient rides as lastName only
  lastName: "Grandma",
  address1: "9 Elm Street",
  address2: null,
  city: "Portland",
  province: "OR",
  zip: "97201",
  countryCode: "US",
  phone: null,
};

export const SHIPPING_FEDEX = {
  title: "Guaranteed delivery on your selected dates",
  priceWithCurrency: { amount: FEDEX_SHIPPING_TOTAL, currencyCode: "USD" },
};
export const SHIPPING_USPS = {
  title: "USPS First Class — arrives around your selected dates",
  priceWithCurrency: { amount: USPS_SHIPPING_TOTAL, currencyCode: "USD" },
};
/** With FREE_SHIPPING_CODE on the draft: the suffixed title, a zero line. */
export const SHIPPING_FEDEX_FREE = {
  title: "Guaranteed delivery on your selected dates — free shipping",
  priceWithCurrency: { amount: "0.00", currencyCode: "USD" },
};
export const SHIPPING_USPS_FREE = {
  title: "USPS First Class — arrives around your selected dates — free shipping",
  priceWithCurrency: { amount: "0.00", currencyCode: "USD" },
};

/** line-a: library design, filling delta, two add-ons, message, FedEx. */
export const LINE_A_TITLE = "Fun Birthday Piñatagram — Googly";
export const LINE_A_ATTRS: Attr[] = [
  { key: "Graphic", value: "Fun Birthday Piñatagram — Googly" },
  { key: "Body style", value: "Googly" },
  { key: "Filling", value: "School Fun Pack" },
  { key: "Add-ons", value: "Double Candy, Chonky" },
  { key: "Arrives", value: "Thu, Oct 29" },
  { key: "_bodyStyle", value: "googly" },
  { key: "_design", value: "HBD02" },
  { key: "_frontGraphic", value: HBD02_ART },
  { key: "_fillings", value: "School Fun Pack" },
  { key: "_addons", value: "Double Candy, Chonky" },
  { key: "_requestedDate", value: "2026-10-29" },
  { key: "_carrier", value: "fedex" },
  { key: "message", value: "Happy birthday, Sam!" },
];

/** line-b: the Classic default on a unicorn body, no add-ons, no message. */
export const LINE_B_TITLE = "Classic Piñatagrams — White Uni";
export const LINE_B_ATTRS: Attr[] = [
  { key: "Graphic", value: "Classic Piñatagrams — White Uni" },
  { key: "Body style", value: "White Uni" },
  { key: "Filling", value: "Candy" },
  { key: "Arrives", value: "Thu, Oct 29" },
  { key: "_bodyStyle", value: "white-uni" },
  { key: "_design", value: "STANDARD" },
  { key: "_frontGraphic", value: CLASSIC_ART },
  { key: "_fillings", value: "Candy" },
  { key: "_requestedDate", value: "2026-10-29" },
  { key: "_carrier", value: "fedex" },
];

/** line-c: custom design (Blob art + sha + sidecar), USPS window, capped message. */
export const LINE_C_TITLE = "Custom Piñatagram — Pink Uni";
export const LINE_C_ATTRS: Attr[] = [
  { key: "Graphic", value: "Your custom design" },
  { key: "Body style", value: "Pink Uni" },
  { key: "Filling", value: "Dog Treats" },
  // target ± 2 mailing days (Sundays/postal holidays skipped)
  { key: "Arrives", value: "Nov 3 – Nov 7" },
  { key: "_bodyStyle", value: "pink-uni" },
  { key: "_design", value: "custom" },
  { key: "_frontGraphic", value: CUSTOM_ART },
  { key: "_frontGraphicSha256", value: CUSTOM_SHA },
  { key: "_designJson", value: CUSTOM_JSON },
  { key: "_fillings", value: "Dog Treats" },
  { key: "_requestedDate", value: "2026-11-05" },
  { key: "_carrier", value: "usps" },
  { key: "_requestedWindow", value: "2026-11-03..2026-11-07" },
  { key: "message", value: MESSAGE_300 },
];

/* ---------------------------------------------------------------------------
 * Request plumbing shared by both goldens
 * ------------------------------------------------------------------------- */

/** A checkout POST as the storefront sends it. The route rate-limits per
 *  client IP (6/min) under a pinned clock, so callers pass a fresh IP. */
export function checkoutRequest(body: unknown, ip: string): Request {
  return new Request(`https://${HOST}/api/checkout`, {
    method: "POST",
    headers: {
      host: HOST,
      "content-type": "application/json",
      "x-forwarded-for": ip,
    },
    body: JSON.stringify(body),
  });
}

/** The URL a fetch stub was called with, whatever form the caller used. */
export function fetchedUrl(input: RequestInfo | URL): URL {
  return new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
}
