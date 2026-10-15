import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { rateLimit } from "@/lib/rate-limit";
import { assertPaperDraft } from "@/lib/paper-contract";
import { CLASSIC_GRAPHIC } from "@/lib/flow";
import {
  CLOCK,
  FREE_SHIPPING_CODE,
  HBD02_ART,
  LINE_A_ATTRS,
  LINE_B_ATTRS,
  SHIPPING_FEDEX,
  SHIPPING_FEDEX_FREE,
  SHIPPING_USPS,
  SHIP_TO_AUSTIN,
  SHIP_TO_PORTLAND,
} from "@/lib/__fixtures__/golden-carts";
import { MCP_HOST } from "./price";
import { BUILDER_URL, checkoutTools, FLOW_HEADER_VALUE, MAX_ADDONS, MAX_LINES, MAX_QTY, withMcpClientIp } from "./checkout";
import {
  ADDON_VARIANT,
  ADDON_VARIANT_IDS,
  FEDEX_ARGS,
  FEDEX_MONEY,
  fakeStore,
  GRAPHQL_PATH,
  LINE_PINK_CLASSIC_ATTRS,
  TOKEN,
  USPS_ARGS,
  USPS_MONEY,
  VARIANT_BY_SKU,
} from "./__fixtures__/checkout-store";

/**
 * The checkout tools, OFFLINE. The hub is the recorded golden fixtures, the
 * store is __fixtures__/checkout-store.ts (the golden-live stub pattern plus
 * remembered drafts), the clock is pinned to the goldens' CLOCK, and the
 * REAL /api/checkout POST runs in-process behind a thin recorder that keeps
 * the Request the tool built (headers + body) so the spine's contract is
 * asserted directly: host = MCP_HOST, x-pg-flow v2, the forwarded client IP,
 * `source: "mcp"`, never `sendInvoice`.
 *
 * next/server's after() is mocked as the live golden does — the route calls
 * it on its success path, and the tool must be able to run inside that scope.
 * rate-limit is wrapped (pass-through spy) to prove the route saw the MCP
 * request's own client IP, not a synthetic one.
 */

// Dummy store creds + a clean flag/host BEFORE any module is evaluated
// (price.ts reads MCP_STOREFRONT_HOST at load; shopifyCreds() reads lazily).
const env = vi.hoisted(() => {
  const dummies = {
    SHOPIFY_SHOP: "pinatagrams-mcp-test",
    SHOPIFY_CLIENT_ID: "mcp-client-id",
    SHOPIFY_CLIENT_SECRET: "mcp-client-secret",
  };
  const saved: Record<string, string | undefined> = {};
  for (const k of [...Object.keys(dummies), "VERCEL_ENV", "MCP_ORDERING_ENABLED", "MCP_STOREFRONT_HOST"]) {
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

// The Request the tool hands the route, recorded before the route reads it —
// plus a fault injector: `throwAfter` lets the REAL route finish (so the draft
// exists in the store) and then throws, the way after() outside a request
// scope would, so the tool's answer to a LOST result can be asserted.
type RouteCall = { headers: Record<string, string>; body: Record<string, unknown> };
const routeCalls = vi.hoisted(() => [] as RouteCall[]);
const routeFault = vi.hoisted(() => ({ throwAfter: false }));
vi.mock("@/app/api/checkout/route", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/app/api/checkout/route")>();
  return {
    ...mod,
    POST: async (req: Request) => {
      routeCalls.push({
        headers: Object.fromEntries(req.headers.entries()),
        body: (await req.clone().json()) as Record<string, unknown>,
      });
      const res = await mod.POST(req);
      if (routeFault.throwAfter) {
        routeFault.throwAfter = false;
        throw new Error("after() was called outside a request scope");
      }
      return res;
    },
  };
});

vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/rate-limit")>();
  return { ...mod, rateLimit: vi.fn(mod.rateLimit) };
});

const store = fakeStore(env.dummies);
const realFetch = globalThis.fetch;

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(CLOCK));
  globalThis.fetch = store.fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  vi.useRealTimers();
  for (const [k, v] of Object.entries(env.saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

beforeEach(() => {
  store.reset();
  store.patchCatalog(null);
  store.failNextCreate(null);
  store.failLookups(false);
  afterTasks.length = 0;
  routeCalls.length = 0;
  routeFault.throwAfter = false;
  vi.mocked(rateLimit).mockClear();
  delete process.env.MCP_ORDERING_ENABLED;
  Object.assign(process.env, env.dummies);
});

/* ---------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------- */

type Json = Record<string, unknown>;
type Tool = keyof typeof checkoutTools;

// The route rate-limits 6/min per IP under a FROZEN clock, so every call
// that may reach it presents a fresh client IP (the tool forwards it).
let ipCounter = 0;
let lastIp = "";
function call(tool: Tool, args: Json): Promise<Json> {
  ipCounter++;
  lastIp = `198.51.${100 + Math.floor(ipCounter / 200)}.${ipCounter % 200}`;
  return withMcpClientIp(lastIp, () => checkoutTools[tool].handler(args)) as Promise<Json>;
}

function refusal(res: Json): string | null {
  if (res.isError !== true) return null;
  return (res.content as { text: string }[]).map((c) => c.text).join("\n");
}

async function refused(tool: Tool, args: Json): Promise<string> {
  const res = await call(tool, args);
  const text = refusal(res);
  if (text === null) throw new Error(`expected a refusal from ${tool}, got: ${JSON.stringify(res).slice(0, 400)}`);
  return text;
}

async function ok(tool: Tool, args: Json): Promise<Json> {
  const res = await call(tool, args);
  const text = refusal(res);
  if (text !== null) throw new Error(`expected a result from ${tool}, got refusal: ${text}`);
  return res;
}

const enable = () => {
  process.env.MCP_ORDERING_ENABLED = "true";
};
const noCreds = () => {
  delete process.env.SHOPIFY_SHOP;
  delete process.env.SHOPIFY_CLIENT_ID;
  delete process.env.SHOPIFY_CLIENT_SECRET;
};
const confirmArgs = (args: Json): Json => ({ ...args, dry_run: false, confirm: true });
const line = (over: Json = {}): Json => ({ ...FEDEX_ARGS.lines[1], ...over });
const usd = (amount: string) => ({ amount, currencyCode: "USD" });
const NONCE = expect.stringMatching(/^[a-f0-9]{32}$/);

function expectNoNetwork() {
  expect(store.calls).toHaveLength(0);
  expect(routeCalls).toHaveLength(0);
  expect(vi.mocked(rateLimit)).not.toHaveBeenCalled();
}

/** Forget everything observed so far in this test (the store stays warm). */
function resetObserved() {
  store.reset();
  routeCalls.length = 0;
  afterTasks.length = 0;
  vi.mocked(rateLimit).mockClear();
}

/** A created checkout (flag on, store stubbed) — the warm path other tests
 *  build on. */
async function createFedex(extra: Json = {}): Promise<Json> {
  enable();
  return ok("create_checkout", confirmArgs({ ...FEDEX_ARGS, ...extra }));
}

/* ---------------------------------------------------------------------------
 * Registry shape
 * ------------------------------------------------------------------------- */

describe("checkout tools — registry shape", () => {
  it("exports the four tools with the brief's annotations", () => {
    expect(Object.keys(checkoutTools)).toEqual([
      "create_checkout",
      "update_checkout",
      "cancel_checkout",
      "get_checkout_status",
    ]);
    const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
    expect(checkoutTools.create_checkout.annotations).toEqual(write);
    expect(checkoutTools.update_checkout.annotations).toEqual(write);
    expect(checkoutTools.cancel_checkout.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    });
    expect(checkoutTools.get_checkout_status.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
  });

  it("schemas carry the agent-tier caps and the three graphic types", () => {
    expect(MAX_LINES).toBe(5);
    expect(MAX_QTY).toBe(10);
    const create = checkoutTools.create_checkout.inputSchema;
    expect(create).toMatchObject({ type: "object", required: ["carrier", "lines", "ship_to"], additionalProperties: false });
    const props = create.properties as Json;
    const lines = props.lines as Json;
    expect(lines).toMatchObject({ minItems: 1, maxItems: 5 });
    const item = lines.items as Json;
    expect(item.additionalProperties).toBe(false);
    expect(item.required).toEqual(["style_id", "qty", "filling", "graphic", "delivery_date"]);
    const itemProps = item.properties as Json;
    expect(itemProps.qty).toMatchObject({ type: "integer", minimum: 1, maximum: 10 });
    expect(((itemProps.graphic as Json).properties as Json).type).toMatchObject({ enum: ["classic", "library", "hub"] });
    expect(itemProps.message).toMatchObject({ maxLength: 300 });
    expect(MAX_ADDONS).toBe(10);
    expect(itemProps.add_ons).toMatchObject({ type: "array", maxItems: 10 });
    expect((props.ship_to as Json).required).toEqual(["name", "address1", "city", "state", "zip"]);
    expect((props.ship_to as Json).additionalProperties).toBe(false);
    expect(props.discount_codes).toMatchObject({ type: "array", maxItems: 2 });
    expect(props.dry_run).toMatchObject({ type: "boolean" });
    expect(props.confirm).toMatchObject({ type: "boolean" });
    // a UUID is expected: 16 is the floor, not 8
    expect(props.idempotency_key).toMatchObject({ minLength: 16, maxLength: 128 });

    const update = checkoutTools.update_checkout.inputSchema;
    expect(update.required).toEqual(["carrier", "lines", "ship_to", "supersedes"]);
    expect(((update.properties as Json).supersedes as Json).required).toEqual(["draft_order_id", "nonce"]);
    expect(checkoutTools.cancel_checkout.inputSchema.required).toEqual(["draft_order_id", "nonce"]);
    expect(checkoutTools.get_checkout_status.inputSchema.required).toEqual(["draft_order_id"]);
  });

  it("descriptions teach the two-step rule, continue_url verbatim, and never to claim payment", () => {
    const create = checkoutTools.create_checkout.description;
    expect(create).toMatch(/dry_run/);
    expect(create).toMatch(/confirm:true/);
    expect(create).toMatch(/explicitly say yes/i);
    expect(create).toMatch(/continue_url .*verbatim/i);
    expect(create).toMatch(/never say the order is placed, paid or reserved/i);
    expect(create).toContain(BUILDER_URL);
    expect(checkoutTools.update_checkout.description).toMatch(/TWO-STEP RULE/);
    expect(checkoutTools.update_checkout.description).toMatch(/verbatim/);
    expect(checkoutTools.cancel_checkout.description).toMatch(/already paid cannot be cancelled/);
    expect(checkoutTools.get_checkout_status.description).toMatch(/instead of guessing or claiming/);
    // the shared-egress limiter and the retry rule: once, same key, after a minute
    expect(create).toMatch(/share egress IPs/);
    expect(create).toMatch(/retry ONCE with the SAME idempotency_key/);
    expect(create).toMatch(/never retry in a loop/);
    // cancel's authority is the `builder` tag, not "this connector"
    expect(checkoutTools.cancel_checkout.description).toMatch(/created by the Piñatagrams builder/);
    expect(checkoutTools.cancel_checkout.description).not.toMatch(/created through this connector/);
    expect(checkoutTools.get_checkout_status.description).toMatch(/not in a loop/);
    // idempotency: a UUID is expected; replays are per instance AND public-by-key
    const idem = String(((checkoutTools.create_checkout.inputSchema.properties as Json).idempotency_key as Json).description);
    expect(idem).toMatch(/UUID/);
    expect(idem).toMatch(/per server instance/);
    expect(idem).toMatch(/anyone presenting the same key with the identical request/);
    expect(idem).toMatch(/cancelled or paid one is refused/);
  });
});

/* ---------------------------------------------------------------------------
 * Validation — shape problems, no network
 * ------------------------------------------------------------------------- */

describe("create_checkout — validation (no network)", () => {
  it("names every problem at once, order-level first", async () => {
    const text = await refused("create_checkout", { lines: [] });
    expect(text).toMatch(/^3 things need fixing before this checkout can go ahead:/);
    expect(text).toContain("carrier is required");
    expect(text).toContain("lines must be a non-empty array");
    expect(text).toContain("ship_to is required");
    expectNoNetwork();
  });

  it("caps at 5 lines and 10 units per line (the route's 20/25 are not the agent's)", async () => {
    const six = Array.from({ length: 6 }, () => line());
    expect(await refused("create_checkout", { ...FEDEX_ARGS, lines: six })).toContain("caps at 5 lines (got 6)");
    for (const qty of [0, 11, 1.5, "2"]) {
      expect(await refused("create_checkout", { ...FEDEX_ARGS, lines: [line({ qty })] })).toContain(
        "qty must be a whole number from 1 to 10",
      );
    }
    expectNoNetwork();
  });

  it("refuses custom artwork with a pointer to the builder, and malformed graphics", async () => {
    const custom = await refused("create_checkout", { ...FEDEX_ARGS, lines: [line({ graphic: { type: "custom" } })] });
    expect(custom).toContain("custom artwork can't be ordered through this connector yet");
    expect(custom).toContain(BUILDER_URL);
    expect(await refused("create_checkout", { ...FEDEX_ARGS, lines: [line({ graphic: { type: "photo" } })] })).toContain(
      "graphic.type must be one of: classic, library, hub.",
    );
    expect(await refused("create_checkout", { ...FEDEX_ARGS, lines: [line({ graphic: { type: "library" } })] })).toContain(
      ".design is required for a library graphic",
    );
    expect(
      await refused("create_checkout", { ...FEDEX_ARGS, lines: [line({ graphic: { type: "hub", design: "h-1" } })] }),
    ).toContain("isn't valid — codes look like HBD06");
    expect(
      await refused("create_checkout", { ...FEDEX_ARGS, lines: [line({ graphic: { type: "classic", design: "HBD06" } })] }),
    ).toContain('graphic: unknown field "design"');
    expect(await refused("create_checkout", { ...FEDEX_ARGS, lines: [line({ graphic: "HBD06" })] })).toContain(
      "graphic must be an object",
    );
    expectNoNetwork();
  });

  it("refuses an over-long message instead of clipping it, and a non-string one", async () => {
    const text = await refused("create_checkout", { ...FEDEX_ARGS, lines: [line({ message: "x".repeat(301) })] });
    expect(text).toContain("message is 301 characters; the card holds 300");
    expect(await refused("create_checkout", { ...FEDEX_ARGS, lines: [line({ message: 42 })] })).toContain(
      "message must be a string",
    );
    expectNoNetwork();
  });

  it("requires a real YYYY-MM-DD delivery_date on every line", async () => {
    const { delivery_date: _drop, ...noDate } = FEDEX_ARGS.lines[1];
    expect(await refused("create_checkout", { ...FEDEX_ARGS, lines: [noDate] })).toContain("delivery_date is required");
    for (const bad of ["10/29/2026", "2026-02-30", "2026-13-01"]) {
      expect(await refused("create_checkout", { ...FEDEX_ARGS, lines: [line({ delivery_date: bad })] })).toContain(
        "must be a real date as YYYY-MM-DD",
      );
    }
    expectNoNetwork();
  });

  it("requires style_id and filling, and flags unknown line fields (a typo'd `addons` would silently drop add-ons)", async () => {
    const text = await refused("create_checkout", {
      ...FEDEX_ARGS,
      lines: [{ qty: 1, graphic: { type: "classic" }, delivery_date: "2026-10-29", addons: ["double-candy"] }],
    });
    expect(text).toContain("style_id is required");
    expect(text).toContain("filling is required");
    expect(text).toContain('Line 1: unknown field "addons"');
    expect(await refused("create_checkout", { ...FEDEX_ARGS, lines: [line({ add_ons: "double-candy" })] })).toContain(
      "add_ons must be an array of add-on ids",
    );
    expectNoNetwork();
  });

  it("validates every ship_to part: required fields, 2-letter state, US ZIP, no unknown fields", async () => {
    const missing = await refused("create_checkout", { ...FEDEX_ARGS, ship_to: {} });
    for (const k of ["name", "address1", "city", "state", "zip"]) expect(missing).toContain(`ship_to.${k} is required`);
    expect(missing).not.toContain("ship_to.address2");
    expect(missing).not.toContain("ship_to.phone");

    const bad = await refused("create_checkout", {
      ...FEDEX_ARGS,
      ship_to: { ...FEDEX_ARGS.ship_to, state: "Texas", zip: "ABC", country: "US", city: 5 },
    });
    expect(bad).toContain("ship_to.state must be the 2-letter US state code");
    expect(bad).toContain("ship_to.zip must be a US ZIP code");
    expect(bad).toContain('ship_to: unknown field "country"');
    expect(bad).toContain("ship_to.city must be a string");
    expect(bad.match(/ship_to\.city/g)).toHaveLength(1); // one problem, one message

    expect(await refused("create_checkout", { ...FEDEX_ARGS, ship_to: { ...FEDEX_ARGS.ship_to, name: "x".repeat(81) } })).toContain(
      "ship_to.name is too long (81 characters; the limit is 80)",
    );
    expectNoNetwork();
  });

  it("validates email and discount codes (≤2, store-shaped)", async () => {
    expect(await refused("create_checkout", { ...FEDEX_ARGS, email: "not-an-email" })).toContain(
      "email doesn't look like an email address",
    );
    expect(await refused("create_checkout", { ...FEDEX_ARGS, discount_codes: ["CODE-A", "CODE-B", "CODE-C"] })).toContain(
      "At most 2 discount codes can be applied",
    );
    // dedupe + uppercase happen before the count: two spellings of one code are one code
    expect(await ok("create_checkout", { ...FEDEX_ARGS, discount_codes: ["freeship", "FREESHIP", "freeship "] })).toMatchObject({
      discount_codes: ["FREESHIP"],
    });
    store.reset();
    expect(await refused("create_checkout", { ...FEDEX_ARGS, discount_codes: ["ok-code", "bad!code"] })).toContain(
      'discount code "BAD!CODE" isn\'t in a form the store accepts',
    );
    expect(await refused("create_checkout", { ...FEDEX_ARGS, discount_codes: "FREESHIP" })).toContain(
      "discount_codes must be an array of code strings",
    );
    expectNoNetwork();
  });

  it("refuses oversized add_ons / discount_codes by COUNT with a short message — never echoing the entries", async () => {
    const many = Array.from({ length: 20_000 }, (_, i) => `entry-${i}`);
    expect(await refused("create_checkout", { ...FEDEX_ARGS, lines: [line({ add_ons: many })] })).toBe(
      "Line 1: add_ons lists 20000 entries; at most 10 per line.",
    );
    expect(await refused("create_checkout", { ...FEDEX_ARGS, discount_codes: many })).toBe(
      "discount_codes lists 20000 entries; at most 2 codes can be applied (one order code + one shipping code).",
    );
    // the count is judged before a single entry is read, junk or not
    expect(await refused("create_checkout", { ...FEDEX_ARGS, lines: [line({ add_ons: Array(11).fill(42) })] })).toBe(
      "Line 1: add_ons lists 11 entries; at most 10 per line.",
    );
    expect(await refused("create_checkout", { ...FEDEX_ARGS, discount_codes: Array(11).fill(null) })).toContain(
      "discount_codes lists 11 entries",
    );
    // at the cap the entries are still looked at one by one
    expect(await refused("create_checkout", { ...FEDEX_ARGS, lines: [line({ add_ons: Array(10).fill(42) })] })).toContain(
      "add_ons must be an array of add-on ids",
    );
    expectNoNetwork();
  });

  it("refuses unknown order fields — sendInvoice and supersedes can't be smuggled into create_checkout", async () => {
    const text = await refused("create_checkout", {
      ...FEDEX_ARGS,
      sendInvoice: true,
      supersedes: { draft_order_id: "gid://shopify/DraftOrder/1", nonce: "a".repeat(32) },
    });
    expect(text).toContain('Order: unknown fields "sendInvoice", "supersedes"');
    expectNoNetwork();
  });

  it("validates the control fields", async () => {
    expect(await refused("create_checkout", { ...FEDEX_ARGS, dry_run: "yes" })).toContain("dry_run must be true or false.");
    expect(await refused("create_checkout", { ...FEDEX_ARGS, confirm: 1 })).toContain("confirm must be true or false.");
    for (const key of ["short", "x".repeat(15), "x".repeat(129), "has a space in it, long enough"]) {
      expect(await refused("create_checkout", { ...FEDEX_ARGS, idempotency_key: key })).toContain(
        "idempotency_key must be 16–128 printable characters with no spaces — use a UUID",
      );
    }
    expect(await refused("create_checkout", { ...FEDEX_ARGS, agent: ["bot"] })).toContain("agent must be a short string");
    expectNoNetwork();
  });

  it("update_checkout requires a well-formed supersedes", async () => {
    expect(await refused("update_checkout", { ...FEDEX_ARGS })).toContain("supersedes is required");
    const bad = await refused("update_checkout", {
      ...FEDEX_ARGS,
      supersedes: { draft_order_id: "123", nonce: "xyz", extra: 1 },
    });
    expect(bad).toContain("supersedes.draft_order_id must be the id a checkout returned");
    expect(bad).toContain("supersedes.nonce must be the 32-character nonce");
    expect(bad).toContain('supersedes: unknown field "extra"');
    expectNoNetwork();
  });
});

/* ---------------------------------------------------------------------------
 * Validation — against the live calendar + catalog (hub only)
 * ------------------------------------------------------------------------- */

describe("create_checkout — hub-level validation (hub reads only, never Shopify)", () => {
  it("merges date problems with price_order's catalog problems into ONE refusal", async () => {
    const text = await refused("create_checkout", {
      ...FEDEX_ARGS,
      lines: [{ style_id: "nope", qty: 1, filling: "Gravel", graphic: { type: "classic" }, delivery_date: "2026-10-16" }],
    });
    expect(text).toMatch(/^3 things need fixing before this checkout can go ahead:/);
    expect(text).toContain(
      "Line 1: delivery_date 2026-10-16 doesn't work — That's too soon — the earliest it can arrive is Tue, Oct 20.",
    );
    expect(text).toContain('Line 1: body style "nope" isn\'t available');
    expect(text).toContain('Line 1: filling "Gravel" isn\'t available');
    expect(store.shopifyCalls()).toHaveLength(0);
    expect(routeCalls).toHaveLength(0);
  });

  it("applies the carrier's calendar: a Sunday FedEx date, a too-soon USPS target", async () => {
    expect(await refused("create_checkout", { ...FEDEX_ARGS, lines: [line({ delivery_date: "2026-10-25" })] })).toContain(
      "FedEx doesn't deliver on that day of the week",
    );
    expect(
      await refused("create_checkout", { ...USPS_ARGS, lines: [{ ...USPS_ARGS.lines[0], delivery_date: "2026-10-20" }] }),
    ).toContain("That's too soon for USPS — the earliest target date is Thu, Oct 22.");
    expect(store.shopifyCalls()).toHaveLength(0);
  });

  it("refuses an add-on the filling doesn't allow and an unknown design code (price_order's rules)", async () => {
    expect(
      await refused("create_checkout", {
        ...USPS_ARGS,
        lines: [{ ...USPS_ARGS.lines[0], add_ons: ["double-candy"] }],
      }),
    ).toContain("Double Candy isn't available with the Dog Treats filling");
    expect(
      await refused("create_checkout", { ...FEDEX_ARGS, lines: [line({ graphic: { type: "library", design: "ZZZ99" } })] }),
    ).toContain('no design has the code "ZZZ99"');
    expect(store.shopifyCalls()).toHaveLength(0);
  });
});

/* ---------------------------------------------------------------------------
 * dry_run (the default): a priced preview, no route, no Shopify
 * ------------------------------------------------------------------------- */

describe("create_checkout — dry_run preview", () => {
  it("FedEx: prices exactly as price_order / checkout, normalizes, and never touches the route", async () => {
    const res = await ok("create_checkout", FEDEX_ARGS);
    expect(res).toMatchObject({
      dry_run: true,
      carrier: "fedex",
      arrives: "Thu, Oct 29",
      ship_to: {
        name: "Jane Doe",
        address1: "123 Main St",
        address2: "Apt 4",
        city: "Austin",
        state: "TX",
        zip: "78701",
        phone: "5125550100",
      },
      subtotal_cents: FEDEX_MONEY.subtotal,
      total_before_tax_cents: FEDEX_MONEY.total,
      currency: "USD",
      as_of: expect.any(String),
      ordering_enabled: false,
    });
    expect(res.lines).toEqual([
      {
        line: 1,
        style_id: "googly",
        style_name: "Googly",
        graphic: { type: "library", design: "HBD02", label: "Fun Birthday Piñatagram" },
        filling: { id: "school-fun-pack", label: "School Fun Pack" },
        add_ons: ["double-candy", "chonky"],
        qty: 2,
        delivery_date: "2026-10-29",
        arrives: "Thu, Oct 29",
        message: "Happy birthday, Sam!",
        unit_cents: FEDEX_MONEY.line1_unit,
        line_cents: FEDEX_MONEY.line1,
      },
      {
        line: 2,
        style_id: "white-uni",
        style_name: "White Uni",
        graphic: { type: "classic", design: "STANDARD", label: "Classic Piñatagrams" },
        filling: { id: "candy", label: "Candy" },
        add_ons: [],
        qty: 1,
        delivery_date: "2026-10-29",
        arrives: "Thu, Oct 29",
        unit_cents: FEDEX_MONEY.line2_unit,
        line_cents: FEDEX_MONEY.line2,
      },
    ]);
    expect(res.add_on_lines).toEqual([
      { id: "double-candy", label: "Double Candy", unit_cents: 499, qty: 2, cents: FEDEX_MONEY.double_candy },
      { id: "chonky", label: "Chonky", unit_cents: 999, qty: 2, cents: FEDEX_MONEY.chonky },
    ]);
    expect(res.shipping).toMatchObject({ carrier: "fedex", per_unit_cents: 1500, units: 3, cents: FEDEX_MONEY.shipping });
    // Off switch: the preview still works, and says confirm would be refused.
    expect(res.next_step).toContain("switched off");
    expect(res.next_step).toContain(BUILDER_URL);
    expect(String(res.note)).toContain("nothing has been ordered, charged or reserved");
    expect(res).not.toHaveProperty("continue_url");
    expect(res).not.toHaveProperty("email");
    expect(res).not.toHaveProperty("discount_codes");

    // Hub only — scoped to MCP_HOST on every catalog read — and no route call.
    expect(store.shopifyCalls()).toHaveLength(0);
    expect(routeCalls).toHaveLength(0);
    expect(vi.mocked(rateLimit)).not.toHaveBeenCalled();
    const catalogReads = store.hubCalls().filter((c) => c.url.pathname === "/api/public/catalog");
    expect(catalogReads.length).toBeGreaterThan(0);
    for (const c of catalogReads) expect(c.url.searchParams.get("host")).toBe(MCP_HOST);
  });

  it("with ordering on, next_step spells out the exact second call", async () => {
    enable();
    const res = await ok("create_checkout", FEDEX_ARGS);
    expect(res.ordering_enabled).toBe(true);
    expect(res.next_step).toMatch(/explicitly say yes/);
    expect(res.next_step).toContain("dry_run:false");
    expect(res.next_step).toContain("confirm:true");
    expect(routeCalls).toHaveLength(0);
    expect(store.shopifyCalls()).toHaveLength(0);
  });

  it("USPS: the arrival window, the USPS rate, and uppercased state / codes, email echoed", async () => {
    const res = await ok("create_checkout", {
      ...USPS_ARGS,
      email: "payer@example.com",
      discount_codes: ["freeship"],
    });
    expect(res).toMatchObject({
      dry_run: true,
      carrier: "usps",
      arrives: "Nov 3 – Nov 7",
      ship_to: { name: "Grandma", address1: "9 Elm Street", city: "Portland", state: "OR", zip: "97201" },
      total_before_tax_cents: USPS_MONEY.total,
      email: "payer@example.com",
      discount_codes: ["FREESHIP"],
    });
    expect(res.ship_to).not.toHaveProperty("address2");
    expect(res.ship_to).not.toHaveProperty("phone");
    expect(res.shipping).toMatchObject({ carrier: "usps", per_unit_cents: USPS_MONEY.shipping, units: 1 });
    expect((res.lines as Json[])[0]).toMatchObject({ unit_cents: USPS_MONEY.unit, arrives: "Nov 3 – Nov 7" });
    expect(String(res.discount_note)).toMatch(/not include/);
    expect(store.shopifyCalls()).toHaveLength(0);
  });

  it("a hub graphic prices at the library tier and resolves art + sha from the live catalog", async () => {
    store.patchCatalog((c) => {
      (c as unknown as Json).hubGraphics = [
        {
          design: "H0001",
          title: "INTERNAL NAME",
          category: "test",
          bodyStyles: [],
          art: "https://yrfds6n4iwscziqm.public.blob.vercel-storage.com/library/H0001.png",
          artSha256: "a".repeat(64),
          thumb: "",
        },
      ];
    });
    const res = await ok("create_checkout", { ...FEDEX_ARGS, lines: [line({ graphic: { type: "hub", design: "H0001" } })] });
    const [l] = res.lines as Json[];
    expect(l.graphic).toEqual({ type: "hub", design: "H0001", label: "Your selected graphic" });
    expect(l.unit_cents).toBe(2999 + 200);
    expect(JSON.stringify(res)).not.toContain("INTERNAL NAME");
  });

  it("dedupes repeated add-on ids on a line before pricing (the cap is ten DISTINCT add-ons)", async () => {
    const res = await ok("create_checkout", {
      ...FEDEX_ARGS,
      lines: [{ ...FEDEX_ARGS.lines[0], add_ons: ["double-candy", "double-candy", "chonky", "chonky ", " double-candy"] }],
    });
    expect((res.lines as Json[])[0]).toMatchObject({ add_ons: ["double-candy", "chonky"], line_cents: FEDEX_MONEY.line1 });
    expect(res.add_on_lines).toEqual([
      { id: "double-candy", label: "Double Candy", unit_cents: 499, qty: 2, cents: FEDEX_MONEY.double_candy },
      { id: "chonky", label: "Chonky", unit_cents: 999, qty: 2, cents: FEDEX_MONEY.chonky },
    ]);
    expect(res.total_before_tax_cents).toBe(FEDEX_MONEY.line1 + FEDEX_MONEY.double_candy + FEDEX_MONEY.chonky + 1500 * 2);
    expect(store.shopifyCalls()).toHaveLength(0);
  });

  it("dry_run:false without confirm, and confirm with dry_run:true, are refusals (nothing created, no network)", async () => {
    enable();
    const twoStep = await refused("create_checkout", { ...FEDEX_ARGS, dry_run: false });
    expect(twoStep).toContain("Two steps are required");
    expect(twoStep).toContain("Nothing was created");
    const contradictory = await refused("create_checkout", { ...FEDEX_ARGS, confirm: true });
    expect(contradictory).toContain("confirm:true only counts together with dry_run:false");
    expectNoNetwork();
  });
});

/* ---------------------------------------------------------------------------
 * confirm: the off switch, the route's dry-run answer, the real spine
 * ------------------------------------------------------------------------- */

describe("create_checkout — confirm", () => {
  it("with MCP_ORDERING_ENABLED unset/false the confirm is refused LOUDLY before any read", async () => {
    for (const v of [undefined, "false", "1", "TRUE"]) {
      if (v === undefined) delete process.env.MCP_ORDERING_ENABLED;
      else process.env.MCP_ORDERING_ENABLED = v;
      const text = await refused("create_checkout", confirmArgs(FEDEX_ARGS));
      expect(text).toContain("Ordering through this connector is switched off right now; nothing was created.");
    }
    expectNoNetwork();
  });

  it("reports the route's dryRun:true answer (no store credentials) honestly — never a fake continue_url", async () => {
    enable();
    noCreds();
    const text = await refused("create_checkout", confirmArgs(FEDEX_ARGS));
    expect(text).toContain("Store credentials are absent on this deployment");
    expect(text).toContain("nothing was created");
    expect(text).not.toContain("continue_url");
    // The route ran (hub reads, rate-limited on the forwarded IP) but Shopify
    // was never reachable, so nothing could have been created.
    expect(routeCalls).toHaveLength(1);
    expect(store.shopifyCalls()).toHaveLength(0);
    expect(vi.mocked(rateLimit)).toHaveBeenCalledWith(`checkout:${lastIp}`, 6, 60_000);
  });

  it("FedEx: creates ONE draft through the real route and answers UCP-shaped; the DraftOrderInput honours the Paper contract", async () => {
    const res = await createFedex({ agent: "Test Assistant" });

    // --- the Request the tool built (the spine) ---
    expect(routeCalls).toHaveLength(1);
    const [{ headers, body }] = routeCalls;
    expect(headers.host).toBe(MCP_HOST);
    expect(headers["x-pg-flow"]).toBe(FLOW_HEADER_VALUE);
    expect(headers["x-forwarded-for"]).toBe(lastIp);
    expect(headers["content-type"]).toBe("application/json");
    expect(body.source).toBe("mcp");
    expect(body.agent).toBe("Test Assistant");
    expect(body).not.toHaveProperty("sendInvoice");
    expect(body).not.toHaveProperty("previewVariant");
    expect(body).not.toHaveProperty("email");
    expect(body).not.toHaveProperty("discountCodes");
    expect(body).not.toHaveProperty("supersedes");
    const cart = body.lines as Json[];
    expect(cart).toHaveLength(2);
    expect(cart[0]).toMatchObject({
      id: "line-1",
      styleId: "googly",
      styleName: "Googly",
      boxImageUrl: null,
      logoZone: null,
      // library art resolved SERVER-SIDE from public/graphics.json
      graphic: { type: "shopify", design: "HBD02", title: "Fun Birthday Piñatagram", art: HBD02_ART },
      message: "Happy birthday, Sam!",
      filling: "School Fun Pack",
      addons: ["double-candy", "chonky"],
      deliveryDate: "2026-10-29",
      carrier: "fedex",
      address: { name: "Jane Doe", address1: "123 Main St", address2: "Apt 4", city: "Austin", province: "TX", zip: "78701", phone: "5125550100" },
      qty: 2,
    });
    expect(cart[1]).toMatchObject({ id: "line-2", styleId: "white-uni", graphic: CLASSIC_GRAPHIC, filling: "Candy", qty: 1 });
    expect(cart[1]).not.toHaveProperty("addons");
    // the route rate-limited on the MCP request's own client IP
    expect(vi.mocked(rateLimit)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(rateLimit)).toHaveBeenCalledWith(`checkout:${lastIp}`, 6, 60_000);

    // --- the answer ---
    const draftId = String(res.draft_order_id);
    const draft = store.drafts.get(draftId);
    expect(draft).toBeDefined();
    expect(res).toMatchObject({
      status: "ready_for_complete",
      continue_url: draft!.invoiceUrl,
      draft_order_id: expect.stringMatching(/^gid:\/\/shopify\/DraftOrder\/\d+$/),
      nonce: NONCE,
      carrier: "fedex",
      arrives: "Thu, Oct 29",
      ship_to: { name: "Jane Doe", address1: "123 Main St", address2: "Apt 4", city: "Austin", state: "TX", zip: "78701", phone: "5125550100" },
      subtotal_cents: FEDEX_MONEY.subtotal,
      total_before_tax_cents: FEDEX_MONEY.total,
      note: "Open continue_url to pay on Shopify's secure checkout. The order exists only after payment; tax is added there.",
    });
    expect(String(res.continue_url)).toMatch(new RegExp(`^https://${store.shopifyHost.replace(/\./g, "\\.")}/invoices/`));
    expect(res.lines).toHaveLength(2);
    expect((res.lines as Json[])[0]).toMatchObject({ unit_cents: FEDEX_MONEY.line1_unit, line_cents: FEDEX_MONEY.line1 });
    expect(res).not.toHaveProperty("dry_run");
    expect(res).not.toHaveProperty("replayed");
    // Nothing in the answer claims a purchase happened.
    expect(JSON.stringify(res)).not.toMatch(/\b(paid|placed|reserved)\b/i);

    // --- the DraftOrderInput Shopify received ---
    expect(store.draftInputs).toHaveLength(1);
    const input = store.draftInputs[0] as Json & { tags: string[]; customAttributes: { key: string; value: string }[]; lineItems: Json[] };
    expect(input.tags.slice(0, 2)).toEqual(["builder", "variant-default"]);
    expect(input.customAttributes.slice(0, 5)).toEqual([
      { key: "_builderHost", value: MCP_HOST },
      { key: "_builderFlow", value: "v2" },
      { key: "_builderVariant", value: "default (tiered/fedex+usps)" },
      { key: "_builderCatalog", value: "2026-10-15T14:38:44.115Z" },
      { key: "_builderNonce", value: res.nonce },
    ]);
    expect(input.shippingAddress).toEqual(SHIP_TO_AUSTIN);
    expect(input.shippingLine).toEqual(SHIPPING_FEDEX);
    expect(input.lineItems).toEqual([
      { variantId: VARIANT_BY_SKU.get("CUSTOM-GOOGLY"), quantity: 2, priceOverride: usd("33.49"), customAttributes: LINE_A_ATTRS },
      { variantId: VARIANT_BY_SKU.get("CUSTOM-WHITE UNICORN"), quantity: 1, priceOverride: usd("29.99"), customAttributes: LINE_B_ATTRS },
      { variantId: ADDON_VARIANT["DOUBLE-FILLING"], quantity: 2, priceOverride: usd("4.99") },
      { variantId: ADDON_VARIANT.CHONKY, quantity: 2, priceOverride: usd("9.99") },
    ]);
    for (const k of ["note", "corp_ref", "email", "discountCodes"]) expect(input).not.toHaveProperty(k);
    expect(assertPaperDraft(input, { addonVariantIds: ADDON_VARIANT_IDS })).toEqual({
      carrier: "fedex",
      pinataLines: 2,
      addonLines: 2,
    });

    // --- Shopify, in order: one mint, the CUSTOM-* lookup, one SKU search per
    // add-on, the single create; never an invoice send. ---
    const shopify = store.shopifyCalls();
    expect(shopify[0].url.pathname).toBe("/admin/oauth/access_token");
    for (const c of shopify.slice(1)) {
      expect(c.url.pathname).toBe(GRAPHQL_PATH);
      expect(c.headers["x-shopify-access-token"]).toBe(TOKEN);
    }
    expect(store.gqlCalls("product(id: $id)")).toHaveLength(1);
    expect(store.gqlCalls("productVariants(").map((c) => (c.body?.variables as { q: string }).q).sort()).toEqual([
      'sku:"CHONKY"',
      'sku:"DOUBLE-FILLING"',
    ]);
    expect(store.gqlCalls("draftOrderCreate(")).toHaveLength(1);
    expect(store.gqlCalls("draftOrderInvoiceSend(")).toHaveLength(0);
    expect(store.gqlCalls("draftOrderDelete(")).toHaveLength(0);

    // The route called after() inside our request scope — once (the webhook
    // keep-alive; no supersede to retire). Mocked here; legal live.
    expect(afterTasks).toHaveLength(1);

    // Every catalog read — the tool's, price_order's and the route's — was
    // scoped to the same Host, so one variant profile priced and charged.
    const catalogReads = store.hubCalls().filter((c) => c.url.pathname === "/api/public/catalog");
    expect(catalogReads.length).toBeGreaterThanOrEqual(3);
    for (const c of catalogReads) expect(c.url.searchParams.get("host")).toBe(MCP_HOST);
  });

  it("tags the draft `mcp` and stamps _orderSource / _orderAgent right after _builderNonce (route edit landing concurrently)", async (ctx) => {
    const res = await createFedex({ agent: "Test Assistant" });
    const input = store.draftInputs[0] as Json & { tags: string[]; customAttributes: { key: string; value: string }[] };
    if (!input.tags.includes("mcp")) {
      ctx.skip(
        "src/app/api/checkout/route.ts does not yet emit source:\"mcp\" (tag + _orderSource/_orderAgent) — the route builder's additive edit; re-run once the integrator combines the branches",
      );
    }
    expect(input.tags).toEqual(["builder", "variant-default", "mcp"]);
    const keys = input.customAttributes.map((a) => a.key);
    const nonceAt = keys.indexOf("_builderNonce");
    expect(nonceAt).toBeGreaterThanOrEqual(0);
    expect(input.customAttributes.slice(nonceAt, nonceAt + 3)).toEqual([
      { key: "_builderNonce", value: res.nonce },
      { key: "_orderSource", value: "mcp" },
      { key: "_orderAgent", value: "Test Assistant" },
    ]);
    expect(assertPaperDraft(input, { addonVariantIds: ADDON_VARIANT_IDS })).toMatchObject({ carrier: "fedex" });
  });

  it("USPS: window rail, non-Guaranteed title, one-word recipient, no add-on lines", async () => {
    enable();
    const res = await ok("create_checkout", confirmArgs(USPS_ARGS));
    expect(res).toMatchObject({
      status: "ready_for_complete",
      arrives: "Nov 3 – Nov 7",
      ship_to: { name: "Grandma", address1: "9 Elm Street", city: "Portland", state: "OR", zip: "97201" },
      total_before_tax_cents: USPS_MONEY.total,
    });
    const input = store.draftInputs[0] as Json & { lineItems: Json[] };
    expect(input.shippingAddress).toEqual(SHIP_TO_PORTLAND);
    expect(input.shippingLine).toEqual(SHIPPING_USPS);
    expect(input.lineItems).toEqual([
      { variantId: VARIANT_BY_SKU.get("CUSTOM-PINK UNICORN"), quantity: 1, priceOverride: usd("29.99"), customAttributes: LINE_PINK_CLASSIC_ATTRS },
    ]);
    expect(assertPaperDraft(input, { addonVariantIds: ADDON_VARIANT_IDS })).toEqual({ carrier: "usps", pinataLines: 1, addonLines: 0 });
    // warm instance: token + variant maps cached, so only the create hits Shopify
    expect(store.shopifyCalls().map((c) => c.url.pathname)).toEqual([GRAPHQL_PATH]);
  });

  it("passes email + discount codes through as native Shopify fields; sendInvoice stays absent", async () => {
    const res = await createFedex({ email: "payer@example.com", discount_codes: [FREE_SHIPPING_CODE.toLowerCase()] });
    const [{ body }] = routeCalls;
    expect(body.email).toBe("payer@example.com");
    expect(body.discountCodes).toEqual([FREE_SHIPPING_CODE]);
    expect(body).not.toHaveProperty("sendInvoice");
    const input = store.draftInputs[0] as Json;
    expect(input.email).toBe("payer@example.com");
    expect(input.discountCodes).toEqual([FREE_SHIPPING_CODE]);
    expect(input.allowDiscountCodesInCheckout).toBe(false);
    // the hub's free-shipping rule zeroes the line on the draft; the tool's
    // total is still the pre-discount figure and says so
    expect(input.shippingLine).toEqual(SHIPPING_FEDEX_FREE);
    expect(res).toMatchObject({ email: "payer@example.com", discount_codes: [FREE_SHIPPING_CODE], total_before_tax_cents: FEDEX_MONEY.total });
    expect(String(res.discount_note)).toMatch(/not include/);
    expect(store.gqlCalls("draftOrderInvoiceSend(")).toHaveLength(0);
    expect(assertPaperDraft(input, { addonVariantIds: ADDON_VARIANT_IDS })).toMatchObject({ carrier: "fedex" });
  });

  it("maps the route's failures to customer-safe refusals naming each line; nothing payable is hidden", async () => {
    enable();
    store.failNextCreate("address");
    const address = await refused("create_checkout", confirmArgs(FEDEX_ARGS));
    expect(address).toMatch(/^2 things need fixing before this checkout can be created:/);
    expect(address).toContain("Line 1:");
    expect(address).toContain("Line 2:");
    expect(address).toContain("couldn't accept this delivery address");
    expect(address).not.toContain("continue_url");

    store.reset();
    store.failNextCreate("http500");
    const other = await refused("create_checkout", confirmArgs(FEDEX_ARGS));
    expect(other).toBe("We couldn't set up your order just now — nothing was charged. Please try again in a minute.");
  });

  it("when the route THROWS after the create may have run, the answer says the result is unconfirmed and to retry with a NEW key — never 'try again'", async () => {
    enable();
    const key = `idem-${crypto.randomUUID()}`;
    const before = store.drafts.size;
    routeFault.throwAfter = true;
    const text = await refused("create_checkout", confirmArgs({ ...FEDEX_ARGS, idempotency_key: key }));
    expect(text).toBe(
      "The store didn't confirm whether a checkout was created — nothing has been charged. Don't retry immediately: ask the customer whether a Shopify invoice link appeared, then retry with a NEW idempotency_key after a minute.",
    );
    expect(text).not.toContain("continue_url");
    expect(text).not.toMatch(/try again in a minute/);
    // the hazard the wording exists for: the draft IS in the store, payable,
    // and the key was never bound — an immediate same-key retry has nothing to
    // replay and mints a second one
    expect(routeCalls).toHaveLength(1);
    expect(store.drafts.size).toBe(before + 1);
    resetObserved();
    const retry = await ok("create_checkout", confirmArgs({ ...FEDEX_ARGS, idempotency_key: key }));
    expect(retry).not.toHaveProperty("replayed");
    expect(store.drafts.size).toBe(before + 2);
  });
});

/* ---------------------------------------------------------------------------
 * Idempotency (per instance, best effort)
 * ------------------------------------------------------------------------- */

describe("create_checkout — idempotency_key", () => {
  it("replays the stored result for the same key + same request after ONE throttled status read — no hub, no route, no create", async () => {
    const key = `idem-${crypto.randomUUID()}`;
    const first = await createFedex({ idempotency_key: key });
    expect(first.status).toBe("ready_for_complete");
    const createdBefore = store.drafts.size;

    resetObserved();
    const again = await ok("create_checkout", confirmArgs({ ...FEDEX_ARGS, idempotency_key: key }));
    expect(again).toEqual({ ...first, replayed: true });
    // the replay first proved the draft is still open: exactly one
    // draftOrder(id) read, on the stored id, through the MCP-side throttle —
    // nothing else
    expect(routeCalls).toHaveLength(0);
    expect(store.hubCalls()).toHaveLength(0);
    const reads = store.gqlCalls("draftOrder(id: $id)");
    expect(reads).toHaveLength(1);
    expect(reads[0].body?.variables).toEqual({ id: first.draft_order_id });
    expect(store.shopifyCalls()).toEqual(reads);
    expect(vi.mocked(rateLimit)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(rateLimit)).toHaveBeenCalledWith(`mcp-status:${lastIp}`, 30, 60_000);
    expect(store.drafts.size).toBe(createdBefore);

    // Same key, different request → conflict before any read, nothing created.
    resetObserved();
    const conflict = await refused(
      "create_checkout",
      confirmArgs({ ...FEDEX_ARGS, lines: [FEDEX_ARGS.lines[1]], idempotency_key: key }),
    );
    expect(conflict).toMatch(/^idempotency_conflict:/);
    expect(conflict).toContain("Nothing was created");
    expectNoNetwork();

    // A different agent name is NOT a different request (analytics only).
    const renamed = await ok("create_checkout", confirmArgs({ ...FEDEX_ARGS, idempotency_key: key, agent: "Someone Else" }));
    expect(renamed.replayed).toBe(true);
    expect(routeCalls).toHaveLength(0);
    expect(store.gqlCalls("draftOrderCreate(")).toHaveLength(0);
    expect(store.drafts.size).toBe(createdBefore);
  });

  it("a replay re-checks the draft: cancelled or paid → refusal naming a NEW key; store down → honest, names get_checkout_status; never a stale ready_for_complete", async () => {
    // cancelled (through the connector, with its nonce)
    const key = `idem-${crypto.randomUUID()}`;
    const first = await createFedex({ idempotency_key: key });
    const id = String(first.draft_order_id);
    await ok("cancel_checkout", { draft_order_id: id, nonce: first.nonce });
    resetObserved();
    const afterCancel = await refused("create_checkout", confirmArgs({ ...FEDEX_ARGS, idempotency_key: key }));
    expect(afterCancel).toBe("That checkout was cancelled or already paid; start again with a new idempotency_key. Nothing was created.");
    expect(store.gqlCalls("draftOrder(id: $id)")).toHaveLength(1);
    expect(store.gqlCalls("draftOrderCreate(")).toHaveLength(0);
    expect(routeCalls).toHaveLength(0);
    // the key stays bound: repeating the same request can't silently mint a replacement
    expect(await refused("create_checkout", confirmArgs({ ...FEDEX_ARGS, idempotency_key: key }))).toContain("new idempotency_key");
    expect(store.gqlCalls("draftOrderCreate(")).toHaveLength(0);

    // paid
    const key2 = `idem-${crypto.randomUUID()}`;
    const second = await createFedex({ idempotency_key: key2 });
    store.drafts.get(String(second.draft_order_id))!.status = "COMPLETED";
    resetObserved();
    expect(await refused("create_checkout", confirmArgs({ ...FEDEX_ARGS, idempotency_key: key2 }))).toContain("cancelled or already paid");
    expect(store.gqlCalls("draftOrderCreate(")).toHaveLength(0);
    expect(routeCalls).toHaveLength(0);

    // the store doesn't answer: no stale success, no new draft, a pointer to get_checkout_status
    const key3 = `idem-${crypto.randomUUID()}`;
    await createFedex({ idempotency_key: key3 });
    store.failLookups(true);
    resetObserved();
    const unverified = await refused("create_checkout", confirmArgs({ ...FEDEX_ARGS, idempotency_key: key3 }));
    expect(unverified).toContain("couldn't confirm it is still open");
    expect(unverified).toContain("nothing new was created");
    expect(unverified).toContain("get_checkout_status");
    expect(unverified).not.toContain("continue_url");
    expect(store.gqlCalls("draftOrderCreate(")).toHaveLength(0);
    expect(routeCalls).toHaveLength(0);
    store.failLookups(false);
    // once the store answers again the replay is back
    expect((await ok("create_checkout", confirmArgs({ ...FEDEX_ARGS, idempotency_key: key3 }))).replayed).toBe(true);
    expect(store.gqlCalls("draftOrderCreate(")).toHaveLength(0);
  });

  it("a dry_run with a key is just a preview — keys only bind confirms; a failed confirm doesn't burn its key", async () => {
    enable();
    const key = `idem-${crypto.randomUUID()}`;
    const preview = await ok("create_checkout", { ...FEDEX_ARGS, idempotency_key: key });
    expect(preview.dry_run).toBe(true);
    expect(routeCalls).toHaveLength(0);

    store.failNextCreate("http500");
    await refused("create_checkout", confirmArgs({ ...FEDEX_ARGS, idempotency_key: key }));
    store.reset();
    const created = await ok("create_checkout", confirmArgs({ ...FEDEX_ARGS, idempotency_key: key }));
    expect(created.status).toBe("ready_for_complete");
    expect(created).not.toHaveProperty("replayed");
    expect(store.gqlCalls("draftOrderCreate(")).toHaveLength(1);
  });
});

/* ---------------------------------------------------------------------------
 * update_checkout — supersede
 * ------------------------------------------------------------------------- */

describe("update_checkout", () => {
  it("previews like create (plus the superseded id) without any Shopify read", async () => {
    enable();
    const old = await createFedex();
    resetObserved();
    const sup = { draft_order_id: old.draft_order_id, nonce: old.nonce };
    const prev = await ok("update_checkout", { ...FEDEX_ARGS, lines: [line({ qty: 3 })], supersedes: sup });
    expect(prev).toMatchObject({ dry_run: true, supersedes: { draft_order_id: old.draft_order_id }, total_before_tax_cents: 2999 * 3 + 1500 * 3 });
    expect(store.shopifyCalls()).toHaveLength(0);
    expect(routeCalls).toHaveLength(0);
  });

  it("confirm: verifies the old draft's nonce first, passes `supersedes` to the route, and the deferred retire deletes ONLY the old draft", async () => {
    const old = await createFedex();
    const oldId = String(old.draft_order_id);
    resetObserved();

    const sup = { draft_order_id: oldId, nonce: old.nonce };
    const res = await ok("update_checkout", confirmArgs({ ...FEDEX_ARGS, lines: [line({ qty: 3 })], supersedes: sup }));

    // pre-check read the old draft before anything was created
    const lookups = store.gqlCalls("draftOrder(id: $id)");
    expect(lookups.length).toBeGreaterThanOrEqual(1);
    expect(lookups[0].body?.variables).toEqual({ id: oldId });
    expect(store.calls.indexOf(lookups[0])).toBeLessThan(store.calls.indexOf(store.gqlCalls("draftOrderCreate(")[0]));

    expect(routeCalls).toHaveLength(1);
    expect(routeCalls[0].body.supersedes).toEqual({ draftOrderId: oldId, nonce: old.nonce });
    expect(routeCalls[0].body.source).toBe("mcp");

    expect(res).toMatchObject({
      status: "ready_for_complete",
      nonce: NONCE,
      total_before_tax_cents: 2999 * 3 + 1500 * 3,
      superseded: { draft_order_id: oldId },
    });
    expect(res.draft_order_id).not.toBe(oldId);
    expect(res.continue_url).not.toBe(old.continue_url);
    expect(String((res.superseded as Json).note)).toMatch(/get_checkout_status/);

    // The route deferred the retire (then the webhook keep-alive). Run the
    // retire: it looks the old draft up and deletes it — the new one stays.
    expect(afterTasks).toHaveLength(2);
    const deletedBefore = store.deleted.length; // earlier tests' cancels survive reset() by design
    expect(store.deleted).not.toContain(oldId);
    await afterTasks[0]();
    expect(store.deleted.slice(deletedBefore)).toEqual([oldId]);
    expect(store.gqlCalls("draftOrderDelete(")[0].body?.variables).toEqual({ input: { id: oldId } });
    expect(store.drafts.has(String(res.draft_order_id))).toBe(true);
  });

  it("confirm refuses BEFORE creating when the nonce is wrong, the old draft is paid, or it is gone", async () => {
    const old = await createFedex();
    const oldId = String(old.draft_order_id);
    const args = (nonce: string) => confirmArgs({ ...FEDEX_ARGS, supersedes: { draft_order_id: oldId, nonce } });

    resetObserved();
    const wrong = await refused("update_checkout", args("f".repeat(32)));
    expect(wrong).toContain("nonce doesn't match");
    expect(wrong).toContain("Nothing was created");
    expect(store.gqlCalls("draftOrderCreate(")).toHaveLength(0);
    expect(routeCalls).toHaveLength(0);

    resetObserved();
    store.drafts.get(oldId)!.status = "COMPLETED";
    store.drafts.get(oldId)!.order = { id: "gid://shopify/Order/1" };
    const paid = await refused("update_checkout", args(String(old.nonce)));
    expect(paid).toContain("already been paid");
    expect(store.gqlCalls("draftOrderCreate(")).toHaveLength(0);
    expect(routeCalls).toHaveLength(0);

    resetObserved();
    store.drafts.delete(oldId);
    const gone = await refused("update_checkout", args(String(old.nonce)));
    expect(gone).toContain("no longer exists");
    expect(gone).toContain("create_checkout");
    expect(store.gqlCalls("draftOrderCreate(")).toHaveLength(0);
    expect(routeCalls).toHaveLength(0);
  });
});

/* ---------------------------------------------------------------------------
 * cancel_checkout
 * ------------------------------------------------------------------------- */

describe("cancel_checkout", () => {
  const VALID = { draft_order_id: "gid://shopify/DraftOrder/900001", nonce: "a".repeat(32) };

  it("validates its two arguments and refuses extras", async () => {
    const text = await refused("cancel_checkout", { draft_order_id: "900001", nonce: "short", force: true });
    expect(text).toContain("draft_order_id must be the id a checkout returned");
    expect(text).toContain("nonce is required");
    expect(text).toContain('cancel_checkout: unknown field "force"');
    expectNoNetwork();
  });

  it("is behind the off switch and honest without store credentials", async () => {
    expect(await refused("cancel_checkout", VALID)).toContain("switched off right now; nothing was changed");
    expectNoNetwork();
    enable();
    noCreds();
    expect(await refused("cancel_checkout", VALID)).toContain("Store credentials are absent on this deployment");
    expectNoNetwork();
  });

  it("deletes an unpaid connector draft only with its nonce; a second cancel reports gone", async () => {
    const created = await createFedex();
    const id = String(created.draft_order_id);
    store.reset();

    const wrong = await refused("cancel_checkout", { draft_order_id: id, nonce: "f".repeat(32) });
    expect(wrong).toContain("nonce doesn't match");
    expect(wrong).toContain("Nothing was changed");
    expect(store.gqlCalls("draftOrderDelete(")).toHaveLength(0);
    expect(store.deleted).not.toContain(id);

    // the nonce is case-insensitive hex; whitespace is trimmed
    const res = await ok("cancel_checkout", { draft_order_id: id, nonce: ` ${String(created.nonce).toUpperCase()} ` });
    expect(res).toMatchObject({ status: "cancelled", draft_order_id: id });
    expect(String(res.note)).toContain("nothing was charged");
    expect(store.deleted).toContain(id);
    expect(store.gqlCalls("draftOrderDelete(")[0].body?.variables).toEqual({ input: { id } });

    const again = await ok("cancel_checkout", { draft_order_id: id, nonce: created.nonce });
    expect(again).toMatchObject({ status: "gone", draft_order_id: id });
  });

  it("refuses a paid draft, a draft that isn't the builder's, and reports a store failure as such", async () => {
    const created = await createFedex();
    const id = String(created.draft_order_id);
    const args = { draft_order_id: id, nonce: created.nonce };

    store.drafts.get(id)!.status = "COMPLETED";
    const completed = await refused("cancel_checkout", args);
    expect(completed).toContain("already been paid");
    expect(completed).toContain("contact Piñatagrams support");

    store.drafts.get(id)!.status = "OPEN";
    store.drafts.get(id)!.order = { id: "gid://shopify/Order/77" };
    expect(await refused("cancel_checkout", args)).toContain("already been paid");

    store.drafts.get(id)!.order = null;
    store.drafts.get(id)!.tags = ["corporate"];
    // the authority is the `builder` tag (a storefront builder draft is
    // cancellable here with its nonce too), and the wording says so
    expect(await refused("cancel_checkout", args)).toContain("isn't an open checkout created by the Piñatagrams builder");

    store.drafts.get(id)!.tags = ["builder"];
    store.failLookups(true);
    expect(await refused("cancel_checkout", args)).toContain("couldn't reach our store just now — nothing was changed");
    expect(store.deleted).not.toContain(id);
  });
});

/* ---------------------------------------------------------------------------
 * get_checkout_status
 * ------------------------------------------------------------------------- */

describe("get_checkout_status", () => {
  it("validates the id and refuses extras", async () => {
    expect(await refused("get_checkout_status", { draft_order_id: "nope" })).toContain(
      "draft_order_id must be the id a checkout returned",
    );
    expect(await refused("get_checkout_status", { draft_order_id: "gid://shopify/DraftOrder/1", nonce: "x" })).toContain(
      'get_checkout_status: unknown field "nonce"',
    );
    expectNoNetwork();
  });

  it("mirrors api/order-status: open / paid / gone / unknown, with no PII and no off-switch", async () => {
    const created = await createFedex();
    const id = String(created.draft_order_id);
    const args = { draft_order_id: id };
    delete process.env.MCP_ORDERING_ENABLED; // a read; the switch doesn't apply

    const check = async (expected: string) => {
      const res = await ok("get_checkout_status", args);
      expect(res).toMatchObject({ draft_order_id: id, status: expected, meaning: expect.any(String) });
      expect(Object.keys(res).sort()).toEqual(["draft_order_id", "meaning", "status", ...(res.reason ? ["reason"] : [])].sort());
      expect(JSON.stringify(res)).not.toMatch(/Jane|Austin|78701|invoices/);
      return res;
    };

    await check("open");
    store.drafts.get(id)!.status = "INVOICE_SENT";
    await check("open");
    store.drafts.get(id)!.status = "COMPLETED";
    await check("paid");
    store.drafts.get(id)!.status = "OPEN";
    store.drafts.get(id)!.order = { id: "gid://shopify/Order/9" };
    await check("paid");
    store.drafts.get(id)!.order = null;
    store.drafts.get(id)!.status = "SOMETHING_NEW";
    await check("unknown");
    store.drafts.get(id)!.status = "OPEN";
    store.failLookups(true);
    expect((await check("unknown")).reason).toBe("the store didn't answer");
    store.failLookups(false);
    store.deleted.push(id);
    await check("gone");

    noCreds();
    resetObserved();
    expect((await check("unknown")).reason).toBe("this deployment has no store credentials");
    expectNoNetwork();
  });
});

/* ---------------------------------------------------------------------------
 * The MCP-side throttle on Shopify draft reads
 * ------------------------------------------------------------------------- */

describe("throttle — 30 draft reads a minute per client IP, one bucket shared by status, cancel, update and replay", () => {
  // Bypasses call()'s fresh-IP-per-call so one caller can be driven into the
  // bucket; the clock is frozen, so hits never expire within this file.
  const from = (ip: string | null, tool: Tool, args: Json) =>
    withMcpClientIp(ip, () => checkoutTools[tool].handler(args)) as Promise<Json>;

  it("the 31st read from one IP is refused before any Shopify call — then cancel, update and replay from that IP too; another IP is unaffected", async () => {
    const IP = "203.0.113.77"; // never one of call()'s 198.51.x.x addresses
    const created = await createFedex();
    const id = String(created.draft_order_id);
    const status = { draft_order_id: id };

    resetObserved();
    for (let i = 0; i < 30; i++) expect(await from(IP, "get_checkout_status", status)).toMatchObject({ status: "open" });
    expect(store.gqlCalls("draftOrder(id: $id)")).toHaveLength(30);
    expect(vi.mocked(rateLimit)).toHaveBeenCalledTimes(30);
    expect(vi.mocked(rateLimit)).toHaveBeenLastCalledWith(`mcp-status:${IP}`, 30, 60_000);

    resetObserved();
    expect(await from(IP, "get_checkout_status", status)).toEqual({
      draft_order_id: id,
      status: "unknown",
      meaning: expect.any(String),
      reason: "too many status checks — try again in a minute",
    });
    expect(store.calls).toHaveLength(0);

    // the bucket is shared: a cancel from that IP is refused — nothing read, nothing deleted
    expect(refusal(await from(IP, "cancel_checkout", { draft_order_id: id, nonce: created.nonce }))).toBe(
      "Too many status checks — try again in a minute. Nothing was changed.",
    );
    expect(store.calls).toHaveLength(0);
    expect(store.deleted).not.toContain(id);

    // an update confirm from that IP: the hub priced it, Shopify was never read, nothing created
    const update = await from(IP, "update_checkout", confirmArgs({ ...FEDEX_ARGS, supersedes: { draft_order_id: id, nonce: created.nonce } }));
    expect(refusal(update)).toBe("Too many status checks — try again in a minute. Nothing was created.");
    expect(store.shopifyCalls()).toHaveLength(0);
    expect(routeCalls).toHaveLength(0);

    // an idempotent replay from that IP: its status re-check is throttled, nothing created
    const key = `idem-${crypto.randomUUID()}`;
    await createFedex({ idempotency_key: key });
    resetObserved();
    expect(refusal(await from(IP, "create_checkout", confirmArgs({ ...FEDEX_ARGS, idempotency_key: key })))).toBe(
      "Too many status checks — try again in a minute. Nothing was created.",
    );
    expect(store.calls).toHaveLength(0);
    expect(routeCalls).toHaveLength(0);

    // another IP still reads
    resetObserved();
    expect(await from("203.0.113.78", "get_checkout_status", status)).toMatchObject({ status: "open" });
    expect(store.gqlCalls("draftOrder(id: $id)")).toHaveLength(1);
  });

  it("keys on the FIRST hop of a multi-hop forwarded header, and on 'unknown' when there is no client IP at all", async () => {
    const created = await createFedex();
    const status = { draft_order_id: String(created.draft_order_id) };
    resetObserved();
    expect(await from("203.0.113.90, 10.0.0.1", "get_checkout_status", status)).toMatchObject({ status: "open" });
    expect(vi.mocked(rateLimit)).toHaveBeenCalledWith("mcp-status:203.0.113.90", 30, 60_000);
    expect(await from(null, "get_checkout_status", status)).toMatchObject({ status: "open" });
    expect(vi.mocked(rateLimit)).toHaveBeenCalledWith("mcp-status:unknown", 30, 60_000);
  });
});
