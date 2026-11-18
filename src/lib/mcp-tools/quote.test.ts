import { afterEach, describe, expect, it, vi } from "vitest";
import oneLocation50 from "./__fixtures__/quote-one-location-50.json";
import individual25 from "./__fixtures__/quote-individual-25-custom-fedex.json";
import mix100 from "./__fixtures__/quote-mix-100-40.json";
import {
  CONTINUE_URL,
  QUOTE_URL,
  hubQuoteRequest,
  parseBulkArgs,
  parsePublicQuote,
  quoteTools,
} from "./quote";

/**
 * Offline: globalThis.fetch is stubbed with POST /api/public/quote responses
 * recorded from the live hub on 2026-10-15 (__fixtures__/quote-*.json; each
 * filename names the request it answered). Prices in them go stale and prove
 * nothing live — these tests check the request we send and the projection
 * we return, not the hub's math.
 */

type Refusal = { content: { type: "text"; text: string }[]; isError: true };
const isRefusal = (r: unknown): r is Refusal =>
  !!r && typeof r === "object" && (r as Refusal).isError === true;

function stubHub(reply: () => Response | Promise<Response>) {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => reply());
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const quote = (args: Record<string, unknown>) => quoteTools.quote_bulk.handler(args);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("quote_bulk — argument validation", () => {
  const good = { qty: 50, shipping_mode: "one_location", fill: "filled", graphic_type: "stock" };

  it("accepts the minimal valid call and fills documented defaults", () => {
    expect(parseBulkArgs(good)).toEqual({
      qty: 50,
      shipping_mode: "one_location",
      fill: "filled",
      graphic_type: "stock",
      date_guaranteed: false,
      insert_count: 0,
    });
  });

  it("refuses every malformed input with a message naming the field", () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ ...good, qty: 14 }, "qty"],
      [{ ...good, qty: 50001 }, "qty"],
      [{ ...good, qty: 20.5 }, "qty"],
      [{ ...good, qty: "50" }, "qty"],
      [{ ...good, qty: undefined }, "qty"],
      [{ ...good, shipping_mode: undefined }, "shipping_mode"],
      [{ ...good, shipping_mode: "bulk" }, "shipping_mode"],
      [{ ...good, fill: "half" }, "fill"],
      [{ ...good, fill: undefined }, "fill"],
      [{ ...good, graphic_type: "library" }, "graphic_type"],
      [{ ...good, graphic_type: undefined }, "graphic_type"],
      [{ ...good, shipping_mode: "mix" }, "qty_individual"],
      [{ ...good, shipping_mode: "mix", qty_individual: 0 }, "qty_individual"],
      [{ ...good, shipping_mode: "mix", qty_individual: 50 }, "qty_individual"],
      [{ ...good, shipping_mode: "mix", qty_individual: 2.5 }, "qty_individual"],
      [{ ...good, qty_individual: 10 }, "qty_individual"],
      [{ ...good, shipping_mode: "individual", carrier: "ups" }, "carrier"],
      [{ ...good, carrier: "usps" }, "carrier"], // one_location: carrier is the hub's call
      [{ ...good, shipping_mode: "individual", date_guaranteed: "yes" }, "date_guaranteed"],
      [{ ...good, date_guaranteed: true }, "date_guaranteed"], // one_location
      [{ ...good, insert_count: -1 }, "insert_count"],
      [{ ...good, insert_count: 11 }, "insert_count"],
      [{ ...good, insert_count: 1.5 }, "insert_count"],
    ];
    for (const [args, needle] of cases) {
      const r = parseBulkArgs(args);
      expect("refusal" in r, JSON.stringify(args)).toBe(true);
      if ("refusal" in r) expect(r.refusal, JSON.stringify(args)).toContain(needle);
    }
  });

  it("a refused call never reaches the hub", async () => {
    const fetchMock = stubHub(() => json(oneLocation50));
    const out = await quote({ ...good, qty: 10 });
    expect(isRefusal(out)).toBe(true);
    expect((out as Refusal).content[0].text).toContain("15");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("quote_bulk — request shape (parseQuoteConfig contract)", () => {
  it("one_location: full quote-app shape, bodyType pinned to standard, addSample false", () => {
    const a = parseBulkArgs({ qty: 50, shipping_mode: "one_location", fill: "filled", graphic_type: "stock" });
    if ("refusal" in a) throw new Error(a.refusal);
    expect(hubQuoteRequest(a)).toEqual({
      shippingMode: "one_location",
      fill: "filled",
      bodyType: "standard",
      graphicType: "stock",
      qty: 50,
      carrier: "usps",
      bulkCarrier: "ups",
      insertCount: 0,
      addSample: false,
      dateGuaranteed: false,
    });
  });

  it("individual with fedex + date guarantee + inserts", () => {
    const a = parseBulkArgs({
      qty: 25,
      shipping_mode: "individual",
      fill: "filled",
      graphic_type: "custom",
      carrier: "fedex",
      date_guaranteed: true,
      insert_count: 1,
    });
    if ("refusal" in a) throw new Error(a.refusal);
    expect(hubQuoteRequest(a)).toEqual({
      shippingMode: "individual",
      fill: "filled",
      bodyType: "standard",
      graphicType: "custom",
      qty: 25,
      carrier: "fedex",
      bulkCarrier: "ups",
      insertCount: 1,
      addSample: false,
      dateGuaranteed: true,
    });
  });

  it("mix carries qtyIndividual; other modes never do", () => {
    const mix = parseBulkArgs({ qty: 100, shipping_mode: "mix", qty_individual: 40, fill: "filled", graphic_type: "stock" });
    if ("refusal" in mix) throw new Error(mix.refusal);
    expect(hubQuoteRequest(mix)).toMatchObject({ shippingMode: "mix", qty: 100, qtyIndividual: 40 });
    const ind = parseBulkArgs({ qty: 15, shipping_mode: "individual", fill: "empty", graphic_type: "stock" });
    if ("refusal" in ind) throw new Error(ind.refusal);
    expect("qtyIndividual" in hubQuoteRequest(ind)).toBe(false);
  });

  it("POSTs JSON to the hub's public quote endpoint with a timeout", async () => {
    const fetchMock = stubHub(() => json(mix100));
    await quote({ qty: 100, shipping_mode: "mix", qty_individual: 40, fill: "filled", graphic_type: "stock" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(QUOTE_URL);
    expect(QUOTE_URL).toBe("https://admin.betterthanaletter.com/api/public/quote");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(init?.cache).toBe("no-store");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init?.body))).toEqual({
      shippingMode: "mix",
      fill: "filled",
      bodyType: "standard",
      graphicType: "stock",
      qty: 100,
      qtyIndividual: 40,
      carrier: "usps",
      bulkCarrier: "ups",
      insertCount: 0,
      addSample: false,
      dateGuaranteed: false,
    });
  });
});

describe("quote_bulk — projection of the hub's PublicQuote", () => {
  it("one_location 50: snake_case integer cents, next tier, portal hand-off", async () => {
    stubHub(() => json(oneLocation50));
    const out = await quote({ qty: 50, shipping_mode: "one_location", fill: "filled", graphic_type: "stock" });
    expect(isRefusal(out)).toBe(false);
    expect(out).toEqual({
      qty: 50,
      shipping_mode: "one_location",
      qty_individual: 0,
      qty_bulk: 50,
      fill: "filled",
      graphic_type: "stock",
      body_type: "standard",
      carrier: "usps",
      bulk_carrier: "ups",
      date_guaranteed: false,
      pricing_mode: "firm",
      blended_unit_delivered_cents: 2834,
      product_subtotal_cents: 124200,
      shipping_subtotal_cents: 17500,
      fees_cents: 0,
      total_cents: 141700,
      empty_savings_per_unit_cents: 765,
      moq: 1,
      meets_moq: true,
      next_tier: { qty: 100, blended_unit_delivered_cents: 2710 },
      currency: "USD",
      continue_url: CONTINUE_URL,
      note: expect.stringContaining("placed and invoiced through the Piñatagrams corporate portal"),
    });
    expect(CONTINUE_URL).toBe("https://my.betterthanaletter.com");
    const r = out as Record<string, unknown>;
    for (const k of Object.keys(r).filter((k) => k.endsWith("_cents"))) {
      expect(Number.isInteger(r[k]), k).toBe(true);
    }
    expect(JSON.stringify(out)).not.toMatch(/cogs|margin|markup|cost/i);
  });

  it("individual 25 custom fedex: inserts shown, carrier/guarantee echoed from the hub", async () => {
    stubHub(() => json(individual25));
    const out = (await quote({
      qty: 25,
      shipping_mode: "individual",
      fill: "filled",
      graphic_type: "custom",
      carrier: "fedex",
      date_guaranteed: true,
      insert_count: 1,
    })) as Record<string, unknown>;
    expect(out).toMatchObject({
      carrier: "fedex",
      date_guaranteed: true,
      insert_count: 1,
      insert_subtotal_cents: 2500,
      blended_unit_delivered_cents: 4210,
      total_cents: 105250,
      moq: 15,
      meets_moq: true,
      next_tier: { qty: 50, blended_unit_delivered_cents: 3987 },
    });
  });

  it("empty fill omits empty_savings; zero inserts omit insert fields", async () => {
    stubHub(() => json({ ...oneLocation50, emptySavingsPerUnitCents: 0 }));
    const out = (await quote({ qty: 50, shipping_mode: "one_location", fill: "empty", graphic_type: "stock" })) as Record<
      string,
      unknown
    >;
    expect("empty_savings_per_unit_cents" in out).toBe(false);
    expect("insert_count" in out).toBe(false);
    expect("insert_subtotal_cents" in out).toBe(false);
  });

  it("estimate pricing and an unmet MOQ are called out in the note", async () => {
    stubHub(() => json({ ...oneLocation50, pricingMode: "estimate", moq: 100, meetsMoq: false, nextTier: null }));
    const out = (await quote({ qty: 50, shipping_mode: "one_location", fill: "filled", graphic_type: "stock" })) as Record<
      string,
      string | null
    >;
    expect(out.pricing_mode).toBe("estimate");
    expect(out.meets_moq).toBe(false);
    expect(out.next_tier).toBeNull();
    expect(out.note).toContain("estimate");
    expect(out.note).toContain("at least 100");
  });
});

describe("quote_bulk — hub failures are refusals, never thrown and never defaults", () => {
  const args = { qty: 50, shipping_mode: "one_location", fill: "filled", graphic_type: "stock" };

  it("network error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubHub(() => {
      throw new Error("ECONNRESET");
    });
    const out = await quote(args);
    expect(isRefusal(out)).toBe(true);
    expect((out as Refusal).content[0].text).toMatch(/temporarily unavailable/);
    expect((out as Refusal).content[0].text).not.toContain("ECONNRESET");
  });

  it("hub 503 (pricing config missing) and 400", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const status of [503, 400, 500]) {
      stubHub(() => json({ error: "Pricing isn't available right now." }, status));
      const out = await quote(args);
      expect(isRefusal(out), String(status)).toBe(true);
    }
  });

  it("non-JSON and malformed quote bodies", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubHub(() => new Response("<html>maintenance</html>", { status: 200 }));
    expect(isRefusal(await quote(args))).toBe(true);
    for (const bad of [
      {},
      { ...oneLocation50, totalCents: "1417.00" },
      { ...oneLocation50, totalCents: 1417.5 },
      { ...oneLocation50, totalCents: -1 },
      { ...oneLocation50, meetsMoq: "yes" },
      { ...oneLocation50, pricingMode: "guess" },
      { ...oneLocation50, nextTier: { qty: "100" } },
      null,
      [],
    ]) {
      stubHub(() => json(bad));
      expect(isRefusal(await quote(args)), JSON.stringify(bad)).toBe(true);
    }
  });

  it("parsePublicQuote accepts the recorded fixtures verbatim", () => {
    for (const f of [oneLocation50, individual25, mix100]) {
      expect(parsePublicQuote(f)).not.toBeNull();
    }
    expect(parsePublicQuote({ ...oneLocation50, nextTier: null })?.nextTier).toBeNull();
  });
});
