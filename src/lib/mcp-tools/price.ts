import graphicsFile from "../../../public/graphics.json";
import {
  catalogUrl,
  HUB_TIMEOUT_MS,
  priceUrl,
  resolveBuilderPricing,
  resolveHubGraphics,
  type BuilderPricing,
  type HubAddon,
  type HubBodyStyle,
  type HubCatalog,
  type HubFilling,
  type HubGraphicEntry,
  type HubPrice,
  type HubPriceInput,
} from "@/lib/hub";
import { CLASSIC_GRAPHIC, fillingAllowsAddon, resolveFillings } from "@/lib/flow";
import { resolveVariantProfile, type VariantProfile } from "@/lib/variant";
import { EXCLUDED_PREFIXES } from "@/lib/library-data";
import type { Carrier } from "@/lib/delivery";
import { toolError, type ToolAnnotations } from "@/lib/mcp-http";
import type { ToolDef } from "@/lib/order-tools";

/**
 * `price_order` — quote a single-address order EXACTLY as
 * src/app/api/checkout/route.ts will charge it. Every number here is
 * recomputed from the hub's public plane the same way the route does it:
 *
 *   unit        = price.unitPriceCents + tierCents + filling.priceCents
 *   tierCents   = 0 on a flat variant; else Classic default 0, any other
 *                 library / hub design graphicLibraryUpchargeCents, a custom
 *                 design graphicCustomUpchargeCents
 *   add-ons     = separate lines, addon.priceCents × the qty of every piñata
 *                 carrying that add-on (aggregated per add-on id)
 *   shipping    = (usps ? pricing.uspsShipPerUnitCents : price.shipPerUnitCents)
 *                 × total piñatas (one address = one shipping line)
 *
 * The price call is the route's FIXED query (qty=1, filled, standard,
 * custom, individual, standard) regardless of the cart, fetched fresh past
 * every cache exactly like the money path. Tax and discount codes are
 * Shopify's at checkout and are not modelled. Nothing here reads a cost,
 * a margin or a stock count, and nothing is ordered or reserved.
 *
 * The catalog is fetched scoped to MCP_HOST — the Host the checkout tool
 * presents to the route, which scopes ITS catalog by its request Host — so
 * both sides resolve one variant profile. Every cent is an integer: a
 * fractional hub value (which checkout would round) is refused, not quoted.
 *
 * Validation is strict and loud: unknown fields (a typo'd `addons` would
 * otherwise silently under-quote), unknown ids, out-of-stock styles,
 * disallowed add-ons and variant rules (no USPS / no custom / folders-only)
 * are all refused with customer-safe messages that list what IS allowed.
 */

const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

// Same bounds as the checkout route (MAX_LINES / MAX_QTY there).
const MAX_LINES = 20;
const MAX_QTY = 25;
/** Distinct add-ons per line — refused by COUNT before a single entry is read,
 *  so a refusal never echoes thousands of values back. The single source of
 *  truth: checkout.ts imports and re-exports it (never the other way round). */
export const MAX_ADDONS = 10;
const CARRIERS: Carrier[] = ["fedex", "usps"];
const GRAPHIC_TYPES = ["classic", "library", "custom"] as const;
type GraphicType = (typeof GRAPHIC_TYPES)[number];

// Mirrors of the route's shape guards for sellable art.
const DESIGN_RE = /^[A-Z0-9]{2,24}$/;
const ART_RE = /^https:\/\/cdn\.shopify\.com\//;
const BLOB_RE = /^https:\/\/yrfds6n4iwscziqm\.public\.blob\.vercel-storage\.com\//;
const SHA256_RE = /^[a-f0-9]{64}$/;

/** The route's one and only price query — the retail base per piñata plus
 *  the FedEx 2-Day per-unit rate. Never varies with the cart. */
export const CHECKOUT_PRICE_QUERY: HubPriceInput = {
  qty: 1,
  fill: "filled",
  bodyType: "standard",
  graphicType: "custom",
  mode: "individual",
  carrier: "standard",
};

/** The Host this server presents to the hub for the catalog — and the Host
 *  the checkout tool MUST present to /api/checkout — so both resolve the
 *  same variant profile (the route scopes its catalog by its request Host). */
export const MCP_HOST = process.env.MCP_STOREFRONT_HOST ?? "mcp.pinatagrams.com";

// The Classic default's code and customer-facing title, off the GraphicChoice
// union (its `design` is a string on every member but the custom one).
const CLASSIC_DESIGN = typeof CLASSIC_GRAPHIC.design === "string" ? CLASSIC_GRAPHIC.design : "STANDARD";
const CLASSIC_TITLE = "title" in CLASSIC_GRAPHIC ? CLASSIC_GRAPHIC.title : "Classic Piñatagrams";

const PRICING_UNAVAILABLE =
  "Pricing is unavailable right now — try again in a minute. Nothing was ordered.";
const CATALOG_UNAVAILABLE =
  "The catalog is unavailable right now — try again in a minute. Nothing was ordered.";

/* ---- the Shopify design library (public/graphics.json) ------------------ */

type ManifestGraphic = { design: string; title: string; art: string | null };

// Sellable library designs by code: must have cdn.shopify.com print art (the
// route's ART_RE) and not be a client one-off the public library hides.
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

/* ---- hub reads on the money path ---------------------------------------- */

/** GET a hub public endpoint exactly like the checkout route's hubGet: no
 *  cache layer (no-store + a unique query param past the hub's edge cache)
 *  and a hard deadline. null on ANY failure — the caller refuses. */
async function hubGet<T>(url: string): Promise<T | null> {
  try {
    const fresh = `${url}${url.includes("?") ? "&" : "?"}fresh=${Date.now()}`;
    const res = await fetch(fresh, {
      cache: "no-store",
      signal: AbortSignal.timeout(HUB_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`[mcp] price_order: hub returned HTTP ${res.status} for ${url}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (e) {
    console.error(`[mcp] price_order: hub fetch failed for ${url}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/* ---- input parsing (no network) ----------------------------------------- */

type GraphicInput =
  | { type: "classic" }
  | { type: "library"; design: string }
  | { type: "custom" };

type LineInput = {
  style_id: string;
  qty: number;
  filling: string;
  graphic: GraphicInput;
  add_ons: string[];
};

// Every problem is tagged with where it sits (ORDER = order-level, else the
// 0-based line index) so shape problems and catalog problems — found in two
// passes — come back in ONE refusal, in line order, like the route's
// lineErrors.
const ORDER = -1;
type Problem = { at: number; text: string };

/** The parsed request: a null carrier or a null line is one that already
 *  has a problem recorded; the rest can still be checked against the hub. */
type ParsedInput = {
  carrier: Carrier | null;
  lines: (LineInput | null)[];
  problems: Problem[];
};

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

const show = (v: unknown) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return (s ?? String(v)).slice(0, 60);
};

const lineLabel = (at: number) => (at === ORDER ? "Order" : `Line ${at + 1}`);

/** Flags any key outside `allowed` — a silently ignored field could mean a
 *  silently wrong price. */
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
      text: `${lineLabel(at)}: graphic must be an object — {"type":"classic"}, {"type":"library","design":"HBD06"} or {"type":"custom"}.`,
    });
    return null;
  }
  const type = GRAPHIC_TYPES.find((t) => t === raw.type);
  if (!type) {
    problems.push({ at, text: `${where}.type must be one of: ${GRAPHIC_TYPES.join(", ")}.` });
    return null;
  }
  if (type === "library") {
    unknownKeys(raw, ["type", "design"], at, where, problems);
    const design = raw.design;
    if (typeof design !== "string" || !design.trim()) {
      problems.push({
        at,
        text: `${where}.design is required for a library graphic (a design code such as HBD06).`,
      });
      return null;
    }
    return { type, design: design.trim() };
  }
  unknownKeys(raw, ["type"], at, where, problems);
  return { type };
}

function parseLine(raw: unknown, at: number, problems: Problem[]): LineInput | null {
  const label = lineLabel(at);
  if (!isObj(raw)) {
    problems.push({
      at,
      text: `${label}: each line must be an object with style_id, qty, filling, graphic and optional add_ons.`,
    });
    return null;
  }
  const before = problems.length;
  unknownKeys(raw, ["style_id", "qty", "filling", "graphic", "add_ons"], at, label, problems);

  const style_id = typeof raw.style_id === "string" ? raw.style_id.trim() : "";
  if (!style_id) {
    problems.push({ at, text: `${label}: style_id is required (a body style id from get_catalog, e.g. "standard").` });
  }

  const qty = raw.qty;
  if (!Number.isInteger(qty) || (qty as number) < 1 || (qty as number) > MAX_QTY) {
    problems.push({
      at,
      text: `${label}: qty must be a whole number from 1 to ${MAX_QTY} (larger orders go through the bulk quote form).`,
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
      // By COUNT, before looking at a single entry (as create_checkout does):
      // the refusal names the number, never the values.
      problems.push({ at, text: `${label}: add_ons lists ${raw.add_ons.length} entries; at most ${MAX_ADDONS} per line.` });
    } else if (raw.add_ons.some((a) => typeof a !== "string" || !a.trim())) {
      problems.push({ at, text: `${label}: add_ons must be an array of add-on ids (strings), e.g. ["double-candy"].` });
    } else {
      add_ons = (raw.add_ons as string[]).map((a) => a.trim());
    }
  }

  if (problems.length > before || !graphic) return null;
  return { style_id, qty: qty as number, filling, graphic, add_ons };
}

function parseInput(args: Record<string, unknown>): ParsedInput {
  const problems: Problem[] = [];
  unknownKeys(args, ["carrier", "lines"], ORDER, "Order", problems);

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
      text: `That's a lot of piñatas — an order caps at ${MAX_LINES} lines (got ${rawLines.length}). Larger orders go through the bulk quote form.`,
    });
  } else {
    lines = rawLines.map((raw, i) => parseLine(raw, i, problems));
  }

  return { carrier, lines, problems };
}

/* ---- catalog resolution ------------------------------------------------- */

const lower = (s: string) => s.trim().toLowerCase();

function findStyle(styles: HubBodyStyle[], id: string): HubBodyStyle | undefined {
  return styles.find((s) => s.id === id) ?? styles.find((s) => lower(s.id) === lower(id));
}

/** A filling by label or id, exact first, then case-insensitive. */
function findFilling(fillings: HubFilling[], key: string): HubFilling | undefined {
  return (
    fillings.find((f) => f.label === key || f.id === key) ??
    fillings.find((f) => lower(f.label) === lower(key) || lower(f.id) === lower(key))
  );
}

/** An add-on by id or label, exact first, then case-insensitive. */
function findAddon(addons: HubAddon[], key: string): HubAddon | undefined {
  return (
    addons.find((a) => a.id === key || a.label === key) ??
    addons.find((a) => lower(a.id) === lower(key) || lower(a.label) === lower(key))
  );
}

// Integer cents only: a fractional hub value would quote a figure checkout
// can't charge (it rounds via toFixed(2)), so it is refused instead.
const cents = (v: unknown): number | null =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;

type GraphicPick = {
  type: GraphicType;
  design: string;
  // What the invoice's "Graphic" attribute will show — hub titles are
  // internal and never surface here.
  label: string;
  tier: GraphicType;
  cents: number;
};

type Ctx = {
  pricing: BuilderPricing;
  variant: VariantProfile;
  tiered: boolean;
  hubGraphicByDesign: Map<string, HubGraphicEntry>;
};

/** The line's graphic, validated the way the route's resolveGraphic does
 *  and priced into its tier — or why it can't be sold here. */
function resolveGraphic(
  g: GraphicInput,
  style: HubBodyStyle | undefined,
  ctx: Ctx,
): { ok: true; pick: GraphicPick } | { ok: false; message: string } {
  const { pricing, variant, tiered } = ctx;
  const libraryCents = tiered ? pricing.graphicLibraryUpchargeCents : 0;

  if (g.type === "custom") {
    if (!variant.allowCustom) {
      return { ok: false, message: "custom designs aren't offered on this store — pick a library design instead." };
    }
    return {
      ok: true,
      pick: {
        type: "custom",
        design: "custom",
        label: "Your custom design",
        tier: "custom",
        cents: tiered ? pricing.graphicCustomUpchargeCents : 0,
      },
    };
  }

  const design = g.type === "classic" ? CLASSIC_DESIGN : g.design.toUpperCase();
  if (!DESIGN_RE.test(design)) {
    return { ok: false, message: `design code "${show(g.type === "library" ? g.design : design)}" isn't valid — codes look like HBD06.` };
  }

  if (design === CLASSIC_DESIGN) {
    if (variant.library === "none") {
      return { ok: false, message: "the Classic design isn't offered on this store — pick one of its graphics." };
    }
    return {
      ok: true,
      pick: { type: "classic", design, label: CLASSIC_TITLE, tier: "classic", cents: 0 },
    };
  }

  const lib = LIBRARY.get(design);
  if (lib) {
    if (variant.library === "none") {
      return { ok: false, message: `design ${design} isn't offered on this store — pick one of its graphics.` };
    }
    return {
      ok: true,
      pick: { type: "library", design, label: lib.title, tier: "library", cents: libraryCents },
    };
  }

  const hub = ctx.hubGraphicByDesign.get(design);
  if (hub) {
    if (style && hub.bodyStyles !== "all" && !hub.bodyStyles.includes(style.id)) {
      return {
        ok: false,
        message: `design ${design} isn't offered on the ${style.name} body — swap the body style or the design.`,
      };
    }
    if (!BLOB_RE.test(hub.art) || !SHA256_RE.test(hub.artSha256)) {
      console.error(`[mcp] price_order: hub graphic ${design} has malformed art/sha in the catalog`);
      return { ok: false, message: `design ${design} can't be sold right now — pick another.` };
    }
    return {
      ok: true,
      pick: { type: "library", design, label: "Your selected graphic", tier: "library", cents: libraryCents },
    };
  }

  return {
    ok: false,
    message: `no design has the code "${design}" — use a code from the design library (they look like HBD06) or {"type":"classic"} for the included Classic design.`,
  };
}

/** One refusal naming every problem, order-level first, then by line. */
function refuse(problems: Problem[]) {
  const texts = [...problems].sort((a, b) => a.at - b.at).map((p) => p.text);
  return toolError(
    texts.length === 1
      ? texts[0]
      : `${texts.length} things need fixing before this order can be priced:\n${texts.map((t) => `- ${t}`).join("\n")}`,
  );
}

/* ---- the quote ---------------------------------------------------------- */

type PricedLine = {
  style: HubBodyStyle;
  qty: number;
  filling: HubFilling;
  fillingCents: number;
  graphic: GraphicPick;
  addons: HubAddon[];
};

function quote(input: ParsedInput, catalog: HubCatalog, price: HubPrice) {
  const pricing = resolveBuilderPricing(catalog.pricing);
  // resolveBuilderPricing falls back on a non-finite or negative value but
  // lets a fractional one through — refuse rather than quote cents that
  // checkout (toFixed(2)) would never charge as such.
  if (
    !Number.isInteger(pricing.graphicLibraryUpchargeCents) ||
    !Number.isInteger(pricing.graphicCustomUpchargeCents) ||
    !Number.isInteger(pricing.uspsShipPerUnitCents)
  ) {
    console.error("[mcp] price_order: the catalog's pricing block carries non-integer cents");
    return toolError(PRICING_UNAVAILABLE);
  }
  const variant = resolveVariantProfile(catalog.variant);
  const tiered = variant.pricing === "tiered";
  const uspsOffered = variant.carriers.includes("usps");
  const { carrier } = input;
  // Shape problems already found ride along with the catalog problems below.
  const problems: Problem[] = [...input.problems];

  if (carrier === "usps" && !uspsOffered) {
    problems.push({ at: ORDER, text: 'USPS isn\'t offered on this store — price the order with carrier "fedex".' });
  }

  const fillings = resolveFillings(catalog.fillings);
  const addons = catalog.addons ?? [];
  const ctx: Ctx = {
    pricing,
    variant,
    tiered,
    hubGraphicByDesign: new Map(resolveHubGraphics(catalog.hubGraphics).map((g) => [g.design, g])),
  };
  const inStockIds = catalog.bodyStyles.filter((s) => s.inStock).map((s) => s.id);
  const fillingList = fillings.map((f) => `${f.label} (${f.id})`).join(", ");
  const addonList = addons.map((a) => `${a.label} (${a.id})`).join(", ");

  const priced: PricedLine[] = [];

  input.lines.forEach((l, i) => {
    if (!l) return; // its shape problems are already recorded
    const at = lineLabel(i);
    const found: string[] = [];

    const style = findStyle(catalog.bodyStyles, l.style_id);
    if (!style) {
      found.push(`${at}: body style "${show(l.style_id)}" isn't available — choose one of: ${inStockIds.join(", ")}.`);
    } else if (!style.inStock) {
      found.push(`${at}: the ${style.name} body is out of stock right now — pick another body style.`);
    }

    const filling = findFilling(fillings, l.filling);
    let fillingCents = 0;
    if (!filling) {
      found.push(`${at}: filling "${show(l.filling)}" isn't available — choose one of: ${fillingList}.`);
    } else {
      const c = cents(filling.priceCents);
      if (c === null) found.push(`${at}: the ${filling.label} filling can't be priced right now — try again shortly.`);
      else fillingCents = c;
    }

    const lineAddons: HubAddon[] = [];
    for (const key of l.add_ons) {
      const rec = findAddon(addons, key);
      if (!rec) {
        found.push(
          `${at}: add-on "${show(key)}" isn't available — ${addons.length ? `choose from: ${addonList}` : "no add-ons are offered right now"}.`,
        );
      } else if (cents(rec.priceCents) === null) {
        found.push(`${at}: the ${rec.label} add-on can't be priced right now — try again shortly.`);
      } else if (!lineAddons.some((a) => a.id === rec.id)) {
        lineAddons.push(rec);
      }
    }
    if (filling) {
      for (const a of lineAddons) {
        if (!fillingAllowsAddon(filling, a.id)) {
          found.push(`${at}: ${a.label} isn't available with the ${filling.label} filling — drop the add-on or choose another filling.`);
        }
      }
    }

    const graphic = resolveGraphic(l.graphic, style, ctx);
    if (!graphic.ok) found.push(`${at}: ${graphic.message}`);

    if (found.length || !style || !filling || !graphic.ok) {
      problems.push(...found.map((text) => ({ at: i, text })));
      return;
    }
    priced.push({ style, qty: l.qty, filling, fillingCents, graphic: graphic.pick, addons: lineAddons });
  });

  if (problems.length || !carrier) return refuse(problems);

  // Shipping rate by the ORDER's carrier: FedEx from the price API, USPS
  // from the catalog's pricing block; charged per piñata, one address.
  const shipRate = carrier === "usps" ? pricing.uspsShipPerUnitCents : price.shipPerUnitCents;
  const units = priced.reduce((s, l) => s + l.qty, 0);
  const shippingCents = shipRate * units;

  const lines = priced.map((l, i) => {
    const unit = price.unitPriceCents + l.graphic.cents + l.fillingCents;
    return {
      line: i + 1,
      style_id: l.style.id,
      style_name: l.style.name,
      graphic: {
        type: l.graphic.type,
        design: l.graphic.design,
        label: l.graphic.label,
        tier: l.graphic.tier,
      },
      filling: { id: l.filling.id, label: l.filling.label },
      add_ons: l.addons.map((a) => a.id),
      qty: l.qty,
      unit_cents: unit,
      line_cents: unit * l.qty,
      breakdown: {
        base: price.unitPriceCents,
        graphic_upcharge: l.graphic.cents,
        filling: l.fillingCents,
      },
    };
  });

  // Add-ons aggregate into one line per add-on id across the order, exactly
  // like the draft order's add-on product lines.
  const addonTotals = new Map<string, { addon: HubAddon; qty: number }>();
  for (const l of priced) {
    for (const a of l.addons) {
      addonTotals.set(a.id, { addon: a, qty: (addonTotals.get(a.id)?.qty ?? 0) + l.qty });
    }
  }
  const add_on_lines = [...addonTotals.values()].map(({ addon, qty }) => ({
    id: addon.id,
    label: addon.label,
    unit_cents: addon.priceCents,
    qty,
    cents: addon.priceCents * qty,
  }));

  const subtotal =
    lines.reduce((s, l) => s + l.line_cents, 0) + add_on_lines.reduce((s, a) => s + a.cents, 0);

  return {
    carrier,
    lines,
    add_on_lines,
    shipping: {
      carrier,
      service:
        carrier === "fedex"
          ? "FedEx 2-Day — guaranteed arrival on the chosen date"
          : "USPS First Class — arrives in a window around the chosen date",
      per_unit_cents: shipRate,
      units,
      cents: shippingCents,
    },
    subtotal_cents: subtotal,
    total_before_tax_cents: subtotal + shippingCents,
    currency: "USD",
    as_of: price.asOf ?? catalog.asOf,
    note: "Sales tax and any discount code are applied by Shopify at checkout and are not included here. This is a quote — nothing has been ordered or reserved.",
  };
}

/* ---- the tool ----------------------------------------------------------- */

export const priceTools: Record<string, ToolDef> = {
  price_order: {
    description:
      "Price a single-address order exactly as checkout will charge it, before tax — a quote only; nothing is ordered or reserved. Give the carrier (fedex = 2-Day with a guaranteed arrival date; usps = First Class, arrives in a window) and 1–20 lines, each with a body style id from get_catalog (must be in stock), qty 1–25, a filling (id or label from get_catalog), a graphic — {\"type\":\"classic\"} for the included Classic Piñatagrams design, {\"type\":\"library\",\"design\":\"HBD06\"} for a design-library code, or {\"type\":\"custom\"} for custom artwork — and optional add-on ids (up to 10 per line). Returns each line's unit and line total with a base / graphic upcharge / filling breakdown, add-on lines, shipping by carrier, the subtotal and the total before tax, all in integer cents USD. Sales tax and any discount code are applied by Shopify at checkout and are not included. Refusals name every problem at once and list the allowed values, and a filling or add-on whose price is negative or not whole cents is refused rather than quoted. WHAT CAN BE BOUGHT HERE: create_checkout accepts at most 5 lines and 10 piñatas per line. Custom artwork is NOT orderable through this connector — quote it only as a reference and send the customer to https://builder.pinatagrams.com to design and order it. A quote above 5 lines or 10 per line is reference-only too: order it at https://builder.pinatagrams.com, or use quote_bulk for 15 or more piñatas. For an order that fits, pass this quote's normalized style_id, filling.label and add_ons values to create_checkout — never the caller's raw strings — because checkout matches them exactly. Nothing is ordered or reserved.",
    inputSchema: {
      type: "object",
      required: ["carrier", "lines"],
      properties: {
        carrier: {
          type: "string",
          enum: CARRIERS,
          description:
            "How the whole order ships: fedex (2-Day, guaranteed arrival date) or usps (First Class, arrives in a window around the chosen date). One carrier per order.",
        },
        lines: {
          type: "array",
          minItems: 1,
          maxItems: MAX_LINES,
          description: "One entry per piñata design. Piñatas with the same style, graphic, filling and add-ons can share a line via qty.",
          items: {
            type: "object",
            required: ["style_id", "qty", "filling", "graphic"],
            properties: {
              style_id: {
                type: "string",
                description: 'Body style id from get_catalog, e.g. "standard".',
              },
              qty: {
                type: "integer",
                minimum: 1,
                maximum: MAX_QTY,
                description: `How many of this exact piñata (1–${MAX_QTY} here; create_checkout accepts at most 10 per line — above that the quote is reference-only).`,
              },
              filling: {
                type: "string",
                description: 'Filling id or label from get_catalog, e.g. "candy" or "Candy".',
              },
              graphic: {
                type: "object",
                required: ["type"],
                properties: {
                  type: {
                    type: "string",
                    enum: GRAPHIC_TYPES,
                    description:
                      "classic = the included Classic Piñatagrams design (no upcharge); library = a design-library code (set design); custom = custom artwork — priced here for reference only, NOT orderable through this connector (the customer designs and orders it at builder.pinatagrams.com).",
                  },
                  design: {
                    type: "string",
                    description: 'Design code, required when type is "library" (e.g. "HBD06").',
                  },
                },
                additionalProperties: false,
              },
              add_ons: {
                type: "array",
                items: { type: "string" },
                maxItems: MAX_ADDONS,
                description: `Optional add-on ids from get_catalog, e.g. ["double-candy"] — up to ${MAX_ADDONS} per line. Some fillings allow no add-ons.`,
              },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    annotations: READ_ONLY,
    handler: async (args) => {
      const parsed = parseInput(args);
      // Nothing priceable (no lines, too many, or every line malformed):
      // refuse on shape alone, without a hub round trip.
      if (!parsed.lines.some(Boolean)) return refuse(parsed.problems);

      // Both hub reads in parallel, fresh, exactly like checkout's pre-flight —
      // the catalog scoped to MCP_HOST, as the route scopes it to its own Host.
      const [catalog, price] = await Promise.all([
        hubGet<HubCatalog>(catalogUrl({ host: MCP_HOST })),
        hubGet<HubPrice>(priceUrl(CHECKOUT_PRICE_QUERY)),
      ]);
      if (!catalog || !Array.isArray(catalog.bodyStyles)) return toolError(CATALOG_UNAVAILABLE);
      // Never quote at zero — a misconfigured price table fails loudly here
      // just as checkout refuses to sell at it.
      if (
        !price ||
        !Number.isFinite(price.unitPriceCents) ||
        price.unitPriceCents <= 0 ||
        !Number.isFinite(price.shipPerUnitCents) ||
        price.shipPerUnitCents < 0 ||
        // Stricter than the route: integer cents only (see cents()).
        !Number.isInteger(price.unitPriceCents) ||
        !Number.isInteger(price.shipPerUnitCents)
      ) {
        return toolError(PRICING_UNAVAILABLE);
      }
      return quote(parsed, catalog, price);
    },
  },
};
