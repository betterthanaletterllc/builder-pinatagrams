import { getCatalog } from "@/lib/hub";
import {
  deliveryProblem,
  fedexNearbyDays,
  maxDeliveryDate,
  minDeliveryDate,
  resolveDeliveryConfig,
  type Carrier,
} from "@/lib/delivery";
import {
  carrierService,
  FEDEX_NEARBY_BUSINESS_DAYS,
  GUARANTEE_LABEL,
  GUARANTEE_TERMS,
} from "@/lib/order-rules";
import { resolveVariantProfile } from "@/lib/variant";
import { toolError, toolText, type McpToolListing, type ToolAnnotations } from "@/lib/mcp-http";
import { projectCatalog } from "@/lib/mcp-tools/catalog";
import { checkoutTools } from "@/lib/mcp-tools/checkout";
import { designerTools } from "@/lib/mcp-tools/designer";
import { designTools } from "@/lib/mcp-tools/designs";
import { MCP_HOST, priceTools } from "@/lib/mcp-tools/price";
import { quoteTools } from "@/lib/mcp-tools/quote";

/**
 * The ordering MCP's tool registry — transport-agnostic so the same table
 * can feed the MCP shell today and a REST twin later. Every tool validates
 * its own arguments (no zod in the builder; schemas are hand-written JSON
 * Schema and checked by the handler), reads the hub's PUBLIC plane only,
 * and returns JSON as MCP text content.
 *
 * Phase 0 ships the two reads that can never be wrong about money: the
 * catalog and the delivery calendar. Pricing and checkout follow once the
 * golden Paper-contract test guards the checkout route.
 */

const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

export type ToolDef = {
  /** Human-readable name for a host's UI (tools/list `title`); optional. */
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: ToolAnnotations;
  /** Extension metadata passed through tools/list verbatim — an MCP App's
   *  `{ ui: { resourceUri } }`. Optional. */
  _meta?: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
};

const CARRIERS: Carrier[] = ["fedex", "usps"];
const YMD = /^\d{4}-\d{2}-\d{2}$/;

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

export const orderTools: Record<string, ToolDef> = {
  // Phase 1+ modules (src/lib/mcp-tools/*): each owns its own file + tests.
  ...priceTools,
  ...designTools,
  ...quoteTools,
  ...checkoutTools,
  ...designerTools,
  get_catalog: {
    description:
      "What Piñatagrams can send right now: body styles with in-stock status, fillings, add-ons, per-unit shipping (FedEx 2-Day vs USPS First Class window), graphic upcharges, the store's carriers and paid guaranteed-date price, and the earliest and latest delivery dates. Amounts are integer cents, as checkout charges them on this store. Call this before quoting anything.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: READ_ONLY,
    // Scoped to MCP_HOST like price_order and create_checkout: one profile.
    handler: async () => projectCatalog(await getCatalog({ host: MCP_HOST })),
  },

  get_delivery_options: {
    description:
      "Delivery-date rules for a carrier (fedex = 2-Day aimed at the chosen day; usps = First Class, arrives in a window around it). Returns the earliest and latest selectable dates, whether this store offers a paid guaranteed delivery date (FedEx only) with its price and terms, and if you pass a date, whether that exact date works and why not — plus, for a FedEx date without the guarantee on a store that offers one, the business days it may arrive on instead.",
    inputSchema: {
      type: "object",
      properties: {
        carrier: {
          type: "string",
          enum: CARRIERS,
          description: "fedex (default) or usps",
        },
        date: {
          type: "string",
          pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          description: "Optional YYYY-MM-DD arrival date to validate",
        },
        guaranteed: {
          type: "boolean",
          description: `Optional: true to ask about the date WITH the paid ${GUARANTEE_LABEL.toLowerCase()} (FedEx, where offered).`,
        },
      },
      additionalProperties: false,
    },
    annotations: READ_ONLY,
    handler: async (args) => {
      const carrierArg = str(args.carrier) ?? "fedex";
      if (!CARRIERS.includes(carrierArg as Carrier)) {
        return toolError(`carrier must be one of: ${CARRIERS.join(", ")}`);
      }
      const carrier = carrierArg as Carrier;
      const date = str(args.date);
      if (date !== null && !YMD.test(date)) {
        return toolError("date must be YYYY-MM-DD");
      }
      if (args.guaranteed !== undefined && typeof args.guaranteed !== "boolean") {
        return toolError("guaranteed must be true or false");
      }
      // Scoped to MCP_HOST like price_order: the guarantee is the profile's.
      const catalog = await getCatalog({ host: MCP_HOST });
      const cfg = resolveDeliveryConfig(catalog.delivery);
      const variant = resolveVariantProfile(catalog.variant);
      const guaranteeOffered = variant.guaranteeCents !== null && carrier === "fedex";
      const guaranteed = guaranteeOffered && args.guaranteed === true;
      const problem = date ? deliveryProblem(date, cfg, carrier) : null;
      // An unguaranteed FedEx date on a guarantee store is aimed at the day
      // and may land up to two business days either side (the builder's
      // calendar shades the same days: lib/delivery fedexNearbyDays).
      const nearby =
        date && !problem && guaranteeOffered && !guaranteed
          ? [...fedexNearbyDays(date, cfg, FEDEX_NEARBY_BUSINESS_DAYS), date].sort()
          : null;
      return {
        carrier,
        timezone: "America/Chicago",
        earliest: minDeliveryDate(cfg, carrier),
        latest: maxDeliveryDate(cfg),
        ...(date
          ? {
              requested: date,
              ok: problem === null,
              ...(problem ? { reason: problem } : {}),
              ...(nearby
                ? {
                    may_arrive: {
                      earliest: nearby[0],
                      latest: nearby[nearby.length - 1],
                      business_days: nearby,
                      note: `Without the ${GUARANTEE_LABEL.toLowerCase()}, FedEx aims for ${date} but may deliver on any of these business days.`,
                    },
                  }
                : {}),
            }
          : {}),
        promise:
          carrier === "fedex"
            ? guaranteeOffered && !guaranteed
              ? `${carrierService("fedex", true)}.`
              : "Arrives on the exact date you pick (FedEx 2-Day)."
            : `Arrives within about ${cfg.uspsWindowDays} mailing days either side of the date you pick (USPS First Class).`,
        guarantee: guaranteeOffered
          ? {
              offered: true,
              label: GUARANTEE_LABEL,
              cents_per_pinata: variant.guaranteeCents,
              terms: GUARANTEE_TERMS,
              how: "Add guaranteed:true to each line that should have it in price_order and create_checkout.",
            }
          : {
              offered: false,
              note:
                variant.guaranteeCents === null
                  ? "This store has no paid guaranteed date (its FedEx dates are already guaranteed)."
                  : `The ${GUARANTEE_LABEL.toLowerCase()} is FedEx only.`,
            },
      };
    },
  },
};

export function orderToolList(): McpToolListing[] {
  return Object.entries(orderTools).map(([name, def]) => ({
    name,
    ...(def.title ? { title: def.title } : {}),
    description: def.description,
    inputSchema: def.inputSchema,
    annotations: def.annotations,
    ...(def._meta ? { _meta: def._meta } : {}),
  }));
}

/** Execute a tool call; returns MCP content. Throws only on unknown tool. */
export async function executeOrderTool(name: string, args: unknown) {
  const def = orderTools[name];
  if (!def) throw new Error(`Unknown tool: ${name}`);
  const input =
    args && typeof args === "object" && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : {};
  try {
    const result = await def.handler(input);
    // Handlers may return a ready-made refusal (isError) or plain JSON.
    if (result && typeof result === "object" && "content" in result) return result;
    return toolText(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[mcp] ${name} failed: ${message}`);
    return toolError(
      "The catalog is temporarily unavailable. Try again in a minute; nothing was ordered.",
    );
  }
}
