/**
 * checkout-store — the fake Shopify store + recorded hub behind
 * src/lib/mcp-tools/checkout.test.ts.
 *
 * Follows src/lib/checkout-golden-live.test.ts's stub pattern (client-
 * credentials token mint, CUSTOM-* variants by product, add-on variants by
 * SKU search, draftOrderCreate with its `input` captured) and adds what the
 * checkout TOOLS need that the route alone never exercises: drafts the store
 * REMEMBERS. `draftOrder(id)` lookups (cancel_checkout, get_checkout_status,
 * update_checkout's pre-check and the route's deferred retireSupersededDraft)
 * and `draftOrderDelete` therefore behave like a real store for the life of
 * one test file. Nothing here reaches the network: a URL this stub doesn't
 * know is a rejected promise — a test failure, never a fetch.
 *
 * The hub side is the golden fixtures' served catalog (School Fun Pack at
 * 150¢, a second add-on "Chonky" at 999¢) and the fixed price query, so the
 * money the tools compute can be asserted against the goldens' literals.
 */
import { HUB_URL } from "@/lib/hub";
import { SHOPIFY_API_VERSION } from "@/lib/shopify";
import { CUSTOM_PRODUCT_GID, customSkuFor } from "@/lib/paper-contract";
import {
  CLASSIC_ART,
  fetchedUrl,
  hubResponse,
  servedCatalog,
  type ServedCatalog,
} from "@/lib/__fixtures__/golden-carts";
import hubCatalogFixture from "@/lib/__fixtures__/hub-catalog.json";

export type StoreCreds = {
  SHOPIFY_SHOP: string;
  SHOPIFY_CLIENT_ID: string;
  SHOPIFY_CLIENT_SECRET: string;
};

export const TOKEN = "mcp-test-access-token";
export const GRAPHQL_PATH = `/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

/** One CUSTOM-* variant per fixture body style, in fixture order — the same
 *  pins the live golden uses (googly → 7002, white-uni → 7012, pink-uni → 7013). */
export const VARIANT_BY_SKU = new Map<string, string>(
  hubCatalogFixture.bodyStyles.map((s, i) => [customSkuFor(s.id), `gid://shopify/ProductVariant/${7001 + i}`]),
);
export const ADDON_VARIANT = {
  "DOUBLE-FILLING": "gid://shopify/ProductVariant/8001",
  CHONKY: "gid://shopify/ProductVariant/8002",
} as const;
export const ADDON_VARIANT_IDS: ReadonlySet<string> = new Set(Object.values(ADDON_VARIANT));

export type Attr = { key: string; value: string };

export type DraftRecord = {
  id: string;
  status: string;
  tags: string[];
  order: { id: string } | null;
  customAttributes: Attr[];
  invoiceUrl: string;
  /** The DraftOrderInput that created it. */
  input: Record<string, unknown>;
};

export type Call = {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
};

export type CreateFailure = "address" | "email" | "http500";

export type FakeStore = {
  fetch: typeof fetch;
  shopifyHost: string;
  /** Every fetch since the last reset(), hub and Shopify alike. */
  calls: Call[];
  /** draftOrderCreate inputs captured since the last reset(). */
  draftInputs: Record<string, unknown>[];
  /** Every draft ever created in this store (survives reset()). */
  drafts: Map<string, DraftRecord>;
  /** Draft ids removed through draftOrderDelete, in order (survives reset()). */
  deleted: string[];
  /** Serve a patched copy of the recorded catalog (null = the recorded one). */
  patchCatalog(fn: ((c: ServedCatalog) => void) | null): void;
  /** Make the next draftOrderCreate fail this way, then recover. */
  failNextCreate(kind: CreateFailure | null): void;
  /** While on, every draftOrder lookup answers HTTP 500. */
  failLookups(on: boolean): void;
  /** Forget calls + captured inputs. Drafts stay — the store is warm. */
  reset(): void;
  shopifyCalls(): Call[];
  hubCalls(): Call[];
  gqlCalls(needle: string): Call[];
};

function jsonResponse(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  );
}

function addonSearch(sku: string): { id: string; sku: string | null }[] {
  if (sku === "DOUBLE-FILLING") {
    return [
      // the search is a prefix match: only the exact SKU may be trusted
      { id: "gid://shopify/ProductVariant/8101", sku: "DOUBLE-FILLING-OLD" },
      { id: ADDON_VARIANT["DOUBLE-FILLING"], sku: "DOUBLE-FILLING" },
    ];
  }
  if (sku === "CHONKY") return [{ id: ADDON_VARIANT.CHONKY, sku: "CHONKY" }];
  return [];
}

export function fakeStore(creds: StoreCreds): FakeStore {
  const shopifyHost = `${creds.SHOPIFY_SHOP}.myshopify.com`;
  const hubOrigin = new URL(HUB_URL).origin;
  const calls: Call[] = [];
  const draftInputs: Record<string, unknown>[] = [];
  const drafts = new Map<string, DraftRecord>();
  const deleted: string[] = [];
  let created = 0;
  let catalogPatch: ((c: ServedCatalog) => void) | null = null;
  let nextCreateFailure: CreateFailure | null = null;
  let lookupsFail = false;

  const customVariantNodes = [
    ...[...VARIANT_BY_SKU.entries()].map(([sku, id]) => ({ id, sku })),
    // a variant without a SKU is skipped by the route, never mapped
    { id: "gid://shopify/ProductVariant/7999", sku: null },
  ];

  function graphql(body: Record<string, unknown> | null): Promise<Response> {
    const query = String(body?.query ?? "");
    const variables = (body?.variables ?? {}) as Record<string, unknown>;

    if (query.includes("product(id: $id)")) {
      if (variables.id !== CUSTOM_PRODUCT_GID) return jsonResponse({ data: { product: null } });
      return jsonResponse({ data: { product: { variants: { nodes: customVariantNodes } } } });
    }
    if (query.includes("productVariants(")) {
      const m = /^sku:(".*")$/.exec(String(variables.q));
      const sku = m ? (JSON.parse(m[1]) as string) : "";
      return jsonResponse({ data: { productVariants: { nodes: addonSearch(sku) } } });
    }
    if (query.includes("draftOrderCreate(")) {
      const input = variables.input as Record<string, unknown>;
      draftInputs.push(input);
      const failure = nextCreateFailure;
      nextCreateFailure = null;
      if (failure === "http500") return jsonResponse({ errors: [{ message: "Internal error" }] }, 500);
      if (failure) {
        return jsonResponse({
          data: {
            draftOrderCreate: {
              draftOrder: null,
              userErrors: [
                failure === "address"
                  ? { field: ["input", "shippingAddress", "zip"], message: "Zip is not valid for the province" }
                  : { field: ["input", "email"], message: "Email is invalid" },
              ],
            },
          },
        });
      }
      created++;
      const id = `gid://shopify/DraftOrder/${900000 + created}`;
      const invoiceUrl = `https://${shopifyHost}/invoices/mcp-${created}`;
      drafts.set(id, {
        id,
        status: "OPEN",
        tags: Array.isArray(input.tags) ? [...(input.tags as string[])] : [],
        order: null,
        customAttributes: Array.isArray(input.customAttributes) ? [...(input.customAttributes as Attr[])] : [],
        invoiceUrl,
        input,
      });
      return jsonResponse({ data: { draftOrderCreate: { draftOrder: { id, invoiceUrl }, userErrors: [] } } });
    }
    if (query.includes("draftOrderDelete(")) {
      const id = String((variables.input as { id?: string } | undefined)?.id ?? "");
      if (!drafts.has(id) || deleted.includes(id)) {
        return jsonResponse({
          data: { draftOrderDelete: { deletedId: null, userErrors: [{ field: ["input", "id"], message: "Draft order not found" }] } },
        });
      }
      deleted.push(id);
      return jsonResponse({ data: { draftOrderDelete: { deletedId: id, userErrors: [] } } });
    }
    if (query.includes("draftOrder(id: $id)")) {
      if (lookupsFail) return jsonResponse({ errors: [{ message: "Internal error" }] }, 500);
      const id = String(variables.id ?? "");
      const d = drafts.get(id);
      if (!d || deleted.includes(id)) return jsonResponse({ data: { draftOrder: null } });
      return jsonResponse({
        data: { draftOrder: { status: d.status, tags: d.tags, order: d.order, customAttributes: d.customAttributes } },
      });
    }
    return Promise.reject(new Error(`checkout-store: unexpected GraphQL operation: ${query.slice(0, 80)}`));
  }

  const fetchStub = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = fetchedUrl(input);
    const method = init?.method ?? "GET";
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    calls.push({ url, method, headers, body });

    if (url.origin === hubOrigin && url.pathname === "/api/public/catalog" && catalogPatch) {
      const c = servedCatalog();
      catalogPatch(c);
      return jsonResponse(c);
    }
    const hub = hubResponse(url);
    if (hub) return Promise.resolve(hub);

    if (url.hostname === shopifyHost && method === "POST") {
      if (url.pathname === "/admin/oauth/access_token") {
        const b = body as { grant_type?: string; client_id?: string; client_secret?: string } | null;
        if (
          b?.grant_type !== "client_credentials" ||
          b.client_id !== creds.SHOPIFY_CLIENT_ID ||
          b.client_secret !== creds.SHOPIFY_CLIENT_SECRET
        ) {
          return jsonResponse({ error: "invalid_client" }, 401);
        }
        return jsonResponse({ access_token: TOKEN, scope: "write_draft_orders,read_products", expires_in: 86399 });
      }
      if (url.pathname === GRAPHQL_PATH) {
        if (headers["x-shopify-access-token"] !== TOKEN) return jsonResponse({ errors: "unauthorized" }, 401);
        return graphql(body);
      }
    }
    return Promise.reject(new Error(`checkout-store: unexpected fetch ${method} ${url.href}`));
  };

  return {
    fetch: fetchStub as typeof fetch,
    shopifyHost,
    calls,
    draftInputs,
    drafts,
    deleted,
    patchCatalog: (fn) => {
      catalogPatch = fn;
    },
    failNextCreate: (kind) => {
      nextCreateFailure = kind;
    },
    failLookups: (on) => {
      lookupsFail = on;
    },
    reset: () => {
      calls.length = 0;
      draftInputs.length = 0;
    },
    shopifyCalls: () => calls.filter((c) => c.url.hostname === shopifyHost),
    hubCalls: () => calls.filter((c) => c.url.hostname !== shopifyHost),
    gqlCalls: (needle) =>
      calls.filter(
        (c) => c.url.hostname === shopifyHost && c.url.pathname === GRAPHQL_PATH && String(c.body?.query).includes(needle),
      ),
  };
}

/* ---------------------------------------------------------------------------
 * The goldens' carts, in the TOOL's vocabulary, and their money — LITERAL.
 * ------------------------------------------------------------------------- */

export const SHIP_TO_AUSTIN_ARG = {
  name: "Jane Doe",
  address1: "123 Main St",
  address2: "Apt 4",
  city: "Austin",
  state: "TX",
  zip: "78701",
  phone: "5125550100",
};

/** One-word recipient, lowercase state, no address2 / phone. */
export const SHIP_TO_PORTLAND_ARG = {
  name: "Grandma",
  address1: "9 Elm Street",
  city: "Portland",
  state: "or",
  zip: "97201",
};

/** The live golden's FedEx cart: a library design + filling delta + two
 *  add-ons (qty 2) and the Classic default on a unicorn body (qty 1). */
export const FEDEX_ARGS = {
  carrier: "fedex",
  lines: [
    {
      style_id: "googly",
      qty: 2,
      filling: "School Fun Pack",
      graphic: { type: "library", design: "HBD02" },
      add_ons: ["double-candy", "chonky"],
      message: "Happy birthday, Sam!",
      delivery_date: "2026-10-29",
    },
    {
      style_id: "white-uni",
      qty: 1,
      filling: "Candy",
      graphic: { type: "classic" },
      delivery_date: "2026-10-29",
    },
  ],
  ship_to: SHIP_TO_AUSTIN_ARG,
};

/** USPS: the Classic default on the pink unicorn body, a no-add-on filling,
 *  no message, a one-word recipient. */
export const USPS_ARGS = {
  carrier: "usps",
  lines: [
    {
      style_id: "pink-uni",
      qty: 1,
      filling: "Dog Treats",
      graphic: { type: "classic" },
      delivery_date: "2026-11-05",
    },
  ],
  ship_to: SHIP_TO_PORTLAND_ARG,
};

/** base 2999; library +200; School Fun Pack +150 (served); Candy +0;
 *  Double Candy 499 × 2; Chonky 999 × 2; FedEx 1500 × 3 units. */
export const FEDEX_MONEY = {
  line1_unit: 3349,
  line1: 6698,
  line2_unit: 2999,
  line2: 2999,
  double_candy: 998,
  chonky: 1998,
  subtotal: 12693,
  shipping: 4500,
  total: 17193,
};

/** base 2999 + Classic 0 + Dog Treats 0; USPS 675 × 1 unit. */
export const USPS_MONEY = { unit: 2999, shipping: 675, total: 3674 };

/** The USPS line's Paper attributes, literal (cf. golden LINE_C_ATTRS for a
 *  custom design; this one is the Classic default, so no sha / sidecar). */
export const LINE_PINK_CLASSIC_ATTRS: Attr[] = [
  { key: "Graphic", value: "Classic Piñatagrams — Pink Uni" },
  { key: "Body style", value: "Pink Uni" },
  { key: "Filling", value: "Dog Treats" },
  { key: "Arrives", value: "Nov 3 – Nov 7" },
  { key: "_bodyStyle", value: "pink-uni" },
  { key: "_design", value: "STANDARD" },
  { key: "_frontGraphic", value: CLASSIC_ART },
  { key: "_fillings", value: "Dog Treats" },
  { key: "_requestedDate", value: "2026-11-05" },
  { key: "_carrier", value: "usps" },
  { key: "_requestedWindow", value: "2026-11-03..2026-11-07" },
];
