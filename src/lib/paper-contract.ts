import type { Carrier } from "@/lib/delivery";

/**
 * THE PAPER CONTRACT — frozen 2026-10-15.
 *
 * Everything the live Paper backend (pinatagrams-monorepo, apps/backend)
 * reads off a builder draft order, as exported constants, plus validators
 * that refuse a draft line / draft input that drifts from it. Mirrored from
 * src/app/api/checkout/route.ts (the money path) and verified against paid
 * orders #198181 and #198195.
 *
 * This module DESCRIBES and CHECKS the contract; it never changes what
 * checkout emits. route.ts still carries its own private copies of the SKU
 * rule, the art regexes, the attribute literals and the shipping titles —
 * they must stay identical, and the two goldens (src/lib/checkout-golden.test.ts
 * for the dry-run shape, src/lib/checkout-golden-live.test.ts for the live
 * DraftOrderInput shape) fail loudly if they diverge.
 */

export const PAPER_CONTRACT_FROZEN_ON = "2026-10-15";

/* ---------------------------------------------------------------------------
 * Product + SKU
 * ------------------------------------------------------------------------- */

/** The generic "Custom Built Piñatagram" product every builder piñata line
 *  attaches to: one variant per body style, SKU CUSTOM-{BODY}. */
export const CUSTOM_PRODUCT_GID = "gid://shopify/Product/7741496623202";

/** Paper derives the body style from the SKU by splitting on the LAST
 *  hyphen, so the body part is upper-cased with SPACES, never hyphens. */
export const CUSTOM_SKU_PREFIX = "CUSTOM-";

/** Body ids whose SKU suffix is not the mechanical upper-case/space form. */
export const CUSTOM_SKU_SUFFIX_SPECIAL: Readonly<Record<string, string>> =
  Object.freeze({
    "white-uni": "WHITE UNICORN",
    "pink-uni": "PINK UNICORN",
  });

/** `googly` → "CUSTOM-GOOGLY"; `star-spangled` → "CUSTOM-STAR SPANGLED";
 *  `white-uni` → "CUSTOM-WHITE UNICORN"; `pink-uni` → "CUSTOM-PINK UNICORN". */
export function customSkuFor(styleId: string): string {
  return `${CUSTOM_SKU_PREFIX}${
    CUSTOM_SKU_SUFFIX_SPECIAL[styleId] ?? styleId.toUpperCase().replace(/-/g, " ")
  }`;
}

/* ---------------------------------------------------------------------------
 * Line-item custom attributes
 * ------------------------------------------------------------------------- */

/** Visible attributes (no underscore → shown under the line on the payment
 *  page and invoice). `Add-ons` rides only when the line has add-ons. */
export const LINE_VISIBLE_ATTR = Object.freeze({
  graphic: "Graphic",
  bodyStyle: "Body style",
  filling: "Filling",
  addons: "Add-ons",
  arrives: "Arrives",
} as const);

/** Hidden machine rails (underscore) + `message`: what Paper reads.
 *  - _frontGraphic: https URL on cdn.shopify.com (library pick) or the
 *    builder Blob host (custom design / hub graphic). Paper prints this file.
 *  - _frontGraphicSha256: lowercase hex sha256 of the Blob bytes — REQUIRED
 *    for Blob art (Paper re-hashes and refuses a mismatch), ABSENT for cdn art.
 *  - _designJson: optional Blob URL of the editor's design sidecar.
 *  - _fillings: the filling label (same string as visible `Filling`).
 *  - _addons: comma-separated add-on labels (same string as `Add-ons`).
 *  - _requestedDate: YYYY-MM-DD, Paper's scheduling anchor.
 *  - _carrier: "fedex" | "usps" — emitted only on storefronts offering USPS.
 *  - _requestedWindow: "YYYY-MM-DD..YYYY-MM-DD", USPS lines only.
 *  - message: the recipient's message (≤ MESSAGE_MAX_CHARS), only when any.
 *    Paper falls back to the ORDER NOTE when this is absent, which is why a
 *    draft must never carry a `note` (see DRAFT_FORBIDDEN_KEYS). */
export const LINE_RAIL_ATTR = Object.freeze({
  bodyStyle: "_bodyStyle",
  design: "_design",
  frontGraphic: "_frontGraphic",
  frontGraphicSha256: "_frontGraphicSha256",
  designJson: "_designJson",
  fillings: "_fillings",
  addons: "_addons",
  requestedDate: "_requestedDate",
  carrier: "_carrier",
  requestedWindow: "_requestedWindow",
  message: "message",
} as const);

/** Present on EVERY piñata line. */
export const LINE_ATTR_REQUIRED: readonly string[] = Object.freeze([
  LINE_VISIBLE_ATTR.graphic,
  LINE_VISIBLE_ATTR.bodyStyle,
  LINE_VISIBLE_ATTR.filling,
  LINE_VISIBLE_ATTR.arrives,
  LINE_RAIL_ATTR.bodyStyle,
  LINE_RAIL_ATTR.design,
  LINE_RAIL_ATTR.frontGraphic,
  LINE_RAIL_ATTR.fillings,
  LINE_RAIL_ATTR.requestedDate,
]);

/** Present only under their condition (add-ons, Blob art, sidecar, USPS
 *  storefront, USPS carrier, a non-empty message). */
export const LINE_ATTR_CONDITIONAL: readonly string[] = Object.freeze([
  LINE_VISIBLE_ATTR.addons,
  LINE_RAIL_ATTR.frontGraphicSha256,
  LINE_RAIL_ATTR.designJson,
  LINE_RAIL_ATTR.addons,
  LINE_RAIL_ATTR.carrier,
  LINE_RAIL_ATTR.requestedWindow,
  LINE_RAIL_ATTR.message,
]);

/** Every key a piñata line may carry. Anything else is contract drift. */
export const LINE_ATTR_KEYS: readonly string[] = Object.freeze([
  ...LINE_ATTR_REQUIRED,
  ...LINE_ATTR_CONDITIONAL,
]);

/** `_design` value for a canvas-made design (its art is Blob-hosted). */
export const CUSTOM_DESIGN_CODE = "custom";
/** `_design` value for a library pick (Shopify design code, e.g. HBD02,
 *  STANDARD) or a hub graphic (H0001-style). */
export const DESIGN_CODE_RE = /^[A-Z0-9]{2,24}$/;

/** How `_addons` / `Add-ons` join labels — exactly how Paper splits them. */
export const ADDONS_SEPARATOR = ", ";

/** `message` attribute cap (checkout truncates at this many characters). */
export const MESSAGE_MAX_CHARS = 300;

/* ---------------------------------------------------------------------------
 * Art hosts + fingerprints
 * ------------------------------------------------------------------------- */

export const SHOPIFY_CDN_HOST = "cdn.shopify.com";
/** The builder's OWN Blob store — exact hostname; Paper allowlists the same
 *  string (full equality) before snapshotting art at ingest. */
export const BUILDER_BLOB_HOST = "yrfds6n4iwscziqm.public.blob.vercel-storage.com";
export const ALLOWED_ART_HOSTS: readonly string[] = Object.freeze([
  SHOPIFY_CDN_HOST,
  BUILDER_BLOB_HOST,
]);
/** Byte-identical to route.ts ART_RE / BLOB_RE: https, the exact lowercase
 *  host, no port, and at least a "/" path. The validators test THESE — a
 *  URL-parse + hostname comparison would also admit ":443", an upper-case
 *  host and a bare origin, all of which checkout refuses. */
export const SHOPIFY_CDN_ART_RE = /^https:\/\/cdn\.shopify\.com\//;
export const BUILDER_BLOB_ART_RE =
  /^https:\/\/yrfds6n4iwscziqm\.public\.blob\.vercel-storage\.com\//;
/** Lowercase hex sha256 of the uploaded print bytes. */
export const SHA256_RE = /^[a-f0-9]{64}$/;

/** The allowed art host a URL is on — by the route's own regexes (exact
 *  acceptance, not a URL parse) — else null. */
export function artHost(url: string): string | null {
  if (SHOPIFY_CDN_ART_RE.test(url)) return SHOPIFY_CDN_HOST;
  if (BUILDER_BLOB_ART_RE.test(url)) return BUILDER_BLOB_HOST;
  return null;
}

/* ---------------------------------------------------------------------------
 * Dates, carriers, money
 * ------------------------------------------------------------------------- */

export const CARRIERS: readonly Carrier[] = Object.freeze(["fedex", "usps"]);
export const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
export const REQUESTED_WINDOW_RE = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/;
/** Draft-order money is a 2-decimal string ("33.49"). */
export const MONEY_RE = /^\d+\.\d{2}$/;

/** YYYY-MM-DD that exists on the calendar (rejects 2026-02-30). */
export function isCalendarDate(ymd: string): boolean {
  if (!YMD_RE.test(ymd)) return false;
  const [y, m, d] = ymd.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/* ---------------------------------------------------------------------------
 * Shipping line
 * ------------------------------------------------------------------------- */

/** ⚠ LOAD-BEARING: Paper's fulfill-date logic branches on a shipping title
 *  that starts with this word (→ ship 2 business days before the requested
 *  date, the FedEx 2-Day math; anything else → the ~5-day standard lead,
 *  which is USPS First Class's schedule). FedEx's title MUST start with it;
 *  USPS's MUST NOT. */
export const GUARANTEED_PREFIX = "Guaranteed";
export const SHIPPING_LINE_TITLE: Readonly<Record<Carrier, string>> = Object.freeze({
  fedex: "Guaranteed delivery on your selected dates",
  usps: "USPS First Class — arrives around your selected dates",
});
/** Appended when a hub free-shipping code zeroes the line. */
export const FREE_SHIPPING_SUFFIX = " — free shipping";

export function shippingLineTitle(carrier: Carrier, freeShipping = false): string {
  return `${SHIPPING_LINE_TITLE[carrier]}${freeShipping ? FREE_SHIPPING_SUFFIX : ""}`;
}

/** Paper's branch: startsWith "guaranteed", case-insensitive. */
export function isGuaranteedShippingTitle(title: string): boolean {
  return title.trim().toLowerCase().startsWith(GUARANTEED_PREFIX.toLowerCase());
}

// Module-load self-check of the prefix rule against the constants above. The
// validators only ever accept these exact titles (carrierOfShippingTitle), so
// a mis-edited constant could not be caught by a per-draft check — it would
// make every draft "valid" while Paper scheduled USPS as FedEx 2-Day (or
// FedEx on the slow lead). Fail at import instead.
if (
  !isGuaranteedShippingTitle(SHIPPING_LINE_TITLE.fedex) ||
  !isGuaranteedShippingTitle(shippingLineTitle("fedex", true)) ||
  isGuaranteedShippingTitle(SHIPPING_LINE_TITLE.usps) ||
  isGuaranteedShippingTitle(shippingLineTitle("usps", true))
) {
  throw new Error(
    `Paper contract: shipping title prefix rule violated — FedEx must start with "${GUARANTEED_PREFIX}", USPS must not`,
  );
}

/** Which carrier a builder shipping title encodes (free-shipping variant
 *  included), or null for a title the contract doesn't know. */
export function carrierOfShippingTitle(title: string): Carrier | null {
  for (const c of CARRIERS) {
    if (title === SHIPPING_LINE_TITLE[c] || title === shippingLineTitle(c, true)) return c;
  }
  return null;
}

/* ---------------------------------------------------------------------------
 * Order level
 * ------------------------------------------------------------------------- */

/** Order-level customAttributes: underscore forensics only (never shown to
 *  the customer, never on the order note). */
export const ORDER_ATTR = Object.freeze({
  builderHost: "_builderHost",
  builderFlow: "_builderFlow",
  builderVariant: "_builderVariant",
  builderCatalog: "_builderCatalog",
  builderNonce: "_builderNonce",
} as const);
export const ORDER_ATTR_REQUIRED: readonly string[] = Object.freeze(Object.values(ORDER_ATTR));
/** Visit ids, emitted only when the client sends them. Paper ignores them. */
export const ORDER_ANALYTICS_ATTR_KEYS: readonly string[] = Object.freeze([
  "_phDistinctId",
  "_phSessionId",
  "_gaClientId",
  "_fbp",
  "_fbc",
]);
export const NONCE_RE = /^[a-f0-9]{32}$/;

export const ORDER_TAG_BUILDER = "builder";
export const ORDER_TAG_VARIANT_PREFIX = "variant-";
export const ORDER_TAG_VARIANT_RE = /^variant-[a-z0-9-]{1,32}$/;

/** Ordering-MCP provenance (Phase 2, 2026-10-15): emitted TOGETHER,
 *  immediately after _builderNonce and before any analytics key, only when
 *  the draft was placed through the MCP (CheckoutBody.source === "mcp") — and
 *  then the draft also carries ORDER_TAG_MCP after builder + variant-*.
 *  Absent on storefront drafts; Paper ignores both.
 *  - _orderSource: the literal ORDER_SOURCE_MCP.
 *  - _orderAgent: the connector's self-reported client name as checkout
 *    sanitized it (ORDER_AGENT_RE; ORDER_AGENT_UNKNOWN when nothing
 *    survived). ATTACKER-CONTROLLED and analytics-only — never a trust input
 *    anywhere (not here, not in Paper, not in the hub). */
export const ORDER_MCP_ATTR = Object.freeze({
  source: "_orderSource",
  agent: "_orderAgent",
} as const);
export const ORDER_MCP_ATTR_KEYS: readonly string[] = Object.freeze(Object.values(ORDER_MCP_ATTR));
export const ORDER_SOURCE_MCP = "mcp";
export const ORDER_TAG_MCP = "mcp";
export const ORDER_AGENT_MAX_CHARS = 64;
/** What survives checkout's sanitizer: the allowlisted characters, 1–64 of
 *  them, never a leading or trailing space (checkout trims after slicing, so
 *  the contract is exactly as tight as what the route can emit). */
export const ORDER_AGENT_RE = /^[A-Za-z0-9._/:-](?:[A-Za-z0-9 ._/:-]{0,62}[A-Za-z0-9._/:-])?$/;
export const ORDER_AGENT_UNKNOWN = "unknown";

/** Never on a builder draft. `note`: Paper prints the order note as the
 *  recipient's message on any line without a `message` attribute.
 *  `corp_ref`: a corporate-portal rail that B2C drafts must not carry. */
export const DRAFT_FORBIDDEN_KEYS: readonly string[] = Object.freeze(["note", "corp_ref"]);

/* ---------------------------------------------------------------------------
 * Validators
 * ------------------------------------------------------------------------- */

export class PaperContractError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`Paper contract: ${message}`);
    this.name = "PaperContractError";
    this.code = code;
  }
}

const fail = (code: string, message: string): never => {
  throw new PaperContractError(code, message);
};

export type PaperLineCheck =
  | {
      kind: "pinata";
      /** Line title when present, else the sku / variantId / "piñata line". */
      label: string;
      attrs: Readonly<Record<string, string>>;
      /** The SKU the line should attach to (from _bodyStyle). */
      sku: string;
    }
  | { kind: "addon"; label: string };

export type PaperLineOpts = {
  /** The order's carrier (the shipping line's) — a line's _carrier must
   *  agree with it. */
  carrier?: Carrier;
  /** Live drafts only: the Shopify variant ids the hub's add-ons resolve to.
   *  When supplied, a live add-on line must attach to one of them and no
   *  piñata line may. (Dry-run add-on lines are identified by title and
   *  mapped onto the piñata lines' _addons by assertPaperDraft instead.) */
  addonVariantIds?: ReadonlySet<string>;
};

export type PaperDraftOpts = Pick<PaperLineOpts, "addonVariantIds">;

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function isPosInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1;
}

/** Collects `customAttributes` into a key→value map; refuses malformed
 *  entries and duplicate keys. */
function readAttrs(raw: unknown, label: string): Record<string, string> {
  if (!Array.isArray(raw)) return fail("attrs_not_array", `${label}: customAttributes must be an array`);
  const out: Record<string, string> = {};
  for (const a of raw as unknown[]) {
    if (!isRecord(a) || typeof a.key !== "string" || !a.key || typeof a.value !== "string")
      return fail("attr_malformed", `${label}: every customAttribute must be { key: string, value: string } — got ${JSON.stringify(a)}`);
    if (a.key in out) return fail("attr_duplicate", `${label}: duplicate attribute key "${a.key}"`);
    out[a.key] = a.value;
  }
  return out;
}

/** Draft-order money: a 2-decimal string. A piñata line is always > 0 (the
 *  route refuses a zero unit price before composing anything); an add-on line
 *  carries the hub add-on's priceCents verbatim and the hub does not forbid
 *  0¢, so "0.00" is legal there and only there. */
function checkMoney(v: unknown, what: string, label: string, allowZero: boolean): void {
  if (typeof v !== "string" || !MONEY_RE.test(v) || (!allowZero && Number(v) <= 0))
    fail(
      "money_format",
      `${label}: ${what} must be a ${allowZero ? "non-negative" : "positive"} 2-decimal string like "33.49" — got ${JSON.stringify(v)}`,
    );
}

/**
 * Refuse a draft-order line item that violates the contract; return what it
 * is. Accepts both shapes checkout produces and requires EXACTLY the pricing
 * field of its shape — the hub's composed price must ride on every line, or
 * Shopify would charge the variant's own price:
 *   - dry-run custom line: { title, originalUnitPrice, quantity, customAttributes? }
 *   - live variant line:   { variantId, priceOverride: { amount, currencyCode: "USD" },
 *                            quantity, customAttributes? }
 * A `sku` field is optional and, when present on a piñata line, must equal
 * customSkuFor(_bodyStyle).
 *
 * A piñata line = any line carrying a `customAttributes` field, or whose sku
 * starts with CUSTOM-. An EMPTY customAttributes array is a piñata line that
 * lost its rails — a contract failure, never an add-on. Everything else is an
 * add-on line (its own product, no attributes — the per-piñata mapping rides
 * on the piñata's _addons).
 */
export function assertPaperLine(lineItem: unknown, opts: PaperLineOpts = {}): PaperLineCheck {
  if (!isRecord(lineItem)) return fail("line_not_object", "line item must be an object");
  const li = lineItem;
  const sku = typeof li.sku === "string" ? li.sku : null;
  const variantId = typeof li.variantId === "string" ? li.variantId : null;
  const live = variantId !== null;
  const title = typeof li.title === "string" ? li.title : "";
  const skuIsCustom = sku !== null && sku.startsWith(CUSTOM_SKU_PREFIX);
  const isPinata = li.customAttributes !== undefined || skuIsCustom;
  const label = title || sku || variantId || (isPinata ? "piñata line" : "line");

  if (!isPosInt(li.quantity))
    fail("quantity_invalid", `${label}: quantity must be a positive integer — got ${JSON.stringify(li.quantity)}`);

  // Exactly one pricing field, the one its shape uses, carrying the hub's
  // composed amount. (Zero is legal on an add-on line only — see checkMoney.)
  const allowZero = !isPinata;
  if (live) {
    if (li.originalUnitPrice !== undefined)
      fail("price_field_mixed", `${label}: a live line (variantId) prices through priceOverride only — originalUnitPrice must be absent`);
    const po = li.priceOverride;
    if (!isRecord(po))
      return fail(
        "price_missing",
        `${label}: live line must carry priceOverride { amount, currencyCode } (the hub price is authoritative — without it Shopify charges the variant's own price)`,
      );
    checkMoney(po.amount, "priceOverride.amount", label, allowZero);
    if (po.currencyCode !== "USD")
      fail("currency", `${label}: priceOverride.currencyCode must be "USD" — got ${JSON.stringify(po.currencyCode)}`);
  } else {
    if (li.priceOverride !== undefined)
      fail("price_field_mixed", `${label}: a dry-run line (no variantId) prices through originalUnitPrice only — priceOverride must be absent`);
    if (li.originalUnitPrice === undefined)
      fail("price_missing", `${label}: dry-run line must carry originalUnitPrice (the hub's composed price)`);
    checkMoney(li.originalUnitPrice, "originalUnitPrice", label, allowZero);
  }

  if (!isPinata) {
    if (!title && !live)
      fail("addon_unidentified", "add-on line needs a title (dry-run) or a variantId (live)");
    if (opts.addonVariantIds && variantId !== null && !opts.addonVariantIds.has(variantId))
      fail("addon_variant_unknown", `${label}: add-on line attaches to variant ${variantId}, which is not one of the hub add-ons' variants`);
    return { kind: "addon", label: title || String(variantId) };
  }

  if (li.customAttributes === undefined)
    fail("attrs_missing", `${label}: a ${CUSTOM_SKU_PREFIX}* line must carry customAttributes (no _frontGraphic, no _bodyStyle — Paper cannot print it)`);
  const attrs = readAttrs(li.customAttributes, label);
  if (Object.keys(attrs).length === 0)
    fail("attrs_empty", `${label}: customAttributes is empty — a piñata line that lost its rails is unprintable, and it is never an add-on`);
  if (opts.addonVariantIds && variantId !== null && opts.addonVariantIds.has(variantId))
    fail("pinata_on_addon_variant", `${label}: a piñata line is attached to an add-on's variant (${variantId})`);

  const unknown = Object.keys(attrs).filter((k) => !LINE_ATTR_KEYS.includes(k));
  if (unknown.length)
    fail("attr_unknown", `${label}: attribute key(s) outside the frozen contract: ${unknown.map((k) => `"${k}"`).join(", ")}`);
  const missing = LINE_ATTR_REQUIRED.filter((k) => !(k in attrs));
  if (missing.length)
    fail("attr_missing", `${label}: missing required attribute(s): ${missing.join(", ")}`);
  const empty = Object.entries(attrs).filter(([, v]) => v.trim() === "").map(([k]) => k);
  if (empty.length)
    fail("attr_empty", `${label}: empty attribute value(s) — omit the key instead: ${empty.join(", ")}`);

  const A = LINE_RAIL_ATTR;
  const V = LINE_VISIBLE_ATTR;
  const bodyStyle = attrs[A.bodyStyle];
  if (!/^[a-z0-9-]+$/.test(bodyStyle))
    fail("body_style_invalid", `${label}: _bodyStyle must be a lowercase slug (the hub body id) — got "${bodyStyle}"`);
  const expectedSku = customSkuFor(bodyStyle);
  if (sku !== null && sku !== expectedSku)
    fail("sku_mismatch", `${label}: sku "${sku}" does not match _bodyStyle "${bodyStyle}" (expected "${expectedSku}")`);

  const design = attrs[A.design];
  const isCustom = design === CUSTOM_DESIGN_CODE;
  if (!isCustom && !DESIGN_CODE_RE.test(design))
    fail("design_invalid", `${label}: _design must be "${CUSTOM_DESIGN_CODE}" or a design code matching ${DESIGN_CODE_RE} — got "${design}"`);

  // Art acceptance is the route's regexes verbatim (ART_RE / BLOB_RE): https,
  // exact lowercase host, no port, a path. Not a URL parse.
  const art = attrs[A.frontGraphic];
  const host = artHost(art);
  if (!host)
    fail("art_host", `${label}: _frontGraphic must be an https URL on ${ALLOWED_ART_HOSTS.join(" or ")} (exact host, no port, with a path) — got "${art}"`);
  const onBlob = host === BUILDER_BLOB_HOST;
  if (isCustom && !onBlob)
    fail("custom_art_not_blob", `${label}: a "${CUSTOM_DESIGN_CODE}" design must point _frontGraphic at ${BUILDER_BLOB_HOST} — got "${art}"`);
  const sha = attrs[A.frontGraphicSha256];
  if (onBlob) {
    if (sha === undefined)
      fail("sha_missing", `${label}: Blob-hosted _frontGraphic requires _frontGraphicSha256 (Paper re-hashes the download)`);
    if (!SHA256_RE.test(sha))
      fail("sha_invalid", `${label}: _frontGraphicSha256 must be 64 lowercase hex chars — got "${sha}"`);
  } else if (sha !== undefined) {
    fail("sha_unexpected", `${label}: _frontGraphicSha256 is only emitted for Blob-hosted art, not ${host}`);
  }
  const sidecar = attrs[A.designJson];
  if (sidecar !== undefined && !BUILDER_BLOB_ART_RE.test(sidecar))
    fail("design_json_host", `${label}: _designJson must be an https URL on ${BUILDER_BLOB_HOST} (exact host, no port, with a path) — got "${sidecar}"`);

  if (attrs[A.fillings] !== attrs[V.filling])
    fail("filling_mismatch", `${label}: _fillings ("${attrs[A.fillings]}") must equal Filling ("${attrs[V.filling]}")`);

  const addonsRail = attrs[A.addons];
  const addonsVisible = attrs[V.addons];
  if ((addonsRail === undefined) !== (addonsVisible === undefined))
    fail("addons_pairing", `${label}: _addons and Add-ons must be emitted together or not at all`);
  if (addonsRail !== undefined) {
    if (addonsRail !== addonsVisible)
      fail("addons_mismatch", `${label}: _addons ("${addonsRail}") must equal Add-ons ("${addonsVisible}")`);
    if (addonsRail.split(ADDONS_SEPARATOR).some((t) => !t.trim()))
      fail("addons_format", `${label}: _addons must be labels joined by "${ADDONS_SEPARATOR}" — got "${addonsRail}"`);
  }

  const date = attrs[A.requestedDate];
  if (!isCalendarDate(date))
    fail("date_invalid", `${label}: _requestedDate must be a real YYYY-MM-DD date — got "${date}"`);

  const carrier = attrs[A.carrier];
  if (carrier !== undefined && !(CARRIERS as readonly string[]).includes(carrier))
    fail("carrier_invalid", `${label}: _carrier must be one of ${CARRIERS.join("|")} — got "${carrier}"`);
  if (opts.carrier && carrier !== undefined && carrier !== opts.carrier)
    fail("carrier_mismatch", `${label}: _carrier "${carrier}" disagrees with the order's shipping line (${opts.carrier})`);

  const window = attrs[A.requestedWindow];
  const usps = carrier === "usps";
  if (usps && window === undefined)
    fail("window_missing", `${label}: a USPS line must carry _requestedWindow`);
  if (!usps && window !== undefined)
    fail("window_unexpected", `${label}: _requestedWindow is USPS-only (this line's _carrier is ${carrier ?? "absent → fedex"})`);
  if (window !== undefined) {
    const m = REQUESTED_WINDOW_RE.exec(window);
    if (!m || !isCalendarDate(m[1]) || !isCalendarDate(m[2]))
      fail("window_invalid", `${label}: _requestedWindow must be "YYYY-MM-DD..YYYY-MM-DD" — got "${window}"`);
    else if (!(m[1] <= date && date <= m[2]))
      fail("window_range", `${label}: _requestedWindow ${window} must bracket _requestedDate ${date}`);
  }

  const message = attrs[A.message];
  if (message !== undefined && message.length > MESSAGE_MAX_CHARS)
    fail("message_too_long", `${label}: message is ${message.length} chars; the cap is ${MESSAGE_MAX_CHARS}`);

  return { kind: "pinata", label, attrs, sku: expectedSku };
}

/**
 * Refuse a whole DraftOrderInput that violates the contract: forbidden keys,
 * tags, order-level forensics, the shipping-line title/carrier rule, the
 * ship-to shape, every line (via assertPaperLine), and the add-on mapping:
 * a dry-run add-on line (identified by its title, the hub add-on's label)
 * must be named in some piñata line's _addons; a live add-on line must
 * attach to one of `opts.addonVariantIds` when those are supplied. Returns
 * the order's carrier and line counts.
 */
export function assertPaperDraft(
  input: unknown,
  opts: PaperDraftOpts = {},
): {
  carrier: Carrier;
  pinataLines: number;
  addonLines: number;
} {
  if (!isRecord(input)) return fail("draft_not_object", "draft input must be an object");

  for (const k of DRAFT_FORBIDDEN_KEYS) {
    if (k in input) fail("forbidden_key", `draft must not carry "${k}"`);
  }

  const tags = input.tags;
  if (!Array.isArray(tags) || !tags.includes(ORDER_TAG_BUILDER))
    fail("tag_builder", `draft tags must include "${ORDER_TAG_BUILDER}" — got ${JSON.stringify(tags)}`);
  const variantTags = (tags as unknown[]).filter((t) => typeof t === "string" && t.startsWith(ORDER_TAG_VARIANT_PREFIX));
  if (variantTags.length > 1 || variantTags.some((t) => !ORDER_TAG_VARIANT_RE.test(t as string)))
    fail("tag_variant", `draft may carry at most one ${ORDER_TAG_VARIANT_PREFIX}<name> tag — got ${JSON.stringify(variantTags)}`);

  const orderAttrs = readAttrs(input.customAttributes, "draft");
  const nonForensic = Object.keys(orderAttrs).filter((k) => !k.startsWith("_"));
  if (nonForensic.length)
    fail("order_attr_visible", `order-level attributes must all start with "_" — got ${nonForensic.join(", ")}`);
  const unknownOrder = Object.keys(orderAttrs).filter(
    (k) =>
      !ORDER_ATTR_REQUIRED.includes(k) &&
      !ORDER_ANALYTICS_ATTR_KEYS.includes(k) &&
      !ORDER_MCP_ATTR_KEYS.includes(k),
  );
  if (unknownOrder.length)
    fail("order_attr_unknown", `order-level attribute key(s) outside the frozen contract: ${unknownOrder.join(", ")}`);
  const missingOrder = ORDER_ATTR_REQUIRED.filter((k) => !(k in orderAttrs));
  if (missingOrder.length)
    fail("order_attr_missing", `missing order-level attribute(s): ${missingOrder.join(", ")}`);
  if (!NONCE_RE.test(orderAttrs[ORDER_ATTR.builderNonce]))
    fail("nonce_invalid", `${ORDER_ATTR.builderNonce} must be 32 lowercase hex chars`);

  // Ordering-MCP provenance: both rails or neither, travelling with the "mcp"
  // tag; _orderSource is the literal channel, _orderAgent whatever checkout's
  // sanitizer let through — checked for SHAPE only, never read as a fact.
  const source = orderAttrs[ORDER_MCP_ATTR.source];
  const agent = orderAttrs[ORDER_MCP_ATTR.agent];
  const mcpTagged = (tags as unknown[]).includes(ORDER_TAG_MCP);
  if ((source === undefined) !== (agent === undefined))
    fail("mcp_attrs_pairing", `${ORDER_MCP_ATTR.source} and ${ORDER_MCP_ATTR.agent} must be emitted together or not at all`);
  if (source !== undefined && source !== ORDER_SOURCE_MCP)
    fail("order_source_invalid", `${ORDER_MCP_ATTR.source} must be "${ORDER_SOURCE_MCP}" — got "${source}"`);
  if (agent !== undefined && !ORDER_AGENT_RE.test(agent))
    fail(
      "order_agent_invalid",
      `${ORDER_MCP_ATTR.agent} must match ${ORDER_AGENT_RE} (checkout strips everything else and caps at ${ORDER_AGENT_MAX_CHARS}; "${ORDER_AGENT_UNKNOWN}" when nothing survives) — got ${JSON.stringify(agent)}`,
    );
  if (mcpTagged !== (source !== undefined))
    fail(
      "mcp_tag_pairing",
      mcpTagged
        ? `tag "${ORDER_TAG_MCP}" without ${ORDER_MCP_ATTR.source} — an MCP draft carries both`
        : `${ORDER_MCP_ATTR.source} without the "${ORDER_TAG_MCP}" tag — an MCP draft carries both`,
    );
  // POSITION is part of the contract: the pair sits IMMEDIATELY after
  // _builderNonce (before any analytics key) and the tag is LAST (after
  // builder + variant-*). readAttrs already proved the array-of-{key} shape.
  if (source !== undefined) {
    const orderKeys = (input.customAttributes as { key: string }[]).map((a) => a.key);
    const n = orderKeys.indexOf(ORDER_ATTR.builderNonce);
    if (orderKeys[n + 1] !== ORDER_MCP_ATTR.source || orderKeys[n + 2] !== ORDER_MCP_ATTR.agent)
      fail(
        "mcp_attrs_position",
        `${ORDER_MCP_ATTR.source}, ${ORDER_MCP_ATTR.agent} must follow ${ORDER_ATTR.builderNonce} immediately — got ${orderKeys.join(", ")}`,
      );
    const tagList = tags as unknown[];
    if (tagList[tagList.length - 1] !== ORDER_TAG_MCP)
      fail(
        "mcp_tag_position",
        `tag "${ORDER_TAG_MCP}" must be last (after ${ORDER_TAG_BUILDER} + ${ORDER_TAG_VARIANT_PREFIX}<name>) — got ${JSON.stringify(tags)}`,
      );
  }

  const ship = input.shippingLine;
  if (!isRecord(ship) || typeof ship.title !== "string")
    return fail("shipping_line", "draft must carry shippingLine.title");
  // Exact-title match: the Guaranteed-prefix rule itself is enforced against
  // SHIPPING_LINE_TITLE at module load, so an accepted title satisfies it.
  const carrier = carrierOfShippingTitle(ship.title);
  if (!carrier)
    return fail("shipping_title_unknown", `shipping title "${ship.title}" is not a contract title (${Object.values(SHIPPING_LINE_TITLE).join(" | ")}, optionally + "${FREE_SHIPPING_SUFFIX}")`);
  const pwc = ship.priceWithCurrency;
  if (!isRecord(pwc) || typeof pwc.amount !== "string" || !MONEY_RE.test(pwc.amount) || pwc.currencyCode !== "USD")
    fail("shipping_price", `shippingLine.priceWithCurrency must be { amount: "0.00"-style string, currencyCode: "USD" } — got ${JSON.stringify(pwc)}`);

  const addr = input.shippingAddress;
  if (!isRecord(addr)) return fail("ship_to_missing", "draft must carry shippingAddress");
  if (addr.countryCode !== "US") fail("ship_to_country", `shippingAddress.countryCode must be "US"`);
  for (const k of ["lastName", "address1", "city", "province", "zip"]) {
    if (typeof addr[k] !== "string" || !(addr[k] as string).trim())
      fail("ship_to_field", `shippingAddress.${k} must be a non-empty string`);
  }

  const items = input.lineItems;
  if (!Array.isArray(items) || items.length === 0)
    return fail("line_items_empty", "draft must carry at least one line item");
  let pinataLines = 0;
  let addonLines = 0;
  // Every label the piñata lines' _addons name, and every dry-run add-on
  // line's title — reconciled after the loop (line order is not assumed).
  const addonLabels = new Set<string>();
  const addonTitles: string[] = [];
  for (const li of items as unknown[]) {
    const r = assertPaperLine(li, { carrier, addonVariantIds: opts.addonVariantIds });
    if (r.kind === "pinata") {
      pinataLines++;
      const lineCarrier = r.attrs[LINE_RAIL_ATTR.carrier];
      // A line without _carrier is a FedEx-only storefront's; it can't ride a
      // USPS order.
      if (lineCarrier === undefined && carrier === "usps")
        fail("carrier_rail_missing", `${r.label}: USPS order but the line carries no _carrier`);
      const rail = r.attrs[LINE_RAIL_ATTR.addons];
      if (rail !== undefined) for (const t of rail.split(ADDONS_SEPARATOR)) addonLabels.add(t);
    } else {
      addonLines++;
      if (isRecord(li) && typeof li.title === "string") addonTitles.push(li.title);
    }
  }
  if (pinataLines === 0) fail("no_pinata_lines", "draft has add-on lines but no piñata line");
  // A dry-run add-on line not named by any piñata's _addons is a stray charge
  // the packer has no map for (or a piñata line that lost its rails).
  for (const t of addonTitles) {
    if (!addonLabels.has(t))
      fail(
        "addon_unmapped",
        `add-on line "${t}" is not named in any piñata line's ${LINE_RAIL_ATTR.addons} (${addonLabels.size ? [...addonLabels].join(" | ") : "none"})`,
      );
  }

  return { carrier, pinataLines, addonLines };
}
