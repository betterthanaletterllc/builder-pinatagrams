import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import graphicsFile from "../../../public/graphics.json";
import { POST as checkoutPost } from "@/app/api/checkout/route";
import {
  catalogUrl,
  HUB_TIMEOUT_MS,
  resolveHubGraphics,
  type HubCatalog,
  type HubGraphicEntry,
} from "@/lib/hub";
import { CLASSIC_GRAPHIC, type CartLine, type DeliveryAddress, type GraphicChoice } from "@/lib/flow";
import {
  deliveryIssueAtCheckout,
  formatWindow,
  formatYmd,
  resolveDeliveryConfig,
  uspsWindow,
  type Carrier,
  type DeliveryConfig,
} from "@/lib/delivery";
import { EXCLUDED_PREFIXES } from "@/lib/library-data";
import { shopifyAdmin, supersedeAllowed, unpaidBuilderDraft, type Attr } from "@/lib/shopify";
import { rateLimit } from "@/lib/rate-limit";
import { toolError, type ToolAnnotations } from "@/lib/mcp-http";
import { MAX_ADDONS, MCP_HOST, priceTools } from "@/lib/mcp-tools/price";
import type { ToolDef } from "@/lib/order-tools";

/**
 * The checkout tools — the ONLY way an agent buys through this connector.
 *
 *   create_checkout     dry_run (default) → a priced preview, no Shopify;
 *                       dry_run:false + confirm:true → ONE Shopify draft order
 *                       through the real /api/checkout route, answered as
 *                       { status: "ready_for_complete", continue_url, … }.
 *   update_checkout     the same path with `supersedes` so the route retires
 *                       the unpaid draft being replaced.
 *   cancel_checkout     deletes an unpaid draft — only with its nonce.
 *   get_checkout_status open | paid | gone | unknown (no PII).
 *
 * MONEY. Nothing is priced here. The preview's figures come from
 * price_order's own handler (src/lib/mcp-tools/price.ts) — the quote function
 * is not exported, and calling the exported tool IS reusing it: the same
 * parsing, the same catalog rules, the same composition the route charges.
 * The real charge is then composed again by the route itself from the hub,
 * so the preview can never be the price — only agree with it.
 *
 * THE SPINE. On confirm the tool builds a CheckoutBody (CartLine[] exactly as
 * the storefront's cart sends them, `source: "mcp"`, never `sendInvoice`) and
 * invokes the route's exported POST in-process with a synthetic Request:
 * host = MCP_HOST, so the route scopes its catalog to the SAME variant
 * profile price_order used; x-pg-flow = v2 (the header middleware would set);
 * x-forwarded-for copied from the MCP request (the route rate-limits per IP —
 * a synthetic IP would defeat it). The route's dry-run answer (no Shopify
 * credentials on this deployment) is reported honestly as "nothing was
 * created", never as a continue_url.
 *
 * OFF SWITCH. Creating and cancelling need MCP_ORDERING_ENABLED === "true"
 * at call time; otherwise a loud refusal, never a silent preview.
 *
 * IDEMPOTENCY (Phase 2 = best effort). An in-memory map per server instance,
 * 24h TTL, 200 entries: the same idempotency_key (a UUID; ≥ 16 chars) with the
 * same request hash replays the stored result — after ONE draftOrder(id) read
 * proving the draft is still open; a cancelled or paid draft is a refusal, not
 * a stale "ready_for_complete". A different request under the same key is an
 * `idempotency_conflict` refusal. Cold instances don't share the map, and the
 * map is public-by-key (this server has no auth): whoever presents the key AND
 * the byte-identical request gets the stored result. Phase 3 moves it to
 * Upstash.
 *
 * THROTTLE. Every Shopify draft READ this file makes on an agent's behalf —
 * get_checkout_status, cancel_checkout's and update_checkout's nonce checks,
 * the idempotency replay check — shares one per-IP bucket, 30/min, keyed on
 * the same forwarded client IP the create path hands the route (mirrors
 * src/app/api/order-status/route.ts). Without it these tools were a draft-id
 * existence oracle over every draft in the store and a Shopify-budget DoS
 * against the connector's own checkout.
 *
 * CAPS for the agent tier: ≤ MAX_LINES lines, ≤ MAX_QTY per line, ≤ MAX_ADDONS
 * add-ons per line, exactly one ship_to, no custom artwork
 * (builder.pinatagrams.com). Arrays are refused by COUNT before any per-entry
 * validation, so a refusal never echoes thousands of values back.
 */

const WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};
const DESTRUCTIVE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
};
const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

// Agent-tier caps (tighter than the route's 20 lines / 25 per line).
export const MAX_LINES = 5;
export const MAX_QTY = 10;
const MESSAGE_MAX = 300; // the route's str(message, 300) — refused here, never clipped
const MAX_CODES = 2; // the route keeps at most two native codes
// MAX_ADDONS (distinct add-ons per line, refused by COUNT before any lookup)
// is defined once in price.ts so the quote and the checkout share the cap;
// re-exported here for callers that read the checkout caps together.
export { MAX_ADDONS };
const MAX_CODE_ENTRIES = 10; // raw discount_codes entries examined before refusing by COUNT
const STATUS_READS_PER_MIN = 30; // mirrors api/order-status: Shopify draft reads per client IP
const CARRIERS: Carrier[] = ["fedex", "usps"];
const GRAPHIC_TYPES = ["classic", "library", "hub", "custom"] as const;
export const BUILDER_URL = "https://builder.pinatagrams.com";
export const FLOW_HEADER_VALUE = "v2";

// Mirrors of the route's guards (route.ts: DESIGN_RE, ART_RE, EMAIL_RE, the
// discount-code filter, DRAFT_GID_RE, NONCE_RE) and its cleanAddress caps.
const DESIGN_RE = /^[A-Z0-9]{2,24}$/;
const ART_RE = /^https:\/\/cdn\.shopify\.com\//;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const CODE_RE = /^[A-Z0-9 _#-]{2,64}$/;
const DRAFT_GID_RE = /^gid:\/\/shopify\/DraftOrder\/\d+$/;
const NONCE_RE = /^[a-f0-9]{32}$/;
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const STATE_RE = /^[A-Za-z]{2}$/;
const ZIP_RE = /^\d{5}(-\d{4})?$/;
// A UUID is 36 chars; anything much shorter is guessable on a public server
// whose replay map is keyed by this value alone.
const IDEMPOTENCY_KEY_MIN = 16;
const IDEMPOTENCY_KEY_MAX = 128;
const IDEMPOTENCY_KEY_RE = new RegExp(`^[\\x21-\\x7e]{${IDEMPOTENCY_KEY_MIN},${IDEMPOTENCY_KEY_MAX}}$`);
const ADDRESS_MAX = { name: 80, address1: 120, address2: 120, city: 60, zip: 16, phone: 24 } as const;
const EMAIL_MAX = 120;
const AGENT_MAX = 200; // the route sanitizes to 64; this only bounds the body

const ORDERING_OFF =
  "Ordering through this connector is switched off right now; nothing was created. Customers can order at " +
  BUILDER_URL +
  ".";
const ORDERING_OFF_CANCEL =
  "Ordering through this connector is switched off right now; nothing was changed.";
const TWO_STEP =
  "Two steps are required to create a checkout: first call with dry_run true (the default) and show the customer the priced preview; after they explicitly say yes, call again with BOTH dry_run:false AND confirm:true. Nothing was created.";
const CONFIRM_NEEDS_DRY_RUN_FALSE =
  "confirm:true only counts together with dry_run:false (both flags, so a preview can never turn into a purchase by accident). This call was treated as nothing: no preview, no checkout. Call again with dry_run:false and confirm:true to create it, or drop confirm to preview.";
const NO_CREDS_CREATE =
  "Store credentials are absent on this deployment, so no checkout can be created here — nothing was created and nothing is owed. Customers can order at " +
  BUILDER_URL +
  ".";
const NO_CREDS_CANCEL =
  "Store credentials are absent on this deployment, so there is no checkout here to cancel; nothing was changed.";
const STORE_UNREACHABLE =
  "Checkout couldn't reach our store just now — nothing was charged. Please try again in a minute.";
// The route threw AFTER it may have created the draft (after() outside a
// request scope is the realistic cause): the answer is lost, the key is not
// bound, and "try again" would invite a second payable draft.
const ROUTE_THREW =
  "The store didn't confirm whether a checkout was created — nothing has been charged. Don't retry immediately: wait a minute, then retry with a NEW idempotency_key; if two checkouts end up existing, cancel_checkout can delete the unpaid duplicate.";
const TOO_MANY_CHECKS = "too many status checks — try again in a minute";
const TOO_MANY_CHECKS_CANCEL = "Too many status checks — try again in a minute. Nothing was changed.";
const TOO_MANY_CHECKS_CREATE = "Too many status checks — try again in a minute. Nothing was created.";
// A replay whose draft is already PAID: the order exists. This is the one
// answer that must never read as "start again" — that retry would place a
// second order for the same customer.
const REPLAY_PAID =
  "That checkout was already paid, so the order is placed — do not create another one. Use get_checkout_status with the draft_order_id for details. Nothing new was created.";
const REPLAY_GONE =
  "That checkout was cancelled, replaced or expired; start again with a new idempotency_key. Nothing was created.";
const REPLAY_UNVERIFIED =
  "A checkout was created earlier under this idempotency_key, but the store couldn't confirm it is still open just now — nothing new was created. Check it with get_checkout_status, or retry in a minute.";
const CATALOG_UNAVAILABLE =
  "The catalog is unavailable right now — try again in a minute. Nothing was ordered.";
const PRICING_UNAVAILABLE =
  "Pricing is unavailable right now — try again in a minute. Nothing was ordered.";
const PAY_NOTE =
  "Open continue_url to pay on Shopify's secure checkout. The order exists only after payment; tax is added there.";
const PREVIEW_NOTE =
  "Sales tax and any discount code are applied by Shopify at checkout and are not included. This is a preview — nothing has been ordered, charged or reserved.";

/* ---- the MCP request's client IP ---------------------------------------- */

/**
 * The route rate-limits 6 checkouts/min per `x-forwarded-for`. The tool
 * forwards the MCP request's own header — read from Next's request scope
 * (`headers()` works inside the MCP route handler) or from an explicit
 * context the host wraps the call in (tests, a non-Next host). With neither,
 * the header is omitted and the route buckets the call as "unknown": it
 * throttles harder, never looser. A synthetic IP is never invented.
 */
const requestContext = new AsyncLocalStorage<{ clientIp: string | null }>();

/** Run `fn` with `clientIp` as the x-forwarded-for the checkout call forwards. */
export function withMcpClientIp<T>(clientIp: string | null, fn: () => Promise<T>): Promise<T> {
  return requestContext.run({ clientIp }, fn);
}

async function clientIpForRoute(): Promise<string | null> {
  const ctx = requestContext.getStore();
  if (ctx) return ctx.clientIp;
  try {
    const { headers } = await import("next/headers");
    const h = await headers();
    return h.get("x-forwarded-for") || null;
  } catch {
    return null; // outside a Next request scope
  }
}

/**
 * The MCP-side throttle on Shopify draft reads (status, cancel, supersede
 * verification, idempotency replay): one shared bucket per client IP — the
 * first hop of the forwarded header, "unknown" when there is none, which
 * throttles harder, never looser. True = refuse; nothing has been read yet.
 */
async function statusReadThrottled(): Promise<boolean> {
  const ip = (await clientIpForRoute())?.split(",")[0]?.trim() || "unknown";
  return !rateLimit(`mcp-status:${ip}`, STATUS_READS_PER_MIN, 60_000);
}

/* ---- the Shopify design library (public/graphics.json) ------------------ */

type ManifestGraphic = { design: string; title: string; thumb: string | null; art: string | null; message?: string | null };

// Same sellable set as price_order / list_designs: cdn.shopify.com print art,
// client one-off prefixes excluded. The art URL for a CartLine is resolved
// HERE from the manifest, never taken from the agent.
const LIBRARY: Map<string, ManifestGraphic> = (() => {
  const out = new Map<string, ManifestGraphic>();
  const list = (graphicsFile as unknown as { graphics?: ManifestGraphic[] }).graphics ?? [];
  for (const g of list) {
    if (!g || typeof g.design !== "string" || typeof g.art !== "string") continue;
    if (!ART_RE.test(g.art)) continue;
    if (EXCLUDED_PREFIXES.has(g.design.replace(/[0-9]+$/, ""))) continue;
    out.set(g.design.toUpperCase(), g);
  }
  return out;
})();

const CLASSIC_DESIGN = typeof CLASSIC_GRAPHIC.design === "string" ? CLASSIC_GRAPHIC.design : "STANDARD";

/* ---- hub read (delivery calendar + hub graphics), fresh like the route --- */

async function hubGet<T>(url: string): Promise<T | null> {
  try {
    const fresh = `${url}${url.includes("?") ? "&" : "?"}fresh=${Date.now()}`;
    const res = await fetch(fresh, { cache: "no-store", signal: AbortSignal.timeout(HUB_TIMEOUT_MS) });
    if (!res.ok) {
      console.error(`[mcp] checkout: hub returned HTTP ${res.status} for ${url}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (e) {
    console.error(`[mcp] checkout: hub fetch failed for ${url}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/* ---- input parsing (no network) ----------------------------------------- */

type GraphicInput = { type: "classic" } | { type: "library" | "hub"; design: string };

type LineInput = {
  style_id: string;
  qty: number;
  filling: string;
  graphic: GraphicInput;
  add_ons: string[];
  message: string;
  delivery_date: string;
};

type ShipTo = {
  name: string;
  address1: string;
  address2: string;
  city: string;
  state: string;
  zip: string;
  phone: string;
};

type Supersedes = { draftOrderId: string; nonce: string };

type Parsed = {
  carrier: Carrier;
  lines: LineInput[];
  ship_to: ShipTo;
  email: string;
  discount_codes: string[];
  dry_run: boolean;
  confirm: boolean;
  idempotency_key: string | null;
  agent: string | null;
  supersedes: Supersedes | null;
};

type Mode = "create" | "update";

const ORDER = -1;
type Problem = { at: number; text: string };

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

const show = (v: unknown) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return (s ?? String(v)).slice(0, 60);
};

const lineLabel = (at: number) => (at === ORDER ? "Order" : `Line ${at + 1}`);

function unknownKeys(
  o: Record<string, unknown>,
  allowed: readonly string[],
  at: number,
  where: string,
  problems: Problem[],
): void {
  const extra = Object.keys(o).filter((k) => !allowed.includes(k));
  if (extra.length) {
    problems.push({
      at,
      text: `${where}: unknown field${extra.length > 1 ? "s" : ""} ${extra.map((k) => `"${k}"`).join(", ")} — allowed fields are ${allowed.join(", ")}.`,
    });
  }
}

function parseGraphic(raw: unknown, at: number, problems: Problem[]): GraphicInput | null {
  const where = `${lineLabel(at)}: graphic`;
  if (!isObj(raw)) {
    problems.push({
      at,
      text: `${lineLabel(at)}: graphic must be an object — {"type":"classic"}, {"type":"library","design":"HBD06"} or {"type":"hub","design":"H0001"}.`,
    });
    return null;
  }
  const type = GRAPHIC_TYPES.find((t) => t === raw.type);
  if (!type) {
    problems.push({ at, text: `${where}.type must be one of: classic, library, hub.` });
    return null;
  }
  if (type === "custom") {
    problems.push({
      at,
      text: `${lineLabel(at)}: custom artwork can't be ordered through this connector yet — pick a design code from list_designs, or send the customer to ${BUILDER_URL} to design their own.`,
    });
    return null;
  }
  if (type === "classic") {
    unknownKeys(raw, ["type"], at, where, problems);
    return { type };
  }
  unknownKeys(raw, ["type", "design"], at, where, problems);
  const design = raw.design;
  if (typeof design !== "string" || !design.trim()) {
    problems.push({ at, text: `${where}.design is required for a ${type} graphic (a design code such as ${type === "hub" ? "H0001" : "HBD06"}).` });
    return null;
  }
  if (!DESIGN_RE.test(design.trim().toUpperCase())) {
    problems.push({ at, text: `${where}.design "${show(design)}" isn't valid — codes look like HBD06.` });
    return null;
  }
  return { type, design: design.trim().toUpperCase() };
}

const LINE_KEYS = ["style_id", "qty", "filling", "graphic", "add_ons", "message", "delivery_date"] as const;

function parseLine(raw: unknown, at: number, problems: Problem[]): LineInput | null {
  const label = lineLabel(at);
  if (!isObj(raw)) {
    problems.push({
      at,
      text: `${label}: each line must be an object with style_id, qty, filling, graphic, delivery_date and optional add_ons and message.`,
    });
    return null;
  }
  const before = problems.length;
  unknownKeys(raw, LINE_KEYS, at, label, problems);

  const style_id = typeof raw.style_id === "string" ? raw.style_id.trim() : "";
  if (!style_id) {
    problems.push({ at, text: `${label}: style_id is required (a body style id from get_catalog, e.g. "standard").` });
  }

  const qty = raw.qty;
  if (!Number.isInteger(qty) || (qty as number) < 1 || (qty as number) > MAX_QTY) {
    problems.push({
      at,
      text: `${label}: qty must be a whole number from 1 to ${MAX_QTY} per line through this connector (more of the same piñata? use another line; 15 or more in total? quote_bulk).`,
    });
  }

  const filling = typeof raw.filling === "string" ? raw.filling.trim() : "";
  if (!filling) {
    problems.push({ at, text: `${label}: filling is required (a filling id or label from get_catalog, e.g. "Candy").` });
  }

  const graphic = parseGraphic(raw.graphic, at, problems);

  let add_ons: string[] = [];
  if (raw.add_ons !== undefined) {
    if (!Array.isArray(raw.add_ons)) {
      problems.push({ at, text: `${label}: add_ons must be an array of add-on ids (strings), e.g. ["double-candy"].` });
    } else if (raw.add_ons.length > MAX_ADDONS) {
      // By COUNT, before looking at a single entry: the refusal names the
      // number, never the values (20,000 entries must not come back as 2 MB).
      problems.push({ at, text: `${label}: add_ons lists ${raw.add_ons.length} entries; at most ${MAX_ADDONS} per line.` });
    } else if (raw.add_ons.some((a) => typeof a !== "string" || !a.trim())) {
      problems.push({ at, text: `${label}: add_ons must be an array of add-on ids (strings), e.g. ["double-candy"].` });
    } else {
      // Exact repeats collapse here; price_order also dedupes by resolved id.
      add_ons = [...new Set((raw.add_ons as string[]).map((a) => a.trim()))];
    }
  }

  let message = "";
  if (raw.message !== undefined) {
    if (typeof raw.message !== "string") {
      problems.push({ at, text: `${label}: message must be a string (the note printed inside, up to ${MESSAGE_MAX} characters).` });
    } else {
      message = raw.message.trim();
      if (message.length > MESSAGE_MAX) {
        problems.push({
          at,
          text: `${label}: message is ${message.length} characters; the card holds ${MESSAGE_MAX} — shorten it (nothing is clipped silently).`,
        });
      }
    }
  }

  const delivery_date = typeof raw.delivery_date === "string" ? raw.delivery_date.trim() : "";
  if (!YMD_RE.test(delivery_date) || !isCalendarDate(delivery_date)) {
    problems.push({
      at,
      text: delivery_date
        ? `${label}: delivery_date "${show(delivery_date)}" must be a real date as YYYY-MM-DD.`
        : `${label}: delivery_date is required (YYYY-MM-DD; check it with get_delivery_options).`,
    });
  }

  if (problems.length > before || !graphic) return null;
  return { style_id, qty: qty as number, filling, graphic, add_ons, message, delivery_date };
}

function isCalendarDate(ymd: string): boolean {
  const [y, m, d] = ymd.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

const SHIP_TO_KEYS = ["name", "address1", "address2", "city", "state", "zip", "phone"] as const;

function parseShipTo(raw: unknown, problems: Problem[]): ShipTo | null {
  const where = "ship_to";
  if (!isObj(raw)) {
    problems.push({
      at: ORDER,
      text: `${where} is required: { name, address1, address2?, city, state (2 letters), zip, phone? } — the one US address the whole order ships to.`,
    });
    return null;
  }
  const before = problems.length;
  unknownKeys(raw, SHIP_TO_KEYS, ORDER, where, problems);

  const field = (k: (typeof SHIP_TO_KEYS)[number], required: boolean, what: string): string => {
    const v = raw[k];
    if (v === undefined || v === null || v === "") {
      if (required) problems.push({ at: ORDER, text: `${where}.${k} is required (${what}).` });
      return "";
    }
    if (typeof v !== "string") {
      problems.push({ at: ORDER, text: `${where}.${k} must be a string (${what}).` });
      return "";
    }
    const s = v.trim();
    if (required && !s) problems.push({ at: ORDER, text: `${where}.${k} is required (${what}).` });
    const max = k === "state" ? 2 : ADDRESS_MAX[k];
    if (s.length > max) problems.push({ at: ORDER, text: `${where}.${k} is too long (${s.length} characters; the limit is ${max}).` });
    return s;
  };

  const name = field("name", true, "the recipient's name");
  const address1 = field("address1", true, "the street address");
  const address2 = field("address2", false, "apartment, suite or unit");
  const city = field("city", true, "the city");
  const stateRaw = typeof raw.state === "string" ? raw.state.trim() : "";
  if (!stateRaw) problems.push({ at: ORDER, text: `${where}.state is required (the 2-letter US state code, e.g. "TX").` });
  else if (!STATE_RE.test(stateRaw)) problems.push({ at: ORDER, text: `${where}.state must be the 2-letter US state code (got ${show(stateRaw)}).` });
  const zip = field("zip", true, "the ZIP code");
  if (zip && !ZIP_RE.test(zip)) problems.push({ at: ORDER, text: `${where}.zip must be a US ZIP code like 78701 or 78701-1234 (got ${show(zip)}).` });
  const phone = field("phone", false, "a phone number for the carrier");

  if (problems.length > before) return null;
  return { name, address1, address2, city, state: stateRaw.toUpperCase(), zip, phone };
}

function parseSupersedes(raw: unknown, problems: Problem[]): Supersedes | null {
  const where = "supersedes";
  if (!isObj(raw)) {
    problems.push({
      at: ORDER,
      text: `${where} is required: { draft_order_id, nonce } of the checkout being replaced, exactly as create_checkout returned them.`,
    });
    return null;
  }
  const before = problems.length;
  unknownKeys(raw, ["draft_order_id", "nonce"], ORDER, where, problems);
  const id = typeof raw.draft_order_id === "string" ? raw.draft_order_id.trim() : "";
  if (!DRAFT_GID_RE.test(id)) {
    problems.push({ at: ORDER, text: `${where}.draft_order_id must be the id a checkout returned (it looks like gid://shopify/DraftOrder/123).` });
  }
  const nonce = typeof raw.nonce === "string" ? raw.nonce.trim().toLowerCase() : "";
  if (!NONCE_RE.test(nonce)) {
    problems.push({ at: ORDER, text: `${where}.nonce must be the 32-character nonce that checkout returned with the draft_order_id.` });
  }
  if (problems.length > before) return null;
  return { draftOrderId: id, nonce };
}

const ORDER_KEYS = [
  "carrier",
  "lines",
  "ship_to",
  "email",
  "discount_codes",
  "dry_run",
  "confirm",
  "idempotency_key",
  "agent",
] as const;

function parseInput(args: Record<string, unknown>, mode: Mode): { ok: true; value: Parsed } | { ok: false; refusal: ReturnType<typeof toolError> } {
  const problems: Problem[] = [];
  const allowed = mode === "update" ? [...ORDER_KEYS, "supersedes"] : [...ORDER_KEYS];
  unknownKeys(args, allowed, ORDER, "Order", problems);

  const carrierRaw = args.carrier;
  const carrier = CARRIERS.find((c) => c === carrierRaw) ?? null;
  if (!carrier) {
    problems.push({
      at: ORDER,
      text:
        carrierRaw === undefined
          ? `carrier is required: "fedex" (2-Day, guaranteed arrival date) or "usps" (First Class, arrives in a window).`
          : `carrier must be "fedex" or "usps" (got ${show(carrierRaw)}).`,
    });
  }

  const rawLines = args.lines;
  let lines: (LineInput | null)[] = [];
  if (!Array.isArray(rawLines) || rawLines.length === 0) {
    problems.push({ at: ORDER, text: "lines must be a non-empty array — one entry per piñata design in the order." });
  } else if (rawLines.length > MAX_LINES) {
    problems.push({
      at: ORDER,
      text: `An order through this connector caps at ${MAX_LINES} lines (got ${rawLines.length}). Larger orders go through ${BUILDER_URL}, or quote_bulk for 15 or more piñatas.`,
    });
  } else {
    lines = rawLines.map((raw, i) => parseLine(raw, i, problems));
  }

  const ship_to = parseShipTo(args.ship_to, problems);

  let email = "";
  if (args.email !== undefined && args.email !== null && args.email !== "") {
    if (typeof args.email !== "string" || args.email.trim().length > EMAIL_MAX || !EMAIL_RE.test(args.email.trim())) {
      problems.push({ at: ORDER, text: `email doesn't look like an email address (got ${show(args.email)}). Leave it out to let the customer enter it on Shopify.` });
    } else {
      email = args.email.trim();
    }
  }

  let discount_codes: string[] = [];
  if (args.discount_codes !== undefined) {
    if (!Array.isArray(args.discount_codes)) {
      problems.push({ at: ORDER, text: "discount_codes must be an array of code strings." });
    } else if (args.discount_codes.length > MAX_CODE_ENTRIES) {
      // By COUNT, before reading a single entry (see add_ons).
      problems.push({
        at: ORDER,
        text: `discount_codes lists ${args.discount_codes.length} entries; at most ${MAX_CODES} codes can be applied (one order code + one shipping code).`,
      });
    } else if (args.discount_codes.some((c) => typeof c !== "string")) {
      problems.push({ at: ORDER, text: "discount_codes must be an array of code strings." });
    } else {
      const codes = [...new Set((args.discount_codes as string[]).map((c) => c.trim().toUpperCase()).filter(Boolean))];
      const bad = codes.filter((c) => !CODE_RE.test(c));
      if (bad.length) {
        problems.push({ at: ORDER, text: `discount code${bad.length > 1 ? "s" : ""} ${bad.map((c) => `"${show(c)}"`).join(", ")} ${bad.length > 1 ? "aren't" : "isn't"} in a form the store accepts (2–64 letters, digits, spaces, _ # -).` });
      } else if (codes.length > MAX_CODES) {
        problems.push({ at: ORDER, text: `At most ${MAX_CODES} discount codes can be applied (one order code + one shipping code); got ${codes.length}.` });
      } else {
        discount_codes = codes;
      }
    }
  }

  const flag = (k: "dry_run" | "confirm", fallback: boolean): boolean => {
    const v = args[k];
    if (v === undefined) return fallback;
    if (typeof v !== "boolean") {
      problems.push({ at: ORDER, text: `${k} must be true or false.` });
      return fallback;
    }
    return v;
  };
  const dry_run = flag("dry_run", true);
  const confirm = flag("confirm", false);

  let idempotency_key: string | null = null;
  if (args.idempotency_key !== undefined) {
    if (typeof args.idempotency_key !== "string" || !IDEMPOTENCY_KEY_RE.test(args.idempotency_key)) {
      problems.push({
        at: ORDER,
        text: `idempotency_key must be ${IDEMPOTENCY_KEY_MIN}–${IDEMPOTENCY_KEY_MAX} printable characters with no spaces — use a UUID. The same key with the same request returns the same checkout.`,
      });
    } else {
      idempotency_key = args.idempotency_key;
    }
  }

  let agent: string | null = null;
  if (args.agent !== undefined && args.agent !== null) {
    if (typeof args.agent !== "string") {
      problems.push({ at: ORDER, text: "agent must be a short string naming who is ordering (analytics only)." });
    } else {
      agent = args.agent.trim().slice(0, AGENT_MAX) || null;
    }
  }

  const supersedes = mode === "update" ? parseSupersedes(args.supersedes, problems) : null;

  if (problems.length || !carrier || !ship_to || lines.some((l) => !l) || (mode === "update" && !supersedes)) {
    return { ok: false, refusal: refuse(problems.sort((a, b) => a.at - b.at).map((p) => p.text)) };
  }
  return {
    ok: true,
    value: {
      carrier,
      lines: lines as LineInput[],
      ship_to,
      email,
      discount_codes,
      dry_run,
      confirm,
      idempotency_key,
      agent,
      supersedes,
    },
  };
}

/** One refusal naming every problem. */
function refuse(texts: string[], what = "this checkout can go ahead") {
  return toolError(
    texts.length === 1
      ? texts[0]
      : `${texts.length} things need fixing before ${what}:\n${texts.map((t) => `- ${t}`).join("\n")}`,
  );
}

/* ---- price_order's quote (the money) ------------------------------------ */

type Quote = {
  carrier: Carrier;
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
  shipping: { carrier: Carrier; service: string; per_unit_cents: number; units: number; cents: number };
  subtotal_cents: number;
  total_before_tax_cents: number;
  currency: string;
  as_of: string;
  note: string;
};

/** A tool result's refusal text, or null when it is a plain result. */
function refusalText(res: unknown): string | null {
  if (!isObj(res) || res.isError !== true || !Array.isArray(res.content)) return null;
  return (res.content as { text?: string }[]).map((c) => c.text ?? "").join("\n");
}

// price_order's multi-problem refusal header (price.ts refuse()); its bullets
// are re-listed among ours so the agent still gets ONE list.
const PRICE_HEADER_RE = /^\d+ things need fixing before this order can be priced:\n/;
function priceProblems(text: string): string[] {
  if (!PRICE_HEADER_RE.test(text)) return [text];
  return text
    .replace(PRICE_HEADER_RE, "")
    .split("\n- ")
    .map((s) => s.replace(/^- /, "").trim())
    .filter(Boolean);
}

function isQuote(v: unknown, lineCount: number): v is Quote {
  if (!isObj(v) || !Array.isArray(v.lines) || v.lines.length !== lineCount) return false;
  if (!Number.isInteger(v.total_before_tax_cents) || !Number.isInteger(v.subtotal_cents)) return false;
  if (!isObj(v.shipping) || !Array.isArray(v.add_on_lines)) return false;
  return v.lines.every(
    (l) =>
      isObj(l) &&
      typeof l.style_id === "string" &&
      typeof l.style_name === "string" &&
      isObj(l.graphic) &&
      isObj(l.filling) &&
      Array.isArray(l.add_ons) &&
      Number.isInteger(l.unit_cents) &&
      Number.isInteger(l.line_cents),
  );
}

/* ---- the prepared order (validated, priced, cart built) ------------------ */

type NormalizedLine = {
  line: number;
  style_id: string;
  style_name: string;
  graphic: { type: "classic" | "library" | "hub"; design: string; label: string };
  filling: { id: string; label: string };
  add_ons: string[];
  qty: number;
  delivery_date: string;
  arrives: string;
  message?: string;
  unit_cents: number;
  line_cents: number;
};

type Prepared = {
  parsed: Parsed;
  quote: Quote;
  cart: CartLine[];
  lines: NormalizedLine[];
  arrives: string;
  ship_to: Record<string, string>;
};

function normalizedShipTo(s: ShipTo): Record<string, string> {
  return {
    name: s.name,
    address1: s.address1,
    ...(s.address2 ? { address2: s.address2 } : {}),
    city: s.city,
    state: s.state,
    zip: s.zip,
    ...(s.phone ? { phone: s.phone } : {}),
  };
}

/** The line's "Arrives" promise, worded exactly like the draft's attribute. */
function arrivesFor(date: string, carrier: Carrier, cfg: DeliveryConfig): string {
  return carrier === "usps" ? formatWindow(uspsWindow(date, cfg)) : formatYmd(date);
}

/** The CartLine graphic for a design code: the Classic default, a library
 *  design (art from the manifest) or a hub graphic (art + sha from the live
 *  catalog; the route re-resolves both by code anyway). */
function cartGraphic(
  g: GraphicInput,
  hubGraphics: Map<string, HubGraphicEntry>,
): { choice: GraphicChoice; type: NormalizedLine["graphic"]["type"] } | null {
  if (g.type === "classic") return { choice: CLASSIC_GRAPHIC, type: "classic" };
  if (g.design === CLASSIC_DESIGN) return { choice: CLASSIC_GRAPHIC, type: "classic" };
  const lib = LIBRARY.get(g.design);
  if (lib) {
    return {
      choice: {
        type: "shopify",
        design: g.design,
        title: lib.title,
        thumb: lib.thumb ?? null,
        art: lib.art,
        ...(lib.message ? { message: lib.message } : {}),
      },
      type: "library",
    };
  }
  const hub = hubGraphics.get(g.design);
  if (hub) {
    return {
      choice: {
        type: "hub",
        design: hub.design,
        title: hub.title,
        thumb: hub.thumb || null,
        art: hub.art,
        artSha256: hub.artSha256,
      },
      type: "hub",
    };
  }
  return null;
}

/** Validate against the live calendar, price through price_order, and build
 *  the CartLine[] the route expects — or ONE refusal naming every problem. */
async function prepare(parsed: Parsed): Promise<{ ok: true; value: Prepared } | { ok: false; refusal: ReturnType<typeof toolError> }> {
  // price_order's vocabulary: a hub graphic is a library-tier design code.
  const priceLines = parsed.lines.map((l) => ({
    style_id: l.style_id,
    qty: l.qty,
    filling: l.filling,
    graphic: l.graphic.type === "classic" ? { type: "classic" } : { type: "library", design: l.graphic.design },
    ...(l.add_ons.length ? { add_ons: l.add_ons } : {}),
  }));
  const [catalog, quoteRes] = await Promise.all([
    hubGet<HubCatalog>(catalogUrl({ host: MCP_HOST })),
    priceTools.price_order.handler({ carrier: parsed.carrier, lines: priceLines }),
  ]);
  if (!catalog || !Array.isArray(catalog.bodyStyles)) return { ok: false, refusal: toolError(CATALOG_UNAVAILABLE) };

  const cfg = resolveDeliveryConfig(catalog.delivery);
  const hubGraphics = new Map(resolveHubGraphics(catalog.hubGraphics).map((g) => [g.design, g]));

  const problems: string[] = [];
  parsed.lines.forEach((l, i) => {
    const issue = deliveryIssueAtCheckout(l.delivery_date, cfg, parsed.carrier);
    if (issue) problems.push(`${lineLabel(i)}: delivery_date ${l.delivery_date} doesn't work — ${issue.message}`);
  });
  const quoteErr = refusalText(quoteRes);
  if (quoteErr) problems.push(...priceProblems(quoteErr));
  if (problems.length) return { ok: false, refusal: refuse(problems) };
  if (!isQuote(quoteRes, parsed.lines.length)) {
    console.error("[mcp] checkout: price_order answered an unexpected shape");
    return { ok: false, refusal: toolError(PRICING_UNAVAILABLE) };
  }
  const quote = quoteRes;

  const address: DeliveryAddress = {
    name: parsed.ship_to.name,
    address1: parsed.ship_to.address1,
    address2: parsed.ship_to.address2,
    city: parsed.ship_to.city,
    province: parsed.ship_to.state,
    zip: parsed.ship_to.zip,
    phone: parsed.ship_to.phone,
  };

  const cart: CartLine[] = [];
  const lines: NormalizedLine[] = [];
  parsed.lines.forEach((l, i) => {
    const q = quote.lines[i];
    const graphic = cartGraphic(l.graphic, hubGraphics);
    if (!graphic) {
      // price_order priced a code neither source knows — a drift between the
      // two resolvers, never something to paper over.
      problems.push(`${lineLabel(i)}: design ${l.graphic.type === "classic" ? CLASSIC_DESIGN : l.graphic.design} can't be placed on an order right now — pick another.`);
      return;
    }
    cart.push({
      id: `line-${i + 1}`,
      styleId: q.style_id,
      styleName: q.style_name,
      boxImageUrl: null,
      logoZone: null,
      graphic: graphic.choice,
      message: l.message,
      filling: q.filling.label,
      ...(q.add_ons.length ? { addons: q.add_ons } : {}),
      deliveryDate: l.delivery_date,
      carrier: parsed.carrier,
      address,
      qty: l.qty,
    });
    lines.push({
      line: i + 1,
      style_id: q.style_id,
      style_name: q.style_name,
      graphic: { type: graphic.type, design: q.graphic.design, label: q.graphic.label },
      filling: { id: q.filling.id, label: q.filling.label },
      add_ons: q.add_ons,
      qty: l.qty,
      delivery_date: l.delivery_date,
      arrives: arrivesFor(l.delivery_date, parsed.carrier, cfg),
      ...(l.message ? { message: l.message } : {}),
      unit_cents: q.unit_cents,
      line_cents: q.line_cents,
    });
  });
  if (problems.length) return { ok: false, refusal: refuse(problems) };

  const distinct = [...new Set(lines.map((l) => l.arrives))];
  const arrives = distinct.length === 1 ? distinct[0] : lines.map((l) => `Line ${l.line}: ${l.arrives}`).join("; ");

  return { ok: true, value: { parsed, quote, cart, lines, arrives, ship_to: normalizedShipTo(parsed.ship_to) } };
}

/** The money + order blocks shared by the preview and the created result. */
function orderSummary(p: Prepared) {
  const { quote, parsed } = p;
  return {
    carrier: parsed.carrier,
    arrives: p.arrives,
    ship_to: p.ship_to,
    lines: p.lines,
    add_on_lines: quote.add_on_lines,
    shipping: quote.shipping,
    subtotal_cents: quote.subtotal_cents,
    total_before_tax_cents: quote.total_before_tax_cents,
    currency: "USD",
    ...(parsed.email ? { email: parsed.email } : {}),
    ...(parsed.discount_codes.length
      ? {
          discount_codes: parsed.discount_codes,
          discount_note:
            "Discount codes are applied by Shopify on the payment page (a code it can't honour is simply skipped); the totals here do not include them.",
        }
      : {}),
  };
}

const orderingEnabled = () => process.env.MCP_ORDERING_ENABLED === "true";

function preview(p: Prepared, mode: Mode) {
  const tool = mode === "update" ? "update_checkout" : "create_checkout";
  const enabled = orderingEnabled();
  return {
    dry_run: true,
    ...(mode === "update" && p.parsed.supersedes ? { supersedes: { draft_order_id: p.parsed.supersedes.draftOrderId } } : {}),
    ...orderSummary(p),
    as_of: p.quote.as_of,
    ordering_enabled: enabled,
    next_step: enabled
      ? `Show this preview to the customer (lines, arrival, ship-to, total before tax). Only after they explicitly say yes, call ${tool} again with the same arguments plus dry_run:false and confirm:true to create the checkout.`
      : `Ordering through this connector is switched off right now, so confirm would be refused. Share the preview and send the customer to ${BUILDER_URL} to place the order.`,
    note: PREVIEW_NOTE,
  };
}

/* ---- idempotency (per instance, best effort) ----------------------------- */

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000;
const IDEMPOTENCY_MAX = 200;
type Stored = { hash: string; at: number; result: Record<string, unknown> };
const idempotency = new Map<string, Stored>();

// What makes two confirms "the same request": everything that shapes the
// draft. `agent` (analytics only) and the flags themselves are left out, so
// a retry that merely renames the assistant still replays instead of
// conflicting.
function requestHash(parsed: Parsed, mode: Mode): string {
  const { carrier, lines, ship_to, email, discount_codes, supersedes } = parsed;
  return createHash("sha256")
    .update(JSON.stringify({ mode, carrier, lines, ship_to, email, discount_codes, supersedes }))
    .digest("hex");
}

function idempotencyLookup(key: string, hash: string): Stored | "conflict" | null {
  const now = Date.now();
  for (const [k, v] of idempotency) if (now - v.at > IDEMPOTENCY_TTL_MS) idempotency.delete(k);
  const hit = idempotency.get(key);
  if (!hit) return null;
  return hit.hash === hash ? hit : "conflict";
}

function idempotencyStore(key: string, hash: string, result: Record<string, unknown>): void {
  idempotency.set(key, { hash, at: Date.now(), result });
  while (idempotency.size > IDEMPOTENCY_MAX) idempotency.delete(idempotency.keys().next().value!);
}

/** A stored confirm, replayed only while its draft is still open: ONE
 *  throttled draftOrder(id) read first. A cancelled or paid draft — or no
 *  answer — is a refusal, never a stale "ready_for_complete". The key stays
 *  bound either way, so the same request can't silently mint a replacement. */
async function replay(hit: Stored): Promise<unknown> {
  const id = String(hit.result.draft_order_id ?? "");
  const gql = await shopifyAdmin();
  if (!gql) return toolError(REPLAY_UNVERIFIED);
  if (await statusReadThrottled()) return toolError(TOO_MANY_CHECKS_CREATE);
  const s = await readDraftStatus(gql, id);
  if (s.status === "open") return { ...hit.result, replayed: true };
  if (s.status === "paid") return toolError(REPLAY_PAID);
  if (s.status === "gone") return toolError(REPLAY_GONE);
  return toolError(REPLAY_UNVERIFIED);
}

/* ---- the in-process route call ------------------------------------------- */

type RouteOrder = {
  groupKey?: string;
  shipTo?: string;
  invoiceUrl?: string;
  draftOrderId?: string;
  invoiceSent?: boolean;
  nonce?: string;
};
type RouteAnswer = {
  dryRun?: boolean;
  orders?: RouteOrder[];
  error?: string;
  lineErrors?: { lineId?: string; code?: string; message?: string }[];
  createdSoFar?: RouteOrder[];
};

const lineNumber = (lineId: unknown) => {
  const m = /^line-(\d+)$/.exec(String(lineId ?? ""));
  return m ? `Line ${m[1]}` : "Line";
};

function routeFailure(status: number, json: RouteAnswer) {
  const texts: string[] = [];
  if (Array.isArray(json.lineErrors) && json.lineErrors.length) {
    for (const e of json.lineErrors) texts.push(`${lineNumber(e?.lineId)}: ${e?.message ?? "couldn't be set up."}`);
  } else if (typeof json.error === "string" && json.error) {
    texts.push(json.error);
  } else {
    console.error(`[mcp] checkout: route answered HTTP ${status} without a message`);
    texts.push(STORE_UNREACHABLE);
  }
  // A created draft (only possible with several ship-to groups, which this
  // tool never sends) is still reported — nothing payable is ever hidden.
  const created = Array.isArray(json.createdSoFar) ? json.createdSoFar.filter((o) => o?.invoiceUrl) : [];
  if (created.length) {
    texts.push(
      `Already created and payable: ${created.map((o) => `${o.draftOrderId} → ${o.invoiceUrl}`).join("; ")} — do not create these again.`,
    );
  }
  return refuse(texts, "this checkout can be created");
}

async function createViaRoute(p: Prepared, mode: Mode): Promise<Record<string, unknown> | ReturnType<typeof toolError>> {
  const { parsed } = p;
  const body = {
    lines: p.cart,
    ...(parsed.email ? { email: parsed.email } : {}),
    ...(parsed.discount_codes.length ? { discountCodes: parsed.discount_codes } : {}),
    ...(mode === "update" && parsed.supersedes ? { supersedes: parsed.supersedes } : {}),
    // Never sendInvoice: the anonymous tier may not trigger Shopify emails.
    source: "mcp" as const,
    ...(parsed.agent ? { agent: parsed.agent } : {}),
  };
  const clientIp = await clientIpForRoute();
  const req = new Request(`https://${MCP_HOST}/api/checkout`, {
    method: "POST",
    headers: {
      host: MCP_HOST,
      "content-type": "application/json",
      "x-pg-flow": FLOW_HEADER_VALUE,
      ...(clientIp ? { "x-forwarded-for": clientIp } : {}),
    },
    body: JSON.stringify(body),
  });

  let status: number;
  let json: RouteAnswer;
  try {
    const res = await checkoutPost(req);
    status = res.status;
    json = (await res.json()) as RouteAnswer;
  } catch (e) {
    // The draft may already exist (the route throws only after its own
    // Shopify handling, e.g. after() outside a request scope), so never
    // "try again": see ROUTE_THREW.
    console.error(`[mcp] checkout: route call failed after the create may have run: ${e instanceof Error ? e.message : String(e)}`);
    return toolError(ROUTE_THREW);
  }
  if (!isObj(json)) return toolError(STORE_UNREACHABLE);

  if (status !== 200) return routeFailure(status, json);
  if (json.dryRun === true) {
    // No Shopify credentials on this deployment: the route composed the
    // payload and stopped. Honest answer, never a fake continue_url.
    console.error("[mcp] checkout: route ran dry (no Shopify credentials) — nothing created");
    return toolError(NO_CREDS_CREATE);
  }
  const orders = Array.isArray(json.orders) ? json.orders : [];
  if (orders.length !== 1 || !orders[0]?.invoiceUrl || !orders[0]?.draftOrderId || !orders[0]?.nonce) {
    console.error(`[mcp] checkout: route answered 200 with ${orders.length} order(s) — expected exactly one`);
    if (orders.length > 1) {
      return refuse(
        orders.map((o) => `A checkout was created — ${o.draftOrderId} → ${o.invoiceUrl}`),
        "this can be reported as one checkout (contact Piñatagrams support; do not create these again)",
      );
    }
    return toolError(STORE_UNREACHABLE);
  }
  const order = orders[0];
  return {
    status: "ready_for_complete",
    continue_url: order.invoiceUrl,
    draft_order_id: order.draftOrderId,
    nonce: order.nonce,
    ...orderSummary(p),
    ...(mode === "update" && parsed.supersedes
      ? {
          superseded: {
            draft_order_id: parsed.supersedes.draftOrderId,
            note: "Verified unpaid with a matching nonce before this replacement was created; the store retires it right after, so its old continue_url stops working. get_checkout_status on it reports gone once that completes.",
          },
        }
      : {}),
    note: PAY_NOTE,
  };
}

/* ---- create / update ----------------------------------------------------- */

async function run(args: Record<string, unknown>, mode: Mode): Promise<unknown> {
  const parsed = parseInput(args, mode);
  if (!parsed.ok) return parsed.refusal;
  const p = parsed.value;

  if (!p.dry_run && !p.confirm) return toolError(TWO_STEP);
  if (p.dry_run && p.confirm) return toolError(CONFIRM_NEEDS_DRY_RUN_FALSE);
  const creating = !p.dry_run && p.confirm;

  let hash = "";
  if (creating) {
    if (!orderingEnabled()) return toolError(ORDERING_OFF);
    if (p.idempotency_key) {
      hash = requestHash(p, mode);
      const hit = idempotencyLookup(p.idempotency_key, hash);
      if (hit === "conflict") {
        return toolError(
          `idempotency_conflict: idempotency_key "${p.idempotency_key}" was already used for a different request on this server. Use a new key for a new checkout, or repeat the original request exactly. Nothing was created.`,
        );
      }
      if (hit) return replay(hit);
    }
  }

  const prepared = await prepare(p);
  if (!prepared.ok) return prepared.refusal;
  if (!creating) return preview(prepared.value, mode);

  // An update first proves the draft it replaces is still ours to retire —
  // otherwise the route would create a second payable draft next to one it
  // then leaves alone (wrong nonce, already paid), and the customer could pay
  // either. One Shopify read, before anything is created.
  if (mode === "update" && p.supersedes) {
    const bad = await verifySupersedes(p.supersedes);
    if (bad) return bad;
  }

  const result = await createViaRoute(prepared.value, mode);
  if (p.idempotency_key && !("isError" in result) && result.status === "ready_for_complete") {
    idempotencyStore(p.idempotency_key, hash, result);
  }
  return result;
}

/* ---- draft lookup (cancel / update / status) ----------------------------- */

type DraftLookup = {
  status: string;
  tags: string[];
  order: { id: string } | null;
  customAttributes: Attr[];
};

type Gql = NonNullable<Awaited<ReturnType<typeof shopifyAdmin>>>;

/** The draft as cancel/supersede need it: `null` = Shopify's explicit "no
 *  such draft" (gone), `"malformed"` = an answer this code can't read. Throws
 *  on transport/GraphQL failure (shopifyAdmin's client does). */
async function lookupDraft(gql: Gql, id: string): Promise<DraftLookup | null | "malformed"> {
  const data = await gql<{ draftOrder: DraftLookup | null }>(
    `query($id: ID!) {
      draftOrder(id: $id) { status tags order { id } customAttributes { key value } }
    }`,
    { id },
  );
  const d = data.draftOrder;
  if (d === null) return null;
  if (!d || typeof d.status !== "string" || !Array.isArray(d.tags) || !Array.isArray(d.customAttributes)) {
    return "malformed";
  }
  return d;
}

const ALREADY_PAID =
  "That checkout has already been paid, so it can't be changed here — the order is real now. The customer should contact Piñatagrams support about changes.";
// unpaidBuilderDraft keys on the `builder` tag, so a storefront builder draft
// is also changeable here with its nonce (the same authority the storefront's
// own supersede has) — the wording says so.
const NOT_OURS = "That isn't an open checkout created by the Piñatagrams builder, so it can't be changed here.";
const NONCE_MISMATCH =
  "The nonce doesn't match that checkout — only the nonce returned when it was created can change it.";

/** Refuses an update whose `supersedes` can't be retired; null = go ahead. */
async function verifySupersedes(s: Supersedes): Promise<ReturnType<typeof toolError> | null> {
  const gql = await shopifyAdmin();
  if (!gql) return toolError(NO_CREDS_CREATE);
  if (await statusReadThrottled()) return toolError(TOO_MANY_CHECKS_CREATE);
  try {
    const d = await lookupDraft(gql, s.draftOrderId);
    if (d === null) {
      return toolError(
        "The checkout being replaced no longer exists (cancelled, replaced or expired) — use create_checkout for a fresh one. Nothing was created.",
      );
    }
    if (d === "malformed") {
      console.error("[mcp] update_checkout: unexpected draftOrder shape");
      return toolError(STORE_UNREACHABLE);
    }
    if (d.status === "COMPLETED" || d.order) return toolError(`${ALREADY_PAID} Nothing was created.`);
    if (!unpaidBuilderDraft(d)) return toolError(`${NOT_OURS} Nothing was created.`);
    if (!supersedeAllowed(d, s.nonce)) return toolError(`${NONCE_MISMATCH} Nothing was created.`);
    return null;
  } catch (e) {
    console.error(`[mcp] update_checkout: supersede lookup failed: ${e instanceof Error ? e.message : String(e)}`);
    return toolError(STORE_UNREACHABLE);
  }
}

/* ---- cancel -------------------------------------------------------------- */

async function cancel(args: Record<string, unknown>): Promise<unknown> {
  const problems: Problem[] = [];
  unknownKeys(args, ["draft_order_id", "nonce"], ORDER, "cancel_checkout", problems);
  const id = typeof args.draft_order_id === "string" ? args.draft_order_id.trim() : "";
  if (!DRAFT_GID_RE.test(id)) {
    problems.push({ at: ORDER, text: "draft_order_id must be the id a checkout returned (it looks like gid://shopify/DraftOrder/123)." });
  }
  const nonce = typeof args.nonce === "string" ? args.nonce.trim().toLowerCase() : "";
  if (!NONCE_RE.test(nonce)) {
    problems.push({ at: ORDER, text: "nonce is required: the 32-character nonce returned with the draft_order_id (it proves the request comes from the same conversation)." });
  }
  if (problems.length) return refuse(problems.map((p) => p.text), "this checkout can be cancelled");

  if (!orderingEnabled()) return toolError(ORDERING_OFF_CANCEL);
  const gql = await shopifyAdmin();
  if (!gql) return toolError(NO_CREDS_CANCEL);
  if (await statusReadThrottled()) return toolError(TOO_MANY_CHECKS_CANCEL);

  try {
    const d = await lookupDraft(gql, id);
    if (d === null) {
      return {
        status: "gone",
        draft_order_id: id,
        note: "No such checkout exists any more — it was already cancelled, replaced or expired. Nothing was charged.",
      };
    }
    if (d === "malformed") {
      console.error("[mcp] cancel_checkout: unexpected draftOrder shape");
      return toolError(STORE_UNREACHABLE);
    }
    if (d.status === "COMPLETED" || d.order) return toolError(`${ALREADY_PAID} Nothing was changed.`);
    if (!unpaidBuilderDraft(d)) return toolError(`${NOT_OURS} Nothing was changed.`);
    if (!supersedeAllowed(d, nonce)) return toolError(`${NONCE_MISMATCH} Nothing was changed.`);
    const del = await gql<{ draftOrderDelete: { deletedId: string | null; userErrors: { message?: string }[] } | null }>(
      `mutation($input: DraftOrderDeleteInput!) {
        draftOrderDelete(input: $input) { deletedId userErrors { field message } }
      }`,
      { input: { id } },
    );
    const out = del.draftOrderDelete;
    if (!out?.deletedId || out.userErrors?.length) {
      console.error(`[mcp] cancel_checkout: draftOrderDelete refused for ${id}: ${JSON.stringify(out)}`);
      return toolError("The store wouldn't cancel that checkout just now — try again in a minute. Nothing was charged.");
    }
    return {
      status: "cancelled",
      draft_order_id: id,
      note: "The unpaid checkout was deleted; its continue_url no longer works and nothing was charged.",
    };
  } catch (e) {
    console.error(`[mcp] cancel_checkout failed: ${e instanceof Error ? e.message : String(e)}`);
    return toolError("Checkout couldn't reach our store just now — nothing was changed. Please try again in a minute.");
  }
}

/* ---- status -------------------------------------------------------------- */

type CheckoutStatus = "open" | "paid" | "gone" | "unknown";
const STATUS_MEANING: Record<CheckoutStatus, string> = {
  open: "awaiting payment — the continue_url still works; nothing has been charged.",
  paid: "paid on Shopify — the draft became a real order.",
  gone: "no such checkout any more (cancelled, replaced or expired) — nothing was bought.",
  unknown: "couldn't tell right now — try again shortly; assume nothing changed.",
};

async function status(args: Record<string, unknown>): Promise<unknown> {
  const problems: Problem[] = [];
  unknownKeys(args, ["draft_order_id"], ORDER, "get_checkout_status", problems);
  const id = typeof args.draft_order_id === "string" ? args.draft_order_id.trim() : "";
  if (!DRAFT_GID_RE.test(id)) {
    problems.push({ at: ORDER, text: "draft_order_id must be the id a checkout returned (it looks like gid://shopify/DraftOrder/123)." });
  }
  if (problems.length) return refuse(problems.map((p) => p.text), "the status can be checked");

  const reply = (s: CheckoutStatus, reason?: string) => ({
    draft_order_id: id,
    status: s,
    meaning: STATUS_MEANING[s],
    ...(reason ? { reason } : {}),
  });

  const gql = await shopifyAdmin();
  if (!gql) return reply("unknown", "this deployment has no store credentials");
  if (await statusReadThrottled()) return reply("unknown", TOO_MANY_CHECKS);
  const s = await readDraftStatus(gql, id);
  return reply(s.status, s.reason);
}

/** One draftOrder(id) read, mapped as src/app/api/order-status/route.ts does:
 *  "gone" only on Shopify's explicit null, never on a missing answer. The
 *  caller has already passed the throttle. Never throws. */
async function readDraftStatus(gql: Gql, id: string): Promise<{ status: CheckoutStatus; reason?: string }> {
  try {
    const data = await gql<{ draftOrder: { status: string; order: { id: string } | null } | null }>(
      `query($id: ID!) { draftOrder(id: $id) { status order { id } } }`,
      { id },
    );
    const draft = data.draftOrder;
    if (draft === null) return { status: "gone" };
    if (!draft) return { status: "unknown" };
    if (draft.status === "COMPLETED" || draft.order) return { status: "paid" };
    if (draft.status === "OPEN" || draft.status === "INVOICE_SENT") return { status: "open" };
    return { status: "unknown" };
  } catch (e) {
    console.error(`[mcp] draft status read failed: ${e instanceof Error ? e.message : String(e)}`);
    return { status: "unknown", reason: "the store didn't answer" };
  }
}

/* ---- schemas ------------------------------------------------------------- */

const LINE_SCHEMA = {
  type: "object",
  required: ["style_id", "qty", "filling", "graphic", "delivery_date"],
  properties: {
    style_id: { type: "string", description: 'Body style id from get_catalog, e.g. "standard" (must be in stock).' },
    qty: { type: "integer", minimum: 1, maximum: MAX_QTY, description: `How many of this exact piñata (1–${MAX_QTY}).` },
    filling: { type: "string", description: 'Filling id or label from get_catalog, e.g. "candy" or "Candy".' },
    graphic: {
      type: "object",
      required: ["type"],
      properties: {
        type: {
          type: "string",
          enum: ["classic", "library", "hub"],
          description:
            "classic = the included Classic Piñatagrams design (no upcharge); library = a design-library code from list_designs (set design); hub = a hub graphic code from list_designs (set design). Custom artwork is not available here — send the customer to builder.pinatagrams.com.",
        },
        design: { type: "string", description: 'Design code, required for library and hub (e.g. "HBD06", "H0001").' },
      },
      additionalProperties: false,
    },
    add_ons: {
      type: "array",
      items: { type: "string" },
      maxItems: MAX_ADDONS,
      description: `Optional add-on ids from get_catalog, e.g. ["double-candy"] — up to ${MAX_ADDONS} distinct per line. Some fillings allow none.`,
    },
    message: {
      type: "string",
      maxLength: MESSAGE_MAX,
      description: `Optional message printed on the card inside, up to ${MESSAGE_MAX} characters. Confirm the wording with the customer first.`,
    },
    delivery_date: {
      type: "string",
      pattern: "^\\d{4}-\\d{2}-\\d{2}$",
      description: "Arrival date, YYYY-MM-DD in America/Chicago. FedEx: the exact day; USPS: the target of a window. Validate with get_delivery_options.",
    },
  },
  additionalProperties: false,
};

const SHIP_TO_SCHEMA = {
  type: "object",
  required: ["name", "address1", "city", "state", "zip"],
  properties: {
    name: { type: "string", maxLength: ADDRESS_MAX.name, description: "Recipient's name as it should appear on the label." },
    address1: { type: "string", maxLength: ADDRESS_MAX.address1, description: "Street address." },
    address2: { type: "string", maxLength: ADDRESS_MAX.address2, description: "Apartment, suite or unit (optional)." },
    city: { type: "string", maxLength: ADDRESS_MAX.city },
    state: { type: "string", minLength: 2, maxLength: 2, description: '2-letter US state code, e.g. "TX".' },
    zip: { type: "string", pattern: "^\\d{5}(-\\d{4})?$", description: "US ZIP code." },
    phone: { type: "string", maxLength: ADDRESS_MAX.phone, description: "Recipient phone for the carrier (optional but recommended)." },
  },
  additionalProperties: false,
  description: "The ONE US address the whole order ships to (one order = one address).",
};

const ORDER_PROPERTIES = {
  carrier: {
    type: "string",
    enum: CARRIERS,
    description: "How the whole order ships: fedex (2-Day, guaranteed arrival date) or usps (First Class, arrives in a window around the chosen date).",
  },
  lines: {
    type: "array",
    minItems: 1,
    maxItems: MAX_LINES,
    description: `One entry per piñata design, ${MAX_LINES} at most. Piñatas with the same style, graphic, filling, add-ons, message and date share a line via qty.`,
    items: LINE_SCHEMA,
  },
  ship_to: SHIP_TO_SCHEMA,
  email: {
    type: "string",
    description: "Optional payer email: prefills Shopify's contact field so the order confirmation goes there. No email is sent by this tool.",
  },
  discount_codes: {
    type: "array",
    items: { type: "string" },
    maxItems: MAX_CODES,
    description: "Optional, up to two codes (one order + one shipping). Shopify applies them at payment; the preview total does not include them.",
  },
  dry_run: {
    type: "boolean",
    description: "Default true: return the priced preview without creating anything. Set false ONLY together with confirm:true after the customer explicitly approved the preview.",
  },
  confirm: {
    type: "boolean",
    description: "Default false. true together with dry_run:false creates the checkout. Never set it before the customer has seen the preview and said yes.",
  },
  idempotency_key: {
    type: "string",
    minLength: IDEMPOTENCY_KEY_MIN,
    maxLength: IDEMPOTENCY_KEY_MAX,
    description: `Recommended on every confirm: a UUID (${IDEMPOTENCY_KEY_MIN}–${IDEMPOTENCY_KEY_MAX} printable characters, no spaces). Repeating a confirm with the same key and the same request returns the same checkout instead of creating a second one — after re-checking that its draft is still open (a cancelled or paid one is refused: after a cancellation start again with a new key; after payment the order already exists — never create another). Best effort: replays live per server instance for 24h, and anyone presenting the same key with the identical request gets the stored result, so keep keys random and private. The same key with a different request is refused.`,
  },
  agent: { type: "string", description: "Optional: who is ordering (e.g. the assistant's name). Analytics only." },
};

/* ---- the tools ----------------------------------------------------------- */

export const checkoutTools: Record<string, ToolDef> = {
  create_checkout: {
    description:
      `Create a Shopify checkout for ONE single-address order (1–${MAX_LINES} lines, up to ${MAX_QTY} piñatas per line) — the only way to buy through this connector. TWO-STEP RULE: call it first with dry_run true (the default) to get the priced preview (each line, add-ons, shipping, total before tax, arrival date, ship-to); show that preview to the customer; only after they explicitly say yes, call it again with the same arguments plus dry_run:false AND confirm:true. That creates one unpaid Shopify draft order and returns status "ready_for_complete" with continue_url — Shopify's secure hosted payment page. Show continue_url to the customer verbatim; they pay there and tax is added there. Until they pay, nothing is ordered, charged or reserved — never say the order is placed, paid or reserved (check with get_checkout_status instead). Use ids, labels and design codes exactly as get_catalog and list_designs return them: carrier fedex (2-Day, exact arrival date) or usps (First Class, arrival window); lines of style_id, qty, filling, graphic ({"type":"classic"}, {"type":"library","design":"HBD06"} or {"type":"hub","design":"H0001"}), optional add_ons (up to ${MAX_ADDONS} per line), optional message (≤${MESSAGE_MAX} characters, printed inside), delivery_date YYYY-MM-DD; ship_to (name, address1, address2?, city, 2-letter state, zip, phone?) for one US address; optional email, discount_codes (≤${MAX_CODES}), idempotency_key (a UUID; recommended on every confirm) and agent. Custom artwork is not available here — send the customer to ${BUILDER_URL}. Hosted assistants share egress IPs, so the store's checkout limiter may refuse a burst of confirms ("Too many checkout attempts") even from a well-behaved session: wait a minute and retry ONCE with the SAME idempotency_key — never retry in a loop. Refusals name every problem at once. Amounts are integer cents USD before tax. Keep the returned draft_order_id and nonce: update_checkout and cancel_checkout need them.`,
    inputSchema: {
      type: "object",
      required: ["carrier", "lines", "ship_to"],
      properties: ORDER_PROPERTIES,
      additionalProperties: false,
    },
    annotations: WRITE,
    handler: (args) => run(args, "create"),
  },

  update_checkout: {
    description:
      "Replace an unpaid checkout with a corrected one (a changed line, date, address or message). Same inputs and the same TWO-STEP RULE as create_checkout — dry_run first, show the preview, get an explicit yes, then dry_run:false with confirm:true — plus supersedes: { draft_order_id, nonce } of the checkout being replaced, exactly as it was returned. On confirm the new draft order is created first and the old one is retired if it is still unpaid (a paid one is left alone). Returns the NEW continue_url, draft_order_id and nonce: show the new continue_url verbatim; the old link stops working. Nothing is ordered, charged or reserved until the customer pays on Shopify.",
    inputSchema: {
      type: "object",
      required: ["carrier", "lines", "ship_to", "supersedes"],
      properties: {
        ...ORDER_PROPERTIES,
        supersedes: {
          type: "object",
          required: ["draft_order_id", "nonce"],
          properties: {
            draft_order_id: { type: "string", description: "The draft_order_id the checkout being replaced returned (gid://shopify/DraftOrder/…)." },
            nonce: { type: "string", description: "The nonce returned with it." },
          },
          additionalProperties: false,
          description: "The unpaid checkout this one replaces.",
        },
      },
      additionalProperties: false,
    },
    annotations: WRITE,
    handler: (args) => run(args, "update"),
  },

  cancel_checkout: {
    description:
      "Cancel an unpaid checkout created by the Piñatagrams builder (through this connector or at builder.pinatagrams.com): deletes the draft order so its continue_url stops working. Needs the draft_order_id and the nonce returned when it was created (the nonce proves the request comes from the same conversation; without a match nothing is changed). A checkout the customer has already paid cannot be cancelled here — the order is real, and the customer should contact Piñatagrams support. Result status: cancelled, or gone when it was already removed. Lookups are throttled (30 a minute per connection). This tool never charges anything.",
    inputSchema: {
      type: "object",
      required: ["draft_order_id", "nonce"],
      properties: {
        draft_order_id: { type: "string", description: "gid://shopify/DraftOrder/… as returned by create_checkout or update_checkout." },
        nonce: { type: "string", description: "The nonce returned with that draft_order_id." },
      },
      additionalProperties: false,
    },
    annotations: DESTRUCTIVE,
    handler: cancel,
  },

  get_checkout_status: {
    description:
      "Where a checkout stands: open (awaiting payment — continue_url still works), paid (the customer paid on Shopify and a real order now exists), gone (cancelled, replaced or expired — nothing was bought) or unknown (couldn't tell; try again shortly and assume nothing changed). Returns only that status — never names, addresses or totals. Use it after sharing continue_url to learn whether the customer has paid, instead of guessing or claiming. Throttled to 30 checks a minute per connection: check once when the customer says they have paid, not in a loop.",
    inputSchema: {
      type: "object",
      required: ["draft_order_id"],
      properties: {
        draft_order_id: { type: "string", description: "gid://shopify/DraftOrder/… as returned by create_checkout or update_checkout." },
      },
      additionalProperties: false,
    },
    annotations: READ_ONLY,
    handler: status,
  },
};
