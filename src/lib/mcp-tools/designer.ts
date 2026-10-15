import { readFile } from "node:fs/promises";
import path from "node:path";
import graphicsFile from "../../../public/graphics.json";
import {
  getCatalog,
  resolveGraphicCategories,
  resolveHubGraphics,
  type HubAddon,
  type HubBodyStyle,
  type HubCatalog,
  type HubFilling,
} from "@/lib/hub";
import { fillingAllowsAddon, resolveFillings } from "@/lib/flow";
import { deliveryProblem, resolveDeliveryConfig, type Carrier } from "@/lib/delivery";
import { HOLIDAYS, type LibraryGraphic } from "@/lib/library-data";
import { resolveVariantProfile } from "@/lib/variant";
import type { McpResourceContents, McpResourceListing, ToolAnnotations } from "@/lib/mcp-http";
import { projectCatalog, type ProjectedCatalog } from "@/lib/mcp-tools/catalog";
import { matchOccasionLabels, searchDesigns, type DesignRow } from "@/lib/mcp-tools/designs";
import { MAX_ADDONS, MCP_HOST } from "@/lib/mcp-tools/price";
import type { ToolDef } from "@/lib/order-tools";

/**
 * `open_designer` — the in-chat Piñatagram designer as an MCP App
 * (extension io.modelcontextprotocol/ui, spec 2026-01-26).
 *
 * The tool's listing carries `_meta.ui.resourceUri` = the `ui://` HTML
 * resource below; a host that renders MCP Apps fetches that resource over the
 * normal MCP connection (resources/read), shows it in a sandboxed iframe, and
 * hands it this tool's result through `ui/notifications/tool-result`. The
 * app then calls the SAME tools every agent uses (`price_order`,
 * `create_checkout`, …) through the host bridge — nothing here prices or
 * orders anything.
 *
 * Input is PREFILL, not an order: every field is optional and a value that
 * doesn't match the catalog (an unknown style, a date the calendar refuses,
 * an add-on the filling doesn't allow) is DROPPED with a customer-safe reason
 * in `dropped`, never refused — the person fixes it in the designer. The
 * result is a short model-facing summary in `content` (what is prefilled,
 * what is still to choose) plus the app's data in `structuredContent`: the
 * customer-safe catalog projection, a design gallery (Classic STANDARD first;
 * the occasion's page when one was given, otherwise a curated page spanning
 * the headline occasions and the next holidays), every occasion label (the
 * app loads the rest through list_designs), the normalized prefill, the
 * ordering flag and today's date in the shop's timezone.
 *
 * The HTML is ONE self-contained file (src/mcp-app/designer.html, owned by
 * the app builder) read with fs relative to process.cwd() — the same pattern
 * as src/lib/render/fonts.ts — and cached in module scope so a host that
 * prefetches the resource costs one disk read per instance. next.config's
 * outputFileTracingIncludes ships the folder in the /api/mcp bundle.
 */

const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

export const DESIGNER_RESOURCE_URI = "ui://pinatagrams/designer.html";
/** The MCP Apps mime type, exactly — hosts match the string. */
export const MCP_APP_MIME = "text/html;profile=mcp-app";
/** ONE static expression on process.cwd() so @vercel/nft can trace the file. */
export const DESIGNER_HTML_PATH = path.join(process.cwd(), "src/mcp-app/designer.html");
export const BUILDER_URL = "https://builder.pinatagrams.com";
/** Gallery size the app receives (it calls list_designs for more). */
export const DESIGN_LIMIT = 24;
/** The default page (no occasion given) is curated, not an alphabetical
 *  slice: Classic, then an even share from each of these in order, then the
 *  next calendar holidays. */
export const HEADLINE_OCCASIONS = ["Birthday", "Thank you", "Family & Friends", "Sympathy", "Congrats"];
export const HOLIDAYS_ON_DEFAULT_PAGE = 2;
const MESSAGE_MAX = 300; // the card's capacity (checkout refuses longer)
const TEXT_MAX = 100;
const EMAIL_MAX = 120;
const SHOP_TZ = "America/Chicago";

/** Origins the app loads images, styles and fonts from. Hosts default to a
 *  deny-all CSP, so anything not declared here is blocked in the iframe. */
export const RESOURCE_DOMAINS = [
  "https://*.public.blob.vercel-storage.com", // body-style photos (the hub's Blob store)
  "https://cdn.shopify.com", // design thumbnails
  "https://fonts.googleapis.com", // Poppins
  "https://fonts.gstatic.com",
];

const UI_META = {
  ui: {
    csp: { resourceDomains: RESOURCE_DOMAINS, connectDomains: [] as string[] },
    prefersBorder: true,
  },
};

const CARRIERS: Carrier[] = ["fedex", "usps"];
const FIELDS = [
  "occasion",
  "recipient_name",
  "style_id",
  "filling",
  "design",
  "add_ons",
  "message",
  "carrier",
  "delivery_date",
  "ship_to",
  "email",
] as const;
const SHIP_TO_FIELDS = ["name", "address1", "address2", "city", "state", "zip", "phone"] as const;
type ShipToField = (typeof SHIP_TO_FIELDS)[number];
// The checkout route's cleanAddress caps; state is checked by shape below.
const SHIP_TO_MAX: Record<ShipToField, number> = {
  name: 80,
  address1: 120,
  address2: 120,
  city: 60,
  state: 20,
  zip: 16,
  phone: 24,
};
const DESIGN_RE = /^[A-Z0-9]{2,24}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const STATE_RE = /^[A-Za-z]{2}$/;
const ZIP_RE = /^\d{5}(-\d{4})?$/;
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

type Manifest = { graphics: LibraryGraphic[] };
const MANIFEST = graphicsFile as unknown as Manifest;

export type ShipToPrefill = Partial<Record<ShipToField, string>>;

/** The prefill that survived normalization — ids and codes exactly as the
 *  catalog spells them, so the app can hand them straight to price_order. */
export type DesignerPrefill = {
  occasion?: string;
  recipient_name?: string;
  style_id?: string;
  filling?: string;
  design?: string;
  add_ons?: string[];
  message?: string;
  carrier?: Carrier;
  delivery_date?: string;
  ship_to?: ShipToPrefill;
  email?: string;
};

export type Dropped = { field: string; reason: string };

export type DesignerDesign = {
  code: string;
  title: string;
  thumb_url: string | null;
  upcharge: "free" | "library";
  occasion: string;
  /** Hub graphics limited to certain body styles; absent = fits all. */
  body_styles?: string[];
};

/** structuredContent — the app's data (the model reads `content` instead). */
export type DesignerData = {
  catalog: ProjectedCatalog;
  designs: DesignerDesign[];
  /** Every occasion label, so the app's chips reach designs past the page
   *  (it loads them with tools.designs). */
  occasions: string[];
  prefill: DesignerPrefill;
  dropped: Dropped[];
  ordering_enabled: boolean;
  builder_url: string;
  today: string;
  tools: { price: "price_order"; checkout: "create_checkout"; designs: "list_designs" };
};

/* ---- helpers (no network) ----------------------------------------------- */

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

const show = (v: string) => v.slice(0, 60);
const lower = (s: string) => s.trim().toLowerCase();

// Same lookups as price_order / create_checkout (exact first, then
// case-insensitive) so a value kept here is a value those tools accept.
function findStyle(styles: HubBodyStyle[], id: string): HubBodyStyle | undefined {
  return styles.find((s) => s.id === id) ?? styles.find((s) => lower(s.id) === lower(id));
}

function findFilling(fillings: HubFilling[], key: string): HubFilling | undefined {
  return (
    fillings.find((f) => f.label === key || f.id === key) ??
    fillings.find((f) => lower(f.label) === lower(key) || lower(f.id) === lower(key))
  );
}

function findAddon(addons: HubAddon[], key: string): HubAddon | undefined {
  return (
    addons.find((a) => a.id === key || a.label === key) ??
    addons.find((a) => lower(a.id) === lower(key) || lower(a.label) === lower(key))
  );
}

function isCalendarDate(ymd: string): boolean {
  const [y, m, d] = ymd.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** Today's date in the shop's timezone, YYYY-MM-DD (en-CA formats so). */
function shopToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: SHOP_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** A trimmed text prefill value: null when absent or empty (no note), and
 *  null WITH a dropped note when it isn't text or is too long. */
function text(v: unknown, field: string, max: number, dropped: Dropped[]): string | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string") {
    dropped.push({ field, reason: "must be text" });
    return null;
  }
  const s = v.trim();
  if (!s) return null;
  if (s.length > max) {
    dropped.push({ field, reason: `is ${s.length} characters; the limit is ${max}` });
    return null;
  }
  return s;
}

function designOf(r: DesignRow): DesignerDesign {
  return {
    code: r.design,
    title: r.title_or_label,
    thumb_url: r.thumb_url,
    upcharge: r.upcharge,
    occasion: r.occasion,
    ...(r.body_styles ? { body_styles: r.body_styles } : {}),
  };
}

/** The next `n` calendar holidays from `today` (YYYY-MM-DD) as occasion
 *  labels, wrapping past New Year — the seasonal rows on the default page. */
export function upcomingHolidays(today: string, n: number): string[] {
  const mmdd = today.slice(5, 10);
  const key = (h: { month: number; day: number }) =>
    `${String(h.month).padStart(2, "0")}-${String(h.day).padStart(2, "0")}`;
  const sorted = HOLIDAYS.map((h) => ({ label: h.label, k: key(h) })).sort((a, b) =>
    a.k < b.k ? -1 : a.k > b.k ? 1 : 0,
  );
  const ahead = sorted.filter((h) => h.k >= mmdd).concat(sorted.filter((h) => h.k < mmdd));
  return [...new Set(ahead.map((h) => h.label))].slice(0, n);
}

/**
 * The default gallery page: Classic first, then the headline occasions in
 * order and the next holidays, each with an even share of the page (earlier
 * occasions take the remainder; an occasion with fewer designs hands its
 * slack on). Rows keep searchDesigns' alphabetical order within an occasion.
 */
export function curateDefault(rows: DesignRow[], today: string, limit = DESIGN_LIMIT): DesignRow[] {
  const classic = rows.filter((r) => r.is_default);
  const present = new Set(rows.map((r) => r.occasion));
  const order = [
    ...new Set([...HEADLINE_OCCASIONS, ...upcomingHolidays(today, HOLIDAYS_ON_DEFAULT_PAGE)]),
  ].filter((label) => present.has(label));
  const out: DesignRow[] = [];
  let remaining = limit - classic.length;
  order.forEach((label, i) => {
    const quota = Math.ceil(remaining / (order.length - i));
    const take = rows.filter((r) => !r.is_default && r.occasion === label).slice(0, quota);
    out.push(...take);
    remaining -= take.length;
  });
  // A thin library (few occasions) tops up alphabetically so the page is full.
  for (const r of rows) {
    if (remaining <= 0) break;
    if (r.is_default || out.includes(r)) continue;
    out.push(r);
    remaining--;
  }
  return [...classic, ...out];
}

/* ---- normalization against the catalog ---------------------------------- */

export type Normalized = {
  prefill: DesignerPrefill;
  dropped: Dropped[];
  designs: DesignerDesign[];
  /** Every occasion label the library sells, sorted (the app's filter chips). */
  occasions: string[];
  /** Customer-facing names for the model summary. */
  names: { style?: string; filling?: string };
};

/**
 * Check every prefill field against the live catalog; keep what matches
 * (normalized to the catalog's own ids/codes), drop the rest with a reason.
 * Also builds the gallery: the default page, or the occasion's page when an
 * occasion matched, always with the Classic default first and always
 * including a prefilled design even past the page or outside the filter.
 */
export function normalizePrefill(
  args: Record<string, unknown>,
  catalog: HubCatalog,
  today: string = shopToday(),
): Normalized {
  const dropped: Dropped[] = [];
  const prefill: DesignerPrefill = {};
  const names: Normalized["names"] = {};

  for (const k of Object.keys(args)) {
    if (!(FIELDS as readonly string[]).includes(k)) {
      dropped.push({ field: k, reason: "isn't a designer field; ignored" });
    }
  }

  const cfg = resolveDeliveryConfig(catalog.delivery);
  const variant = resolveVariantProfile(catalog.variant);
  const fillings = resolveFillings(catalog.fillings);
  const addons = catalog.addons ?? [];
  const hub = resolveHubGraphics(catalog.hubGraphics);
  const categories = resolveGraphicCategories(catalog.graphicCategories);

  // Every sellable design, Classic first — the table any prefilled code is
  // checked against; the default page is curated from it.
  const all = searchDesigns(MANIFEST.graphics, hub, categories, { limit: Number.MAX_SAFE_INTEGER });
  if ("refusal" in all) throw new Error(all.refusal); // only an occasion filter can refuse
  const byCode = new Map(all.rows.map((r) => [r.design, r]));
  let rows: DesignRow[] = curateDefault(all.rows, today);

  // occasion → the gallery's filter (the label when exactly one matched)
  const occasion = text(args.occasion, "occasion", TEXT_MAX, dropped);
  if (occasion) {
    const labels = matchOccasionLabels(occasion, all.occasions);
    if (!labels.length) {
      dropped.push({
        field: "occasion",
        reason: `no designs are filed under "${show(occasion)}"; the gallery shows every occasion instead`,
      });
    } else {
      const filtered = searchDesigns(MANIFEST.graphics, hub, categories, { occasion, limit: DESIGN_LIMIT });
      if (!("refusal" in filtered)) rows = filtered.rows;
      prefill.occasion = labels.length === 1 ? labels[0] : occasion;
    }
  }

  const recipient = text(args.recipient_name, "recipient_name", SHIP_TO_MAX.name, dropped);
  if (recipient) prefill.recipient_name = recipient;

  // piñata (must exist AND be in stock — the designer greys the rest out)
  let style: HubBodyStyle | undefined;
  const styleKey = text(args.style_id, "style_id", TEXT_MAX, dropped);
  if (styleKey) {
    const found = findStyle(catalog.bodyStyles, styleKey);
    if (!found) {
      dropped.push({ field: "style_id", reason: `no piñata has the id "${show(styleKey)}"` });
    } else if (!found.inStock) {
      dropped.push({ field: "style_id", reason: `the ${found.name} piñata is out of stock right now` });
    } else {
      style = found;
      prefill.style_id = found.id;
      names.style = found.name;
    }
  }

  // filling (id or label → id)
  let filling: HubFilling | undefined;
  const fillingKey = text(args.filling, "filling", TEXT_MAX, dropped);
  if (fillingKey) {
    const found = findFilling(fillings, fillingKey);
    if (!found) {
      dropped.push({ field: "filling", reason: `no filling is called "${show(fillingKey)}"` });
    } else {
      filling = found;
      prefill.filling = found.id;
      names.filling = found.label;
    }
  }

  // design (a code the gallery sells; hub graphics may be body-restricted)
  const designKey = text(args.design, "design", TEXT_MAX, dropped);
  if (designKey) {
    const code = designKey.toUpperCase();
    const row = DESIGN_RE.test(code) ? byCode.get(code) : undefined;
    if (!row) {
      dropped.push({ field: "design", reason: `no design has the code "${show(designKey)}"` });
    } else if (row.body_styles && style && !row.body_styles.includes(style.id)) {
      dropped.push({ field: "design", reason: `design ${code} isn't offered on the ${style.name} piñata` });
    } else {
      prefill.design = row.design;
      // The gallery must show what is selected, even past its page or filter.
      if (!rows.some((r) => r.design === row.design)) rows = [...rows, row];
    }
  }

  // add-ons (ids or labels → ids; the filling's rule applies when known)
  if (args.add_ons !== undefined && args.add_ons !== null) {
    if (!Array.isArray(args.add_ons)) {
      dropped.push({ field: "add_ons", reason: "must be a list of add-on ids" });
    } else if (args.add_ons.length > MAX_ADDONS) {
      dropped.push({ field: "add_ons", reason: `lists ${args.add_ons.length} entries; at most ${MAX_ADDONS}` });
    } else {
      const ids: string[] = [];
      args.add_ons.forEach((raw, i) => {
        const field = `add_ons[${i}]`;
        const key = text(raw, field, TEXT_MAX, dropped);
        if (!key) return;
        const rec = findAddon(addons, key);
        if (!rec) {
          dropped.push({ field, reason: `no add-on is called "${show(key)}"` });
        } else if (filling && !fillingAllowsAddon(filling, rec.id)) {
          dropped.push({ field, reason: `${rec.label} isn't available with the ${filling.label} filling` });
        } else if (!ids.includes(rec.id)) {
          ids.push(rec.id);
        }
      });
      if (ids.length) prefill.add_ons = ids;
    }
  }

  // message (never clipped silently — the person shortens it in the designer)
  if (args.message !== undefined && args.message !== null && args.message !== "") {
    if (typeof args.message !== "string") {
      dropped.push({ field: "message", reason: "must be text" });
    } else {
      const m = args.message.trim();
      if (m.length > MESSAGE_MAX) {
        dropped.push({
          field: "message",
          reason: `is ${m.length} characters; the card holds ${MESSAGE_MAX} — shorten it`,
        });
      } else if (m) {
        prefill.message = m;
      }
    }
  }

  // carrier (and whether this store offers it)
  let carrier: Carrier | undefined;
  const carrierKey = text(args.carrier, "carrier", TEXT_MAX, dropped);
  if (carrierKey) {
    const c = CARRIERS.find((x) => x === carrierKey.toLowerCase());
    if (!c) {
      dropped.push({ field: "carrier", reason: `must be "fedex" or "usps" (got "${show(carrierKey)}")` });
    } else if (!variant.carriers.includes(c)) {
      dropped.push({ field: "carrier", reason: `${c === "usps" ? "USPS" : "FedEx"} isn't offered on this store` });
    } else {
      carrier = c;
      prefill.carrier = c;
    }
  }

  // delivery date — the calendar rule the designer itself applies, for the
  // carrier given (FedEx, the designer's default, otherwise)
  const dateKey = text(args.delivery_date, "delivery_date", TEXT_MAX, dropped);
  if (dateKey) {
    if (!YMD_RE.test(dateKey) || !isCalendarDate(dateKey)) {
      dropped.push({ field: "delivery_date", reason: `"${show(dateKey)}" isn't a real date as YYYY-MM-DD` });
    } else {
      const problem = deliveryProblem(dateKey, cfg, carrier ?? "fedex");
      if (problem) dropped.push({ field: "delivery_date", reason: problem });
      else prefill.delivery_date = dateKey;
    }
  }

  // ship_to — each part on its own, so one bad part doesn't lose the rest
  if (args.ship_to !== undefined && args.ship_to !== null) {
    if (!isObj(args.ship_to)) {
      dropped.push({
        field: "ship_to",
        reason: "must be an object with name, address1, address2, city, state, zip and phone",
      });
    } else {
      const raw = args.ship_to;
      const out: ShipToPrefill = {};
      for (const k of Object.keys(raw)) {
        if (!(SHIP_TO_FIELDS as readonly string[]).includes(k)) {
          dropped.push({ field: `ship_to.${k}`, reason: "isn't an address field; ignored" });
        }
      }
      for (const k of SHIP_TO_FIELDS) {
        const v = text(raw[k], `ship_to.${k}`, SHIP_TO_MAX[k], dropped);
        if (!v) continue;
        if (k === "state") {
          if (!STATE_RE.test(v)) {
            dropped.push({ field: "ship_to.state", reason: `must be the 2-letter state code (got "${show(v)}")` });
            continue;
          }
          out.state = v.toUpperCase();
        } else if (k === "zip" && !ZIP_RE.test(v)) {
          dropped.push({ field: "ship_to.zip", reason: `must be a US ZIP code like 78701 (got "${show(v)}")` });
        } else {
          out[k] = v;
        }
      }
      if (Object.keys(out).length) prefill.ship_to = out;
    }
  }

  // payer email (optional everywhere; Shopify asks again at checkout)
  const email = text(args.email, "email", EMAIL_MAX, dropped);
  if (email) {
    if (!EMAIL_RE.test(email)) {
      dropped.push({ field: "email", reason: `"${show(email)}" doesn't look like an email address` });
    } else {
      prefill.email = email;
    }
  }

  return { prefill, dropped, designs: rows.map(designOf), occasions: all.occasions, names };
}

/* ---- the model-facing summary ------------------------------------------- */

const shipToComplete = (s: ShipToPrefill | undefined): boolean =>
  !!s && !!s.name && !!s.address1 && !!s.city && !!s.state && !!s.zip;

/** Under ~80 words: what is prefilled, what the designer still collects,
 *  and how the model should behave while the person uses it. */
export function summarize(n: Normalized, orderingEnabled: boolean): string {
  const p = n.prefill;
  const have: string[] = [];
  if (p.occasion) have.push(`occasion (${p.occasion})`);
  if (p.recipient_name) have.push(`recipient (${p.recipient_name})`);
  if (p.style_id) have.push(`piñata (${n.names.style ?? p.style_id})`);
  if (p.filling) have.push(`filling (${n.names.filling ?? p.filling})`);
  if (p.add_ons) have.push(`add-ons (${p.add_ons.join(", ")})`);
  if (p.design) have.push(`design (${p.design})`);
  if (p.message) have.push("message");
  if (p.carrier) have.push(`carrier (${p.carrier})`);
  if (p.delivery_date) have.push(`delivery date (${p.delivery_date})`);
  if (p.ship_to) have.push(shipToComplete(p.ship_to) ? "address" : "address (partial)");
  if (p.email) have.push("email");

  const missing: string[] = [];
  if (!p.style_id) missing.push("piñata");
  if (!p.filling) missing.push("filling");
  if (!p.design) missing.push("design");
  // The card message is optional in the designer (step 4 reads "Optional"),
  // so it is never "still to choose"; the model is asked to offer one instead.
  if (!p.delivery_date) missing.push("delivery date");
  if (!shipToComplete(p.ship_to)) missing.push(p.ship_to ? "the rest of the address" : "address");

  // "add_ons[1]" / "ship_to.state" → the field they belong to, once each.
  const droppedFields = [...new Set(n.dropped.map((d) => d.field.replace(/[.[].*$/, "")))];

  return (
    `Designer opened in the chat. Prefilled: ${have.length ? have.join(", ") : "nothing"}.` +
    (droppedFields.length ? ` Couldn't prefill ${droppedFields.join(", ")} (reasons in dropped).` : "") +
    ` Still to choose in the designer: ${missing.length ? missing.join(", ") : "nothing — they can review and check out"}.` +
    " Let the person use the designer for those choices; don't ask for them again." +
    (p.message
      ? " Help with the card message if they want."
      : " The card message is optional — offer to write it.") +
    " When the designer reports a checkout link, relay it and remind them the order exists only after payment." +
    (orderingEnabled
      ? ""
      : " Ordering through the designer is switched off right now; it sends people to the builder to finish.")
  );
}

/* ---- the tool ----------------------------------------------------------- */

export const designerTools: Record<string, ToolDef> = {
  open_designer: {
    title: "Piñatagram designer",
    description:
      "Open the visual Piñatagram designer in the chat: an interactive panel where the person picks the piñata, what goes inside, the front design, writes the card message, chooses the arrival date and address, sees the live price and gets the Shopify checkout link. Call this FIRST whenever someone wants to send, order or design a Piñatagram, passing whatever they already told you as prefill (occasion, recipient, date, message, address, …). Every field is optional and anything that doesn't match the catalog is dropped with a reason, never refused. Returns a short summary of what is prefilled and what the designer still collects; the designer's own data (catalog, design gallery with STANDARD first, normalized prefill, dropped fields) rides in structuredContent. Nothing is ordered or reserved.",
    inputSchema: {
      type: "object",
      description:
        "Prefill only — every field is optional; a value that doesn't match the catalog is dropped with a reason, never refused.",
      properties: {
        occasion: {
          type: "string",
          maxLength: TEXT_MAX,
          description: "The occasion (e.g. Birthday, Thank you, Sympathy, Christmas); filters the design gallery.",
        },
        recipient_name: {
          type: "string",
          maxLength: SHIP_TO_MAX.name,
          description: "Who the Piñatagram is for (a first name is fine).",
        },
        style_id: { type: "string", description: 'Body style id from get_catalog, e.g. "googly".' },
        filling: { type: "string", description: 'Filling id or label from get_catalog, e.g. "Candy".' },
        design: {
          type: "string",
          description: 'Design code from list_designs, e.g. "HBD06"; STANDARD is the free Classic design.',
        },
        add_ons: {
          type: "array",
          items: { type: "string" },
          maxItems: MAX_ADDONS,
          description: 'Add-on ids from get_catalog, e.g. ["double-candy"].',
        },
        message: {
          type: "string",
          maxLength: MESSAGE_MAX,
          description: `The card message printed inside, up to ${MESSAGE_MAX} characters.`,
        },
        carrier: {
          type: "string",
          enum: CARRIERS,
          description: "fedex (2-Day, exact arrival date) or usps (First Class, arrives in a window).",
        },
        delivery_date: {
          type: "string",
          pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          description: "Arrival date, YYYY-MM-DD (America/Chicago).",
        },
        ship_to: {
          type: "object",
          description: "Any part of the recipient's US address that is already known.",
          properties: {
            name: { type: "string" },
            address1: { type: "string" },
            address2: { type: "string" },
            city: { type: "string" },
            state: { type: "string", description: "2-letter state code, e.g. TX" },
            zip: { type: "string" },
            phone: { type: "string" },
          },
          additionalProperties: false,
        },
        email: { type: "string", description: "The payer's email, to prefill Shopify's contact step." },
      },
      additionalProperties: false,
    },
    annotations: READ_ONLY,
    _meta: { ui: { resourceUri: DESIGNER_RESOURCE_URI } },
    handler: async (args) => {
      // Scoped to MCP_HOST like price_order and create_checkout, so the
      // designer shows the variant profile those tools will price.
      const catalog = await getCatalog({ host: MCP_HOST });
      const today = shopToday();
      const n = normalizePrefill(args, catalog, today);
      const ordering_enabled = process.env.MCP_ORDERING_ENABLED === "true";
      const structuredContent: DesignerData = {
        catalog: projectCatalog(catalog),
        designs: n.designs,
        occasions: n.occasions,
        prefill: n.prefill,
        dropped: n.dropped,
        ordering_enabled,
        builder_url: BUILDER_URL,
        today,
        tools: { price: "price_order", checkout: "create_checkout", designs: "list_designs" },
      };
      return {
        content: [{ type: "text" as const, text: summarize(n, ordering_enabled) }],
        structuredContent,
      };
    },
  },
};

/* ---- the ui:// resource ------------------------------------------------- */

let htmlCache: Promise<string> | null = null;

/** The designer's single-file HTML, read once per instance and kept in
 *  module scope (hosts may prefetch the resource); a failed read is not
 *  cached, so the next request retries. */
export function designerHtml(): Promise<string> {
  if (!htmlCache) {
    htmlCache = readFile(DESIGNER_HTML_PATH, "utf8").catch((err: unknown) => {
      htmlCache = null;
      throw err;
    });
  }
  return htmlCache;
}

export const designerResources = {
  list: (): McpResourceListing[] => [
    {
      uri: DESIGNER_RESOURCE_URI,
      name: "Piñatagram designer",
      description:
        "The in-chat Piñatagram designer (an MCP App): pick the piñata, what's inside, the front design, the card message, the arrival date and the address, see the live price and get the Shopify checkout link.",
      mimeType: MCP_APP_MIME,
      _meta: UI_META,
    },
  ],
  read: async (uri: string): Promise<McpResourceContents[] | null> => {
    if (uri !== DESIGNER_RESOURCE_URI) return null;
    return [{ uri, mimeType: MCP_APP_MIME, text: await designerHtml(), _meta: UI_META }];
  },
};
