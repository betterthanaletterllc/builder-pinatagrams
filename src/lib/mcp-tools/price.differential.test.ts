import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/checkout/route";
import { MCP_HOST, priceTools } from "./price";
import catalogFixture from "./__fixtures__/hub-catalog.json";
import priceFixture from "./__fixtures__/hub-price.json";
import graphicsFile from "../../../public/graphics.json";

/**
 * DIFFERENTIAL REVIEW SPEC (adversarial money-math review, 2026-10-15).
 *
 * Runs the SAME selection through price_order and through the REAL
 * /api/checkout POST in dry-run (no SHOPIFY_* env, fetch stubbed to the
 * recorded hub fixtures, clock pinned) and asserts the cents agree:
 * per-line unit price, add-on lines, shipping, merchandise, total.
 * Refusal parity is asserted where both sides must refuse.
 *
 * Asymmetries (one side refuses, the other sells) are asserted as OBSERVED
 * so they are documented, not hidden.
 */

// The checkout tool presents MCP_HOST to the route (which scopes its catalog
// by that Host) and price_order scopes by the same constant: one profile.
const HOST = MCP_HOST;
const BLOB = "https://yrfds6n4iwscziqm.public.blob.vercel-storage.com";
const CLASSIC_ART = "https://cdn.shopify.com/s/files/1/1116/8788/files/STANDARD_front.png?v=1728860086";
const CUSTOM_ART = `${BLOB}/art/diff-print.png`;
const CUSTOM_JSON = `${BLOB}/art/diff-design.json`;
const CUSTOM_SHA = "9f2c1e7b4a6d8c0e3b5f7a9d1c3e5b7f9a1c3e5b7d9f1a3c5e7b9d1f3a5c7e9b";
const HUB_ART = `${BLOB}/library/H0001.png`;
const HUB_SHA = "a".repeat(64);

const AUSTIN = {
  name: "Jane Doe",
  address1: "123 Main St",
  address2: "",
  city: "Austin",
  province: "TX",
  zip: "78701",
  phone: "",
};
const FEDEX_DATE = "2026-10-29";
const USPS_DATE = "2026-11-05";

type Json = Record<string, unknown>;
type Catalog = typeof catalogFixture;

const BASE = priceFixture.unitPriceCents; // 2999
const FEDEX = priceFixture.shipPerUnitCents; // 1500
const LIB = catalogFixture.pricing.graphicLibraryUpchargeCents; // 200
const CUSTOM = catalogFixture.pricing.graphicCustomUpchargeCents; // 500
const USPS = catalogFixture.pricing.uspsShipPerUnitCents; // 675
const DC = catalogFixture.addons[0].priceCents; // 499

const LIBRARY = new Map(
  (graphicsFile as { graphics: { design: string; title: string; art: string | null }[] }).graphics.map((g) => [g.design, g]),
);

let served: Json = structuredClone(catalogFixture) as unknown as Json;
const servedPrice: Json = structuredClone(priceFixture) as unknown as Json;

function patched(fn: (c: Catalog) => void): void {
  const c = structuredClone(catalogFixture) as Catalog;
  fn(c);
  served = c as unknown as Json;
}
function resetCatalog(): void {
  served = structuredClone(catalogFixture) as unknown as Json;
}

const fetched: string[] = [];
const realFetch = globalThis.fetch;
function stubFetch(input: RequestInfo | URL): Promise<Response> {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  fetched.push(url.href);
  const json = (body: unknown) =>
    Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
  if (url.pathname === "/api/public/catalog") return json(served);
  if (url.pathname === "/api/public/price") return json(servedPrice);
  return Promise.reject(new Error(`differential: unexpected fetch ${url.href}`));
}

const savedEnv: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const k of ["SHOPIFY_SHOP", "SHOPIFY_CLIENT_ID", "SHOPIFY_CLIENT_SECRET", "VERCEL_ENV"]) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-15T18:00:00Z"));
  globalThis.fetch = stubFetch as typeof fetch;
});
// A failing assertion must never leave a patched catalog behind for the
// next case (the inline resets below are skipped when an expect throws).
afterEach(() => resetCatalog());
afterAll(() => {
  globalThis.fetch = realFetch;
  vi.useRealTimers();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/* ---- one selection → both request shapes -------------------------------- */

type Graphic = "classic" | "custom" | { lib: string } | { hub: string } | { shopifyRaw: { design: string; art: string } };
type Sel = { style: string; qty: number; filling: string; graphic: Graphic; addons?: string[] };

function cartGraphic(g: Graphic): Json {
  if (g === "classic") {
    return { type: "shopify", design: "STANDARD", title: "Classic Piñatagrams", thumb: null, art: CLASSIC_ART };
  }
  if (g === "custom") {
    return { type: "custom", design: { v: 1, layers: [] }, preview: "", art: CUSTOM_ART, designUrl: CUSTOM_JSON, artSha256: CUSTOM_SHA };
  }
  if ("lib" in g) {
    const row = LIBRARY.get(g.lib.toUpperCase());
    return { type: "shopify", design: g.lib, title: row?.title ?? g.lib, thumb: null, art: row?.art ?? CLASSIC_ART };
  }
  if ("hub" in g) {
    return { type: "hub", design: g.hub, title: "INTERNAL", thumb: null, art: HUB_ART, artSha256: HUB_SHA };
  }
  return { type: "shopify", design: g.shopifyRaw.design, title: g.shopifyRaw.design, thumb: null, art: g.shopifyRaw.art };
}
function priceGraphic(g: Graphic): Json {
  if (g === "classic") return { type: "classic" };
  if (g === "custom") return { type: "custom" };
  if ("lib" in g) return { type: "library", design: g.lib };
  if ("hub" in g) return { type: "library", design: g.hub };
  return { type: "library", design: g.shopifyRaw.design };
}

function cartLines(sels: Sel[], carrier: "fedex" | "usps"): Json[] {
  return sels.map((s, i) => ({
    id: `line-${i + 1}`,
    styleId: s.style,
    styleName: s.style,
    boxImageUrl: null,
    logoZone: null,
    graphic: cartGraphic(s.graphic),
    message: "",
    filling: s.filling,
    ...(s.addons ? { addons: s.addons } : {}),
    deliveryDate: carrier === "usps" ? USPS_DATE : FEDEX_DATE,
    carrier,
    address: AUSTIN,
    qty: s.qty,
  }));
}
function priceArgs(sels: Sel[], carrier: string): Json {
  return {
    carrier,
    lines: sels.map((s) => ({
      style_id: s.style,
      qty: s.qty,
      filling: s.filling,
      graphic: priceGraphic(s.graphic),
      ...(s.addons ? { add_ons: s.addons } : {}),
    })),
  };
}

let ip = 0;
async function route(lines: Json[]): Promise<{ status: number; json: Json }> {
  ip++;
  const req = new Request(`https://${HOST}/api/checkout`, {
    method: "POST",
    headers: { host: HOST, "content-type": "application/json", "x-forwarded-for": `203.0.113.${ip % 250}` },
    body: JSON.stringify({ lines }),
  });
  const res = await POST(req);
  return { status: res.status, json: (await res.json()) as Json };
}
const price = (args: Json) => priceTools.price_order.handler(args) as Promise<Json>;

type Numbers = {
  units: number[];
  qty: number[];
  addons: { label: string; unit: number; qty: number }[];
  shipping: number;
  merchandise: number;
  total: number;
};
const c = (s: unknown) => Math.round(parseFloat(String(s)) * 100);

function routeNumbers(json: Json): Numbers {
  const draft = (json.draftOrders as Json[])[0];
  const input = draft.input as Json;
  const items = input.lineItems as Json[];
  const pinatas = items.filter((i) => i.customAttributes);
  const addons = items.filter((i) => !i.customAttributes);
  const units = pinatas.map((i) => c(i.originalUnitPrice));
  const qty = pinatas.map((i) => i.quantity as number);
  const addonRows = addons.map((i) => ({ label: String(i.title), unit: c(i.originalUnitPrice), qty: i.quantity as number }));
  const shipping = c(((input.shippingLine as Json).priceWithCurrency as Json).amount);
  const merchandise = units.reduce((s, u, i) => s + u * qty[i], 0) + addonRows.reduce((s, a) => s + a.unit * a.qty, 0);
  return { units, qty, addons: addonRows, shipping, merchandise, total: merchandise + shipping };
}
function priceNumbers(q: Json): Numbers {
  const lines = q.lines as Json[];
  const addons = (q.add_on_lines as Json[]).map((a) => ({ label: String(a.label), unit: a.unit_cents as number, qty: a.qty as number }));
  return {
    units: lines.map((l) => l.unit_cents as number),
    qty: lines.map((l) => l.qty as number),
    addons,
    shipping: (q.shipping as Json).cents as number,
    merchandise: q.subtotal_cents as number,
    total: q.total_before_tax_cents as number,
  };
}
const refusalText = (res: Json) =>
  res.isError === true ? (res.content as { text: string }[]).map((x) => x.text).join("\n") : null;

/** Both sides must quote, and agree to the cent. Returns the agreed numbers. */
async function agree(sels: Sel[], carrier: "fedex" | "usps"): Promise<Numbers> {
  const r = await route(cartLines(sels, carrier));
  expect(r.status, `route refused: ${JSON.stringify(r.json)}`).toBe(200);
  const p = await price(priceArgs(sels, carrier));
  expect(refusalText(p), "price_order refused").toBeNull();
  const a = routeNumbers(r.json);
  const b = priceNumbers(p);
  expect(b).toEqual(a);
  return a;
}
/** Both sides must refuse. Returns both messages. */
async function bothRefuse(sels: Sel[], carrier: "fedex" | "usps"): Promise<{ route: string; price: string }> {
  const r = await route(cartLines(sels, carrier));
  expect(r.status, `route sold: ${JSON.stringify(r.json)}`).not.toBe(200);
  const p = await price(priceArgs(sels, carrier));
  const t = refusalText(p);
  expect(t, `price_order sold: ${JSON.stringify(p)}`).not.toBeNull();
  return { route: String(r.json.error), price: t! };
}

/* ---- parity ------------------------------------------------------------- */

describe("price_order ≡ checkout (dry-run), cents for cents", () => {
  const ok0: Sel = { style: "standard", qty: 1, filling: "Candy", graphic: "classic" };

  it("FedEx: classic + library + custom, filling delta, add-on across two lines", async () => {
    patched((cat) => {
      cat.fillings.find((f) => f.id === "school-fun-pack")!.priceCents = 150;
    });
    const n = await agree(
      [
        { style: "standard", qty: 1, filling: "Candy", graphic: "classic" },
        { style: "googly", qty: 2, filling: "School Fun Pack", graphic: { lib: "HBD06" }, addons: ["double-candy"] },
        { style: "pink-uni", qty: 3, filling: "Candy", graphic: "custom", addons: ["double-candy"] },
      ],
      "fedex",
    );
    expect(n.units).toEqual([BASE, BASE + LIB + 150, BASE + CUSTOM]);
    expect(n.addons).toEqual([{ label: "Double Candy", unit: DC, qty: 5 }]);
    expect(n.shipping).toBe(FEDEX * 6);
    expect(n.total).toBe(BASE * 6 + LIB * 2 + 150 * 2 + CUSTOM * 3 + DC * 5 + FEDEX * 6);
    resetCatalog();
  });

  it("USPS: same cart ships at the catalog USPS rate on both sides", async () => {
    const n = await agree(
      [
        { style: "standard", qty: 2, filling: "Candy", graphic: "classic" },
        { style: "tropical", qty: 1, filling: "Candy", graphic: { lib: "HBD02" } },
        { style: "white-uni", qty: 1, filling: "Dog Treats", graphic: "custom" },
      ],
      "usps",
    );
    expect(n.shipping).toBe(USPS * 4);
    expect(n.units).toEqual([BASE, BASE + LIB, BASE + CUSTOM]);
  });

  it("Classic code under the library type prices as Classic on both sides", async () => {
    const n = await agree([{ style: "standard", qty: 1, filling: "Candy", graphic: { lib: "STANDARD" } }], "fedex");
    expect(n.units).toEqual([BASE]);
  });

  it("lower-case design code is upper-cased on both sides", async () => {
    const n = await agree([{ style: "standard", qty: 1, filling: "Candy", graphic: { lib: "hbd06" } }], "fedex");
    expect(n.units).toEqual([BASE + LIB]);
  });

  it("hub graphic prices as a library pick; body-style list gates both sides", async () => {
    patched((cat) => {
      (cat as unknown as Json).hubGraphics = [
        { design: "H0001", title: "INTERNAL", category: "corp", bodyStyles: ["googly"], art: HUB_ART, artSha256: HUB_SHA, thumb: HUB_ART },
      ];
    });
    const n = await agree([{ style: "googly", qty: 2, filling: "Candy", graphic: { hub: "H0001" } }], "fedex");
    expect(n.units).toEqual([BASE + LIB]);
    await bothRefuse([{ style: "standard", qty: 1, filling: "Candy", graphic: { hub: "H0001" } }], "fedex");
    resetCatalog();
  });

  it("hub graphic on a folders-only variant sells on both sides; Classic/library refuse on both", async () => {
    patched((cat) => {
      (cat.variant as Json).library = "none";
      (cat as unknown as Json).hubGraphics = [
        { design: "H0001", title: "INTERNAL", category: "corp", bodyStyles: [], art: HUB_ART, artSha256: HUB_SHA, thumb: HUB_ART },
      ];
    });
    const n = await agree([{ style: "standard", qty: 1, filling: "Candy", graphic: { hub: "H0001" } }], "fedex");
    expect(n.units).toEqual([BASE + LIB]);
    await bothRefuse([{ style: "standard", qty: 1, filling: "Candy", graphic: "classic" }], "fedex");
    await bothRefuse([{ style: "standard", qty: 1, filling: "Candy", graphic: { lib: "HBD06" } }], "fedex");
    resetCatalog();
  });

  it("flat variant: every tier is 0 on both sides", async () => {
    patched((cat) => {
      (cat.variant as Json).pricing = "flat";
    });
    const n = await agree(
      [
        { style: "standard", qty: 1, filling: "Candy", graphic: "classic" },
        { style: "standard", qty: 1, filling: "Candy", graphic: { lib: "HBD06" } },
        { style: "standard", qty: 1, filling: "Candy", graphic: "custom" },
      ],
      "fedex",
    );
    expect(n.units).toEqual([BASE, BASE, BASE]);
    resetCatalog();
  });

  it("duplicate add-on ids on one line dedupe to one add-on unit per piñata on both sides", async () => {
    const n = await agree([{ style: "standard", qty: 3, filling: "Candy", graphic: "classic", addons: ["double-candy", "double-candy"] }], "fedex");
    expect(n.addons).toEqual([{ label: "Double Candy", unit: DC, qty: 3 }]);
  });

  it("the caps: 20 lines × qty 25 = 500 units sells on both sides", async () => {
    const sels: Sel[] = Array.from({ length: 20 }, () => ({ style: "standard", qty: 25, filling: "Candy", graphic: "classic" as const }));
    const n = await agree(sels, "fedex");
    expect(n.shipping).toBe(FEDEX * 500);
    expect(n.total).toBe(BASE * 500 + FEDEX * 500);
  });

  it("refusal parity: qty 26, qty 0, 21 lines, out-of-stock, unknown add-on, filling gating, !allowCustom, FedEx-only + USPS", async () => {
    const ok: Sel = { style: "standard", qty: 1, filling: "Candy", graphic: "classic" };
    await bothRefuse([{ ...ok, qty: 26 }], "fedex");
    await bothRefuse([{ ...ok, qty: 0 }], "fedex");
    await bothRefuse(Array.from({ length: 21 }, () => ok), "fedex");
    await bothRefuse([{ ...ok, addons: ["gift-wrap"] }], "fedex");
    await bothRefuse([{ ...ok, filling: "Realsy Dates", addons: ["double-candy"] }], "fedex");
    await bothRefuse([{ ...ok, filling: "Dog Treats", addons: ["double-candy"] }], "fedex");
    await bothRefuse([{ ...ok, filling: "Gummy Bears" }], "fedex");
    await bothRefuse([{ ...ok, style: "unicorn-deluxe" }], "fedex");

    patched((cat) => {
      cat.bodyStyles.find((s) => s.id === "googly")!.inStock = false;
    });
    await bothRefuse([{ ...ok, style: "googly" }], "fedex");

    patched((cat) => {
      (cat.variant as Json).allowCustom = false;
    });
    await bothRefuse([{ ...ok, graphic: "custom" }], "fedex");

    patched((cat) => {
      (cat.variant as Json).carriers = ["fedex"];
    });
    await bothRefuse([ok], "usps");
    await agree([ok], "fedex");
    resetCatalog();
  });

  it("mixed carriers: the route refuses; price_order's one order-level carrier cannot express a mix", async () => {
    const lines = cartLines(
      [
        { style: "standard", qty: 1, filling: "Candy", graphic: "classic" },
        { style: "standard", qty: 1, filling: "Candy", graphic: "classic" },
      ],
      "fedex",
    );
    (lines[1] as Json).carrier = "usps";
    (lines[1] as Json).deliveryDate = USPS_DATE;
    const r = await route(lines);
    expect(r.status).toBe(400);
    expect(String(r.json.error)).toMatch(/One delivery speed per order/);
  });

  it("catalog host: checkout scopes the catalog by its request Host, price_order by MCP_HOST — one and the same", async () => {
    fetched.length = 0;
    await route(cartLines([ok0], "fedex"));
    const routeCatalog = new URL(fetched.find((u) => u.includes("/api/public/catalog"))!);
    fetched.length = 0;
    await price(priceArgs([ok0], "fedex"));
    const priceCatalog = new URL(fetched.find((u) => u.includes("/api/public/catalog"))!);
    expect(routeCatalog.searchParams.get("host")).toBe(MCP_HOST);
    expect(priceCatalog.searchParams.get("host")).toBe(MCP_HOST);
    expect(priceCatalog.origin + priceCatalog.pathname).toBe(routeCatalog.origin + routeCatalog.pathname);
  });
});

/* ---- asymmetries (documented, not hidden) -------------------------------- */

describe("asymmetries between price_order and checkout", () => {
  const ok: Sel = { style: "standard", qty: 1, filling: "Candy", graphic: "classic" };

  it("NEGATIVE filling delta: checkout honours it, price_order refuses", async () => {
    patched((cat) => {
      cat.fillings.find((f) => f.id === "candy")!.priceCents = -300;
    });
    const r = await route(cartLines([ok], "fedex"));
    expect(r.status).toBe(200);
    expect(routeNumbers(r.json).units).toEqual([BASE - 300]);
    const p = await price(priceArgs([ok], "fedex"));
    expect(refusalText(p)).toMatch(/can't be priced right now/);
    resetCatalog();
  });

  it("MISSING filling priceCents: checkout emits NaN money, price_order refuses", async () => {
    patched((cat) => {
      delete (cat.fillings.find((f) => f.id === "candy") as unknown as Json).priceCents;
    });
    const r = await route(cartLines([ok], "fedex"));
    expect(r.status).toBe(200);
    const items = ((r.json.draftOrders as Json[])[0].input as Json).lineItems as Json[];
    expect(items[0].originalUnitPrice).toBe("NaN");
    const p = await price(priceArgs([ok], "fedex"));
    expect(refusalText(p)).toMatch(/can't be priced right now/);
    resetCatalog();
  });

  // Money-math review 2026-10-15: a fractional priceCents from the hub (150.4)
  // is rounded by checkout's toFixed(2) → "31.49". price_order must never emit
  // a fractional quote, so its integer-cents guard (cents(), the price guard
  // and the pricing-block check in price.ts) refuses instead.
  it("NON-INTEGER cents from the hub: checkout rounds, price_order refuses — never a fractional quote", async () => {
    patched((cat) => {
      cat.fillings.find((f) => f.id === "candy")!.priceCents = 150.4;
    });
    const r = await route(cartLines([ok], "fedex"));
    expect(routeNumbers(r.json).units).toEqual([BASE + 150]); // checkout charges "31.49"
    const p = await price(priceArgs([ok], "fedex"));
    expect(refusalText(p)).toMatch(/the Candy filling can't be priced right now/);
    resetCatalog();
  });

  it("NON-INTEGER base price from the price API: price_order refuses outright", async () => {
    servedPrice.unitPriceCents = BASE + 0.4;
    try {
      const p = await price(priceArgs([ok], "fedex"));
      expect(refusalText(p)).toMatch(/Pricing is unavailable/);
    } finally {
      servedPrice.unitPriceCents = BASE;
    }
  });

  it("design code NOT in graphics.json but with cdn art: checkout sells at library tier, price_order refuses", async () => {
    const sel: Sel = { ...ok, graphic: { shopifyRaw: { design: "BSG01", art: CLASSIC_ART } } };
    const r = await route(cartLines([sel], "fedex"));
    expect(r.status).toBe(200);
    expect(routeNumbers(r.json).units).toEqual([BASE + LIB]);
    const p = await price(priceArgs([sel], "fedex"));
    expect(refusalText(p)).toMatch(/no design has the code "BSG01"/);
  });

  it("custom-typed line claiming the Classic code: checkout and price_order both charge the custom tier", async () => {
    // route: the custom branch ignores g.design entirely
    const lines = cartLines([{ ...ok, graphic: "custom" }], "fedex");
    ((lines[0] as Json).graphic as Json).design = "STANDARD";
    const r = await route(lines);
    expect(r.status).toBe(200);
    expect(routeNumbers(r.json).units).toEqual([BASE + CUSTOM]);
    // price_order: {type:"custom", design:"STANDARD"} is refused (unknown field), {type:"custom"} charges custom
    const p1 = await price({ carrier: "fedex", lines: [{ style_id: "standard", qty: 1, filling: "Candy", graphic: { type: "custom", design: "STANDARD" } }] });
    expect(refusalText(p1)).toMatch(/graphic: unknown field "design"/);
    const p2 = await price(priceArgs([{ ...ok, graphic: "custom" }], "fedex"));
    expect(priceNumbers(p2).units).toEqual([BASE + CUSTOM]);
  });

  it("id leniency: price_order accepts case/label variants the route rejects, but normalizes them in its output", async () => {
    // route: exact styleId, exact filling LABEL, exact add-on ID
    const r1 = await route(cartLines([{ ...ok, style: "Standard" }], "fedex"));
    expect(r1.status).toBe(400);
    const r2 = await route(cartLines([{ ...ok, filling: "candy" }], "fedex"));
    expect(r2.status).toBe(400);
    const r3 = await route(cartLines([{ ...ok, addons: ["Double Candy"] }], "fedex"));
    expect(r3.status).toBe(400);
    // price_order accepts all three and reports the canonical ids/labels
    const p = await price(priceArgs([{ ...ok, style: "Standard", filling: "candy", addons: ["Double Candy"] }], "fedex"));
    expect(refusalText(p)).toBeNull();
    const l = (p.lines as Json[])[0];
    expect(l.style_id).toBe("standard");
    expect(l.filling).toEqual({ id: "candy", label: "Candy" });
    expect(l.add_ons).toEqual(["double-candy"]);
    // and the money matches the canonical selection
    const canon = await route(cartLines([{ ...ok, addons: ["double-candy"] }], "fedex"));
    expect(priceNumbers(p)).toEqual(routeNumbers(canon.json));
  });

});
