import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/checkout/route";
import { SHOPIFY_API_VERSION } from "@/lib/shopify";
import { CUSTOM_PRODUCT_GID, assertPaperDraft, customSkuFor } from "@/lib/paper-contract";
import hubCatalogFixture from "./__fixtures__/hub-catalog.json";
import {
  CHONKY_ADDON,
  CHONKY_UNIT,
  CLOCK,
  DOUBLE_CANDY_UNIT,
  FEDEX_BODY,
  FEDEX_GROUP,
  FIXED_PRICE_QUERY,
  HOST,
  LINE_A_ATTRS,
  LINE_A_UNIT,
  LINE_B_ATTRS,
  LINE_B_UNIT,
  LINE_C_ATTRS,
  LINE_C_UNIT,
  MCP_AGENT,
  MCP_AGENT_CLEAN,
  MCP_AGENT_DIRTY,
  SHIPPING_FEDEX,
  SHIPPING_USPS,
  SHIP_TO_AUSTIN,
  SHIP_TO_PORTLAND,
  TAGS,
  TAGS_MCP,
  USPS_BODY,
  USPS_GROUP,
  checkoutRequest,
  fetchedUrl,
  hubResponse,
  mcpBody,
  orderAttrs,
} from "./__fixtures__/golden-carts";

/**
 * GOLDEN CHECKOUT PAYLOAD — LIVE DraftOrderInput shape.
 *
 * The dry-run golden can't see what checkout sends Shopify when credentials
 * exist: each piñata line attaches to the Custom Built Piñatagram variant for
 * its body (variantId per customSkuFor(styleId)) and EVERY line — piñata and
 * add-on — carries priceOverride with the hub's composed amount, so Shopify
 * never charges a variant's own price. This spec runs the REAL route with
 * dummy SHOPIFY_* env and globalThis.fetch stubbed end to end: the hub (same
 * recorded fixtures as the dry-run golden), the client-credentials token mint,
 * the two variant lookups (CUSTOM-* by product, add-ons by SKU search) and
 * draftOrderCreate, whose `input` is captured and asserted KEY BY KEY. Nothing
 * reaches the network; Shopify is never called.
 *
 * next/server's after() throws outside a request scope (route.ts:1365 calls
 * it on the success path), so it is mocked to collect its tasks, which are
 * never run here.
 */

// Dummy creds BEFORE the route module is evaluated (shopifyCreds() reads them
// lazily today; a future hoist to module scope must still see them).
const env = vi.hoisted(() => {
  const dummies = {
    SHOPIFY_SHOP: "pinatagrams-golden",
    SHOPIFY_CLIENT_ID: "golden-client-id",
    SHOPIFY_CLIENT_SECRET: "golden-client-secret",
  };
  const saved: Record<string, string | undefined> = {};
  for (const k of [...Object.keys(dummies), "VERCEL_ENV"]) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  Object.assign(process.env, dummies);
  return { saved, dummies };
});

const afterTasks = vi.hoisted(() => [] as (() => unknown)[]);
vi.mock("next/server", async (importOriginal) => {
  const mod = await importOriginal<typeof import("next/server")>();
  return {
    ...mod,
    after: (task: () => unknown) => {
      afterTasks.push(task);
    },
  };
});

const SHOP = env.dummies.SHOPIFY_SHOP;
const SHOPIFY_HOST = `${SHOP}.myshopify.com`;
const TOKEN = "golden-access-token";
const GRAPHQL_PATH = `/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

/* ---------------------------------------------------------------------------
 * The fake store: one CUSTOM-* variant per fixture body style, one variant
 * per hub add-on SKU (plus a decoy the exact-SKU filter must skip).
 * ------------------------------------------------------------------------- */

const VARIANT_BY_SKU = new Map<string, string>(
  hubCatalogFixture.bodyStyles.map((s, i) => [customSkuFor(s.id), `gid://shopify/ProductVariant/${7001 + i}`]),
);
const CUSTOM_VARIANT_NODES = [
  ...[...VARIANT_BY_SKU.entries()].map(([sku, id]) => ({ id, sku })),
  // a variant without a SKU is skipped by the route, never mapped
  { id: "gid://shopify/ProductVariant/7999", sku: null },
];
const ADDON_VARIANT = {
  "DOUBLE-FILLING": "gid://shopify/ProductVariant/8001",
  CHONKY: "gid://shopify/ProductVariant/8002",
} as const;
const ADDON_VARIANT_IDS: ReadonlySet<string> = new Set(Object.values(ADDON_VARIANT));
function addonSearch(sku: string) {
  if (sku === "DOUBLE-FILLING")
    return [
      // the search is a prefix match: only the exact SKU may be trusted
      { id: "gid://shopify/ProductVariant/8101", sku: "DOUBLE-FILLING-OLD" },
      { id: ADDON_VARIANT["DOUBLE-FILLING"], sku: "DOUBLE-FILLING" },
    ];
  if (sku === "CHONKY") return [{ id: ADDON_VARIANT.CHONKY, sku: "CHONKY" }];
  return [];
}

type Call = { url: URL; method: string; headers: Record<string, string>; body: Record<string, unknown> | null };
const calls: Call[] = [];
const draftInputs: Record<string, unknown>[] = [];
const realFetch = globalThis.fetch;

function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = fetchedUrl(input);
  const method = init?.method ?? "GET";
  const headers = Object.fromEntries(new Headers(init?.headers).entries());
  const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
  calls.push({ url, method, headers, body });
  const json = (b: unknown, status = 200) =>
    Promise.resolve(
      new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } }),
    );

  const hub = hubResponse(url);
  if (hub) return Promise.resolve(hub);

  if (url.hostname === SHOPIFY_HOST && method === "POST") {
    if (url.pathname === "/admin/oauth/access_token") {
      const b = body as { grant_type?: string; client_id?: string; client_secret?: string } | null;
      if (
        b?.grant_type !== "client_credentials" ||
        b.client_id !== env.dummies.SHOPIFY_CLIENT_ID ||
        b.client_secret !== env.dummies.SHOPIFY_CLIENT_SECRET
      )
        return json({ error: "invalid_client" }, 401);
      return json({ access_token: TOKEN, scope: "write_draft_orders,read_products", expires_in: 86399 });
    }
    if (url.pathname === GRAPHQL_PATH) {
      if (headers["x-shopify-access-token"] !== TOKEN) return json({ errors: "unauthorized" }, 401);
      const query = String(body?.query ?? "");
      const variables = (body?.variables ?? {}) as Record<string, unknown>;
      if (query.includes("product(id: $id)")) {
        if (variables.id !== CUSTOM_PRODUCT_GID) return json({ data: { product: null } });
        return json({ data: { product: { variants: { nodes: CUSTOM_VARIANT_NODES } } } });
      }
      if (query.includes("productVariants(")) {
        const m = /^sku:(".*")$/.exec(String(variables.q));
        const sku = m ? (JSON.parse(m[1]) as string) : "";
        return json({ data: { productVariants: { nodes: addonSearch(sku) } } });
      }
      if (query.includes("draftOrderCreate(")) {
        draftInputs.push(variables.input as Record<string, unknown>);
        const n = draftInputs.length;
        return json({
          data: {
            draftOrderCreate: {
              draftOrder: {
                id: `gid://shopify/DraftOrder/${900000 + n}`,
                invoiceUrl: `https://${SHOPIFY_HOST}/invoices/golden-${n}`,
              },
              userErrors: [],
            },
          },
        });
      }
    }
  }
  // Anything else (an invoice send, a supersede lookup, a foreign host) is a
  // test failure, never a network call.
  return Promise.reject(new Error(`live golden: unexpected fetch ${method} ${url.href}`));
}

const shopifyCalls = () => calls.filter((c) => c.url.hostname === SHOPIFY_HOST);
const hubCalls = () => calls.filter((c) => c.url.hostname !== SHOPIFY_HOST);
const gqlCalls = (needle: string) =>
  shopifyCalls().filter((c) => c.url.pathname === GRAPHQL_PATH && String(c.body?.query).includes(needle));

let ipCounter = 0;
async function checkout(body: unknown) {
  ipCounter++;
  calls.length = 0;
  draftInputs.length = 0;
  afterTasks.length = 0;
  const res = await POST(checkoutRequest(body, `198.51.100.${ipCounter}`));
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
  for (const [k, v] of Object.entries(env.saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/* ---------------------------------------------------------------------------
 * Expected DraftOrderInput — LITERAL (shared attribute literals from the
 * fixture module; the live-only fields are spelled out here).
 * ------------------------------------------------------------------------- */

const NONCE = expect.stringMatching(/^[a-f0-9]{32}$/);
const usd = (amount: string) => ({ amount, currencyCode: "USD" });

const EXPECTED_FEDEX_INPUT = {
  tags: TAGS,
  customAttributes: orderAttrs(NONCE, true),
  shippingAddress: SHIP_TO_AUSTIN,
  shippingLine: SHIPPING_FEDEX,
  lineItems: [
    {
      variantId: "gid://shopify/ProductVariant/7002", // CUSTOM-GOOGLY (bodyStyles[1])
      quantity: 2,
      priceOverride: usd(LINE_A_UNIT),
      customAttributes: LINE_A_ATTRS,
    },
    {
      variantId: "gid://shopify/ProductVariant/7012", // CUSTOM-WHITE UNICORN (bodyStyles[11])
      quantity: 1,
      priceOverride: usd(LINE_B_UNIT),
      customAttributes: LINE_B_ATTRS,
    },
    // add-on lines: the add-on product's own variant, the hub's price pinned
    // via priceOverride (a drifted Shopify product price must never apply)
    { variantId: ADDON_VARIANT["DOUBLE-FILLING"], quantity: 2, priceOverride: usd(DOUBLE_CANDY_UNIT) },
    { variantId: ADDON_VARIANT.CHONKY, quantity: 2, priceOverride: usd(CHONKY_UNIT) },
  ],
};

const EXPECTED_USPS_INPUT = {
  tags: TAGS,
  customAttributes: orderAttrs(NONCE, false),
  shippingAddress: SHIP_TO_PORTLAND,
  shippingLine: SHIPPING_USPS,
  lineItems: [
    {
      variantId: "gid://shopify/ProductVariant/7013", // CUSTOM-PINK UNICORN (bodyStyles[12])
      quantity: 1,
      priceOverride: usd(LINE_C_UNIT),
      customAttributes: LINE_C_ATTRS,
    },
  ],
};

/* ---------------------------------------------------------------------------
 * Tests
 * ------------------------------------------------------------------------- */

type Order = { groupKey: string; shipTo: string; draftOrderId: string; invoiceUrl: string; invoiceSent: boolean; nonce: string };

describe("checkout live golden payload (DraftOrderInput sent to Shopify)", () => {
  it("the fake store's variant map follows the contract's SKU rule", () => {
    // The literal variant ids above are pinned to fixture positions; name the
    // drift if hub-catalog.json's body-style order ever moves.
    expect(VARIANT_BY_SKU.get("CUSTOM-GOOGLY")).toBe("gid://shopify/ProductVariant/7002");
    expect(VARIANT_BY_SKU.get("CUSTOM-WHITE UNICORN")).toBe("gid://shopify/ProductVariant/7012");
    expect(VARIANT_BY_SKU.get("CUSTOM-PINK UNICORN")).toBe("gid://shopify/ProductVariant/7013");
    expect(VARIANT_BY_SKU.has("CUSTOM-STAR SPANGLED")).toBe(true);
    expect(VARIANT_BY_SKU.size).toBe(hubCatalogFixture.bodyStyles.length);
    expect(CHONKY_ADDON.sku).toBe("CHONKY");
  });

  it("FedEx: variantId per customSkuFor(styleId), priceOverride on every piñata AND add-on line, shipping, tags, order attrs", async () => {
    const { status, json } = await checkout(FEDEX_BODY);
    expect(status).toBe(200);
    expect(json).toEqual({
      dryRun: false,
      orders: [
        {
          ...FEDEX_GROUP,
          draftOrderId: "gid://shopify/DraftOrder/900001",
          invoiceUrl: `https://${SHOPIFY_HOST}/invoices/golden-1`,
          invoiceSent: false,
          nonce: NONCE,
        },
      ],
    });

    // Exactly one draft was created, with exactly this input.
    expect(draftInputs).toHaveLength(1);
    const input = draftInputs[0] as typeof EXPECTED_FEDEX_INPUT & Record<string, unknown>;
    expect(input).toEqual(EXPECTED_FEDEX_INPUT);
    expect(input).not.toHaveProperty("note");
    expect(input).not.toHaveProperty("corp_ref");
    expect(input).not.toHaveProperty("email");
    expect(input).not.toHaveProperty("discountCodes");
    // The nonce on the draft IS the nonce handed back for supersedes.
    const [order] = json.orders as Order[];
    expect(input.customAttributes.find((a) => a.key === "_builderNonce")?.value).toBe(order.nonce);
    // Each piñata line attaches to the variant whose SKU the contract derives
    // from its own _bodyStyle.
    for (const li of input.lineItems) {
      const attrs = li.customAttributes;
      if (!attrs) continue; // add-on line
      const body = attrs.find((a) => a.key === "_bodyStyle")!.value;
      expect(li.variantId).toBe(VARIANT_BY_SKU.get(customSkuFor(body)));
    }
    expect(assertPaperDraft(input, { addonVariantIds: ADDON_VARIANT_IDS })).toEqual({
      carrier: "fedex",
      pinataLines: 2,
      addonLines: 2,
    });

    // The hub: host-scoped catalog + the FIXED price query, nothing else.
    expect(hubCalls().map((c) => c.url.pathname).sort()).toEqual(["/api/public/catalog", "/api/public/price"]);
    const catalogUrl = hubCalls().find((c) => c.url.pathname === "/api/public/catalog")!.url;
    expect(catalogUrl.searchParams.get("host")).toBe(HOST);
    const priceUrl = new URL(hubCalls().find((c) => c.url.pathname === "/api/public/price")!.url.href);
    priceUrl.searchParams.delete("fresh");
    expect(priceUrl.search).toBe(`?${FIXED_PRICE_QUERY}`);

    // Shopify, in order: one client-credentials mint, the CUSTOM-* variant
    // lookup by product, one SKU search per add-on, then the single create.
    const shopify = shopifyCalls();
    expect(shopify[0].url.pathname).toBe("/admin/oauth/access_token");
    expect(shopify[0].body).toEqual({
      grant_type: "client_credentials",
      client_id: env.dummies.SHOPIFY_CLIENT_ID,
      client_secret: env.dummies.SHOPIFY_CLIENT_SECRET,
    });
    expect(shopify.filter((c) => c.url.pathname === "/admin/oauth/access_token")).toHaveLength(1);
    for (const c of shopify.slice(1)) {
      expect(c.url.pathname).toBe(GRAPHQL_PATH);
      expect(c.headers["x-shopify-access-token"]).toBe(TOKEN);
    }
    const productLookups = gqlCalls("product(id: $id)");
    expect(productLookups).toHaveLength(1);
    expect(productLookups[0].body?.variables).toEqual({ id: CUSTOM_PRODUCT_GID });
    expect(
      gqlCalls("productVariants(")
        .map((c) => (c.body?.variables as { q: string }).q)
        .sort(),
    ).toEqual(['sku:"CHONKY"', 'sku:"DOUBLE-FILLING"']);
    expect(gqlCalls("draftOrderCreate(")).toHaveLength(1);
    expect(gqlCalls("draftOrderInvoiceSend(")).toHaveLength(0);
    expect(shopify[shopify.length - 1].body?.query).toContain("draftOrderCreate(");

    // After the response: only the webhook keep-alive (no supersede to retire).
    expect(afterTasks).toHaveLength(1);
  });

  it("USPS: custom design on the PINK UNICORN variant, window rail, non-Guaranteed title, no add-on lines", async () => {
    const { status, json } = await checkout(USPS_BODY);
    expect(status).toBe(200);
    expect(json).toEqual({
      dryRun: false,
      orders: [
        {
          ...USPS_GROUP,
          draftOrderId: "gid://shopify/DraftOrder/900001",
          invoiceUrl: `https://${SHOPIFY_HOST}/invoices/golden-1`,
          invoiceSent: false,
          nonce: NONCE,
        },
      ],
    });
    expect(draftInputs).toHaveLength(1);
    expect(draftInputs[0]).toEqual(EXPECTED_USPS_INPUT);
    expect(assertPaperDraft(draftInputs[0], { addonVariantIds: ADDON_VARIANT_IDS })).toEqual({
      carrier: "usps",
      pinataLines: 1,
      addonLines: 0,
    });

    // The variant maps and the token are cached on the warm instance (the
    // clock is pinned inside their TTLs): this checkout only creates.
    expect(shopifyCalls().map((c) => c.url.pathname)).toEqual([GRAPHQL_PATH]);
    expect(gqlCalls("draftOrderCreate(")).toHaveLength(1);
    expect(afterTasks).toHaveLength(1);
  });

  it("refuses before creating anything when an add-on has no Shopify variant", async () => {
    // Serve a cart whose add-on SKU the store doesn't know: the route must
    // fail fast with a per-line config error and never call draftOrderCreate.
    const unknownAddon = { ...CHONKY_ADDON, id: "mystery", label: "Mystery", sku: "MYSTERY" };
    const realHub = hubResponse;
    const catalogWithMystery = (url: URL) => {
      const r = realHub(url);
      if (!r || url.pathname !== "/api/public/catalog") return r;
      return r.json().then((c: { addons: unknown[] }) => {
        c.addons.push(unknownAddon);
        return new Response(JSON.stringify(c), { status: 200, headers: { "content-type": "application/json" } });
      });
    };
    const previous = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = fetchedUrl(input);
      if (url.pathname === "/api/public/catalog") return catalogWithMystery(url) as Promise<Response>;
      return stubFetch(input, init);
    }) as typeof fetch;
    try {
      const line = { ...FEDEX_BODY.lines[1], addons: ["mystery"] };
      const { status, json } = await checkout({ lines: [line] });
      expect(status).toBe(502);
      expect(json.lineErrors).toEqual([
        {
          lineId: "line-b",
          code: "addon_unavailable",
          message: expect.stringContaining('"Mystery" can\'t be added right now'),
        },
      ]);
      expect(draftInputs).toHaveLength(0);
      expect(afterTasks).toHaveLength(0);
    } finally {
      globalThis.fetch = previous;
    }
  });
});

/* ---------------------------------------------------------------------------
 * Ordering MCP (Phase 2): the live DraftOrderInput with source "mcp" — the
 * "mcp" tag last, the provenance pair right after _builderNonce, every line
 * (variantId, priceOverride, attributes) byte-identical to the storefront's.
 * ------------------------------------------------------------------------- */

describe("checkout live golden payload — ordering MCP source", () => {
  it('FedEx + agent: tag "mcp" after builder + variant-*, _orderSource/_orderAgent between the nonce and the visit ids', async () => {
    const { status, json } = await checkout(mcpBody(FEDEX_BODY, MCP_AGENT));
    expect(status).toBe(200);
    expect(json).toEqual({
      dryRun: false,
      orders: [
        {
          ...FEDEX_GROUP,
          draftOrderId: "gid://shopify/DraftOrder/900001",
          invoiceUrl: `https://${SHOPIFY_HOST}/invoices/golden-1`,
          invoiceSent: false,
          nonce: NONCE,
        },
      ],
    });
    expect(draftInputs).toHaveLength(1);
    const input = draftInputs[0] as typeof EXPECTED_FEDEX_INPUT & Record<string, unknown>;
    expect(input).toEqual({
      ...EXPECTED_FEDEX_INPUT,
      tags: TAGS_MCP,
      customAttributes: orderAttrs(NONCE, true, MCP_AGENT),
    });
    const keys = input.customAttributes.map((a) => a.key);
    const i = keys.indexOf("_builderNonce");
    expect(keys.slice(i, i + 4)).toEqual(["_builderNonce", "_orderSource", "_orderAgent", "_phDistinctId"]);
    expect(input.tags[input.tags.length - 1]).toBe("mcp");
    expect(assertPaperDraft(input, { addonVariantIds: ADDON_VARIANT_IDS })).toEqual({
      carrier: "fedex",
      pinataLines: 2,
      addonLines: 2,
    });
    // Warm instance: only the create reaches Shopify — an MCP-sourced body
    // changes nothing about the call pattern, the invoice email or after().
    expect(shopifyCalls().map((c) => c.url.pathname)).toEqual([GRAPHQL_PATH]);
    expect(gqlCalls("draftOrderCreate(")).toHaveLength(1);
    expect(gqlCalls("draftOrderInvoiceSend(")).toHaveLength(0);
    expect(afterTasks).toHaveLength(1);
  });

  it("USPS + a dirty agent: sanitized to the 64-char literal; no visit ids → the pair closes the list", async () => {
    const { status } = await checkout(mcpBody(USPS_BODY, MCP_AGENT_DIRTY));
    expect(status).toBe(200);
    expect(draftInputs).toHaveLength(1);
    const input = draftInputs[0] as typeof EXPECTED_USPS_INPUT & Record<string, unknown>;
    expect(input).toEqual({
      ...EXPECTED_USPS_INPUT,
      tags: TAGS_MCP,
      customAttributes: orderAttrs(NONCE, false, MCP_AGENT_CLEAN),
    });
    const keys = input.customAttributes.map((a) => a.key);
    expect(keys.slice(-3)).toEqual(["_builderNonce", "_orderSource", "_orderAgent"]);
    expect(input.customAttributes[input.customAttributes.length - 1].value).toBe(MCP_AGENT_CLEAN);
    expect(MCP_AGENT_CLEAN).toHaveLength(64);
    expect(assertPaperDraft(input, { addonVariantIds: ADDON_VARIANT_IDS }).carrier).toBe("usps");
  });
});
