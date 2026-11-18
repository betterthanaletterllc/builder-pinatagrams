import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import catalogFixture from "./__fixtures__/hub-catalog.json";
import { HUB_URL } from "@/lib/hub";
import { GUARANTEE_LABEL, GUARANTEE_TERMS } from "@/lib/order-rules";
import { orderTools } from "@/lib/order-tools";
import { MCP_HOST } from "./price";

/**
 * get_delivery_options, OFFLINE (the recorded 2026-10-15 catalog, clock
 * pinned): on a store with a paid guaranteed date, an unguaranteed FedEx
 * date is aimed at the day and may land up to two business days either side
 * — the days the builder's calendar shades (lib/delivery fedexNearbyDays).
 */

const CLOCK = "2026-10-15T15:00:00Z";
type Json = Record<string, unknown>;

/** builder.pinatagrams.com's profile on 2026-11-17. */
const FLAT_50 = {
  name: "flat-50-freeship",
  pricing: "flat",
  carriers: ["fedex"],
  library: "all",
  landingLines: null,
  resolvedVia: "host",
  allowCustom: true,
  showLanding: true,
  flatPrice: { unitCents: 5000, shipCents: 0 },
  guaranteeCents: 500,
};

let served: unknown = catalogFixture;
const hosts: (string | null)[] = [];
const realFetch = globalThis.fetch;

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(CLOCK));
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.href.startsWith(`${HUB_URL}/api/public/catalog`)) {
      hosts.push(url.searchParams.get("host"));
      return new Response(JSON.stringify(served), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected fetch: ${url.href}`);
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  vi.useRealTimers();
});

const ask = async (args: Json, catalog: unknown = { ...catalogFixture, variant: FLAT_50 }) => {
  served = catalog;
  return (await orderTools.get_delivery_options.handler(args)) as Json;
};

describe("get_delivery_options — the guaranteed date and FedEx's ± business days", () => {
  it("an unguaranteed FedEx date on a guarantee store: the business days it may land on (weekends skipped)", async () => {
    // Monday 2026-10-26: two business days back are Thu/Fri (the weekend is skipped).
    const r = await ask({ carrier: "fedex", date: "2026-10-26" });
    expect(r).toMatchObject({ requested: "2026-10-26", ok: true });
    expect(r.may_arrive).toEqual({
      earliest: "2026-10-22",
      latest: "2026-10-28",
      business_days: ["2026-10-22", "2026-10-23", "2026-10-26", "2026-10-27", "2026-10-28"],
      note: `Without the ${GUARANTEE_LABEL.toLowerCase()}, FedEx aims for 2026-10-26 but may deliver on any of these business days.`,
    });
    expect(String(r.promise)).toMatch(/aimed at the chosen date; it may arrive up to 2 business days either side/);
    expect(r.guarantee).toEqual({
      offered: true,
      label: GUARANTEE_LABEL,
      cents_per_pinata: 500,
      terms: GUARANTEE_TERMS,
      how: expect.stringContaining("guaranteed:true"),
    });
    // Scoped to the same profile price_order prices.
    expect(hosts.at(-1)).toBe(MCP_HOST);
  });

  it("with the guarantee, the date is the date", async () => {
    const r = await ask({ carrier: "fedex", date: "2026-10-26", guaranteed: true });
    expect(r).not.toHaveProperty("may_arrive");
    expect(r.promise).toBe("Arrives on the exact date you pick (FedEx 2-Day).");
  });

  it("a store without a paid guarantee: FedEx is the guaranteed service, no range", async () => {
    const r = await ask({ carrier: "fedex", date: "2026-10-26" }, catalogFixture);
    expect(r).not.toHaveProperty("may_arrive");
    expect(r.promise).toBe("Arrives on the exact date you pick (FedEx 2-Day).");
    expect(r.guarantee).toEqual({ offered: false, note: expect.stringMatching(/no paid guaranteed date/) });
  });

  it("USPS keeps its window wording; a refused date gets no range; guaranteed must be a boolean", async () => {
    const usps = await ask({ carrier: "usps", date: "2026-10-28" }, catalogFixture);
    expect(usps).not.toHaveProperty("may_arrive");
    expect(String(usps.promise)).toMatch(/USPS First Class/);
    const sunday = await ask({ carrier: "fedex", date: "2026-10-25" });
    expect(sunday.ok).toBe(false);
    expect(sunday).not.toHaveProperty("may_arrive");
    const bad = (await orderTools.get_delivery_options.handler({ guaranteed: "yes" })) as Json;
    expect(bad.isError).toBe(true);
  });
});
