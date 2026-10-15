import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ensureOrdersPaidWebhook, OFFLINE. The rule under test: on the mcp face
 * (APP_MODE=mcp — mcp.pinatagrams.com, which IS VERCEL_ENV=production and has
 * its own Shopify app) it must return before ANY Shopify call, or the first
 * MCP confirm's after() would register a second orders/paid webhook under the
 * MCP app — signed with the wrong secret, aimed at the storefront URL.
 * Storefront behaviour (APP_MODE unset) is pinned unchanged alongside it.
 *
 * Every test imports a FRESH module (vi.resetModules) so the once-per-instance
 * memo in ensureOrdersPaidWebhookOnce and shopify.ts's token cache start empty.
 * fetch is a stub: a URL it doesn't know is a thrown error, never a network call.
 */

const ORDERS_PAID_URI = "https://builder.pinatagrams.com/api/webhooks/orders-paid";
const CREDS = {
  SHOPIFY_SHOP: "pinatagrams-webhook-test",
  SHOPIFY_CLIENT_ID: "wh-client-id",
  SHOPIFY_CLIENT_SECRET: "wh-client-secret",
};
const TOKEN = "wh-access-token";
const SUB_ID = "gid://shopify/WebhookSubscription/4242";
const ENV_KEYS = ["APP_MODE", "VERCEL_ENV", ...Object.keys(CREDS)] as const;
type EnvKey = (typeof ENV_KEYS)[number];

type Call = { url: string; body: Record<string, unknown> | null };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A fake Shopify: the token mint, the ORDERS_PAID list (empty, or already
 *  subscribed at the storefront URL) and the create mutation. */
function fakeShopify(existing: boolean) {
  const calls: Call[] = [];
  const fetchStub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    calls.push({ url, body });
    if (url.endsWith("/admin/oauth/access_token")) {
      return json({ access_token: TOKEN, scope: "read_orders,write_draft_orders", expires_in: 86399 });
    }
    const query = String(body?.query ?? "");
    if (query.includes("webhookSubscriptions(")) {
      return json({ data: { webhookSubscriptions: { nodes: existing ? [{ id: SUB_ID, uri: ORDERS_PAID_URI }] : [] } } });
    }
    if (query.includes("webhookSubscriptionCreate(")) {
      const sub = (body?.variables as { sub: { uri: string } }).sub;
      return json({ data: { webhookSubscriptionCreate: { webhookSubscription: { id: SUB_ID, uri: sub.uri }, userErrors: [] } } });
    }
    throw new Error(`webhooks.test: unexpected fetch ${url}`);
  };
  return { calls, fetch: fetchStub as typeof fetch };
}

const saved: Partial<Record<EnvKey, string | undefined>> = {};
const realFetch = globalThis.fetch;

function setEnv(vars: Partial<Record<EnvKey, string>>) {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, vars);
}

async function freshWebhooks() {
  vi.resetModules();
  return import("./webhooks");
}

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

describe("ensureOrdersPaidWebhook on the mcp face (APP_MODE=mcp)", () => {
  it("answers skipped/'mcp face' BEFORE the production check and makes ZERO Shopify calls — even in production with credentials", async () => {
    const shop = fakeShopify(false);
    globalThis.fetch = shop.fetch;
    setEnv({ APP_MODE: "mcp", VERCEL_ENV: "production", ...CREDS });
    const mod = await freshWebhooks();
    expect(await mod.ensureOrdersPaidWebhook()).toEqual({ status: "skipped", reason: "mcp face" });
    // the once-per-instance wrapper the checkout route's after() calls
    expect(await mod.ensureOrdersPaidWebhookOnce()).toEqual({ status: "skipped", reason: "mcp face" });
    expect(await mod.ensureOrdersPaidWebhookOnce()).toEqual({ status: "skipped", reason: "mcp face" });
    expect(shop.calls).toEqual([]);
  });

  it("the mcp guard wins over every other gate: preview, or no credentials, still answers 'mcp face' — never 'not production'", async () => {
    const shop = fakeShopify(false);
    globalThis.fetch = shop.fetch;
    setEnv({ APP_MODE: "mcp", VERCEL_ENV: "preview", ...CREDS });
    expect(await (await freshWebhooks()).ensureOrdersPaidWebhook()).toEqual({ status: "skipped", reason: "mcp face" });
    setEnv({ APP_MODE: "mcp", VERCEL_ENV: "production" });
    expect(await (await freshWebhooks()).ensureOrdersPaidWebhook()).toEqual({ status: "skipped", reason: "mcp face" });
    expect(shop.calls).toEqual([]);
  });

  it("only the exact value 'mcp' is the mcp face — 'MCP' is a storefront", async () => {
    const shop = fakeShopify(false);
    globalThis.fetch = shop.fetch;
    setEnv({ APP_MODE: "MCP", VERCEL_ENV: "preview", ...CREDS });
    expect(await (await freshWebhooks()).ensureOrdersPaidWebhook()).toEqual({ status: "skipped", reason: "not production" });
    expect(shop.calls).toEqual([]);
  });
});

describe("ensureOrdersPaidWebhook on the storefront (APP_MODE unset) — unchanged", () => {
  it("in production with credentials: mints, lists, then creates the subscription at the storefront URL with the field allowlist", async () => {
    const shop = fakeShopify(false);
    globalThis.fetch = shop.fetch;
    setEnv({ VERCEL_ENV: "production", ...CREDS });
    const mod = await freshWebhooks();
    expect(mod.ORDERS_PAID_WEBHOOK_URI).toBe(ORDERS_PAID_URI);
    expect(await mod.ensureOrdersPaidWebhook()).toEqual({ status: "created", id: SUB_ID });
    expect(shop.calls.map((c) => c.url)).toEqual([
      `https://${CREDS.SHOPIFY_SHOP}.myshopify.com/admin/oauth/access_token`,
      expect.stringMatching(/\/admin\/api\/[\d-]+\/graphql\.json$/),
      expect.stringMatching(/\/admin\/api\/[\d-]+\/graphql\.json$/),
    ]);
    expect(String(shop.calls[1].body?.query)).toContain("webhookSubscriptions(first: 50, topics: [ORDERS_PAID])");
    const create = shop.calls[2].body as {
      query: string;
      variables: { sub: { uri: string; format: string; includeFields: string[] } };
    };
    expect(create.query).toContain("webhookSubscriptionCreate(topic: ORDERS_PAID");
    expect(create.variables.sub).toMatchObject({ uri: ORDERS_PAID_URI, format: "JSON" });
    expect(create.variables.sub.includeFields).toEqual(expect.arrayContaining(["id", "tags", "note_attributes", "line_items"]));
    for (const pii of ["customer", "email", "phone", "shipping_address", "billing_address"]) {
      expect(create.variables.sub.includeFields).not.toContain(pii);
    }
  });

  it("in production with the subscription already present: lists only, answers exists", async () => {
    const shop = fakeShopify(true);
    globalThis.fetch = shop.fetch;
    setEnv({ VERCEL_ENV: "production", ...CREDS });
    expect(await (await freshWebhooks()).ensureOrdersPaidWebhook()).toEqual({ status: "exists", id: SUB_ID });
    expect(shop.calls).toHaveLength(2); // mint + list, no create
    expect(String(shop.calls[1].body?.query)).toContain("webhookSubscriptions(");
  });

  it("outside production, or without credentials, skips without a Shopify call", async () => {
    const shop = fakeShopify(false);
    globalThis.fetch = shop.fetch;
    setEnv({ VERCEL_ENV: "preview", ...CREDS });
    expect(await (await freshWebhooks()).ensureOrdersPaidWebhook()).toEqual({ status: "skipped", reason: "not production" });
    setEnv({ VERCEL_ENV: "production" });
    expect(await (await freshWebhooks()).ensureOrdersPaidWebhook()).toEqual({
      status: "skipped",
      reason: "Shopify credentials not configured",
    });
    expect(shop.calls).toEqual([]);
  });
});
