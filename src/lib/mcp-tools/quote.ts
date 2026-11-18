import { HUB_URL, hubTimeout } from "@/lib/hub";
import { toolError, type ToolAnnotations } from "@/lib/mcp-http";
import type { ToolDef } from "@/lib/order-tools";

/**
 * `quote_bulk` — a corporate-quantity quote (15+ piñatas, shipped to one
 * location, to many recipients, or a mix) priced by the hub's full quote
 * engine: POST {HUB_URL}/api/public/quote, the same endpoint and request
 * shape quote.pinatagrams.com's calculator uses (admin/src/lib/quote-pricing
 * `parseQuoteConfig`). The hub is the only source of money here — this file
 * validates the request, mirrors it, and projects the PublicQuote to
 * snake_case integer cents.
 *
 * Bulk orders are NOT placed through this server: the response carries the
 * corporate portal URL where the order is placed and invoiced.
 */

const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

export const QUOTE_URL = `${HUB_URL}/api/public/quote`;
export const CONTINUE_URL = "https://my.betterthanaletter.com";
export const MIN_BULK_QTY = 15;
export const MAX_BULK_QTY = 50000;
const MAX_INSERTS = 10;
const QUOTE_TIMEOUT_MS = 5000;

const SHIPPING_MODES = ["individual", "one_location", "mix"] as const;
const FILLS = ["filled", "empty"] as const;
const GRAPHIC_TYPES = ["stock", "custom"] as const;
const CARRIERS = ["usps", "fedex"] as const;

type ShippingMode = (typeof SHIPPING_MODES)[number];
type Fill = (typeof FILLS)[number];
type GraphicType = (typeof GRAPHIC_TYPES)[number];
type Carrier = (typeof CARRIERS)[number];

/** Exactly the fields the hub's parseQuoteConfig reads. */
export type HubQuoteRequest = {
  shippingMode: ShippingMode;
  fill: Fill;
  bodyType: "standard";
  graphicType: GraphicType;
  qty: number;
  qtyIndividual?: number;
  carrier: Carrier;
  bulkCarrier: "ups";
  insertCount: number;
  addSample: false;
  dateGuaranteed: boolean;
};

/** The hub's PublicQuote (admin/src/lib/quote-pricing.ts), as received. */
type PublicQuote = {
  pricingMode: "firm" | "estimate";
  shippingMode: ShippingMode;
  carrier: Carrier;
  bulkCarrier: "ups" | "freight";
  dateGuaranteed: boolean;
  qtyIndividual: number;
  qtyBulk: number;
  blendedUnitDeliveredCents: number;
  emptySavingsPerUnitCents: number;
  productSubtotalCents: number;
  shippingSubtotalCents: number;
  insertSubtotalCents: number;
  feesCents: number;
  totalCents: number;
  moq: number;
  meetsMoq: boolean;
  nextTier: { qty: number; blendedUnitDeliveredCents: number } | null;
};

export type BulkQuoteArgs = {
  qty: number;
  shipping_mode: ShippingMode;
  qty_individual?: number;
  fill: Fill;
  graphic_type: GraphicType;
  carrier?: Carrier;
  date_guaranteed: boolean;
  insert_count: number;
};

const HUB_DOWN =
  "Bulk pricing is temporarily unavailable. Try again in a minute; nothing was ordered.";

function oneOf<T extends string>(v: unknown, allowed: readonly T[]): v is T {
  return typeof v === "string" && (allowed as readonly string[]).includes(v);
}

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

export function parseBulkArgs(args: Record<string, unknown>): BulkQuoteArgs | { refusal: string } {
  if (!isInt(args.qty) || args.qty < MIN_BULK_QTY || args.qty > MAX_BULK_QTY) {
    return {
      refusal: `qty must be a whole number from ${MIN_BULK_QTY} to ${MAX_BULK_QTY}. Fewer than ${MIN_BULK_QTY} piñatas are ordered one at a time through the single-order tools, not as a bulk quote.`,
    };
  }
  if (!oneOf(args.shipping_mode, SHIPPING_MODES)) {
    return {
      refusal: `shipping_mode must be one of: ${SHIPPING_MODES.join(", ")} (individual = each piñata to its own recipient; one_location = everything to one address; mix = some of each)`,
    };
  }
  if (!oneOf(args.fill, FILLS)) {
    return { refusal: `fill must be one of: ${FILLS.join(", ")}` };
  }
  if (!oneOf(args.graphic_type, GRAPHIC_TYPES)) {
    return {
      refusal: `graphic_type must be one of: ${GRAPHIC_TYPES.join(", ")} (stock = a design from list_designs; custom = the customer's own artwork)`,
    };
  }

  const mode = args.shipping_mode;
  let qtyIndividual: number | undefined;
  if (mode === "mix") {
    if (!isInt(args.qty_individual) || args.qty_individual < 1 || args.qty_individual >= args.qty) {
      return {
        refusal: `qty_individual is required for shipping_mode "mix": a whole number from 1 to ${args.qty - 1} (how many of the ${args.qty} ship to individual recipients; the rest ship to one location)`,
      };
    }
    qtyIndividual = args.qty_individual;
  } else if (args.qty_individual !== undefined) {
    return { refusal: 'qty_individual only applies to shipping_mode "mix"' };
  }

  let carrier: Carrier | undefined;
  if (args.carrier !== undefined) {
    if (!oneOf(args.carrier, CARRIERS)) {
      return { refusal: `carrier must be one of: ${CARRIERS.join(", ")}` };
    }
    if (mode === "one_location") {
      return {
        refusal:
          "carrier applies to individually shipped piñatas only; a one_location order ships by UPS (or freight at large quantities), chosen by the hub",
      };
    }
    carrier = args.carrier;
  }

  let dateGuaranteed = false;
  if (args.date_guaranteed !== undefined) {
    if (typeof args.date_guaranteed !== "boolean") {
      return { refusal: "date_guaranteed must be true or false" };
    }
    if (args.date_guaranteed && mode === "one_location") {
      return {
        refusal:
          "date_guaranteed applies to individually shipped piñatas only (it moves them to FedEx with a guaranteed arrival date)",
      };
    }
    dateGuaranteed = args.date_guaranteed;
  }

  let insertCount = 0;
  if (args.insert_count !== undefined) {
    if (!isInt(args.insert_count) || args.insert_count < 0 || args.insert_count > MAX_INSERTS) {
      return { refusal: `insert_count must be a whole number from 0 to ${MAX_INSERTS}` };
    }
    insertCount = args.insert_count;
  }

  return {
    qty: args.qty,
    shipping_mode: mode,
    ...(qtyIndividual !== undefined ? { qty_individual: qtyIndividual } : {}),
    fill: args.fill,
    graphic_type: args.graphic_type,
    ...(carrier ? { carrier } : {}),
    date_guaranteed: dateGuaranteed,
    insert_count: insertCount,
  };
}

/** The request body sent to the hub — the quote app's shape, field for field. */
export function hubQuoteRequest(a: BulkQuoteArgs): HubQuoteRequest {
  return {
    shippingMode: a.shipping_mode,
    fill: a.fill,
    bodyType: "standard",
    graphicType: a.graphic_type,
    qty: a.qty,
    ...(a.shipping_mode === "mix" ? { qtyIndividual: a.qty_individual! } : {}),
    // USPS is the hub's own default for individual shipments; sent explicitly
    // so the request never relies on the hub's coercion, and the response
    // reports the carrier the hub actually priced.
    carrier: a.carrier ?? "usps",
    bulkCarrier: "ups",
    insertCount: a.insert_count,
    addSample: false,
    dateGuaranteed: a.date_guaranteed,
  };
}

const CENTS_FIELDS = [
  "blendedUnitDeliveredCents",
  "productSubtotalCents",
  "shippingSubtotalCents",
  "insertSubtotalCents",
  "feesCents",
  "totalCents",
  "emptySavingsPerUnitCents",
  "qtyIndividual",
  "qtyBulk",
  "moq",
] as const;

/** Narrow the hub's JSON to a PublicQuote; null when any money field is off. */
export function parsePublicQuote(raw: unknown): PublicQuote | null {
  if (!raw || typeof raw !== "object") return null;
  const q = raw as Record<string, unknown>;
  for (const f of CENTS_FIELDS) {
    if (!isInt(q[f]) || (q[f] as number) < 0) return null;
  }
  if (typeof q.meetsMoq !== "boolean" || typeof q.dateGuaranteed !== "boolean") return null;
  if (q.pricingMode !== "firm" && q.pricingMode !== "estimate") return null;
  if (!oneOf(q.shippingMode, SHIPPING_MODES) || !oneOf(q.carrier, CARRIERS)) return null;
  if (q.bulkCarrier !== "ups" && q.bulkCarrier !== "freight") return null;
  let nextTier: PublicQuote["nextTier"] = null;
  if (q.nextTier !== null && q.nextTier !== undefined) {
    const t = q.nextTier as Record<string, unknown>;
    if (!t || typeof t !== "object" || !isInt(t.qty) || !isInt(t.blendedUnitDeliveredCents)) {
      return null;
    }
    nextTier = { qty: t.qty, blendedUnitDeliveredCents: t.blendedUnitDeliveredCents };
  }
  return { ...(q as unknown as PublicQuote), nextTier };
}

export function projectBulkQuote(a: BulkQuoteArgs, q: PublicQuote) {
  const note =
    "Bulk orders are placed and invoiced through the Piñatagrams corporate portal, not through this server. " +
    "This quote is before tax and reserves nothing." +
    (q.pricingMode === "estimate"
      ? " At this quantity the figures are an estimate; the portal confirms a firm price."
      : "") +
    (q.meetsMoq
      ? ""
      : ` This configuration needs at least ${q.moq} piñatas.`);
  return {
    qty: a.qty,
    shipping_mode: q.shippingMode,
    qty_individual: q.qtyIndividual,
    qty_bulk: q.qtyBulk,
    fill: a.fill,
    graphic_type: a.graphic_type,
    body_type: "standard" as const,
    carrier: q.carrier,
    bulk_carrier: q.bulkCarrier,
    date_guaranteed: q.dateGuaranteed,
    pricing_mode: q.pricingMode,
    blended_unit_delivered_cents: q.blendedUnitDeliveredCents,
    product_subtotal_cents: q.productSubtotalCents,
    shipping_subtotal_cents: q.shippingSubtotalCents,
    ...(a.insert_count > 0
      ? { insert_count: a.insert_count, insert_subtotal_cents: q.insertSubtotalCents }
      : {}),
    fees_cents: q.feesCents,
    total_cents: q.totalCents,
    ...(a.fill === "filled" ? { empty_savings_per_unit_cents: q.emptySavingsPerUnitCents } : {}),
    moq: q.moq,
    meets_moq: q.meetsMoq,
    next_tier: q.nextTier
      ? { qty: q.nextTier.qty, blended_unit_delivered_cents: q.nextTier.blendedUnitDeliveredCents }
      : null,
    currency: "USD" as const,
    continue_url: CONTINUE_URL,
    note,
  };
}

export const quoteTools: Record<string, ToolDef> = {
  quote_bulk: {
    description:
      `Price a corporate or bulk order of ${MIN_BULK_QTY}–${MAX_BULK_QTY} piñatas (standard body styles) from the live price book. shipping_mode: individual (each piñata to its own recipient, by USPS or FedEx), one_location (all to one address, by UPS or freight) or mix (qty_individual of them to recipients, the rest to one location). fill filled or empty, graphic_type stock (a list_designs design) or custom (the customer's artwork). Optional: carrier usps|fedex for the individually shipped units (default usps), date_guaranteed true to move those to FedEx with a guaranteed arrival date, insert_count printed inserts per box (0–${MAX_INSERTS}). Returns integer USD cents before tax: blended delivered price per unit, product and shipping subtotals, fees, total, the minimum order quantity and whether it is met, and the next quantity break. Bulk orders are placed and invoiced through the corporate portal at the returned continue_url, never through this server.`,
    inputSchema: {
      type: "object",
      properties: {
        qty: {
          type: "integer",
          minimum: MIN_BULK_QTY,
          maximum: MAX_BULK_QTY,
          description: "Total piñatas",
        },
        shipping_mode: {
          type: "string",
          enum: [...SHIPPING_MODES],
          description: "individual = one per recipient; one_location = all to one address; mix = both",
        },
        qty_individual: {
          type: "integer",
          minimum: 1,
          description: "Required for mix: how many ship to individual recipients (the rest go to one location)",
        },
        fill: { type: "string", enum: [...FILLS], description: "filled with treats, or empty" },
        graphic_type: {
          type: "string",
          enum: [...GRAPHIC_TYPES],
          description: "stock = a library design; custom = the customer's own artwork",
        },
        carrier: {
          type: "string",
          enum: [...CARRIERS],
          description: "Carrier for individually shipped units (default usps). Not for one_location.",
        },
        date_guaranteed: {
          type: "boolean",
          description: "Guarantee the arrival date for individually shipped units (FedEx). Not for one_location.",
        },
        insert_count: {
          type: "integer",
          minimum: 0,
          maximum: MAX_INSERTS,
          description: "Printed inserts per box (default 0)",
        },
      },
      required: ["qty", "shipping_mode", "fill", "graphic_type"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
    handler: async (args) => {
      const parsed = parseBulkArgs(args);
      if ("refusal" in parsed) return toolError(parsed.refusal);

      let res: Response;
      try {
        res = await fetch(QUOTE_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(hubQuoteRequest(parsed)),
          cache: "no-store",
          signal: hubTimeout(QUOTE_TIMEOUT_MS),
        });
      } catch (err) {
        console.error(
          `[mcp] quote_bulk: hub unreachable (${err instanceof Error ? err.message : String(err)})`,
        );
        return toolError(HUB_DOWN);
      }
      if (!res.ok) {
        console.error(`[mcp] quote_bulk: hub answered HTTP ${res.status}`);
        return toolError(HUB_DOWN);
      }
      let raw: unknown;
      try {
        raw = await res.json();
      } catch {
        console.error("[mcp] quote_bulk: hub answered non-JSON");
        return toolError(HUB_DOWN);
      }
      const quote = parsePublicQuote(raw);
      if (!quote) {
        console.error("[mcp] quote_bulk: hub quote malformed");
        return toolError(HUB_DOWN);
      }
      return projectBulkQuote(parsed, quote);
    },
  },
};
