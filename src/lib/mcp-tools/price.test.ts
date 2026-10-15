import { afterEach, describe, expect, it, vi } from "vitest";
import catalogFixture from "./__fixtures__/hub-catalog.json";
import priceFixture from "./__fixtures__/hub-price.json";
import { CHECKOUT_PRICE_QUERY, MCP_HOST, priceTools } from "./price";
import { catalogUrl, HUB_URL, priceUrl } from "@/lib/hub";

/**
 * price_order is tested OFFLINE against the hub responses recorded on
 * 2026-10-15 (__fixtures__/hub-catalog.json, hub-price.json). Live values
 * at recording time: base 2999, FedEx 1500/unit, library +200, custom +500,
 * USPS 675/unit, default variant tiered + fedex/usps + custom allowed, all
 * 19 styles in stock, every filling at +0 (Dog/Cat Treats and Realsy Dates
 * allow no add-ons), one add-on (Double Candy 499), no hub graphics.
 * Scenarios the live hub doesn't exhibit (out of stock, a filling delta, a
 * flat variant, a hub graphic, FedEx-only) patch a copy of the fixture.
 */

type Price = typeof priceFixture;
type Json = Record<string, unknown>;

const BASE = priceFixture.unitPriceCents; // 2999
const FEDEX = priceFixture.shipPerUnitCents; // 1500
const LIB = catalogFixture.pricing.graphicLibraryUpchargeCents; // 200
const CUSTOM = catalogFixture.pricing.graphicCustomUpchargeCents; // 500
const USPS = catalogFixture.pricing.uspsShipPerUnitCents; // 675
const DOUBLE_CANDY = catalogFixture.addons[0].priceCents; // 499

const clone = <T>(v: T): T => structuredClone(v);
/** A loosely-typed copy of the recorded catalog, ready to patch. */
const catalogCopy = (): Json & { variant: Json; bodyStyles: Json[]; fillings: Json[] } =>
  clone(catalogFixture) as unknown as Json & { variant: Json; bodyStyles: Json[]; fillings: Json[] };

type HubStub = {
  catalog?: unknown;
  price?: unknown;
  catalogStatus?: number;
  priceStatus?: number;
  network?: "down";
};

/** Route the two hub URLs to canned responses; everything else is a bug. */
function stubHub(opts: HubStub = {}) {
  const catalog = opts.catalog ?? catalogFixture;
  const price = opts.price ?? priceFixture;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (opts.network === "down") throw new TypeError("fetch failed");
    const json = (body: unknown, status: number) =>
      new Response(status >= 400 ? "nope" : JSON.stringify(body), {
        status,
        headers: { "content-type": status >= 400 ? "text/plain" : "application/json" },
      });
    if (url.startsWith(`${HUB_URL}/api/public/catalog`)) return json(catalog, opts.catalogStatus ?? 200);
    if (url.startsWith(`${HUB_URL}/api/public/price`)) return json(price, opts.priceStatus ?? 200);
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const run = (args: Json) => priceTools.price_order.handler(args) as Promise<Json>;

const line = (over: Json = {}): Json => ({
  style_id: "standard",
  qty: 1,
  filling: "Candy",
  graphic: { type: "classic" },
  ...over,
});

const order = (lines: Json[], carrier = "fedex"): Json => ({ carrier, lines });

/** A refusal's text, or null when the handler returned a quote. */
function refusal(res: Json): string | null {
  if (res.isError !== true) return null;
  const content = res.content as { type: string; text: string }[];
  return content.map((c) => c.text).join("\n");
}

type Quote = {
  carrier: string;
  lines: {
    line: number;
    style_id: string;
    style_name: string;
    graphic: { type: string; design: string; label: string; tier: string };
    filling: { id: string; label: string };
    add_ons: string[];
    qty: number;
    unit_cents: number;
    line_cents: number;
    breakdown: { base: number; graphic_upcharge: number; filling: number };
  }[];
  add_on_lines: { id: string; label: string; unit_cents: number; qty: number; cents: number }[];
  shipping: { carrier: string; service: string; per_unit_cents: number; units: number; cents: number };
  subtotal_cents: number;
  total_before_tax_cents: number;
  currency: string;
  as_of: string;
  note: string;
};

async function quote(args: Json): Promise<Quote> {
  const res = await run(args);
  const err = refusal(res);
  if (err) throw new Error(`expected a quote, got refusal: ${err}`);
  return res as unknown as Quote;
}

async function refused(args: Json): Promise<string> {
  const res = await run(args);
  const err = refusal(res);
  if (!err) throw new Error(`expected a refusal, got quote: ${JSON.stringify(res)}`);
  return err;
}

describe("price_order — registry shape", () => {
  it("exports exactly one read-only tool with a strict schema", () => {
    expect(Object.keys(priceTools)).toEqual(["price_order"]);
    const def = priceTools.price_order;
    expect(def.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(def.inputSchema).toMatchObject({
      type: "object",
      required: ["carrier", "lines"],
      additionalProperties: false,
    });
    const lines = (def.inputSchema.properties as Json).lines as Json;
    expect(lines.maxItems).toBe(20);
    const item = lines.items as Json;
    expect((item.properties as Json).qty).toMatchObject({ type: "integer", minimum: 1, maximum: 25 });
    expect(item.additionalProperties).toBe(false);
  });
});

describe("price_order — composition mirrors checkout", () => {
  it("fetches the catalog and the route's FIXED price query, fresh", async () => {
    const fetchMock = stubHub();
    await quote(order([line()]));
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls).toHaveLength(2);
    const catalogCall = urls.find((u) => u.includes("/api/public/catalog"))!;
    const priceCall = urls.find((u) => u.includes("/api/public/price"))!;
    // Scoped to MCP_HOST — the Host the checkout tool presents to the route —
    // so price_order and checkout resolve the same variant profile.
    const expectedCatalog = catalogUrl({ host: MCP_HOST });
    expect(expectedCatalog).toBe(`${HUB_URL}/api/public/catalog?host=${encodeURIComponent(MCP_HOST)}`);
    expect(catalogCall).toMatch(new RegExp(`^${expectedCatalog.replace(/[?&]/g, "\\$&")}&fresh=\\d+$`));
    // Exactly what src/app/api/checkout/route.ts asks for, plus the cache-buster.
    const expected = priceUrl(CHECKOUT_PRICE_QUERY);
    expect(expected).toBe(
      `${HUB_URL}/api/public/price?qty=1&fill=filled&bodyType=standard&graphicType=custom&mode=individual&carrier=standard`,
    );
    expect(priceCall).toMatch(new RegExp(`^${expected.replace(/[?&]/g, "\\$&")}&fresh=\\d+$`));
    for (const call of fetchMock.mock.calls) {
      expect(call[1]?.cache).toBe("no-store");
    }
  });

  it("classic rides free, a library design adds the library tier, custom adds the custom tier", async () => {
    stubHub();
    const q = await quote(
      order([
        line({ graphic: { type: "classic" } }),
        line({ graphic: { type: "library", design: "HBD06" } }),
        line({ graphic: { type: "custom" } }),
      ]),
    );
    expect(q.lines.map((l) => l.unit_cents)).toEqual([BASE, BASE + LIB, BASE + CUSTOM]);
    expect(q.lines.map((l) => l.graphic.tier)).toEqual(["classic", "library", "custom"]);
    expect(q.lines[0].graphic).toEqual({
      type: "classic",
      design: "STANDARD",
      label: "Classic Piñatagrams",
      tier: "classic",
    });
    expect(q.lines[1].graphic).toMatchObject({ type: "library", design: "HBD06", label: "Smashing Birthday Piñatagram" });
    expect(q.lines[2].graphic).toMatchObject({ type: "custom", design: "custom", label: "Your custom design" });
    expect(q.lines.map((l) => l.breakdown)).toEqual([
      { base: BASE, graphic_upcharge: 0, filling: 0 },
      { base: BASE, graphic_upcharge: LIB, filling: 0 },
      { base: BASE, graphic_upcharge: CUSTOM, filling: 0 },
    ]);
    const merchandise = BASE * 3 + LIB + CUSTOM;
    expect(q.subtotal_cents).toBe(merchandise);
    expect(q.shipping).toMatchObject({ carrier: "fedex", per_unit_cents: FEDEX, units: 3, cents: FEDEX * 3 });
    expect(q.total_before_tax_cents).toBe(merchandise + FEDEX * 3);
    expect(q.currency).toBe("USD");
    expect(q.note).toMatch(/tax/i);
    expect(q.note).toMatch(/discount/i);
  });

  it("a library graphic with the Classic code prices as classic (tier by design code, like the route)", async () => {
    stubHub();
    const q = await quote(order([line({ graphic: { type: "library", design: "standard" } })]));
    expect(q.lines[0].unit_cents).toBe(BASE);
    expect(q.lines[0].graphic.tier).toBe("classic");
  });

  it("a flat variant prices every graphic the same", async () => {
    const catalog = catalogCopy();
    catalog.variant.pricing = "flat";
    stubHub({ catalog });
    const q = await quote(
      order([
        line({ graphic: { type: "classic" } }),
        line({ graphic: { type: "library", design: "HBD06" } }),
        line({ graphic: { type: "custom" } }),
      ]),
    );
    expect(q.lines.map((l) => l.unit_cents)).toEqual([BASE, BASE, BASE]);
    expect(q.lines.map((l) => l.breakdown.graphic_upcharge)).toEqual([0, 0, 0]);
  });

  it("the filling's price delta prices into the line, and fillings resolve by label or id", async () => {
    const catalog = catalogCopy();
    catalog.fillings.find((f) => f.id === "realsy-dates")!.priceCents = 350;
    stubHub({ catalog });
    const q = await quote(
      order([
        line({ filling: "Realsy Dates", qty: 2 }),
        line({ filling: "realsy-dates", graphic: { type: "custom" } }),
        line({ filling: "candy" }),
      ]),
    );
    expect(q.lines[0].unit_cents).toBe(BASE + 350);
    expect(q.lines[0].line_cents).toBe((BASE + 350) * 2);
    expect(q.lines[0].breakdown).toEqual({ base: BASE, graphic_upcharge: 0, filling: 350 });
    expect(q.lines[0].filling).toEqual({ id: "realsy-dates", label: "Realsy Dates" });
    expect(q.lines[1].unit_cents).toBe(BASE + CUSTOM + 350);
    expect(q.lines[2].filling).toEqual({ id: "candy", label: "Candy" });
    expect(q.lines[2].unit_cents).toBe(BASE);
  });

  it("add-ons become their own aggregated lines (priceCents × qty) and ride the subtotal", async () => {
    stubHub();
    const q = await quote(
      order([
        line({ qty: 3, add_ons: ["double-candy"] }),
        line({ qty: 2, filling: "School Fun Pack", add_ons: ["Double Candy", "double-candy"] }),
        line({ qty: 4 }),
      ]),
    );
    expect(q.lines[0].add_ons).toEqual(["double-candy"]);
    expect(q.lines[1].add_ons).toEqual(["double-candy"]); // deduped, label resolved to id
    expect(q.lines[2].add_ons).toEqual([]);
    // The add-on never changes the piñata's unit price.
    expect(q.lines.map((l) => l.unit_cents)).toEqual([BASE, BASE, BASE]);
    expect(q.add_on_lines).toEqual([
      { id: "double-candy", label: "Double Candy", unit_cents: DOUBLE_CANDY, qty: 5, cents: DOUBLE_CANDY * 5 },
    ]);
    expect(q.subtotal_cents).toBe(BASE * 9 + DOUBLE_CANDY * 5);
    expect(q.shipping.units).toBe(9);
    expect(q.total_before_tax_cents).toBe(BASE * 9 + DOUBLE_CANDY * 5 + FEDEX * 9);
  });

  it("USPS ships at the catalog's USPS rate, FedEx at the price API's rate", async () => {
    stubHub();
    const usps = await quote(order([line({ qty: 2 }), line({ qty: 3 })], "usps"));
    expect(usps.shipping).toMatchObject({ carrier: "usps", per_unit_cents: USPS, units: 5, cents: USPS * 5 });
    expect(usps.shipping.service).toMatch(/USPS First Class/);
    expect(usps.total_before_tax_cents).toBe(BASE * 5 + USPS * 5);

    const fedex = await quote(order([line({ qty: 2 }), line({ qty: 3 })], "fedex"));
    expect(fedex.shipping).toMatchObject({ carrier: "fedex", per_unit_cents: FEDEX, units: 5, cents: FEDEX * 5 });
    expect(fedex.shipping.service).toMatch(/FedEx 2-Day/);
    expect(fedex.total_before_tax_cents).toBe(BASE * 5 + FEDEX * 5);
  });

  it("a hub graphic prices as a library pick and honours its body-style list", async () => {
    const catalog = catalogCopy();
    catalog.hubGraphics = [
      {
        design: "H0001",
        title: "INTERNAL folder title",
        category: "corp",
        bodyStyles: ["googly"],
        art: "https://yrfds6n4iwscziqm.public.blob.vercel-storage.com/library/H0001.png",
        artSha256: "a".repeat(64),
        thumb: "https://yrfds6n4iwscziqm.public.blob.vercel-storage.com/library/H0001-thumb.png",
      },
    ];
    stubHub({ catalog });
    const q = await quote(order([line({ style_id: "googly", graphic: { type: "library", design: "h0001" } })]));
    expect(q.lines[0].unit_cents).toBe(BASE + LIB);
    expect(q.lines[0].graphic).toEqual({ type: "library", design: "H0001", label: "Your selected graphic", tier: "library" });
    expect(JSON.stringify(q)).not.toContain("INTERNAL");

    const err = await refused(order([line({ style_id: "standard", graphic: { type: "library", design: "H0001" } })]));
    expect(err).toMatch(/H0001 isn't offered on the Standard body/);
  });

  it("never leaks costs, margins, SKUs or stock counts", async () => {
    stubHub();
    const q = await quote(order([line({ add_ons: ["double-candy"] })], "usps"));
    expect(JSON.stringify(q)).not.toMatch(/cost|margin|sku|stock|wholesale|cogs/i);
  });
});

describe("price_order — refusals", () => {
  it("refuses a quantity outside 1..25 (never clamps)", async () => {
    stubHub();
    expect(await refused(order([line({ qty: 26 })]))).toMatch(/Line 1: qty must be a whole number from 1 to 25/);
    expect(await refused(order([line({ qty: 0 })]))).toMatch(/Line 1: qty must be/);
    expect(await refused(order([line({ qty: 2.5 })]))).toMatch(/Line 1: qty must be/);
    expect(await refused(order([line({ qty: "3" })]))).toMatch(/Line 1: qty must be/);
    const ok = await quote(order([line({ qty: 25 })]));
    expect(ok.lines[0].line_cents).toBe(BASE * 25);
  });

  it("refuses more than 20 lines", async () => {
    stubHub();
    const err = await refused(order(Array.from({ length: 21 }, () => line())));
    expect(err).toMatch(/caps at 20 lines/);
  });

  it("refuses an unknown body style and lists the in-stock ids", async () => {
    stubHub();
    const err = await refused(order([line({ style_id: "unicorn-deluxe" })]));
    expect(err).toMatch(/Line 1: body style "unicorn-deluxe" isn't available/);
    expect(err).toMatch(/standard, googly, tropical/);
  });

  it("refuses an out-of-stock body style by name", async () => {
    const catalog = catalogCopy();
    catalog.bodyStyles.find((s) => s.id === "googly")!.inStock = false;
    stubHub({ catalog });
    const err = await refused(order([line({ style_id: "googly" })]));
    expect(err).toMatch(/the Googly body is out of stock right now/);
    // An out-of-stock style is also dropped from the "choose one of" list.
    const unknown = await refused(order([line({ style_id: "nope" })]));
    expect(unknown).not.toMatch(/\bgoogly\b/);
  });

  it("refuses an unknown filling and lists the allowed fillings", async () => {
    stubHub();
    const err = await refused(order([line({ filling: "Gummy Bears" })]));
    expect(err).toMatch(/Line 1: filling "Gummy Bears" isn't available/);
    expect(err).toMatch(/Candy \(candy\), School Fun Pack \(school-fun-pack\)/);
  });

  it("refuses an unknown add-on and lists the allowed add-ons", async () => {
    stubHub();
    const err = await refused(order([line({ add_ons: ["gift-wrap"] })]));
    expect(err).toMatch(/Line 1: add-on "gift-wrap" isn't available/);
    expect(err).toMatch(/Double Candy \(double-candy\)/);
  });

  it("refuses an add-on the filling doesn't allow (fillingAllowsAddon gating)", async () => {
    stubHub();
    for (const filling of ["Realsy Dates", "Dog Treats", "cat-treats"]) {
      const err = await refused(order([line({ filling, add_ons: ["double-candy"] })]));
      expect(err).toMatch(/Double Candy isn't available with the (Realsy Dates|Dog Treats|Cat Treats) filling/);
    }
    // Candy + School Fun Pack allow everything.
    await quote(order([line({ filling: "Candy", add_ons: ["double-candy"] }), line({ filling: "School Fun Pack", add_ons: ["double-candy"] })]));
  });

  it("refuses an unknown design code and a malformed one", async () => {
    stubHub();
    expect(await refused(order([line({ graphic: { type: "library", design: "HBD9999" } })]))).toMatch(
      /no design has the code "HBD9999"/,
    );
    expect(await refused(order([line({ graphic: { type: "library", design: "hbd-06!" } })]))).toMatch(/isn't valid/);
    expect(await refused(order([line({ graphic: { type: "library" } })]))).toMatch(/graphic\.design is required/);
  });

  it("refuses client one-off designs hidden from the public library", async () => {
    stubHub();
    // EXCLUDED_PREFIXES = BSG / BRYNNEIL / RETENTION — none is sellable here.
    const err = await refused(order([line({ graphic: { type: "library", design: "BSG01" } })]));
    expect(err).toMatch(/no design has the code "BSG01"/);
  });

  it("refuses custom designs on a variant that doesn't allow them", async () => {
    const catalog = catalogCopy();
    catalog.variant.allowCustom = false;
    stubHub({ catalog });
    const err = await refused(order([line({ graphic: { type: "custom" } })]));
    expect(err).toMatch(/custom designs aren't offered on this store/);
  });

  it("refuses Classic and library picks on a folders-only variant", async () => {
    const catalog = catalogCopy();
    catalog.variant.library = "none";
    stubHub({ catalog });
    const err = await refused(order([line({ graphic: { type: "classic" } }), line({ graphic: { type: "library", design: "HBD06" } })]));
    expect(err).toMatch(/Line 1: the Classic design isn't offered on this store/);
    expect(err).toMatch(/Line 2: design HBD06 isn't offered on this store/);
  });

  it("refuses USPS when the variant is FedEx-only", async () => {
    const catalog = catalogCopy();
    catalog.variant.carriers = ["fedex"];
    stubHub({ catalog });
    expect(await refused(order([line()], "usps"))).toMatch(/USPS isn't offered on this store/);
    await quote(order([line()], "fedex"));
  });

  it("refuses a missing or bad carrier", async () => {
    stubHub();
    expect(await refused({ lines: [line()] })).toMatch(/carrier is required/);
    expect(await refused(order([line()], "ups"))).toMatch(/carrier must be "fedex" or "usps"/);
  });

  it("refuses unknown fields instead of ignoring them (a typo'd addons would under-quote)", async () => {
    stubHub();
    const err = await refused(order([line({ addons: ["double-candy"] })]));
    expect(err).toMatch(/Line 1: unknown field "addons" — allowed fields are style_id, qty, filling, graphic, add_ons/);
    expect(await refused({ carrier: "fedex", lines: [line()], discount: "SAVE10" })).toMatch(/Order: unknown field "discount"/);
    expect(await refused(order([line({ graphic: { type: "classic", design: "HBD06" } })]))).toMatch(
      /graphic: unknown field "design"/,
    );
  });

  it("refuses an empty or missing lines array", async () => {
    stubHub();
    expect(await refused({ carrier: "fedex", lines: [] })).toMatch(/lines must be a non-empty array/);
    expect(await refused({ carrier: "fedex" })).toMatch(/lines must be a non-empty array/);
  });

  it("skips the hub entirely when no line could be priced anyway", async () => {
    const fetchMock = stubHub();
    await refused({ carrier: "fedex" });
    await refused({ carrier: "fedex", lines: [] });
    await refused(order(Array.from({ length: 21 }, () => line())));
    await refused(order([line({ qty: 0 }), line({ addons: [] })]));
    await refused({ carrier: "fedex", lines: ["not an object"] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports every problem across every line at once, shape and catalog together, in line order", async () => {
    stubHub();
    const err = await refused({
      carrier: "ups",
      lines: [
        line({ style_id: "nope", filling: "Gummy" }),
        line(),
        line({ qty: 99, graphic: { type: "library", design: "ZZZ99" } }),
        line({ graphic: { type: "library", design: "ZZZ99" } }),
      ],
    });
    expect(err).toMatch(/^5 things need fixing/);
    const order_ = ["carrier must be", 'Line 1: body style "nope"', 'Line 1: filling "Gummy"', "Line 3: qty must be", 'Line 4: no design has the code "ZZZ99"'];
    const positions = order_.map((s) => err.indexOf(s));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(err).not.toMatch(/Line 2:/);
  });
});

describe("price_order — hub unavailable", () => {
  it("returns a toolError when the catalog answers 503", async () => {
    stubHub({ catalogStatus: 503 });
    const err = await refused(order([line()]));
    expect(err).toMatch(/catalog is unavailable right now/);
    expect(err).toMatch(/Nothing was ordered/);
  });

  it("returns a toolError when the price API answers 503", async () => {
    stubHub({ priceStatus: 503 });
    expect(await refused(order([line()]))).toMatch(/Pricing is unavailable right now/);
  });

  it("returns a toolError when the network is down (no throw)", async () => {
    stubHub({ network: "down" });
    const res = await run(order([line()]));
    expect(res.isError).toBe(true);
  });

  it("never quotes at zero or from a malformed price", async () => {
    stubHub({ price: { ...(priceFixture as Price), unitPriceCents: 0 } });
    expect(await refused(order([line()]))).toMatch(/Pricing is unavailable/);
    stubHub({ price: { ...(priceFixture as Price), shipPerUnitCents: -1 } });
    expect(await refused(order([line()]))).toMatch(/Pricing is unavailable/);
    stubHub({ price: { hello: "world" } });
    expect(await refused(order([line()]))).toMatch(/Pricing is unavailable/);
    stubHub({ catalog: { bodyStyles: "not-an-array" } });
    expect(await refused(order([line()]))).toMatch(/catalog is unavailable/);
  });
});

describe("price_order — integer cents only", () => {
  it("refuses a filling or add-on whose price delta is not whole cents (checkout would round it)", async () => {
    const catalog = catalogCopy();
    catalog.fillings.find((f) => f.id === "candy")!.priceCents = 150.4;
    stubHub({ catalog });
    expect(await refused(order([line({ filling: "Candy" })]))).toMatch(/Line 1: the Candy filling can't be priced right now/);

    const catalog2 = catalogCopy();
    (catalog2.addons as Json[])[0].priceCents = 499.5;
    stubHub({ catalog: catalog2 });
    expect(await refused(order([line({ add_ons: ["double-candy"] })]))).toMatch(
      /Line 1: the Double Candy add-on can't be priced right now/,
    );
  });

  it("refuses a negative filling delta (documented in the tool description)", async () => {
    const catalog = catalogCopy();
    catalog.fillings.find((f) => f.id === "candy")!.priceCents = -300;
    stubHub({ catalog });
    expect(await refused(order([line({ filling: "Candy" })]))).toMatch(/the Candy filling can't be priced right now/);
    expect(priceTools.price_order.description).toMatch(/negative or not whole cents is refused/);
  });

  it("refuses a fractional base price or FedEx rate from the price API", async () => {
    stubHub({ price: { ...(priceFixture as Price), unitPriceCents: 2999.4 } });
    expect(await refused(order([line()]))).toMatch(/Pricing is unavailable/);
    stubHub({ price: { ...(priceFixture as Price), shipPerUnitCents: 1500.5 } });
    expect(await refused(order([line()]))).toMatch(/Pricing is unavailable/);
  });

  it("refuses a fractional tier or USPS rate in the catalog's pricing block, whatever the carrier", async () => {
    for (const key of ["graphicLibraryUpchargeCents", "graphicCustomUpchargeCents", "uspsShipPerUnitCents"]) {
      const catalog = catalogCopy();
      (catalog.pricing as Json)[key] = 200.5;
      stubHub({ catalog });
      expect(await refused(order([line()], "fedex")), key).toMatch(/Pricing is unavailable/);
      expect(await refused(order([line()], "usps")), key).toMatch(/Pricing is unavailable/);
    }
  });

  it("every emitted cents figure is an integer on a valid quote", async () => {
    stubHub();
    const q = await quote(order([line({ qty: 3, add_ons: ["double-candy"] }), line({ graphic: { type: "custom" } })], "usps"));
    const figures = [
      ...q.lines.flatMap((l) => [l.unit_cents, l.line_cents, l.breakdown.base, l.breakdown.graphic_upcharge, l.breakdown.filling]),
      ...q.add_on_lines.flatMap((a) => [a.unit_cents, a.cents]),
      q.shipping.per_unit_cents,
      q.shipping.cents,
      q.subtotal_cents,
      q.total_before_tax_cents,
    ];
    expect(figures.every((v) => Number.isInteger(v))).toBe(true);
  });
});

describe("price_order — catalog host (MCP_HOST)", () => {
  const ENV = "MCP_STOREFRONT_HOST";
  const saved = process.env[ENV];
  afterEach(() => {
    if (saved === undefined) delete process.env[ENV];
    else process.env[ENV] = saved;
    vi.resetModules();
  });

  it("defaults to mcp.pinatagrams.com and MCP_STOREFRONT_HOST overrides it, at module load", async () => {
    delete process.env[ENV];
    vi.resetModules();
    const fresh = await import("./price");
    expect(fresh.MCP_HOST).toBe("mcp.pinatagrams.com");

    process.env[ENV] = "preview.example.test";
    vi.resetModules();
    const overridden = await import("./price");
    expect(overridden.MCP_HOST).toBe("preview.example.test");
    const fetchMock = stubHub();
    const res = (await overridden.priceTools.price_order.handler(order([line()]))) as Json;
    expect(refusal(res)).toBeNull();
    const catalogCall = fetchMock.mock.calls.map((c) => String(c[0])).find((u) => u.includes("/api/public/catalog"))!;
    expect(new URL(catalogCall).searchParams.get("host")).toBe("preview.example.test");
  });

  it("the tool description tells the checkout tool to reuse this quote's normalized ids and labels", () => {
    expect(priceTools.price_order.description).toMatch(/normalized style_id, filling\.label and add_ons/);
    expect(priceTools.price_order.description).toMatch(/never the caller's raw strings/);
  });
});
