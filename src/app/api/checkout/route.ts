import { randomBytes } from "node:crypto";
import { after, NextResponse } from "next/server";
import {
  catalogUrl,
  HUB_URL,
  resolveBuilderPricing,
  resolveHubGraphics,
  type HubAddon,
  type HubBodyStyle,
  type HubCatalog,
  type HubPrice,
} from "@/lib/hub";
import {
  normalizeHost,
  resolveVariantProfile,
  variantUnresolved,
} from "@/lib/variant";
import {
  addressKey,
  CLASSIC_GRAPHIC,
  fillingAllowsAddon,
  formatAddress,
  resolveFillings,
  type CartLine,
  type DeliveryAddress,
} from "@/lib/flow";
import {
  deliveryIssueAtCheckout,
  formatWindow,
  formatYmd,
  resolveDeliveryConfig,
  uspsWindow,
  type Carrier,
} from "@/lib/delivery";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { ensureOrdersPaidWebhookOnce } from "@/lib/webhooks";
import {
  NONCE_ATTR,
  shopifyCreds,
  shopifyGraphql,
  shopifyTokenScope,
  splitRecipientName,
  supersedeAllowed,
  unpaidBuilderDraft,
  type Attr,
  type GqlResponse,
  type ShopifyCreds,
} from "@/lib/shopify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Several external calls, each with its own deadline (hub 3s, Shopify 10s):
// leave them room to fail FRIENDLY before the platform kills the function
// with a bare 504.
export const maxDuration = 60;

/**
 * Draft-order checkout. The client sends a SELECTION (cart lines + optional
 * payer email), never a price — everything money-related is recomputed here
 * from the hub, and every line is re-validated against the live catalog
 * (style must exist and be in stock). Addresses attach PER LINE; lines are
 * grouped by address and each group becomes its own draft order + invoice
 * (fulfillment: one order = one ship-to = one ShipStation label).
 *
 * Problems come back ALL AT ONCE: `error` is a one-line summary and
 * `lineErrors` ({ lineId, code, message }) names every broken piñata by its
 * design title, so the client can mark each row in one pass.
 *
 * Partial failure: created orders are returned in `createdSoFar` with their
 * address group keys so the client can mark those lines ordered and retry
 * only the remainder — no duplicate orders.
 *
 * Each created draft carries a random `_builderNonce` (returned as `nonce`).
 * A later checkout presenting { draftOrderId, nonce } in `supersedes` deletes
 * that older, still-unpaid draft once its replacement exists.
 *
 * Modes: with SHOPIFY_SHOP + SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET it
 * creates real draft orders; otherwise dry-run. An `email` pre-fills Shopify's
 * contact field; the invoice EMAIL goes out only on an explicit
 * `sendInvoice: true`. The raw draft-order payload is only included outside
 * production.
 */

const MAX_LINES = 20;
const MAX_QTY = 25; // B2C sanity bound; bulk goes through quote/corporate
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
// Hub reads are edge-cached GETs: anything slower is a hub problem, and the
// customer hears "try again shortly" instead of watching a spinner.
const HUB_TIMEOUT_MS = 3_000;
const DRAFT_GID_RE = /^gid:\/\/shopify\/DraftOrder\/\d+$/;
const NONCE_RE = /^[a-f0-9]{32}$/;

// Said whenever Shopify itself can't be reached or answers nonsense — the
// customer gets no internals (those go to the function log).
const STORE_UNREACHABLE =
  "Checkout couldn't reach our store just now — nothing was charged. Please try again in a minute.";

/**
 * The generic "Custom Built Piñatagram" product: one variant per body style,
 * SKU CUSTOM-{BODY}. Paper derives the body style from that SKU exactly like
 * legacy orders (spaces not hyphens — its parser splits on the LAST hyphen),
 * Shopify reporting sees a real product, and the invoice shows its image.
 * A style whose variant doesn't resolve refuses checkout loudly — a custom
 * line item without a SKU would strand the order for Paper.
 */
const CUSTOM_PRODUCT_GID = "gid://shopify/Product/7741496623202";
const SKU_SUFFIX_SPECIAL: Record<string, string> = {
  "white-uni": "WHITE UNICORN",
  "pink-uni": "PINK UNICORN",
};
const customSkuFor = (styleId: string) =>
  `CUSTOM-${SKU_SUFFIX_SPECIAL[styleId] ?? styleId.toUpperCase().replace(/-/g, " ")}`;

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Full Shopify failure to the function log (only ops sees that). Scope
 *  trouble is the #1 setup failure, so "Access denied" also logs what the
 *  cached token actually carries (scope handles are config, not secrets). */
function logGqlFailure(what: string, r: GqlResponse<unknown>): void {
  const raw = JSON.stringify(r.body);
  console.error(`${what} failed (HTTP ${r.status})`, raw);
  if (raw?.includes("Access denied")) {
    console.error(`${what}: token scopes: ${shopifyTokenScope() || "(none)"}`);
  }
}

// Variant ids by SKU, cached for the life of the serverless instance
// (10-minute TTL). Only a real answer is cached: an empty or failed lookup
// cached here would keep refusing orders for ten minutes after the fix.
let variantCache: { at: number; bySku: Map<string, string> } | null = null;

/** null = Shopify unreachable/unreadable (retry); a map missing a SKU = a
 *  config problem the fail-fast check below refuses per piñata. */
async function customVariantsBySku(
  creds: ShopifyCreds,
): Promise<Map<string, string> | null> {
  if (variantCache && Date.now() - variantCache.at < 10 * 60_000) {
    return variantCache.bySku;
  }
  try {
    const r = await shopifyGraphql<{
      product: { variants: { nodes: { id: string; sku: string | null }[] } } | null;
    }>(
      creds,
      `query($id: ID!) {
        product(id: $id) { variants(first: 50) { nodes { id sku } } }
      }`,
      { id: CUSTOM_PRODUCT_GID },
    );
    if (r.status !== 200 || r.errors) {
      logGqlFailure("checkout: custom variant lookup", r);
      return null;
    }
    const bySku = new Map<string, string>();
    for (const n of r.data?.product?.variants?.nodes ?? []) {
      if (n?.sku) bySku.set(n.sku, n.id);
    }
    if (bySku.size) variantCache = { at: Date.now(), bySku };
    return bySku;
  } catch (e) {
    console.error(`checkout: custom variant lookup failed: ${errText(e)}`);
    return null;
  }
}

// Add-on variant ids by SKU (e.g. DOUBLE-FILLING → the real Double Candy
// product). Every active add-on MUST resolve to a live variant — checkout
// refuses orders whose add-on doesn't, rather than degrading into a second
// order shape. A refusal is either transient (retry works) or a config
// error to fix in Shopify admin. Cached per SKU for 10 minutes — answers
// only, never a failed lookup.
const addonVariantCache = new Map<string, { at: number; id: string | null }>();

/** Looks every SKU up in parallel. null = some lookup failed in transit
 *  (retry); a SKU absent from the map = no such variant (config problem). */
async function addonVariantIds(
  creds: ShopifyCreds,
  skus: string[],
): Promise<Map<string, string> | null> {
  const results = await Promise.all(
    skus.map(async (sku): Promise<{ sku: string; id: string | null } | null> => {
      const hit = addonVariantCache.get(sku);
      if (hit && Date.now() - hit.at < 10 * 60_000) return { sku, id: hit.id };
      try {
        const r = await shopifyGraphql<{
          productVariants: { nodes: { id: string; sku: string | null }[] };
        }>(
          creds,
          `query($q: String!) {
            productVariants(first: 5, query: $q) { nodes { id sku } }
          }`,
          { q: `sku:${JSON.stringify(sku)}` },
        );
        if (r.status !== 200 || r.errors) {
          logGqlFailure(`checkout: add-on variant lookup (${sku})`, r);
          return null;
        }
        // The query is a search; only trust an exact SKU match.
        const exact = (r.data?.productVariants?.nodes ?? []).find((n) => n?.sku === sku);
        addonVariantCache.set(sku, { at: Date.now(), id: exact?.id ?? null });
        return { sku, id: exact?.id ?? null };
      } catch (e) {
        console.error(`checkout: add-on variant lookup (${sku}) failed: ${errText(e)}`);
        return null;
      }
    }),
  );
  if (results.some((r) => r === null)) return null;
  const out = new Map<string, string>();
  for (const r of results) if (r?.id) out.set(r.sku, r.id);
  return out;
}

/** GET a hub public endpoint on the money path: no cache layer at all and a
 *  hard deadline. no-store skips the builder's fetch cache, and a unique
 *  query param skips the hub's edge cache (s-maxage up to 5 minutes), so a
 *  price the hub has just published is the price charged. Display pages keep
 *  the cached URLs. null on ANY failure — the caller turns that into a
 *  friendly 503. */
async function hubGet<T>(url: string, what: string): Promise<T | null> {
  try {
    const fresh = `${url}${url.includes("?") ? "&" : "?"}fresh=${Date.now()}`;
    const res = await fetch(fresh, {
      cache: "no-store",
      signal: AbortSignal.timeout(HUB_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`checkout: hub ${what} returned HTTP ${res.status}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (e) {
    console.error(`checkout: hub ${what} failed: ${errText(e)}`);
    return null;
  }
}

type ShippingRule = {
  minSubtotalCents: number;
  // Shopify-native codes can cap the covered rate ("under $X") — null =
  // uncapped (every hub-minted code).
  maxShippingCents: number | null;
};

/**
 * Shopify does NOT discount a draft's custom shippingLine — a valid
 * free-shipping code left a real invoice still charging shipping
 * (2026-07-18). The hub MINTS these codes, so its describe endpoint is the
 * rule's source of truth: when the stack carries an active shipping code,
 * the builder zeroes the shipping line itself (minimum checked against each
 * group's merchandise below). The code still rides on the draft, so Shopify
 * records its redemption at payment. Describe unreachable → the priced line
 * stands (fail toward charging the real rate, never toward giving shipping
 * away). Codes are described in parallel; as before, the LAST qualifying
 * code wins.
 */
async function freeShippingRule(codes: string[]): Promise<ShippingRule | null> {
  const rules = await Promise.all(
    codes.map(async (code): Promise<ShippingRule | null> => {
      try {
        const r = await fetch(
          `${HUB_URL}/api/public/discount?code=${encodeURIComponent(code)}`,
          { cache: "no-store", signal: AbortSignal.timeout(HUB_TIMEOUT_MS) },
        );
        if (!r.ok) return null;
        const d = (await r.json())?.discount as {
          kind?: string;
          minSubtotalCents?: number;
          freeShipping?: boolean;
          maxShippingCents?: number;
        } | null;
        // kind "shipping" OR a paired order code flagged freeShipping — either
        // way the hub says this stack rides free.
        if (d?.kind === "shipping" || d?.freeShipping === true) {
          return {
            minSubtotalCents: Number(d.minSubtotalCents) || 0,
            maxShippingCents:
              typeof d.maxShippingCents === "number" && d.maxShippingCents > 0
                ? d.maxShippingCents
                : null,
          };
        }
        return null;
      } catch (e) {
        // hub blip → no free shipping from this code; never throw here
        console.error(`checkout: discount describe failed: ${errText(e)}`);
        return null;
      }
    }),
  );
  return rules.reduce<ShippingRule | null>((acc, r) => r ?? acc, null);
}

const ART_RE = /^https:\/\/cdn\.shopify\.com\//;
// The builder's OWN Blob store, exact host — a tampered client can't point
// _frontGraphic at some other Vercel customer's blob, and Paper allowlists
// this same hostname (full equality) before snapshotting art at ingest.
const BLOB_RE =
  /^https:\/\/yrfds6n4iwscziqm\.public\.blob\.vercel-storage\.com\//;
const DESIGN_RE = /^[A-Z0-9]{2,24}$/;
// Lowercase hex sha256 of the uploaded print bytes, computed by the editor
// at save time. Required for blob-hosted art: Paper re-hashes the blob it
// downloads and refuses a mismatch, so the bytes staged in the transient
// store can't change between save and snapshot.
const SHA256_RE = /^[a-f0-9]{64}$/;

type CheckoutBody = {
  lines: CartLine[];
  // Optional payer email: pre-fills Shopify's contact field (and the order
  // confirmation goes there once paid). It never sends an invoice by itself.
  email?: string;
  // Explicit opt-in to Shopify's invoice email (corporate / pay-later flows).
  sendInvoice?: boolean;
  // Up to two native codes stack on the one draft (one order + one shipping);
  // `discountCode` kept for older cart clients mid-deploy.
  discountCode?: string;
  discountCodes?: string[];
  // Visit ids that join the order back to its session (PostHog, GA, Meta).
  // Advisory: validated, then written as order-level custom attributes.
  analytics?: {
    phDistinctId?: string;
    phSessionId?: string;
    gaClientId?: string;
    fbp?: string;
    fbc?: string;
  };
  // The unpaid draft this checkout replaces (the client's pending record).
  supersedes?: { draftOrderId?: string; nonce?: string };
  // NON-PRODUCTION ONLY: preview a variant by name so local/preview builds
  // can exercise any profile's checkout. Production ignores it completely —
  // there the variant comes from this request's own Host, full stop.
  previewVariant?: string;
};

type LineError = { lineId: string; code: string; message: string };
type AttributeInput = { key: string; value: string };

function bad(error: string): NextResponse {
  return NextResponse.json({ error }, { status: 400 });
}

/** Every line problem at once: `error` summarizes in one line (a client that
 *  only knows `error` still shows something useful), `lineErrors` lets the
 *  client mark each piñata. */
function lineFail(problems: LineError[], status = 400): NextResponse {
  const error =
    problems.length === 1
      ? problems[0].message
      : `${problems.length} things need fixing before checkout. ${problems[0].message}`;
  return NextResponse.json({ error, lineErrors: problems }, { status });
}

function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.slice(0, max).trim() : "";
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "a", "a and b", "a, b and c". */
function listWords(items: string[]): string {
  return items.length <= 1
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

// Required address parts, in customer words.
const ADDRESS_PARTS: [keyof DeliveryAddress, string][] = [
  ["name", "the recipient's name"],
  ["address1", "the street address"],
  ["city", "the city"],
  ["province", "the state"],
  ["zip", "the ZIP code"],
];

/** The line's cleaned address, or which required parts are missing. */
function cleanAddress(
  a: unknown,
): { address: DeliveryAddress } | { missing: string[] } {
  const o = (a && typeof a === "object" ? a : {}) as Record<string, unknown>;
  const out: DeliveryAddress = {
    name: str(o.name, 80),
    address1: str(o.address1, 120),
    address2: str(o.address2, 120),
    city: str(o.city, 60),
    province: str(o.province, 40),
    zip: str(o.zip, 16),
    phone: str(o.phone, 24),
  };
  const missing = ADDRESS_PARTS.filter(([k]) => !out[k]).map(([, label]) => label);
  return missing.length ? { missing } : { address: out };
}

/** How the customer knows this piñata: the design title its cart row shows,
 *  plus the body style so two of the same design stay distinct. Hub-graphic
 *  titles are INTERNAL, so those read "Your graphic" — never the hub name. */
function pinataName(l: CartLine | undefined, styleName: string): string {
  const g = l?.graphic;
  const title =
    g?.type === "custom"
      ? "Your design"
      : g?.type === "hub"
        ? "Your graphic"
        : (g?.type === "shopify" && str(g.title, 60)) || "Your piñata";
  return styleName ? `${title} (${styleName})` : title;
}

// Visit ids → order-level attribute keys, each with its length cap. Values
// are opaque ids: printable ASCII, no spaces. Anything malformed or
// oversized is DROPPED, never truncated — a clipped id joins nothing.
const ANALYTICS_FIELDS = [
  ["phDistinctId", "_phDistinctId", 200],
  ["phSessionId", "_phSessionId", 100],
  ["gaClientId", "_gaClientId", 100],
  ["fbp", "_fbp", 200],
  ["fbc", "_fbc", 500],
] as const;
const ANALYTICS_VALUE_RE = /^[\x21-\x7e]+$/;

function analyticsAttributes(raw: unknown): AttributeInput[] {
  if (!raw || typeof raw !== "object") return [];
  const o = raw as Record<string, unknown>;
  const out: AttributeInput[] = [];
  for (const [field, key, max] of ANALYTICS_FIELDS) {
    const v = typeof o[field] === "string" ? (o[field] as string).trim() : "";
    if (v && v.length <= max && ANALYTICS_VALUE_RE.test(v)) out.push({ key, value: v });
  }
  return out;
}

function cleanSupersedes(raw: unknown): { draftOrderId: string; nonce: string } | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const draftOrderId = str(o.draftOrderId, 80);
  const nonce = str(o.nonce, 64).toLowerCase();
  return DRAFT_GID_RE.test(draftOrderId) && NONCE_RE.test(nonce)
    ? { draftOrderId, nonce }
    : null;
}

/**
 * Best-effort, AFTER the replacement exists: delete the unpaid draft a
 * re-checkout superseded, so a stale invoice can't be paid alongside the new
 * one. Deletes ONLY an unpaid builder draft whose stored nonce matches what
 * the client presented; anything else is left alone. Never throws — the
 * outcome goes to the function log, and the checkout never waits on it.
 */
async function retireSupersededDraft(
  creds: ShopifyCreds,
  s: { draftOrderId: string; nonce: string },
): Promise<void> {
  const what = `checkout: supersede ${s.draftOrderId}`;
  try {
    const r = await shopifyGraphql<{
      draftOrder: {
        status: string;
        tags: string[];
        order: { id: string } | null;
        customAttributes: Attr[];
      } | null;
    }>(
      creds,
      `query($id: ID!) {
        draftOrder(id: $id) { status tags order { id } customAttributes { key value } }
      }`,
      { id: s.draftOrderId },
    );
    if (r.status !== 200 || r.errors || !r.data) {
      logGqlFailure(`${what} lookup`, r);
      return;
    }
    const d = r.data.draftOrder;
    if (!d) {
      console.log(`${what}: already gone`);
      return;
    }
    if (!supersedeAllowed(d, s.nonce)) {
      console.log(
        `${what}: kept — ${
          unpaidBuilderDraft(d)
            ? "nonce mismatch"
            : `not an unpaid builder draft (status ${d.status}${d.order ? ", has an order" : ""})`
        }`,
      );
      return;
    }
    const del = await shopifyGraphql<{
      draftOrderDelete: { deletedId: string | null; userErrors: unknown[] } | null;
    }>(
      creds,
      `mutation($input: DraftOrderDeleteInput!) {
        draftOrderDelete(input: $input) { deletedId userErrors { field message } }
      }`,
      { input: { id: s.draftOrderId } },
    );
    const out = del.data?.draftOrderDelete;
    if (del.status === 200 && !del.errors && out?.deletedId && !out.userErrors?.length) {
      console.log(`${what}: deleted`);
    } else {
      logGqlFailure(`${what} delete`, del);
    }
  } catch (e) {
    console.error(`${what}: ${errText(e)}`);
  }
}

export async function POST(req: Request) {
  // Draft orders write into Shopify — keep bots from spamming them.
  if (!rateLimit(`checkout:${clientIp(req)}`, 6, 60_000)) {
    return NextResponse.json(
      { error: "Too many checkout attempts — give it a minute and try again." },
      { status: 429 },
    );
  }

  let body: CheckoutBody;
  try {
    body = await req.json();
  } catch (e) {
    console.error(`checkout: unreadable request body: ${errText(e)}`);
    return bad("We couldn't read your cart — refresh the page and try again.");
  }

  // Email is OPTIONAL: consumers go straight to Shopify's payment page,
  // which collects contact info itself. When present it goes on the draft so
  // Shopify pre-fills the contact field. The invoice EMAIL is a separate,
  // explicit opt-in (sendInvoice) — a typed address alone never mails one.
  const email = str(body?.email, 120);
  if (email && !EMAIL_RE.test(email)) return bad("That email doesn't look right.");
  const sendInvoice = body?.sendInvoice === true;
  const analyticsAttrs = analyticsAttributes(body?.analytics);
  const supersedes = cleanSupersedes(body?.supersedes);
  const rawLines = body?.lines;
  if (!Array.isArray(rawLines) || rawLines.length === 0)
    return bad("Cart is empty.");
  if (rawLines.length > MAX_LINES)
    return bad(`That's a lot of piñatas — the builder caps at ${MAX_LINES} lines. For bulk orders use the quote form.`);

  // The variant profile is resolved from THIS REQUEST'S OWN Host — Vercel
  // only routes hostnames attached to the project, so the profile that
  // prices this order is provably the one whose storefront the customer
  // used. (?previewVariant rides only outside production, for local tests.)
  const reqHost = normalizeHost(req.headers.get("host"));
  const previewVariant =
    process.env.VERCEL_ENV !== "production" && typeof body?.previewVariant === "string"
      ? body.previewVariant
      : null;

  // ONE carrier per order (one draft = one shipping line; Paper branches its
  // fulfill-date math on that line's title). The client re-stamps every cart
  // line on add-to-cart, so a mix here means a tampered or half-migrated
  // cart — refuse loudly rather than guess which speed the customer paid for.
  const carriers = new Set<Carrier>(
    rawLines.map((l: CartLine) => (l?.carrier === "usps" ? "usps" : "fedex")),
  );
  if (carriers.size > 1) {
    return bad(
      "One delivery speed per order — open your cart, re-save a piñata to apply one carrier to everything, and try again.",
    );
  }
  const orderCarrier: Carrier = carriers.has("usps") ? "usps" : "fedex";

  // Optional discount code: pass the raw code to Shopify as a NATIVE code on
  // the draft (DraftOrderInput.discountCodes). Shopify enforces the whole
  // rule — value, minimum, usage limit, once-per-customer, expiry, free
  // shipping — and SKIPS the code if it's not eligible, so a bad/expired/
  // exhausted code never blocks checkout; the customer just sees the true
  // total on the invoice. We only send it (never an amount), so it can't be
  // tampered into a discount the merchant didn't configure.
  // One order code + one shipping code may stack on the single draft. Accept
  // the array (new clients) or the legacy single field, uppercase + validate
  // each, dedupe, and cap at two so a tampered body can't spray codes. Shopify
  // enforces eligibility AND the combinesWith rule — it applies both only if
  // they're allowed to stack, and silently skips any it can't honor.
  const rawCodes = Array.isArray(body?.discountCodes)
    ? body!.discountCodes!
    : body?.discountCode != null
      ? [body.discountCode]
      : [];
  // Allow the characters Shopify codes actually use — the store's legacy
  // codes include # ("#pinatasearch2016") and Shopify permits spaces — up to
  // Shopify's length. A stricter filter than the client's would silently
  // strip a real code that previewed a discount in the cart.
  const discountCodes = [
    ...new Set(
      rawCodes
        .map((c) => str(c, 64).toUpperCase())
        .filter((c) => /^[A-Z0-9 _#-]{2,64}$/.test(c)),
    ),
  ].slice(0, 2);

  // Pre-flight, all at once — none of these depend on each other: the live
  // catalog, the unit price, each discount's free-shipping rule, and (live
  // mode) the Shopify variant map. None of the promises can reject, so an
  // early return below never strands an unhandled failure.
  const creds = shopifyCreds();
  const catalogP = hubGet<HubCatalog>(
    catalogUrl({ host: reqHost, previewVariant }),
    "catalog",
  );
  const priceP = hubGet<HubPrice>(
    `${HUB_URL}/api/public/price?qty=1&fill=filled&bodyType=standard&graphicType=custom&mode=individual&carrier=standard`,
    "price",
  );
  const shippingRuleP = freeShippingRule(discountCodes);
  const customVariantsP = creds ? customVariantsBySku(creds) : Promise.resolve(null);

  // Live catalog: styles must exist and be in stock at order time. Money
  // path = NO builder-side cache — the hub's edge cache is the only layer,
  // so a config edit (price knob, folder grant, variant flip) can't serve
  // a stale charge from a second stacked cache.
  const catalog = await catalogP;
  if (!catalog || !Array.isArray(catalog.bodyStyles)) {
    return NextResponse.json(
      { error: "The catalog is unavailable right now — try again shortly." },
      { status: 503 },
    );
  }
  const styleById = new Map(catalog.bodyStyles.map((s) => [s.id, s]));
  const deliveryCfg = resolveDeliveryConfig(catalog.delivery);
  // Graphic-tier upcharges + USPS rate — hub-controlled, re-read at order
  // time exactly like fillings/add-ons. The client's display math ran the
  // same resolver; the numbers here are authoritative.
  const pricing = resolveBuilderPricing(catalog.pricing);
  // The storefront's variant profile: flat variants price every graphic the
  // same; carriers gate USPS. Same resolver as the pages — display = invoice.
  const variant = resolveVariantProfile(catalog.variant);
  const tiered = variant.pricing === "tiered";
  const uspsOffered = variant.carriers.includes("usps");

  // Backstop for the cart's self-heal: a USPS cart can't check out on a
  // storefront that doesn't offer USPS (profile changed mid-sitting).
  if (orderCarrier === "usps" && !uspsOffered) {
    return bad(
      "USPS isn't offered on this store — open your cart (shipping updates to FedEx automatically) and try again.",
    );
  }
  // Add-ons re-resolve from the live catalog: the client sends ids only,
  // labels + prices come from the hub at order time.
  const addonById = new Map((catalog.addons ?? []).map((a) => [a.id, a]));
  // Fillings too: label → record (price delta + allowed-add-ons rule).
  const fillingByLabel = new Map(
    resolveFillings(catalog.fillings).map((f) => [f.label, f]),
  );
  // Hub-uploaded graphics, by design code. Art + sha are AUTHORITATIVE from
  // this catalog — the client's copy is display-only, so a tampered cart
  // can't point the printer at foreign art or dodge the fingerprint.
  const hubGraphicByDesign = new Map(
    resolveHubGraphics(catalog.hubGraphics).map((g) => [g.design, g]),
  );

  type CleanLine = {
    // The client's cart-line id (lineErrors key) + the customer's name for
    // this piñata (problem messages).
    lineId: string;
    name: string;
    title: string;
    qty: number;
    styleId: string;
    styleName: string;
    design: string;
    frontGraphic: string;
    frontGraphicSha256: string;
    designJson: string;
    filling: string;
    fillingCents: number;
    // Customer-visible "Graphic" attribute on the invoice — hub-graphic
    // titles are internal, so their lines show a generic label.
    graphicAttr: string;
    // Version-B graphic tier upcharge (0 = the Classic branded default).
    tierCents: number;
    addons: HubAddon[];
    deliveryDate: string;
    // USPS only: the promised arrival window ("start..end" + display label).
    window: { start: string; end: string } | null;
    message: string;
    address: DeliveryAddress;
  };

  type GraphicProblem = { ok: false; code: string; message: string };
  type GraphicPick = {
    ok: true;
    design: string;
    frontGraphic: string;
    frontGraphicSha256: string;
    designJson: string;
    title: string;
    graphicAttr: string;
    tierCents: number;
  };

  // The line's graphic, re-validated and priced — or why it can't be sold.
  const resolveGraphic = (
    l: CartLine,
    style: HubBodyStyle | undefined,
  ): GraphicPick | GraphicProblem => {
    const g = l?.graphic;
    const styleName = style?.name ?? "";
    if (g?.type === "shopify") {
      const design = str(g.design, 24).toUpperCase();
      const art = str(g.art, 500);
      if (!DESIGN_RE.test(design) || !ART_RE.test(art))
        return {
          ok: false,
          code: "graphic_invalid",
          message: "we couldn't read its graphic — edit the piñata and pick the graphic again.",
        };
      const title = `${str(g.title, 120) || design} — ${styleName}`;
      return {
        ok: true,
        design,
        frontGraphic: art,
        frontGraphicSha256: "",
        designJson: "",
        title,
        graphicAttr: title,
        // Tier by design code: the Classic branded default rides free, any
        // other library pick carries the upcharge. Flat variants price every
        // graphic the same. (A tampered cart claiming the Classic code with
        // someone else's art dodges at most the ~$2 library tier — same
        // exposure class as spoofing the line title.)
        tierCents: !tiered
          ? 0
          : design === CLASSIC_GRAPHIC.design
            ? 0
            : pricing.graphicLibraryUpchargeCents,
      };
    }
    if (g?.type === "hub") {
      // Hub-uploaded graphic (admin /catalog): re-resolve EVERYTHING by
      // design code from the live catalog fetched above.
      const design = str(g.design, 24).toUpperCase();
      const hub = hubGraphicByDesign.get(design);
      if (!hub)
        return {
          ok: false,
          code: "graphic_unavailable",
          message: "that graphic is no longer available — edit the piñata and pick another.",
        };
      if (style && hub.bodyStyles !== "all" && !hub.bodyStyles.includes(style.id)) {
        // Hub titles are INTERNAL: the customer hears "that graphic"; the
        // title goes to the log for ops.
        console.error(
          `checkout: hub graphic ${design} ("${hub.title}") isn't offered on body ${style.id}`,
        );
        return {
          ok: false,
          code: "graphic_style_mismatch",
          message: `that graphic isn't offered on the ${style.name} body — swap the body style or the graphic.`,
        };
      }
      // The hub validated these at upload; a malformed row here is hub-side
      // corruption — refuse loudly rather than strand an unprintable order.
      if (!BLOB_RE.test(hub.art) || !SHA256_RE.test(hub.artSha256)) {
        console.error(
          `checkout: hub graphic ${design} has malformed art/sha in the catalog`,
        );
        return {
          ok: false,
          code: "graphic_unavailable",
          message: "that graphic can't be sold right now — pick another.",
        };
      }
      return {
        ok: true,
        design,
        frontGraphic: hub.art,
        frontGraphicSha256: hub.artSha256,
        designJson: "",
        // Hub titles are INTERNAL — the invoice shows a generic line; Paper
        // and support identify the design via _design (the H-code) + hub UI.
        title: `Piñatagram — ${styleName}`,
        graphicAttr: "Your selected graphic",
        // Prices exactly like a Shopify library pick.
        tierCents: tiered ? pricing.graphicLibraryUpchargeCents : 0,
      };
    }
    if (g?.type === "custom") {
      // Storefront rule, enforced where the money is: a no-custom variant
      // refuses custom lines even from a tampered or stale cart.
      if (!variant.allowCustom)
        return {
          ok: false,
          code: "custom_not_offered",
          message: "custom designs aren't offered on this store — pick a graphic instead.",
        };
      // The flattened print file the editor uploaded to Blob; Paper prints
      // from this URL. No placeholder path: an order with unprintable art
      // is refused HERE, not discovered at print time.
      const art = str(g.art, 500);
      if (!BLOB_RE.test(art))
        return {
          ok: false,
          code: "design_not_saved",
          message: `the design hasn't finished saving — give it a few seconds and try again (or edit the piñata, open Edit graphic, and press "Use this design" to re-save).`,
        };
      // Blob art without its save-time hash can't be integrity-checked by
      // Paper, so it can't be sold. Only carts saved before the hash
      // existed hit this; a re-save re-uploads and stamps it.
      const sha = str(g.artSha256, 64).toLowerCase();
      if (!SHA256_RE.test(sha))
        return {
          ok: false,
          code: "design_needs_resave",
          // "Use this design" is the only action that re-exports + re-hashes;
          // "Looks good" merely navigates. Point at the button that heals.
          message: `this design was saved before a recent update — edit the piñata, open Edit graphic, press "Use this design", then try again.`,
        };
      const sidecar = str(g.designUrl, 500);
      return {
        ok: true,
        design: "custom",
        frontGraphic: art,
        frontGraphicSha256: sha,
        designJson: BLOB_RE.test(sidecar) ? sidecar : "",
        title: `Custom Piñatagram — ${styleName}`,
        graphicAttr: "Your custom design",
        tierCents: tiered ? pricing.graphicCustomUpchargeCents : 0,
      };
    }
    return { ok: false, code: "graphic_missing", message: "pick or design a graphic." };
  };

  // Validate EVERY line and collect EVERY problem — the customer fixes the
  // whole cart in one pass instead of one refusal per attempt.
  const lines: CleanLine[] = [];
  const problems: LineError[] = [];
  for (let i = 0; i < rawLines.length; i++) {
    const l = rawLines[i] as CartLine;
    const lineId =
      typeof l?.id === "string" && l.id.trim() ? l.id.trim().slice(0, 64) : `line-${i + 1}`;
    const style = typeof l?.styleId === "string" ? styleById.get(l.styleId) : undefined;
    const name = pinataName(l, style?.name ?? str(l?.styleName, 40));
    const found: LineError[] = [];
    const flag = (code: string, message: string) =>
      found.push({ lineId, code, message: `${name}: ${cap(message)}` });

    if (!style) flag("style_unavailable", "that body style no longer exists — remove it and pick another.");
    else if (!style.inStock)
      flag("style_out_of_stock", `the ${style.name} body is out of stock right now — swap its style and try again.`);
    if (!Number.isInteger(l?.qty) || l.qty < 1 || l.qty > MAX_QTY)
      flag("quantity_invalid", `quantity must be between 1 and ${MAX_QTY}.`);
    const fillingRec = fillingByLabel.get(String(l?.filling ?? ""));
    if (!fillingRec)
      flag(
        "filling_unavailable",
        l?.filling
          ? "that filling isn't available anymore — edit the piñata and pick another."
          : "pick a filling.",
      );
    const addonIds = Array.isArray(l?.addons) ? [...new Set(l.addons)] : [];
    const addons = addonIds.map((id) => addonById.get(String(id)));
    if (addons.some((a) => !a)) {
      flag("addon_unavailable", "one of its add-ons is no longer available — edit the piñata and re-pick.");
    } else if (fillingRec) {
      // The filling's rule, enforced server-side: a stale client can't sneak
      // an add-on into a filling that doesn't allow it (e.g. Realsy Dates).
      const blocked = addons.find((a) => !fillingAllowsAddon(fillingRec, a!.id));
      if (blocked)
        flag(
          "addon_not_allowed",
          `${blocked.label} isn't available with ${fillingRec.label} — edit the piñata and try again.`,
        );
    }
    const deliveryDate = String(l?.deliveryDate ?? "");
    const dateIssue = deliveryIssueAtCheckout(deliveryDate, deliveryCfg, orderCarrier);
    if (dateIssue) flag(dateIssue.code, dateIssue.message);
    const addr = cleanAddress(l?.address);
    if ("missing" in addr)
      flag(
        "address_incomplete",
        addr.missing.length === ADDRESS_PARTS.length
          ? "add a delivery address."
          : `the delivery address is missing ${listWords(addr.missing)}.`,
      );
    const graphic = resolveGraphic(l, style);
    if (!graphic.ok) flag(graphic.code, graphic.message);

    if (found.length || !style || !fillingRec || !graphic.ok || "missing" in addr) {
      problems.push(...found);
      continue;
    }
    lines.push({
      lineId,
      name,
      title: graphic.title,
      qty: l.qty,
      styleId: style.id,
      styleName: style.name,
      design: graphic.design,
      frontGraphic: graphic.frontGraphic,
      frontGraphicSha256: graphic.frontGraphicSha256,
      designJson: graphic.designJson,
      filling: fillingRec.label,
      fillingCents: fillingRec.priceCents,
      graphicAttr: graphic.graphicAttr,
      tierCents: graphic.tierCents,
      addons: addons as HubAddon[],
      deliveryDate,
      window:
        orderCarrier === "usps"
          ? uspsWindow(deliveryDate, deliveryCfg)
          : null,
      message: str(l.message, 300),
      address: addr.address,
    });
  }
  if (problems.length) return lineFail(problems);

  // Server-side price: single-destination B2C — per-unit product + shipping.
  // Same no-stacked-cache rule as the catalog: this number becomes a charge.
  const price = await priceP;
  // Never sell at zero — a misconfigured pricing table must fail loudly.
  if (
    !price ||
    !Number.isFinite(price.unitPriceCents) ||
    price.unitPriceCents <= 0 ||
    !Number.isFinite(price.shipPerUnitCents) ||
    price.shipPerUnitCents < 0
  ) {
    return NextResponse.json(
      { error: "Pricing is unavailable right now — try again shortly." },
      { status: 503 },
    );
  }
  // ONE order shape, exactly like legacy storefront orders: piñata lines at
  // retail (+ the graphic tier's upcharge + the filling's price delta — both
  // are what the piñata IS, so they price into the line), each add-on as its
  // own aggregated product line (money + sales reporting), while WHICH piñata
  // gets it stays on that piñata line's _addons attribute (the packer's map).
  const lineUnit = (l: CleanLine) =>
    ((price.unitPriceCents + l.tierCents + l.fillingCents) / 100).toFixed(2);
  // Shipping rate by the order's carrier: FedEx comes from the price API
  // (builder.shipPerUnitCents), USPS from the catalog's pricing block.
  const shipRateCents =
    orderCarrier === "usps"
      ? pricing.uspsShipPerUnitCents
      : price.shipPerUnitCents;

  // The revenue-attribution tag (search Shopify by tag = revenue per
  // variant). A host the registry didn't recognize is tagged LOUDLY as
  // unresolved — never silently pooled into variant-default; a malformed
  // name is dropped (a comma would split the tag Shopify searches by).
  let variantTag: string | null;
  if (variantUnresolved(variant.resolvedVia, reqHost)) {
    variantTag = "variant-unresolved";
    console.error(
      `checkout: host "${reqHost}" matched no variant profile — order tagged variant-unresolved. Check hub /pricing → Builder variants.`,
    );
  } else if (/^[a-z0-9-]{1,32}$/.test(variant.name)) {
    variantTag = `variant-${variant.name}`;
  } else {
    variantTag = null;
    console.error(`checkout: malformed variant name ${JSON.stringify(variant.name)} — tag dropped.`);
  }
  const addonTotals = (groupLines: CleanLine[]) => {
    const units = new Map<string, { addon: HubAddon; qty: number }>();
    for (const l of groupLines)
      for (const a of l.addons)
        units.set(a.id, { addon: a, qty: (units.get(a.id)?.qty ?? 0) + l.qty });
    return [...units.values()];
  };

  // One draft order per delivery address (ShipStation: one order = one label).
  const groups = new Map<string, CleanLine[]>();
  for (const l of lines) {
    const key = addressKey(l.address);
    groups.set(key, [...(groups.get(key) ?? []), l]);
  }

  const shippingRule = await shippingRuleP;

  const lineAttributes = (l: CleanLine): AttributeInput[] => [
    // No leading underscore = SHOWS on the payment page under the line
    // title — the customer sees their choices while paying. (The line title
    // is the generic product's, so the graphic is named here.)
    {
      key: "Graphic",
      value: l.graphicAttr,
    },
    { key: "Body style", value: l.styleName },
    { key: "Filling", value: l.filling },
    ...(l.addons.length
      ? [{ key: "Add-ons", value: l.addons.map((a) => a.label).join(", ") }]
      : []),
    // The arrival promise, visible on every line: FedEx = the exact
    // guaranteed day ("Thu, Oct 1"); USPS = the promised WINDOW, this line's
    // actual terms. The shipping line's title is Paper's branch key and stays
    // untouched; the machine date rides hidden on _requestedDate below.
    {
      key: "Arrives",
      value: l.window ? formatWindow(l.window) : formatYmd(l.deliveryDate),
    },
    // Underscored = hidden machine rails Paper reads at fulfillment.
    { key: "_bodyStyle", value: l.styleId },
    { key: "_design", value: l.design },
    { key: "_frontGraphic", value: l.frontGraphic },
    // Only blob-hosted custom art carries a hash; library picks are
    // first-party cdn.shopify.com files Paper snapshots without one.
    ...(l.frontGraphicSha256
      ? [{ key: "_frontGraphicSha256", value: l.frontGraphicSha256 }]
      : []),
    ...(l.designJson ? [{ key: "_designJson", value: l.designJson }] : []),
    { key: "_fillings", value: l.filling },
    // Comma-separated labels — exactly how Paper splits _addons. This stays
    // on the piñata line even when the add-on charges as its own product
    // line: it's the per-piñata mapping the packer works from.
    ...(l.addons.length
      ? [{ key: "_addons", value: l.addons.map((a) => a.label).join(", ") }]
      : []),
    { key: "_requestedDate", value: l.deliveryDate },
    // Carrier rails for Paper's coming USPS release: the order's carrier on
    // every line, plus the promised window (target date stays on
    // _requestedDate — Paper's scheduling anchor is unchanged). _carrier is
    // emitted only when the variant OFFERS a carrier choice (FedEx-only
    // storefronts keep their pre-variant rails).
    ...(uspsOffered ? [{ key: "_carrier", value: orderCarrier }] : []),
    ...(l.window
      ? [{ key: "_requestedWindow", value: `${l.window.start}..${l.window.end}` }]
      : []),
    ...(l.message ? [{ key: "message", value: l.message }] : []),
  ];

  // Dry-run payload only (no Shopify creds to resolve variants): plain
  // custom line items mirroring the real structure — piñata at retail plus
  // one line per add-on.
  const customLine = (l: CleanLine) => ({
    title: l.title,
    originalUnitPrice: lineUnit(l),
    quantity: l.qty,
    requiresShipping: true,
    customAttributes: lineAttributes(l),
  });

  const draftOrders = [...groups.entries()].map(([groupKey, groupLines]) => {
    const a = groupLines[0].address;
    const units = groupLines.reduce((s, l) => s + l.qty, 0);
    // Per-draft secret: a later checkout may delete this draft only by
    // presenting it (see supersedes) — never on a draft id alone.
    const nonce = randomBytes(16).toString("hex");
    // Free shipping only when the group's merchandise clears the code's own
    // minimum — the same gate the cart preview shows.
    const merchandiseCents =
      groupLines.reduce(
        (s, l) =>
          s + (price.unitPriceCents + l.tierCents + l.fillingCents) * l.qty,
        0,
      ) +
      addonTotals(groupLines).reduce(
        (s, { addon, qty }) => s + addon.priceCents * qty,
        0,
      );
    const freeShip =
      shippingRule !== null &&
      merchandiseCents >= shippingRule.minSubtotalCents &&
      // capped code: covers this group only when its rate is strictly under
      // the cap (Shopify's "applies to shipping rates under $X")
      (shippingRule.maxShippingCents === null ||
        shipRateCents * units < shippingRule.maxShippingCents);
    return {
      groupKey,
      shipTo: formatAddress(a),
      nonce,
      lines: groupLines,
      input: {
        // Pre-fills Shopify's contact field; never mails an invoice by itself.
        ...(email ? { email } : {}),
        // Native code (Shopify enforces the rule). allowDiscountCodesInCheckout
        // false = the customer can't stack extra codes on the hosted invoice.
        ...(discountCodes.length
          ? { discountCodes, allowDiscountCodesInCheckout: false }
          : {}),
        tags: variantTag ? ["builder", variantTag] : ["builder"],
        // Forensics: which storefront sold this, under which profile shape,
        // priced from which catalog snapshot — orders self-document their
        // config epoch (a mid-test knob edit is visible per order). Then the
        // supersede nonce, and the visit ids that join this order to its
        // analytics session (PostHog / GA / Meta).
        //
        // ⚠ NEVER put this on the order NOTE. Paper falls back to the order
        // note when a line carries no `message` attribute (findItemMessage in
        // apps/paper/src/features/orders/utils.ts), so a note here gets
        // PRINTED as the recipient's message on no-message piñatas. Order
        // custom attributes are outside that fallback and still survive the
        // draft → order completion (metafields on a draft order do not).
        // Underscore keys keep them out of customer-facing surfaces.
        customAttributes: [
          { key: "_builderHost", value: reqHost || "unknown-host" },
          {
            key: "_builderVariant",
            value: `${variant.name} (${variant.pricing}/${variant.carriers.join("+")})`,
          },
          { key: "_builderCatalog", value: catalog.asOf || "unknown" },
          { key: NONCE_ATTR, value: nonce },
          ...analyticsAttrs,
        ],
        shippingAddress: {
          // One-word names ride as lastName only ("Grandma", not
          // "Grandma Grandma").
          ...splitRecipientName(a.name),
          address1: a.address1,
          address2: a.address2 || null,
          city: a.city,
          province: a.province,
          zip: a.zip,
          countryCode: "US",
          phone: a.phone || null,
        },
        shippingLine: {
          // ⚠ The leading word "Guaranteed" is LOAD-BEARING: Paper's
          // fulfill-date logic branches on it (startsWith "guaranteed" →
          // ship 2 business days before the requested date, the FedEx
          // 2-Day math; anything else → the 5-day standard-shipping lead).
          // FedEx IS the guaranteed-date service, so its title keeps the
          // prefix. USPS deliberately does NOT start with it — Paper's
          // standard lead (~5 days before the requested date) is exactly
          // First Class's schedule, so USPS orders route correctly today
          // with zero Paper changes. Verify both branches in the Paper
          // release before advertising USPS.
          title:
            orderCarrier === "usps"
              ? freeShip
                ? "USPS First Class — arrives around your selected dates — free shipping"
                : "USPS First Class — arrives around your selected dates"
              : freeShip
                ? "Guaranteed delivery on your selected dates — free shipping"
                : "Guaranteed delivery on your selected dates",
          // priceWithCurrency replaces the deprecated ShippingLineInput.price.
          priceWithCurrency: {
            amount: freeShip ? "0.00" : ((shipRateCents * units) / 100).toFixed(2),
            currencyCode: "USD",
          },
        },
        lineItems: [
          ...groupLines.map((l) => customLine(l)),
          ...addonTotals(groupLines).map(({ addon, qty }) => ({
            title: addon.label,
            originalUnitPrice: (addon.priceCents / 100).toFixed(2),
            quantity: qty,
            requiresShipping: true,
          })),
        ] as unknown[],
      },
    };
  });

  if (!creds) {
    const isProd = process.env.VERCEL_ENV === "production";
    return NextResponse.json({
      dryRun: true,
      reason: isProd
        ? "Checkout isn't taking live orders quite yet — your cart is saved and nothing was charged."
        : "Shopify credentials aren't configured (needs SHOPIFY_SHOP, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET). This is exactly what would be sent:",
      // The raw payload is a debugging tool, not customer content.
      draftOrders: isProd
        ? draftOrders.map(({ groupKey, shipTo }) => ({ groupKey, shipTo }))
        : draftOrders,
      // What the live path would also do with this request (debug only).
      ...(isProd ? {} : { invoiceEmail: sendInvoice && !!email, supersedes }),
    });
  }

  // Attach each line to the generic Custom Built Piñatagram variant for its
  // body style (real SKU → Paper parses the body like any legacy order; the
  // product image shows on the invoice). priceOverride keeps the hub's
  // price authoritative.
  const variantBySku = await customVariantsP;
  const addonSkus = [
    ...new Set(
      lines.flatMap((l) =>
        l.addons.map((a) => a.sku).filter((s): s is string => !!s),
      ),
    ),
  ];
  const addonVariants = variantBySku ? await addonVariantIds(creds, addonSkus) : null;
  if (!variantBySku || !addonVariants) {
    return NextResponse.json({ error: STORE_UNREACHABLE }, { status: 502 });
  }

  // Fail-fast BEFORE creating anything: every piñata must attach to its
  // CUSTOM-{BODY} variant and every add-on to its own product's variant.
  // A miss is a config error (deleted variant, SKU typo) — refuse loudly,
  // naming every affected piñata; a silent fallback shape would strand
  // orders Paper can't parse (no SKU → no body style) and rot sales reporting.
  const configProblems: LineError[] = [];
  for (const l of lines) {
    if (!variantBySku.has(customSkuFor(l.styleId))) {
      console.error(`checkout: no variant for ${customSkuFor(l.styleId)}`);
      configProblems.push({
        lineId: l.lineId,
        code: "style_checkout_unavailable",
        message: `${l.name}: Checkout is temporarily unavailable for the ${l.styleName} body — try again in a minute.`,
      });
    }
    const dead = l.addons.find((a) => !a.sku || !addonVariants.has(a.sku));
    if (dead) {
      console.error(
        `checkout: add-on "${dead.label}" (sku ${dead.sku ?? "none"}) has no Shopify variant`,
      );
      configProblems.push({
        lineId: l.lineId,
        code: "addon_unavailable",
        message: `${l.name}: "${dead.label}" can't be added right now — remove it from this piñata and try again.`,
      });
    }
  }
  if (configProblems.length) return lineFail(configProblems, 502);

  for (const order of draftOrders) {
    order.input.lineItems = [
      ...order.lines.map((l) => ({
        variantId: variantBySku.get(customSkuFor(l.styleId))!,
        quantity: l.qty,
        priceOverride: { amount: lineUnit(l), currencyCode: "USD" },
        customAttributes: lineAttributes(l),
      })),
      ...addonTotals(order.lines).map(({ addon, qty }) => ({
        variantId: addonVariants.get(addon.sku!)!,
        quantity: qty,
        // Hub price stays authoritative even if the product's price drifts.
        priceOverride: {
          amount: (addon.priceCents / 100).toFixed(2),
          currencyCode: "USD",
        },
      })),
    ];
  }

  const created: {
    groupKey: string;
    shipTo: string;
    invoiceUrl: string;
    draftOrderId: string;
    invoiceSent: boolean;
    nonce: string;
  }[] = [];

  // A refused create. Shopify's own strings go to the log; the customer
  // hears what they can act on. Orders already created ride in createdSoFar.
  const createFailed = (kind: "address" | "email" | "other", failedLines: CleanLine[]) =>
    NextResponse.json(
      {
        error:
          kind === "address"
            ? "Our store couldn't accept that delivery address — double-check the street, ZIP code and phone, then try again."
            : kind === "email"
              ? "Our store couldn't accept that email address — fix it or leave it blank, then try again."
              : created.length
                ? "Some of your orders were created (listed below) — don't re-order those. The rest couldn't be set up just now; please try again in a minute."
                : "We couldn't set up your order just now — nothing was charged. Please try again in a minute.",
        ...(kind === "address"
          ? {
              lineErrors: failedLines.map((l) => ({
                lineId: l.lineId,
                code: "address_rejected",
                message: `${l.name}: Our store couldn't accept this delivery address — double-check the street, ZIP code and phone.`,
              })),
            }
          : {}),
        createdSoFar: created,
      },
      { status: 502 },
    );

  for (const order of draftOrders) {
    let r: GqlResponse<{
      draftOrderCreate: {
        draftOrder: { id: string; invoiceUrl: string | null } | null;
        userErrors: { field?: string[] | null; message?: string }[];
      } | null;
    }>;
    try {
      r = await shopifyGraphql(
        creds,
        `mutation($input: DraftOrderInput!) {
          draftOrderCreate(input: $input) {
            draftOrder { id invoiceUrl }
            userErrors { field message }
          }
        }`,
        { input: order.input },
      );
    } catch (e) {
      // Timeout / network / auth. Shopify may or may not hold the draft; an
      // unpaid duplicate is harmless (nothing is charged until someone pays)
      // and the daily sweep expires it once its date lapses.
      console.error(`draftOrderCreate failed in transit: ${errText(e)}`);
      return createFailed("other", order.lines);
    }
    const userErrors = r.data?.draftOrderCreate?.userErrors ?? [];
    const draft = r.data?.draftOrderCreate?.draftOrder;
    if (r.status !== 200 || r.errors || userErrors.length || !draft?.id || !draft.invoiceUrl) {
      logGqlFailure("draftOrderCreate", r);
      // Field paths (structured, not Shopify's free text) say whether this
      // is something the customer can fix.
      const paths = userErrors.map((e) =>
        (Array.isArray(e?.field) ? e.field.join(".") : "").toLowerCase(),
      );
      const kind = paths.some((p) => p.includes("email"))
        ? "email"
        : paths.some((p) => p.includes("shippingaddress"))
          ? "address"
          : "other";
      return createFailed(kind, order.lines);
    }

    // The invoice EMAIL only on explicit request — and only to an address we
    // have. The consumer flow never sends one: it pays via redirect.
    let invoiceSent = false;
    if (sendInvoice && email) {
      try {
        const s = await shopifyGraphql<{
          draftOrderInvoiceSend: { userErrors: unknown[] } | null;
        }>(
          creds,
          `mutation($id: ID!) {
            draftOrderInvoiceSend(id: $id) {
              draftOrder { id }
              userErrors { field message }
            }
          }`,
          { id: draft.id },
        );
        invoiceSent =
          s.status === 200 &&
          !s.errors &&
          !s.data?.draftOrderInvoiceSend?.userErrors?.length;
        if (!invoiceSent) logGqlFailure("draftOrderInvoiceSend", s);
      } catch (e) {
        console.error(`draftOrderInvoiceSend failed in transit: ${errText(e)}`);
      }
    } else if (sendInvoice) {
      console.error("checkout: sendInvoice requested without an email — no invoice sent");
    }

    created.push({
      groupKey: order.groupKey,
      shipTo: order.shipTo,
      draftOrderId: draft.id,
      invoiceUrl: draft.invoiceUrl,
      invoiceSent,
      nonce: order.nonce,
    });
  }

  // The replacement exists — retire the draft it supersedes. After the
  // response, so the customer's redirect never waits on cleanup.
  if (supersedes && !created.some((o) => o.draftOrderId === supersedes.draftOrderId)) {
    after(() => retireSupersededDraft(creds, supersedes));
  }
  // Keep the orders/paid webhook (paid order → PostHog) registered — once
  // per server instance, after the response; a fresh deploy registers itself
  // on its first checkouts, and the daily cron backs it up.
  after(() => ensureOrdersPaidWebhookOnce());

  return NextResponse.json({ dryRun: false, orders: created });
}
