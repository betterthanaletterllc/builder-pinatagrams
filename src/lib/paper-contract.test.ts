import { describe, expect, it } from "vitest";
import {
  ALLOWED_ART_HOSTS,
  BUILDER_BLOB_ART_RE,
  BUILDER_BLOB_HOST,
  CUSTOM_PRODUCT_GID,
  LINE_ATTR_KEYS,
  LINE_ATTR_REQUIRED,
  MESSAGE_MAX_CHARS,
  ORDER_ATTR_REQUIRED,
  PaperContractError,
  SHA256_RE,
  SHIPPING_LINE_TITLE,
  SHOPIFY_CDN_ART_RE,
  artHost,
  assertPaperDraft,
  assertPaperLine,
  carrierOfShippingTitle,
  customSkuFor,
  isCalendarDate,
  isGuaranteedShippingTitle,
  shippingLineTitle,
} from "@/lib/paper-contract";

const CDN_ART =
  "https://cdn.shopify.com/s/files/1/1116/8788/files/HBD02-TROPICAL_front_graphic.png?v=1728858478";
const BLOB_ART = `https://${BUILDER_BLOB_HOST}/art/golden-print.png`;
const BLOB_JSON = `https://${BUILDER_BLOB_HOST}/art/golden-design.json`;
const SHA = "9f2c1e7b4a6d8c0e3b5f7a9d1c3e5b7f9a1c3e5b7d9f1a3c5e7b9d1f3a5c7e9b";

type Attr = { key: string; value: string };
const attrs = (o: Record<string, string>): Attr[] =>
  Object.entries(o).map(([key, value]) => ({ key, value }));

/** A FedEx library-pick line exactly as checkout's dry run emits it. */
function libraryLine(over: Record<string, string | undefined> = {}) {
  const base: Record<string, string | undefined> = {
    Graphic: "Fun Birthday Piñatagram — Googly",
    "Body style": "Googly",
    Filling: "Candy",
    Arrives: "Thu, Oct 29",
    _bodyStyle: "googly",
    _design: "HBD02",
    _frontGraphic: CDN_ART,
    _fillings: "Candy",
    _requestedDate: "2026-10-29",
    _carrier: "fedex",
    ...over,
  };
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) clean[k] = v;
  return {
    title: "Fun Birthday Piñatagram — Googly",
    originalUnitPrice: "31.99",
    quantity: 1,
    requiresShipping: true,
    customAttributes: attrs(clean),
  };
}

/** A USPS custom-design line (Blob art + sha + sidecar + window). */
function customLine(over: Record<string, string | undefined> = {}) {
  const base: Record<string, string | undefined> = {
    Graphic: "Your custom design",
    "Body style": "Pink Uni",
    Filling: "Dog Treats",
    Arrives: "Nov 3 – Nov 7",
    _bodyStyle: "pink-uni",
    _design: "custom",
    _frontGraphic: BLOB_ART,
    _frontGraphicSha256: SHA,
    _designJson: BLOB_JSON,
    _fillings: "Dog Treats",
    _requestedDate: "2026-11-05",
    _carrier: "usps",
    _requestedWindow: "2026-11-03..2026-11-07",
    message: "Congrats on the new job!",
    ...over,
  };
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) clean[k] = v;
  return {
    title: "Custom Piñatagram — Pink Uni",
    originalUnitPrice: "34.99",
    quantity: 1,
    requiresShipping: true,
    customAttributes: attrs(clean),
  };
}

const expectRefusal = (fn: () => unknown, code: string, snippet: string | RegExp) => {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(PaperContractError);
  const err = caught as PaperContractError;
  expect(err.code).toBe(code);
  expect(err.message).toMatch(snippet);
};

describe("paper-contract constants", () => {
  it("freezes the CUSTOM product and the SKU rule incl. the unicorn specials", () => {
    expect(CUSTOM_PRODUCT_GID).toBe("gid://shopify/Product/7741496623202");
    expect(customSkuFor("standard")).toBe("CUSTOM-STANDARD");
    expect(customSkuFor("googly")).toBe("CUSTOM-GOOGLY");
    expect(customSkuFor("star-spangled")).toBe("CUSTOM-STAR SPANGLED");
    expect(customSkuFor("white-uni")).toBe("CUSTOM-WHITE UNICORN");
    expect(customSkuFor("pink-uni")).toBe("CUSTOM-PINK UNICORN");
  });

  it("freezes the line attribute keys (visible + underscore rails)", () => {
    expect(LINE_ATTR_REQUIRED).toEqual([
      "Graphic",
      "Body style",
      "Filling",
      "Arrives",
      "_bodyStyle",
      "_design",
      "_frontGraphic",
      "_fillings",
      "_requestedDate",
    ]);
    expect([...LINE_ATTR_KEYS].sort()).toEqual(
      [
        "Graphic",
        "Body style",
        "Filling",
        "Add-ons",
        "Arrives",
        "_bodyStyle",
        "_design",
        "_frontGraphic",
        "_frontGraphicSha256",
        "_designJson",
        "_fillings",
        "_addons",
        "_requestedDate",
        "_carrier",
        "_requestedWindow",
        "message",
      ].sort(),
    );
    expect(ORDER_ATTR_REQUIRED).toEqual([
      "_builderHost",
      "_builderFlow",
      "_builderVariant",
      "_builderCatalog",
      "_builderNonce",
    ]);
    expect(MESSAGE_MAX_CHARS).toBe(300);
    expect(ALLOWED_ART_HOSTS).toEqual([
      "cdn.shopify.com",
      "yrfds6n4iwscziqm.public.blob.vercel-storage.com",
    ]);
    expect(SHA256_RE.test(SHA)).toBe(true);
    expect(SHA256_RE.test(SHA.toUpperCase())).toBe(false);
  });

  it("only FedEx's shipping title starts with Guaranteed", () => {
    expect(SHIPPING_LINE_TITLE.fedex).toBe("Guaranteed delivery on your selected dates");
    expect(SHIPPING_LINE_TITLE.usps).toBe("USPS First Class — arrives around your selected dates");
    expect(isGuaranteedShippingTitle(SHIPPING_LINE_TITLE.fedex)).toBe(true);
    expect(isGuaranteedShippingTitle(shippingLineTitle("fedex", true))).toBe(true);
    expect(isGuaranteedShippingTitle(SHIPPING_LINE_TITLE.usps)).toBe(false);
    expect(isGuaranteedShippingTitle(shippingLineTitle("usps", true))).toBe(false);
    expect(shippingLineTitle("usps", true)).toBe(
      "USPS First Class — arrives around your selected dates — free shipping",
    );
    expect(carrierOfShippingTitle(shippingLineTitle("fedex", true))).toBe("fedex");
    expect(carrierOfShippingTitle(shippingLineTitle("usps"))).toBe("usps");
    expect(carrierOfShippingTitle("Standard shipping")).toBeNull();
  });

  it("isCalendarDate rejects impossible dates", () => {
    expect(isCalendarDate("2026-10-29")).toBe(true);
    expect(isCalendarDate("2026-02-30")).toBe(false);
    expect(isCalendarDate("2026-13-01")).toBe(false);
    expect(isCalendarDate("10/29/2026")).toBe(false);
  });
});

describe("assertPaperLine — accepts what checkout emits", () => {
  it("a FedEx library pick", () => {
    const r = assertPaperLine(libraryLine(), { carrier: "fedex" });
    expect(r.kind).toBe("pinata");
    if (r.kind === "pinata") expect(r.sku).toBe("CUSTOM-GOOGLY");
  });

  it("the Classic default on a unicorn body (no _carrier = FedEx-only storefront)", () => {
    const r = assertPaperLine(
      libraryLine({
        Graphic: "Classic Piñatagrams — White Uni",
        "Body style": "White Uni",
        _bodyStyle: "white-uni",
        _design: "STANDARD",
        _frontGraphic:
          "https://cdn.shopify.com/s/files/1/1116/8788/files/STANDARD_front.png?v=1728860086",
        _carrier: undefined,
      }),
    );
    expect(r).toMatchObject({ kind: "pinata", sku: "CUSTOM-WHITE UNICORN" });
  });

  it("a library pick with add-ons and a message", () => {
    const r = assertPaperLine(
      libraryLine({
        "Add-ons": "Double Candy",
        _addons: "Double Candy",
        message: "Happy birthday, Sam!",
      }),
    );
    expect(r.kind).toBe("pinata");
  });

  it("a USPS custom design (Blob art + sha + sidecar + window)", () => {
    const r = assertPaperLine(customLine(), { carrier: "usps" });
    expect(r).toMatchObject({ kind: "pinata", sku: "CUSTOM-PINK UNICORN" });
  });

  it("a hub graphic (design code + Blob art + sha, no sidecar)", () => {
    const r = assertPaperLine(
      libraryLine({
        Graphic: "Your selected graphic",
        _design: "H0001",
        _frontGraphic: `https://${BUILDER_BLOB_HOST}/library/h0001.png`,
        _frontGraphicSha256: SHA,
      }),
    );
    expect(r.kind).toBe("pinata");
  });

  it("the live-path variant line shape (variantId + priceOverride, optional sku)", () => {
    const r = assertPaperLine({
      variantId: "gid://shopify/ProductVariant/1",
      sku: "CUSTOM-GOOGLY",
      quantity: 2,
      priceOverride: { amount: "31.99", currencyCode: "USD" },
      customAttributes: libraryLine().customAttributes,
    });
    expect(r.kind).toBe("pinata");
  });

  it("an add-on line (dry-run and live shapes)", () => {
    expect(
      assertPaperLine({ title: "Double Candy", originalUnitPrice: "4.99", quantity: 2, requiresShipping: true }),
    ).toEqual({ kind: "addon", label: "Double Candy" });
    expect(
      assertPaperLine({
        variantId: "gid://shopify/ProductVariant/2",
        quantity: 1,
        priceOverride: { amount: "4.99", currencyCode: "USD" },
      }),
    ).toEqual({ kind: "addon", label: "gid://shopify/ProductVariant/2" });
  });
});

describe("assertPaperLine — refuses contract violations with a precise message", () => {
  it("a CUSTOM-* line without any attributes", () => {
    expectRefusal(
      () => assertPaperLine({ sku: "CUSTOM-GOOGLY", originalUnitPrice: "29.99", quantity: 1 }),
      "attrs_missing",
      /CUSTOM-\* line must carry customAttributes/,
    );
  });

  it("a piñata line missing _frontGraphic", () => {
    expectRefusal(
      () => assertPaperLine(libraryLine({ _frontGraphic: undefined })),
      "attr_missing",
      /missing required attribute\(s\): _frontGraphic/,
    );
  });

  it("Blob art without its sha", () => {
    expectRefusal(
      () => assertPaperLine(customLine({ _frontGraphicSha256: undefined }), { carrier: "usps" }),
      "sha_missing",
      /requires _frontGraphicSha256/,
    );
  });

  it("a malformed sha", () => {
    expectRefusal(
      () => assertPaperLine(customLine({ _frontGraphicSha256: SHA.toUpperCase() }), { carrier: "usps" }),
      "sha_invalid",
      /64 lowercase hex/,
    );
  });

  it("a sha on cdn art (only Blob art is fingerprinted)", () => {
    expectRefusal(
      () => assertPaperLine(libraryLine({ _frontGraphicSha256: SHA })),
      "sha_unexpected",
      /only emitted for Blob-hosted art/,
    );
  });

  it("art on a foreign host, or over http", () => {
    expectRefusal(
      () => assertPaperLine(libraryLine({ _frontGraphic: "https://evil.example.com/x.png" })),
      "art_host",
      /must be an https URL on cdn\.shopify\.com or yrfds6n4iwscziqm/,
    );
    expectRefusal(
      () => assertPaperLine(libraryLine({ _frontGraphic: CDN_ART.replace("https://", "http://") })),
      "art_host",
      /https URL/,
    );
    expectRefusal(
      () =>
        assertPaperLine(
          libraryLine({ _frontGraphic: "https://other.public.blob.vercel-storage.com/x.png" }),
        ),
      "art_host",
      /https URL/,
    );
  });

  it("a custom design whose art isn't on the builder Blob host", () => {
    expectRefusal(
      () => assertPaperLine(customLine({ _frontGraphic: CDN_ART, _frontGraphicSha256: undefined }), { carrier: "usps" }),
      "custom_art_not_blob",
      /"custom" design must point _frontGraphic at/,
    );
  });

  it("a bad or impossible date", () => {
    expectRefusal(
      () => assertPaperLine(libraryLine({ _requestedDate: "10/29/2026" })),
      "date_invalid",
      /_requestedDate must be a real YYYY-MM-DD date — got "10\/29\/2026"/,
    );
    expectRefusal(
      () => assertPaperLine(libraryLine({ _requestedDate: "2026-02-30" })),
      "date_invalid",
      /2026-02-30/,
    );
  });

  it("a USPS line without a window, and a window on a FedEx line", () => {
    expectRefusal(
      () => assertPaperLine(customLine({ _requestedWindow: undefined }), { carrier: "usps" }),
      "window_missing",
      /USPS line must carry _requestedWindow/,
    );
    expectRefusal(
      () => assertPaperLine(libraryLine({ _requestedWindow: "2026-10-27..2026-10-31" })),
      "window_unexpected",
      /_requestedWindow is USPS-only/,
    );
  });

  it("a window that doesn't bracket the date, or is malformed", () => {
    expectRefusal(
      () => assertPaperLine(customLine({ _requestedWindow: "2026-11-06..2026-11-09" }), { carrier: "usps" }),
      "window_range",
      /must bracket _requestedDate 2026-11-05/,
    );
    expectRefusal(
      () => assertPaperLine(customLine({ _requestedWindow: "2026-11-03 to 2026-11-07" }), { carrier: "usps" }),
      "window_invalid",
      /YYYY-MM-DD\.\.YYYY-MM-DD/,
    );
  });

  it("a line whose _carrier disagrees with the order's shipping line", () => {
    expectRefusal(
      () => assertPaperLine(libraryLine(), { carrier: "usps" }),
      "carrier_mismatch",
      /_carrier "fedex" disagrees with the order's shipping line \(usps\)/,
    );
  });

  it("an attribute key outside the frozen set (drift)", () => {
    expectRefusal(
      () => assertPaperLine(libraryLine({ _giftWrap: "yes" })),
      "attr_unknown",
      /outside the frozen contract: "_giftWrap"/,
    );
  });

  it("Filling / _fillings and Add-ons / _addons out of step", () => {
    expectRefusal(
      () => assertPaperLine(libraryLine({ _fillings: "Dog Treats" })),
      "filling_mismatch",
      /_fillings \("Dog Treats"\) must equal Filling \("Candy"\)/,
    );
    expectRefusal(
      () => assertPaperLine(libraryLine({ _addons: "Double Candy" })),
      "addons_pairing",
      /emitted together or not at all/,
    );
    expectRefusal(
      () => assertPaperLine(libraryLine({ _addons: "Double Candy", "Add-ons": "Extra Candy" })),
      "addons_mismatch",
      /_addons \("Double Candy"\) must equal Add-ons \("Extra Candy"\)/,
    );
  });

  it("a message over the cap, or an empty attribute value", () => {
    expectRefusal(
      () => assertPaperLine(libraryLine({ message: "x".repeat(301) })),
      "message_too_long",
      /301 chars; the cap is 300/,
    );
    expectRefusal(
      () => assertPaperLine(libraryLine({ message: "" })),
      "attr_empty",
      /empty attribute value\(s\).*message/,
    );
  });

  it("a sku that doesn't match _bodyStyle, and a non-slug _bodyStyle", () => {
    expectRefusal(
      () => assertPaperLine({ ...libraryLine(), sku: "CUSTOM-WHITE UNICORN" }),
      "sku_mismatch",
      /sku "CUSTOM-WHITE UNICORN" does not match _bodyStyle "googly" \(expected "CUSTOM-GOOGLY"\)/,
    );
    expectRefusal(
      () => assertPaperLine(libraryLine({ _bodyStyle: "White Uni" })),
      "body_style_invalid",
      /_bodyStyle must be a lowercase slug/,
    );
  });

  it("a non-integer quantity and malformed money", () => {
    expectRefusal(
      () => assertPaperLine({ ...libraryLine(), quantity: 1.5 }),
      "quantity_invalid",
      /positive integer/,
    );
    expectRefusal(
      () => assertPaperLine({ ...libraryLine(), originalUnitPrice: "31.9" }),
      "money_format",
      /2-decimal string/,
    );
  });

  it("duplicate attribute keys", () => {
    const li = libraryLine();
    li.customAttributes.push({ key: "_design", value: "HBD03" });
    expectRefusal(() => assertPaperLine(li), "attr_duplicate", /duplicate attribute key "_design"/);
  });
});

describe("assertPaperDraft", () => {
  const order = (over: Record<string, unknown> = {}) => ({
    tags: ["builder", "variant-default"],
    customAttributes: attrs({
      _builderHost: "builder.pinatagrams.com",
      _builderFlow: "v2",
      _builderVariant: "default (tiered/fedex+usps)",
      _builderCatalog: "2026-10-15T14:38:44.115Z",
      _builderNonce: "0123456789abcdef0123456789abcdef",
    }),
    shippingAddress: {
      firstName: "Jane",
      lastName: "Doe",
      address1: "123 Main St",
      address2: null,
      city: "Austin",
      province: "TX",
      zip: "78701",
      countryCode: "US",
      phone: null,
    },
    shippingLine: {
      title: SHIPPING_LINE_TITLE.fedex,
      priceWithCurrency: { amount: "15.00", currencyCode: "USD" },
    },
    lineItems: [libraryLine()],
    ...over,
  });

  it("accepts a FedEx draft and a USPS draft", () => {
    expect(assertPaperDraft(order())).toEqual({ carrier: "fedex", pinataLines: 1, addonLines: 0 });
    expect(
      assertPaperDraft(
        order({
          shippingLine: {
            title: SHIPPING_LINE_TITLE.usps,
            priceWithCurrency: { amount: "6.75", currencyCode: "USD" },
          },
          lineItems: [customLine()],
        }),
      ),
    ).toEqual({ carrier: "usps", pinataLines: 1, addonLines: 0 });
  });

  it("refuses note and corp_ref", () => {
    expectRefusal(() => assertPaperDraft(order({ note: "hi" })), "forbidden_key", /must not carry "note"/);
    expectRefusal(() => assertPaperDraft(order({ corp_ref: "PO-1" })), "forbidden_key", /"corp_ref"/);
  });

  it("refuses a USPS title that starts with Guaranteed and an unknown title", () => {
    expectRefusal(
      () =>
        assertPaperDraft(
          order({
            shippingLine: {
              title: "Guaranteed USPS",
              priceWithCurrency: { amount: "6.75", currencyCode: "USD" },
            },
          }),
        ),
      "shipping_title_unknown",
      /not a contract title/,
    );
  });

  it("refuses a FedEx-titled order whose lines say usps", () => {
    expectRefusal(
      () => assertPaperDraft(order({ lineItems: [customLine()] })),
      "carrier_mismatch",
      /_carrier "usps" disagrees/,
    );
  });

  it("refuses a visible or unknown order-level attribute, and a missing builder tag", () => {
    expectRefusal(
      () =>
        assertPaperDraft(
          order({
            customAttributes: [...order().customAttributes, { key: "Gift note", value: "x" }],
          }),
        ),
      "order_attr_visible",
      /must all start with "_"/,
    );
    expectRefusal(
      () =>
        assertPaperDraft(
          order({
            customAttributes: [...order().customAttributes, { key: "_corpRef", value: "x" }],
          }),
        ),
      "order_attr_unknown",
      /_corpRef/,
    );
    expectRefusal(() => assertPaperDraft(order({ tags: ["variant-default"] })), "tag_builder", /"builder"/);
  });

  it("maps every dry-run add-on line onto a piñata's _addons, else refuses it as a stray charge", () => {
    const withAddon = libraryLine({ "Add-ons": "Double Candy", _addons: "Double Candy" });
    const addonLine = { title: "Double Candy", originalUnitPrice: "4.99", quantity: 1, requiresShipping: true };
    expect(assertPaperDraft(order({ lineItems: [withAddon, addonLine] }))).toEqual({
      carrier: "fedex",
      pinataLines: 1,
      addonLines: 1,
    });
    // two labels on one piñata, two add-on lines, any order
    const twoAddons = libraryLine({ "Add-ons": "Double Candy, Chonky", _addons: "Double Candy, Chonky" });
    const chonkyLine = { title: "Chonky", originalUnitPrice: "9.99", quantity: 1, requiresShipping: true };
    expect(assertPaperDraft(order({ lineItems: [chonkyLine, twoAddons, addonLine] }))).toEqual({
      carrier: "fedex",
      pinataLines: 1,
      addonLines: 2,
    });
    // an add-on line no piñata names
    expectRefusal(
      () => assertPaperDraft(order({ lineItems: [libraryLine(), addonLine] })),
      "addon_unmapped",
      /add-on line "Double Candy" is not named in any piñata line's _addons \(none\)/,
    );
    expectRefusal(
      () => assertPaperDraft(order({ lineItems: [withAddon, chonkyLine] })),
      "addon_unmapped",
      /add-on line "Chonky" is not named in any piñata line's _addons \(Double Candy\)/,
    );
  });

  it("a live piñata line that lost ALL its attributes is refused, never counted as an add-on", () => {
    const live = (over: Record<string, unknown>) => ({
      variantId: "gid://shopify/ProductVariant/10",
      quantity: 1,
      priceOverride: { amount: "29.99", currencyCode: "USD" },
      customAttributes: libraryLine().customAttributes,
      ...over,
    });
    expect(assertPaperDraft(order({ lineItems: [live({}), live({ variantId: "gid://shopify/ProductVariant/11" })] }))).toEqual({
      carrier: "fedex",
      pinataLines: 2,
      addonLines: 0,
    });
    expectRefusal(
      () =>
        assertPaperDraft(
          order({ lineItems: [live({}), live({ variantId: "gid://shopify/ProductVariant/11", customAttributes: [] })] }),
        ),
      "attrs_empty",
      /customAttributes is empty — a piñata line that lost its rails/,
    );
  });

  it("checks live add-on lines against the hub add-ons' variant ids when given them", () => {
    const addonIds = new Set(["gid://shopify/ProductVariant/8001"]);
    const pinata = {
      variantId: "gid://shopify/ProductVariant/10",
      quantity: 1,
      priceOverride: { amount: "29.99", currencyCode: "USD" },
      customAttributes: libraryLine({ "Add-ons": "Double Candy", _addons: "Double Candy" }).customAttributes,
    };
    const addon = (variantId: string) => ({
      variantId,
      quantity: 1,
      priceOverride: { amount: "4.99", currencyCode: "USD" },
    });
    expect(assertPaperDraft(order({ lineItems: [pinata, addon("gid://shopify/ProductVariant/8001")] }), { addonVariantIds: addonIds })).toEqual({
      carrier: "fedex",
      pinataLines: 1,
      addonLines: 1,
    });
    // without the set a live add-on line is unverifiable and passes
    expect(assertPaperDraft(order({ lineItems: [pinata, addon("gid://shopify/ProductVariant/4242")] })).addonLines).toBe(1);
    expectRefusal(
      () => assertPaperDraft(order({ lineItems: [pinata, addon("gid://shopify/ProductVariant/4242")] }), { addonVariantIds: addonIds }),
      "addon_variant_unknown",
      /attaches to variant gid:\/\/shopify\/ProductVariant\/4242, which is not one of the hub add-ons' variants/,
    );
    expectRefusal(
      () =>
        assertPaperDraft(order({ lineItems: [{ ...pinata, variantId: "gid://shopify/ProductVariant/8001" }] }), {
          addonVariantIds: addonIds,
        }),
      "pinata_on_addon_variant",
      /piñata line is attached to an add-on's variant/,
    );
  });
});

describe("assertPaperLine — exactly one pricing field, matching the line's shape", () => {
  const liveAttrs = () => libraryLine().customAttributes;

  it("refuses a live piñata or add-on line without priceOverride (Shopify would charge the variant's own price)", () => {
    expectRefusal(
      () => assertPaperLine({ variantId: "gid://shopify/ProductVariant/1", quantity: 1, customAttributes: liveAttrs() }),
      "price_missing",
      /live line must carry priceOverride \{ amount, currencyCode \}/,
    );
    expectRefusal(
      () => assertPaperLine({ variantId: "gid://shopify/ProductVariant/2", quantity: 2 }),
      "price_missing",
      /gid:\/\/shopify\/ProductVariant\/2: live line must carry priceOverride/,
    );
    expectRefusal(
      () => assertPaperLine({ variantId: "gid://shopify/ProductVariant/2", quantity: 2, priceOverride: "4.99" }),
      "price_missing",
      /priceOverride \{ amount, currencyCode \}/,
    );
  });

  it("refuses a dry-run piñata or add-on line without originalUnitPrice", () => {
    expectRefusal(
      () => assertPaperLine({ title: "x", quantity: 1, requiresShipping: true, customAttributes: liveAttrs() }),
      "price_missing",
      /x: dry-run line must carry originalUnitPrice/,
    );
    expectRefusal(
      () => assertPaperLine({ title: "Double Candy", quantity: 1, requiresShipping: true }),
      "price_missing",
      /Double Candy: dry-run line must carry originalUnitPrice/,
    );
  });

  it("refuses a line that carries BOTH pricing fields", () => {
    expectRefusal(
      () =>
        assertPaperLine({
          variantId: "gid://shopify/ProductVariant/1",
          quantity: 1,
          priceOverride: { amount: "31.99", currencyCode: "USD" },
          originalUnitPrice: "31.99",
          customAttributes: liveAttrs(),
        }),
      "price_field_mixed",
      /live line \(variantId\) prices through priceOverride only/,
    );
    expectRefusal(
      () => assertPaperLine({ ...libraryLine(), priceOverride: { amount: "31.99", currencyCode: "USD" } }),
      "price_field_mixed",
      /dry-run line \(no variantId\) prices through originalUnitPrice only/,
    );
  });

  it("refuses a non-USD or malformed priceOverride", () => {
    expectRefusal(
      () =>
        assertPaperLine({
          variantId: "gid://shopify/ProductVariant/1",
          quantity: 1,
          priceOverride: { amount: "31.99", currencyCode: "CAD" },
          customAttributes: liveAttrs(),
        }),
      "currency",
      /currencyCode must be "USD" — got "CAD"/,
    );
    expectRefusal(
      () =>
        assertPaperLine({
          variantId: "gid://shopify/ProductVariant/1",
          quantity: 1,
          priceOverride: { amount: 31.99, currencyCode: "USD" },
          customAttributes: liveAttrs(),
        }),
      "money_format",
      /priceOverride\.amount must be a positive 2-decimal string/,
    );
  });

  it("allows 0.00 on an add-on line only (the hub may publish a free add-on; a piñata is never free)", () => {
    expect(
      assertPaperLine({ title: "Free Sticker", originalUnitPrice: "0.00", quantity: 1, requiresShipping: true }),
    ).toEqual({ kind: "addon", label: "Free Sticker" });
    expect(
      assertPaperLine({
        variantId: "gid://shopify/ProductVariant/3",
        quantity: 1,
        priceOverride: { amount: "0.00", currencyCode: "USD" },
      }).kind,
    ).toBe("addon");
    expectRefusal(
      () => assertPaperLine({ ...libraryLine(), originalUnitPrice: "0.00" }),
      "money_format",
      /originalUnitPrice must be a positive 2-decimal string/,
    );
    expectRefusal(
      () =>
        assertPaperLine({
          variantId: "gid://shopify/ProductVariant/1",
          quantity: 1,
          priceOverride: { amount: "0.00", currencyCode: "USD" },
          customAttributes: liveAttrs(),
        }),
      "money_format",
      /priceOverride\.amount must be a positive/,
    );
  });
});

describe("assertPaperLine — a customAttributes field makes a piñata line", () => {
  it("an empty array is a piñata that lost its rails, never an add-on", () => {
    expectRefusal(
      () =>
        assertPaperLine({
          variantId: "gid://shopify/ProductVariant/11",
          quantity: 1,
          priceOverride: { amount: "29.99", currencyCode: "USD" },
          customAttributes: [],
        }),
      "attrs_empty",
      /customAttributes is empty/,
    );
    expectRefusal(
      () => assertPaperLine({ title: "Double Candy", originalUnitPrice: "4.99", quantity: 1, customAttributes: [] }),
      "attrs_empty",
      /Double Candy: customAttributes is empty/,
    );
  });

  it("a non-array customAttributes is refused, not ignored", () => {
    expectRefusal(
      () => assertPaperLine({ title: "Double Candy", originalUnitPrice: "4.99", quantity: 1, customAttributes: {} }),
      "attrs_not_array",
      /customAttributes must be an array/,
    );
  });
});

describe("art acceptance is the route's regex, not a URL parse", () => {
  it("refuses a port, an upper-case host and a bare origin on _frontGraphic", () => {
    for (const art of [
      "https://cdn.shopify.com:443/x.png",
      "https://CDN.SHOPIFY.COM/x.png",
      "https://cdn.shopify.com",
      "https://cdn.shopify.com@evil.example/x.png",
      "https://cdn.shopify.com.evil.example/x.png",
    ]) {
      expect(SHOPIFY_CDN_ART_RE.test(art)).toBe(false);
      expect(artHost(art)).toBeNull();
      expectRefusal(() => assertPaperLine(libraryLine({ _frontGraphic: art })), "art_host", /exact host, no port, with a path/);
    }
    for (const art of [
      `https://${BUILDER_BLOB_HOST}:443/art/x.png`,
      `https://${BUILDER_BLOB_HOST.toUpperCase()}/art/x.png`,
      `https://${BUILDER_BLOB_HOST}`,
    ]) {
      expect(BUILDER_BLOB_ART_RE.test(art)).toBe(false);
      expectRefusal(
        () => assertPaperLine(customLine({ _frontGraphic: art }), { carrier: "usps" }),
        "art_host",
        /_frontGraphic must be an https URL/,
      );
    }
    expect(artHost(CDN_ART)).toBe("cdn.shopify.com");
    expect(artHost(BLOB_ART)).toBe(BUILDER_BLOB_HOST);
  });

  it("refuses a _designJson sidecar off the Blob host, with a port, or on the cdn", () => {
    for (const sidecar of [
      CDN_ART,
      `https://${BUILDER_BLOB_HOST}:443/art/design.json`,
      `https://${BUILDER_BLOB_HOST}`,
      "https://other.public.blob.vercel-storage.com/art/design.json",
    ]) {
      expectRefusal(
        () => assertPaperLine(customLine({ _designJson: sidecar }), { carrier: "usps" }),
        "design_json_host",
        /_designJson must be an https URL on yrfds6n4iwscziqm/,
      );
    }
  });
});
