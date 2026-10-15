import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/checkout/route";
import {
  assertPaperDraft,
  assertPaperLine,
  customSkuFor,
  isGuaranteedShippingTitle,
  shippingLineTitle,
} from "@/lib/paper-contract";
import {
  CHONKY,
  CHONKY_UNIT,
  CLOCK,
  CUSTOM_UP,
  DOUBLE_CANDY,
  DOUBLE_CANDY_UNIT,
  FEDEX_BODY,
  FEDEX_GROUP,
  FEDEX_SHIP,
  FEDEX_SHIPPING_TOTAL,
  FILLING_DELTA_CENTS,
  FIXED_PRICE_QUERY,
  FREE_SHIPPING_CODE,
  HOST,
  LIB_UP,
  LINE_A_ATTRS,
  LINE_A_TITLE,
  LINE_A_UNIT,
  LINE_B_ATTRS,
  LINE_B_TITLE,
  LINE_B_UNIT,
  LINE_C_ATTRS,
  LINE_C_TITLE,
  LINE_C_UNIT,
  MESSAGE_300,
  MESSAGE_320,
  SHIPPING_FEDEX,
  SHIPPING_FEDEX_FREE,
  SHIPPING_USPS,
  SHIPPING_USPS_FREE,
  SHIP_TO_AUSTIN,
  SHIP_TO_PORTLAND,
  TAGS,
  UNIT,
  USPS_BODY,
  USPS_GROUP,
  USPS_SHIP,
  USPS_SHIPPING_TOTAL,
  checkoutRequest,
  fetchedUrl,
  hubResponse,
  money,
  orderAttrs,
} from "./__fixtures__/golden-carts";

/**
 * GOLDEN CHECKOUT PAYLOAD — the Paper contract, end to end (DRY-RUN shape).
 *
 * Drives the REAL /api/checkout handler in dry-run mode (no SHOPIFY_* env) with
 * globalThis.fetch stubbed to serve recorded hub responses, and asserts the
 * draft-order payload it would send to Shopify KEY BY KEY against an explicit
 * expected object. Any drift in attribute keys, values, prices, titles or
 * shape fails loudly. Runs fully offline; Shopify is never reachable.
 *
 * Inputs (carts, served catalog, clock) and the frozen per-line attribute
 * expectations live in ./__fixtures__/golden-carts.ts, shared with the
 * live-shape golden (checkout-golden-live.test.ts), which covers what dry-run
 * structurally cannot: variantId per SKU and priceOverride on every line.
 *
 * Checkout refuses a cart that mixes carriers (one order = one shipping
 * line), so FedEx and USPS are two separate checkouts here.
 */

// The route reads SHOPIFY_* lazily inside POST today, but a future hoist of
// the creds to module scope would silently flip this file to the live path
// (and then into the stub's rejection). Scrub BEFORE the route module is
// evaluated, not in beforeAll.
const savedEnv = vi.hoisted(() => {
  const saved: Record<string, string | undefined> = {};
  for (const k of ["SHOPIFY_SHOP", "SHOPIFY_CLIENT_ID", "SHOPIFY_CLIENT_SECRET", "VERCEL_ENV"]) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  return saved;
});

const fetched: string[] = [];
const realFetch = globalThis.fetch;

function stubFetch(input: RequestInfo | URL): Promise<Response> {
  const url = fetchedUrl(input);
  fetched.push(url.href);
  const hub = hubResponse(url);
  if (hub) return Promise.resolve(hub);
  // Anything else (Shopify, …) is a test failure, never a network call.
  return Promise.reject(new Error(`golden test: unexpected fetch ${url.href}`));
}

let ipCounter = 0;
async function checkout(body: unknown) {
  ipCounter++;
  fetched.length = 0;
  const res = await POST(checkoutRequest(body, `203.0.113.${ipCounter}`));
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(CLOCK));
  globalThis.fetch = stubFetch as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  vi.useRealTimers();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/* ---------------------------------------------------------------------------
 * Expected payloads — LITERAL. Change these only when the Paper contract
 * changes on purpose (and Paper is released to match).
 * ------------------------------------------------------------------------- */

const NONCE = expect.stringMatching(/^[a-f0-9]{32}$/);

const DRY_RUN_REASON =
  "Shopify credentials aren't configured (needs SHOPIFY_SHOP, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET). This is exactly what would be sent:";

const FEDEX_INPUT = {
  tags: TAGS,
  customAttributes: orderAttrs(NONCE, true),
  shippingAddress: SHIP_TO_AUSTIN,
  shippingLine: SHIPPING_FEDEX,
  lineItems: [
    {
      title: LINE_A_TITLE,
      originalUnitPrice: LINE_A_UNIT,
      quantity: 2,
      requiresShipping: true,
      customAttributes: LINE_A_ATTRS,
    },
    {
      title: LINE_B_TITLE,
      originalUnitPrice: LINE_B_UNIT,
      quantity: 1,
      requiresShipping: true,
      customAttributes: LINE_B_ATTRS,
    },
    // each add-on as its own aggregated product line: priceCents × the qty
    // of the piñata(s) carrying it, in first-seen order
    {
      title: "Double Candy",
      originalUnitPrice: DOUBLE_CANDY_UNIT,
      quantity: 2,
      requiresShipping: true,
    },
    {
      title: "Chonky",
      originalUnitPrice: CHONKY_UNIT,
      quantity: 2,
      requiresShipping: true,
    },
  ],
};

const EXPECTED_FEDEX = {
  dryRun: true,
  reason: DRY_RUN_REASON,
  draftOrders: [
    {
      ...FEDEX_GROUP,
      nonce: NONCE,
      lines: expect.any(Array),
      input: FEDEX_INPUT,
    },
  ],
  invoiceEmail: false,
  supersedes: null,
};

const USPS_INPUT = {
  tags: TAGS,
  customAttributes: orderAttrs(NONCE, false),
  shippingAddress: SHIP_TO_PORTLAND,
  shippingLine: SHIPPING_USPS,
  lineItems: [
    {
      title: LINE_C_TITLE,
      originalUnitPrice: LINE_C_UNIT,
      quantity: 1,
      requiresShipping: true,
      customAttributes: LINE_C_ATTRS,
    },
  ],
};

const EXPECTED_USPS = {
  dryRun: true,
  reason: DRY_RUN_REASON,
  draftOrders: [
    {
      ...USPS_GROUP,
      nonce: NONCE,
      lines: expect.any(Array),
      input: USPS_INPUT,
    },
  ],
  invoiceEmail: false,
  supersedes: null,
};

/* ---------------------------------------------------------------------------
 * Tests
 * ------------------------------------------------------------------------- */

type Draft = { nonce: string; input: Record<string, unknown> & { lineItems: unknown[] } };

function sanityOfComposition() {
  // The literal expectations above restate this arithmetic; if the fixture
  // moves, this names the drift before the deep-equal does.
  expect(money(UNIT + LIB_UP + FILLING_DELTA_CENTS)).toBe(LINE_A_UNIT);
  expect(money(UNIT)).toBe(LINE_B_UNIT);
  expect(money(UNIT + CUSTOM_UP)).toBe(LINE_C_UNIT);
  expect(money(FEDEX_SHIP * 3)).toBe(FEDEX_SHIPPING_TOTAL);
  expect(money(USPS_SHIP)).toBe(USPS_SHIPPING_TOTAL);
  expect(money(DOUBLE_CANDY)).toBe(DOUBLE_CANDY_UNIT);
  expect(money(CHONKY)).toBe(CHONKY_UNIT);
  // The capped message: 320 in, the literal first 300 out (slice, then trim —
  // a letter at char 300 means nothing is trimmed).
  expect(MESSAGE_320).toHaveLength(320);
  expect(MESSAGE_300).toHaveLength(300);
  expect(MESSAGE_320.startsWith(MESSAGE_300)).toBe(true);
  expect(MESSAGE_300.slice(0, 300).trim()).toBe(MESSAGE_300);
}

describe("checkout dry-run golden payload (Paper contract)", () => {
  it("FedEx: library design + filling delta + two add-ons + analytics, and the Classic default on a unicorn body", async () => {
    sanityOfComposition();
    const { status, json } = await checkout(FEDEX_BODY);
    expect(status).toBe(200);
    expect(json).toEqual(EXPECTED_FEDEX);

    // The hub was asked exactly twice: the host-scoped catalog and the FIXED
    // price query (both cache-busted) — nothing else, so Shopify was never reachable.
    expect(fetched).toHaveLength(2);
    const catalogUrl = new URL(fetched.find((u) => u.includes("/api/public/catalog"))!);
    expect(catalogUrl.searchParams.get("host")).toBe(HOST);
    expect(catalogUrl.searchParams.has("fresh")).toBe(true);
    const priceUrl = new URL(fetched.find((u) => u.includes("/api/public/price"))!);
    priceUrl.searchParams.delete("fresh");
    expect(priceUrl.search).toBe(`?${FIXED_PRICE_QUERY}`);

    const [draft] = json.draftOrders as Draft[];
    expect(draft.input).not.toHaveProperty("note");
    expect(draft.input).not.toHaveProperty("corp_ref");
    expect(draft.input).not.toHaveProperty("email");
    expect(draft.input).not.toHaveProperty("discountCodes");
    // the returned nonce IS the order's _builderNonce
    const nonceAttr = (draft.input.customAttributes as { key: string; value: string }[]).find(
      (a) => a.key === "_builderNonce",
    );
    expect(nonceAttr?.value).toBe(draft.nonce);
    expect((draft.input.shippingLine as { title: string }).title.startsWith("Guaranteed")).toBe(true);

    // Every emitted line satisfies the frozen contract (incl. the add-on →
    // _addons mapping); the SKU rule the live path applies (dry run exposes
    // no variantId/SKU) resolves per body.
    expect(assertPaperDraft(draft.input)).toEqual({ carrier: "fedex", pinataLines: 2, addonLines: 2 });
    const kinds = draft.input.lineItems.map((li) => assertPaperLine(li, { carrier: "fedex" }));
    expect(kinds.map((k) => (k.kind === "pinata" ? k.sku : k.label))).toEqual([
      "CUSTOM-GOOGLY",
      "CUSTOM-WHITE UNICORN",
      "Double Candy",
      "Chonky",
    ]);
    expect(customSkuFor("white-uni")).toBe("CUSTOM-WHITE UNICORN");
  });

  it("USPS: custom design (Blob art + sha + sidecar), window rail, non-Guaranteed title, 320-char message capped at 300", async () => {
    const { status, json } = await checkout(USPS_BODY);
    expect(status).toBe(200);
    expect(json).toEqual(EXPECTED_USPS);
    expect(fetched).toHaveLength(2);

    const [draft] = json.draftOrders as Draft[];
    expect(draft.input).not.toHaveProperty("note");
    expect(draft.input).not.toHaveProperty("corp_ref");
    const title = (draft.input.shippingLine as { title: string }).title;
    expect(isGuaranteedShippingTitle(title)).toBe(false);
    expect(title.startsWith("Guaranteed")).toBe(false);

    const line = (draft.input.lineItems as { customAttributes: { key: string; value: string }[] }[])[0];
    const message = line.customAttributes.find((a) => a.key === "message")!.value;
    expect(message).toHaveLength(300);
    expect(message).toBe(MESSAGE_300);

    expect(assertPaperDraft(draft.input)).toEqual({ carrier: "usps", pinataLines: 1, addonLines: 0 });
    const [check] = draft.input.lineItems.map((li) => assertPaperLine(li, { carrier: "usps" }));
    expect(check).toMatchObject({ kind: "pinata", sku: "CUSTOM-PINK UNICORN" });
  });

  it("a hub free-shipping code zeroes the shipping line and suffixes the title (both carriers)", async () => {
    for (const [body, carrier, baseInput, shippingFree] of [
      [FEDEX_BODY, "fedex", FEDEX_INPUT, SHIPPING_FEDEX_FREE],
      [USPS_BODY, "usps", USPS_INPUT, SHIPPING_USPS_FREE],
    ] as const) {
      const { status, json } = await checkout({ ...body, discountCodes: [FREE_SHIPPING_CODE] });
      expect(status).toBe(200);
      const [draft] = json.draftOrders as Draft[];
      expect(draft.input).toEqual({
        ...baseInput,
        // the native code still rides on the draft so Shopify records its
        // redemption; the customer can't stack more on the hosted invoice
        discountCodes: [FREE_SHIPPING_CODE],
        allowDiscountCodesInCheckout: false,
        shippingLine: shippingFree,
      });
      expect((draft.input.shippingLine as { title: string }).title).toBe(shippingLineTitle(carrier, true));
      // Paper's branch key is unchanged by the suffix.
      expect(isGuaranteedShippingTitle((draft.input.shippingLine as { title: string }).title)).toBe(carrier === "fedex");

      // catalog + price + the code's describe — nothing else
      expect(fetched).toHaveLength(3);
      const describeUrl = new URL(fetched.find((u) => u.includes("/api/public/discount"))!);
      expect(describeUrl.searchParams.get("code")).toBe(FREE_SHIPPING_CODE);

      expect(assertPaperDraft(draft.input).carrier).toBe(carrier);
    }
  });

  it("refuses a cart that mixes carriers (one order = one shipping line)", async () => {
    const { status, json } = await checkout({
      lines: [FEDEX_BODY.lines[1], USPS_BODY.lines[0]],
    });
    expect(status).toBe(400);
    expect(json).toEqual({
      error:
        "One delivery speed per order — open your cart, re-save a piñata to apply one carrier to everything, and try again.",
    });
    expect(fetched).toHaveLength(0);
  });

  it("refuses Blob art without its sha (Paper can't integrity-check it)", async () => {
    const line = structuredClone(USPS_BODY.lines[0]) as Record<string, unknown> & {
      graphic: Record<string, unknown>;
    };
    delete line.graphic.artSha256;
    const { status, json } = await checkout({ lines: [line] });
    expect(status).toBe(400);
    expect(json.lineErrors).toEqual([
      {
        lineId: "line-c",
        code: "design_needs_resave",
        message: expect.stringContaining("Your design (Pink Uni): This design was saved before a recent update"),
      },
    ]);
  });

  it("refuses a custom design whose art isn't on the builder Blob host", async () => {
    const line = structuredClone(USPS_BODY.lines[0]) as Record<string, unknown> & {
      graphic: Record<string, unknown>;
    };
    line.graphic.art = "https://other.public.blob.vercel-storage.com/art/x.png";
    const { status, json } = await checkout({ lines: [line] });
    expect(status).toBe(400);
    expect((json.lineErrors as { code: string }[]).map((e) => e.code)).toEqual(["design_not_saved"]);
  });
});
