import { getCatalog } from "@/lib/hub";
import {
  deliveryProblem,
  maxDeliveryDate,
  minDeliveryDate,
  resolveDeliveryConfig,
  type Carrier,
} from "@/lib/delivery";
import { toolError, toolText, type McpToolListing, type ToolAnnotations } from "@/lib/mcp-http";
import { projectCatalog } from "@/lib/mcp-tools/catalog";
import { checkoutTools } from "@/lib/mcp-tools/checkout";
import { designerTools } from "@/lib/mcp-tools/designer";
import { designTools } from "@/lib/mcp-tools/designs";
import { priceTools } from "@/lib/mcp-tools/price";
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
      "What Piñatagrams can send right now: body styles with in-stock status, fillings, add-ons, per-unit shipping (FedEx 2-Day guaranteed date vs USPS First Class window), graphic upcharges, and the earliest and latest delivery dates. Amounts are integer cents. Call this before quoting anything.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: READ_ONLY,
    handler: async () => projectCatalog(await getCatalog()),
  },

  get_delivery_options: {
    description:
      "Delivery-date rules for a carrier (fedex = 2-Day with a guaranteed arrival date; usps = First Class, arrives in a window around the chosen day). Returns the earliest and latest selectable dates, and if you pass a date, whether that exact date works and why not.",
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
      const catalog = await getCatalog();
      const cfg = resolveDeliveryConfig(catalog.delivery);
      const problem = date ? deliveryProblem(date, cfg, carrier) : null;
      return {
        carrier,
        timezone: "America/Chicago",
        earliest: minDeliveryDate(cfg, carrier),
        latest: maxDeliveryDate(cfg),
        ...(date
          ? { requested: date, ok: problem === null, ...(problem ? { reason: problem } : {}) }
          : {}),
        promise:
          carrier === "fedex"
            ? "Arrives on the exact date you pick (FedEx 2-Day)."
            : `Arrives within about ${cfg.uspsWindowDays} mailing days either side of the date you pick (USPS First Class).`,
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
