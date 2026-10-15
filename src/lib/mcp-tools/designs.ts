import graphicsFile from "../../../public/graphics.json";
import { CLASSIC_GRAPHIC } from "@/lib/flow";
import {
  getCatalog,
  resolveGraphicCategories,
  resolveHubGraphics,
  type HubGraphicCategory,
  type HubGraphicEntry,
} from "@/lib/hub";
import { EXCLUDED_PREFIXES, OCCASIONS, occasionOf, type LibraryGraphic } from "@/lib/library-data";
import { toolError, type ToolAnnotations } from "@/lib/mcp-http";
import type { ToolDef } from "@/lib/order-tools";

/**
 * `list_designs` — the graphic library an agent may order from, searchable
 * by words and filterable by occasion, returned as DESIGN CODES (the only
 * handle an order accepts; never an image URL).
 *
 * Two sources, one list:
 *  - the Shopify design library compiled into public/graphics.json (the same
 *    sellable set the storefront shows: print art present, client one-off
 *    prefixes excluded);
 *  - the hub's uploaded graphics (catalog `hubGraphics`), whose titles are
 *    INTERNAL — a row shows its category label instead, never the title.
 *
 * The Classic Piñatagrams default (CLASSIC_GRAPHIC, code STANDARD) is listed
 * explicitly as the free tier; every other design is the "library" tier whose
 * upcharge get_catalog reports. No amounts here, so a hub outage degrades to
 * library-only with a visible warning rather than failing the whole call.
 */

const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 50;
const MAX_QUERY_CHARS = 100;
const CLASSIC_OCCASION = "Any occasion";

// CLASSIC_GRAPHIC is typed as the GraphicChoice union; the default is (and
// must stay) a Shopify library design with a code, title and thumbnail.
const CLASSIC = (() => {
  const g = CLASSIC_GRAPHIC;
  if (g.type !== "shopify") throw new Error("CLASSIC_GRAPHIC must be a Shopify library design");
  return g;
})();

export type DesignRow = {
  design: string;
  title_or_label: string;
  occasion: string;
  thumb_url: string | null;
  source: "library" | "hub";
  upcharge: "free" | "library";
  /** Only on the Classic default. */
  is_default?: true;
  /** Hub graphics restricted to certain body styles; absent = fits all. */
  body_styles?: string[];
};

export type DesignSearchArgs = {
  query?: string;
  occasion?: string;
  limit: number;
};

export type DesignSearchResult = {
  rows: DesignRow[];
  total: number;
  occasions: string[];
};

type Manifest = { generatedAt?: string; graphics: LibraryGraphic[] };
const MANIFEST = graphicsFile as unknown as Manifest;

const designPrefix = (design: string) => design.replace(/[0-9]+$/, "");

/** The library the storefront sells: print art present, one-offs excluded. */
export function sellableLibrary(graphics: LibraryGraphic[] = MANIFEST.graphics): LibraryGraphic[] {
  return graphics.filter(
    (g) => !!g?.design && !!g.art && !EXCLUDED_PREFIXES.has(designPrefix(g.design)),
  );
}

/** Lower-case ASCII words: "Piñatagram" → "pinatagram", "St. Patrick's" → "st patrick s". */
export function normalizeText(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function classicRow(): DesignRow {
  return {
    design: CLASSIC.design,
    title_or_label: CLASSIC.title,
    occasion: CLASSIC_OCCASION,
    thumb_url: CLASSIC.thumb ?? null,
    source: "library",
    upcharge: "free",
    is_default: true,
  };
}

function libraryRow(g: LibraryGraphic): DesignRow {
  return {
    design: g.design,
    title_or_label: g.title,
    occasion: occasionOf(g.design),
    thumb_url: g.thumb ?? null,
    source: "library",
    upcharge: "library",
  };
}

function hubRow(h: HubGraphicEntry, labels: Map<string, string>): DesignRow {
  // Hub titles are internal organisation; the category label is what a
  // customer sees, so that is the only name this row carries.
  const label = labels.get(h.category) ?? h.category ?? "Hub design";
  return {
    design: h.design,
    title_or_label: label,
    occasion: label,
    thumb_url: h.thumb || null,
    source: "hub",
    upcharge: "library",
    ...(h.bodyStyles !== "all" ? { body_styles: [...h.bodyStyles] } : {}),
  };
}

/** Words the query is matched against — title/label, occasion and the code. */
function haystack(row: DesignRow): string {
  return `${normalizeText(row.title_or_label)} ${normalizeText(row.occasion)} ${normalizeText(row.design)}`;
}

/** Resolve a user-typed occasion to the labels it names (empty = unknown). */
export function matchOccasionLabels(occasion: string, known: string[]): string[] {
  const nq = normalizeText(occasion);
  if (!nq) return [];
  const byPrefix = OCCASIONS[occasion.toUpperCase().replace(/[^A-Z0-9]/g, "")];
  return known.filter((label) => {
    if (label === byPrefix) return true;
    const nl = normalizeText(label);
    return nl === nq || nl.includes(nq) || nq.includes(nl);
  });
}

/**
 * Pure search over already-resolved rows. Ordering is total and stable:
 * the Classic default first (when it matches at all), then exact code/title
 * matches, then rows whose OCCASION matches the query, then the rest;
 * within a band alphabetical by normalised title, then by code.
 */
export function searchDesigns(
  library: LibraryGraphic[],
  hub: HubGraphicEntry[],
  categories: HubGraphicCategory[],
  args: DesignSearchArgs,
): DesignSearchResult | { refusal: string } {
  const labels = new Map(categories.map((c) => [c.id, c.label]));
  const seen = new Set<string>();
  const rows: DesignRow[] = [classicRow()];
  seen.add(CLASSIC.design);
  for (const g of sellableLibrary(library)) {
    if (seen.has(g.design)) continue;
    seen.add(g.design);
    rows.push(libraryRow(g));
  }
  for (const h of hub) {
    if (seen.has(h.design)) continue;
    seen.add(h.design);
    rows.push(hubRow(h, labels));
  }

  const occasions = [...new Set(rows.filter((r) => !r.is_default).map((r) => r.occasion))].sort(
    (a, b) => (normalizeText(a) < normalizeText(b) ? -1 : 1),
  );

  let matched = rows;

  if (args.occasion !== undefined) {
    const wanted = new Set(matchOccasionLabels(args.occasion, occasions));
    if (wanted.size === 0) {
      return {
        refusal: `No designs for occasion "${args.occasion}". Known occasions: ${occasions.join(", ")}.`,
      };
    }
    // The Classic default suits any occasion, so it always passes this filter.
    matched = matched.filter((r) => r.is_default || wanted.has(r.occasion));
  }

  const nq = args.query === undefined ? "" : normalizeText(args.query);
  const tokens = nq ? nq.split(" ") : [];
  const band = new Map<string, number>();
  if (tokens.length) {
    matched = matched.filter((r) => {
      const hay = haystack(r);
      if (!tokens.every((t) => hay.includes(t))) return false;
      const exact = normalizeText(r.design) === nq || normalizeText(r.title_or_label) === nq;
      const occ = normalizeText(r.occasion);
      const occasionHit = tokens.every((t) => occ.includes(t));
      band.set(r.design, exact ? 0 : occasionHit ? 1 : 2);
      return true;
    });
  }

  matched.sort((a, b) => {
    if (a.is_default !== b.is_default) return a.is_default ? -1 : 1;
    const ba = band.get(a.design) ?? 2;
    const bb = band.get(b.design) ?? 2;
    if (ba !== bb) return ba - bb;
    const ta = normalizeText(a.title_or_label);
    const tb = normalizeText(b.title_or_label);
    if (ta !== tb) return ta < tb ? -1 : 1;
    return a.design < b.design ? -1 : a.design > b.design ? 1 : 0;
  });

  return { rows: matched.slice(0, args.limit), total: matched.length, occasions };
}

function parseArgs(args: Record<string, unknown>): DesignSearchArgs | { refusal: string } {
  let limit = DEFAULT_LIMIT;
  if (args.limit !== undefined) {
    if (typeof args.limit !== "number" || !Number.isInteger(args.limit)) {
      return { refusal: `limit must be a whole number from 1 to ${MAX_LIMIT}` };
    }
    if (args.limit < 1 || args.limit > MAX_LIMIT) {
      return { refusal: `limit must be between 1 and ${MAX_LIMIT}` };
    }
    limit = args.limit;
  }
  let query: string | undefined;
  if (args.query !== undefined) {
    if (typeof args.query !== "string") return { refusal: "query must be a string" };
    if (args.query.length > MAX_QUERY_CHARS) {
      return { refusal: `query must be at most ${MAX_QUERY_CHARS} characters` };
    }
    if (args.query.trim()) query = args.query;
  }
  let occasion: string | undefined;
  if (args.occasion !== undefined) {
    if (typeof args.occasion !== "string") return { refusal: "occasion must be a string" };
    if (args.occasion.length > MAX_QUERY_CHARS) {
      return { refusal: `occasion must be at most ${MAX_QUERY_CHARS} characters` };
    }
    if (args.occasion.trim()) occasion = args.occasion;
  }
  return { query, occasion, limit };
}

const NOTE =
  `${CLASSIC.design} (${CLASSIC.title}) is the free default design. ` +
  "Every other design here adds the library upcharge get_catalog reports as graphic_upcharge_cents.library_design. " +
  "Order by design code only; thumb_url is for preview.";

export const designTools: Record<string, ToolDef> = {
  list_designs: {
    description:
      "Search the design library an order can use, by DESIGN CODE. Pass `query` (words from a design's title or occasion, or a code such as HBD01) and/or `occasion` (a label such as Birthday, Thank you, Sympathy, Christmas — the response lists every valid label) and up to `limit` (1–50, default 20) designs come back, exact matches first, then occasion matches, then alphabetical. Each row has the code to order by, a customer-facing title or category label, the occasion, a preview thumb_url, and its price tier: STANDARD (Classic Piñatagrams) is free, every other design is the library tier whose upcharge get_catalog shows. Hub-uploaded designs may be limited to certain body_styles. Never order by image URL.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          maxLength: MAX_QUERY_CHARS,
          description: "Words matched against title, occasion and design code (e.g. 'basketball', 'thank you', 'HBD01')",
        },
        occasion: {
          type: "string",
          maxLength: MAX_QUERY_CHARS,
          description: "Occasion label to filter by (e.g. 'Birthday'); the response's `occasions` lists valid labels",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: MAX_LIMIT,
          default: DEFAULT_LIMIT,
          description: "Maximum rows to return",
        },
      },
      additionalProperties: false,
    },
    annotations: READ_ONLY,
    handler: async (args) => {
      const parsed = parseArgs(args);
      if ("refusal" in parsed) return toolError(parsed.refusal);

      let hub: HubGraphicEntry[] = [];
      let categories: HubGraphicCategory[] = [];
      let asOf = MANIFEST.generatedAt ?? new Date(0).toISOString();
      let stale: { reason: string; fetchedAt: string } | undefined;
      const warnings: string[] = [];
      try {
        const catalog = await getCatalog();
        hub = resolveHubGraphics(catalog.hubGraphics);
        categories = resolveGraphicCategories(catalog.graphicCategories);
        asOf = catalog.asOf;
        stale = catalog.stale;
      } catch (err) {
        console.warn(
          `[mcp] list_designs: hub catalog unavailable (${err instanceof Error ? err.message : String(err)}); listing the library only`,
        );
        warnings.push(
          "Hub-uploaded designs could not be loaded right now; only the standard library is listed.",
        );
      }

      const result = searchDesigns(MANIFEST.graphics, hub, categories, parsed);
      if ("refusal" in result) return toolError(result.refusal);

      return {
        as_of: asOf,
        ...(stale ? { stale } : {}),
        default_design: CLASSIC.design,
        total_matches: result.total,
        returned: result.rows.length,
        designs: result.rows,
        occasions: result.occasions,
        ...(warnings.length ? { warnings } : {}),
        note: NOTE,
      };
    },
  },
};
