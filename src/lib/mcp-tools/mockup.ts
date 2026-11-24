import { CLASSIC_GRAPHIC } from "@/lib/flow";
import { getCatalog, resolveHubGraphics, styleOffered, type HubBodyStyle, type HubCatalog } from "@/lib/hub";
import { MESSAGE_RULES } from "@/lib/order-rules";
import { toolError, type ToolAnnotations } from "@/lib/mcp-http";
import { MANIFEST } from "@/lib/mcp-tools/library";
import { MCP_HOST } from "@/lib/mcp-tools/price";
import type { ToolDef } from "@/lib/order-tools";
import { isRenderableText, renderPng } from "@/lib/render";
import { loadImage, type RasterImage } from "@/lib/render/images";
import {
  closedSceneSvg,
  composeSheet,
  fitRaster,
  openSceneSvg,
  type SheetTile,
} from "@/lib/render/mockup";

/**
 * `render_mockup` — STAFF ONLY (served by /api/mcp/staff/<secret>, never by
 * the public ordering server). Draws a front graphic and an inside-flap card
 * on body styles, closed and/or open, and returns the sheet as images a chat
 * assistant shows inline — for trying designs across the line-up before
 * they go on sale.
 *
 * Front and flap are chosen independently: each is a design code (library
 * from public/graphics.json — offered or not, this is for experimenting —
 * or a hub upload H0001-style, or STANDARD), an https image URL (PNG, JPEG,
 * WebP or SVG), or nothing. The flap defaults to "match": the front design's
 * own card, the default card (HBD01's) for a URL or hub upload (what the
 * storefront prints for custom art), plain white when a design has none.
 *
 * Read-only: nothing is saved, priced or ordered.
 */

const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

// The default card (HBD01's) custom designs and hub graphics preview and print
// on (src/v2/design/stage.tsx DEFAULT_MESSAGE_CARD — keep in step).
export const DEFAULT_MESSAGE_CARD =
  "https://cdn.shopify.com/s/files/1/1116/8788/files/HBD01-GOOGLY_message_graphic.svg?v=1696183772";

export const VIEWS = ["both", "closed", "open"] as const;
type ViewArg = (typeof VIEWS)[number];

/** Scene widths: big when a few styles are compared, smaller on a full sheet. */
export const SCENE_W = { few: 760, many: 460 } as const;
const FEW = 2;
/** Tiles per returned image (several images come back for a big line-up). */
export const PER_IMAGE = { both: 6, single: 12 } as const;
const MAX_STYLES = 30;

export type ArtRef =
  | { kind: "none" }
  | { kind: "url"; url: string }
  | { kind: "design"; code: string; title: string; art: string | null; card: string | null; source: "library" | "hub" | "classic"; bodyStyles?: "all" | string[] };

/** The Classic default's code (CLASSIC_GRAPHIC is a library design). */
const CLASSIC_CODE = "STANDARD";
const URL_RE = /^https:\/\//i;
const CODE_RE = /^[A-Za-z0-9_-]{2,40}$/;

/** A design code → its front art and its own flap card. */
export function resolveDesign(code: string, catalog: Pick<HubCatalog, "hubGraphics"> | null): ArtRef | null {
  const upper = code.trim().toUpperCase();
  if (upper === CLASSIC_CODE && CLASSIC_GRAPHIC.type === "shopify") {
    return {
      kind: "design",
      code: upper,
      title: CLASSIC_GRAPHIC.title,
      art: CLASSIC_GRAPHIC.art,
      card: CLASSIC_GRAPHIC.message ?? null,
      source: "classic",
    };
  }
  const lib = MANIFEST.graphics.find((g) => g?.design?.toUpperCase() === upper);
  if (lib) {
    return { kind: "design", code: lib.design, title: lib.title, art: lib.art, card: lib.message ?? null, source: "library" };
  }
  const hub = resolveHubGraphics(catalog?.hubGraphics).find((g) => g.design.toUpperCase() === upper);
  if (hub) {
    return {
      kind: "design",
      code: hub.design,
      title: hub.title,
      art: hub.art,
      card: DEFAULT_MESSAGE_CARD,
      source: "hub",
      bodyStyles: hub.bodyStyles,
    };
  }
  return null;
}

type Parsed = {
  styles: string[] | "all";
  front: string;
  flap: string;
  message: string;
  view: ViewArg;
  includeUnoffered: boolean;
};

export function parseArgs(args: Record<string, unknown>): Parsed | { error: string } {
  let styles: string[] | "all" = "all";
  const s = args.styles;
  if (s !== undefined) {
    const list = typeof s === "string" ? [s] : s;
    if (!Array.isArray(list) || !list.every((x) => typeof x === "string" && x.trim())) {
      return { error: 'styles must be a list of body-style ids (get_catalog / the sheet captions), or "all"' };
    }
    const ids = list.map((x) => (x as string).trim().toLowerCase());
    if (ids.includes("all")) styles = "all";
    else if (ids.length > MAX_STYLES) return { error: `at most ${MAX_STYLES} styles per call` };
    else styles = [...new Set(ids)];
  }
  const str = (v: unknown, name: string): string | { error: string } => {
    if (v === undefined || v === null) return "";
    if (typeof v !== "string") return { error: `${name} must be a string` };
    return v.trim();
  };
  const front = str(args.front, "front");
  if (typeof front !== "string") return front;
  const flap = str(args.flap, "flap");
  if (typeof flap !== "string") return flap;
  const message = typeof args.message === "string" ? args.message.replace(/\r\n/g, "\n").trim() : "";
  if (args.message !== undefined && typeof args.message !== "string") return { error: "message must be a string" };
  if (message.length > MESSAGE_RULES.maxChars) {
    return { error: `message must be ${MESSAGE_RULES.maxChars} characters or fewer (the card's limit)` };
  }
  if (message.split("\n").length > MESSAGE_RULES.maxLines) {
    return { error: `message must be ${MESSAGE_RULES.maxLines} lines or fewer (the card's limit)` };
  }
  if (message && !isRenderableText(message)) {
    return { error: "message may use Latin letters, numbers, punctuation and spaces only (no emoji)" };
  }
  const view = (args.view ?? "both") as ViewArg;
  if (!VIEWS.includes(view)) return { error: `view must be one of: ${VIEWS.join(", ")}` };
  if (args.include_unoffered !== undefined && typeof args.include_unoffered !== "boolean") {
    return { error: "include_unoffered must be true or false" };
  }
  for (const [name, v] of [["front", front], ["flap", flap]] as const) {
    if (v && !URL_RE.test(v) && !CODE_RE.test(v) && !/^(none|blank|match)$/i.test(v)) {
      return { error: `${name} must be a design code, an https:// image URL${name === "flap" ? ', "match" or "blank"' : ' or "none"'}` };
    }
  }
  return { styles, front, flap, message, view, includeUnoffered: args.include_unoffered === true };
}

function resolveRef(v: string, catalog: HubCatalog, fallback: ArtRef): ArtRef | { error: string } {
  if (!v) return fallback;
  if (/^(none|blank)$/i.test(v)) return { kind: "none" };
  if (URL_RE.test(v)) return { kind: "url", url: v };
  return resolveDesign(v, catalog) ?? { error: `no design "${v}" in the library or the hub's uploads (list_designs searches them)` };
}

function describe(ref: ArtRef, what: string): string {
  if (ref.kind === "none") return `${what}: none`;
  if (ref.kind === "url") return `${what}: ${ref.url}`;
  return `${what}: ${ref.code} (${ref.title})`;
}

async function load(url: string | null, warnings: string[], what: string): Promise<RasterImage | null> {
  if (!url) return null;
  try {
    return await loadImage(url, "art");
  } catch (err) {
    warnings.push(`${what} could not be loaded (${err instanceof Error ? err.message : String(err)}); drawn without it`);
    return null;
  }
}

export async function renderMockup(args: Record<string, unknown>) {
  const p = parseArgs(args);
  if ("error" in p) return toolError(p.error);

  const catalog = await getCatalog({ host: MCP_HOST });
  const front = resolveRef(p.front, catalog, resolveDesign(CLASSIC_CODE, catalog)!);
  if ("error" in front) return toolError(front.error);

  let flapUrl: string | null;
  let flapLabel: string;
  if (!p.flap || /^match$/i.test(p.flap)) {
    flapUrl = front.kind === "design" ? front.card : front.kind === "url" ? DEFAULT_MESSAGE_CARD : null;
    flapLabel =
      front.kind === "design"
        ? front.card
          ? front.source === "hub"
            ? "flap: the default card (what a hub upload prints on)"
            : `flap: ${front.code}'s own card`
          : `flap: plain white (${front.code} has no card of its own)`
        : front.kind === "url"
          ? "flap: the default card (what custom art prints on)"
          : "flap: plain white";
  } else {
    const flap = resolveRef(p.flap, catalog, { kind: "none" });
    if ("error" in flap) return toolError(flap.error);
    flapUrl = flap.kind === "url" ? flap.url : flap.kind === "design" ? flap.card : null;
    flapLabel =
      flap.kind === "design" && !flap.card
        ? `flap: plain white (${flap.code} has no card of its own)`
        : describe(flap, "flap");
  }

  // Styles: every offered style by default; named ones in the order given.
  const all = catalog.bodyStyles;
  const unknown: string[] = [];
  let styles: HubBodyStyle[];
  if (p.styles === "all") {
    styles = all.filter((s) => p.includeUnoffered || styleOffered(s));
  } else {
    styles = [];
    for (const id of p.styles) {
      const s = all.find((x) => x.id.toLowerCase() === id);
      if (s) styles.push(s);
      else unknown.push(id);
    }
  }
  if (!styles.length) {
    return toolError(
      `no body styles to draw${unknown.length ? ` (unknown: ${unknown.join(", ")})` : ""}. Valid ids: ${all.map((s) => s.id).join(", ")}`,
    );
  }

  const warnings: string[] = [];
  if (unknown.length) warnings.push(`skipped unknown style ids: ${unknown.join(", ")} (valid: ${all.map((s) => s.id).join(", ")})`);
  if (front.kind === "design" && front.bodyStyles && front.bodyStyles !== "all") {
    const off = styles.filter((s) => !(front.bodyStyles as string[]).includes(s.id)).map((s) => s.id);
    if (off.length) warnings.push(`${front.code} is only assigned to ${front.bodyStyles.join(", ")} in the hub; also drawn on ${off.join(", ")} for comparison`);
  }

  const views: ("closed" | "open")[] = p.view === "both" ? ["closed", "open"] : [p.view];
  const sceneW = styles.length <= FEW ? SCENE_W.few : SCENE_W.many;
  const t0 = performance.now();

  const frontUrl = front.kind === "url" ? front.url : front.kind === "design" ? front.art : null;
  const [frontImg, cardRaw, interiorRaw] = await Promise.all([
    load(frontUrl, warnings, "front art"),
    views.includes("open") ? load(flapUrl, warnings, "flap card") : Promise.resolve(null),
    views.includes("open") && catalog.box?.interiorUrl
      ? loadImage(catalog.box.interiorUrl).catch(() => null)
      : Promise.resolve(null),
  ]);
  if (front.kind === "design" && !front.art) warnings.push(`${front.code} has no front art on file; boxes drawn bare`);
  const art = frontImg ? await fitRaster(frontImg, sceneW * 1.5) : null;
  const cardImg = cardRaw ? await fitRaster(cardRaw, sceneW * 1.5) : null;
  const interior = interiorRaw ? await fitRaster(interiorRaw, sceneW * 2) : null;
  const messageZone = catalog.box?.messageZone ?? null;
  if (views.includes("open") && (!interior || !messageZone)) {
    warnings.push("the hub has no box-interior photo or flap placement, so open views are skipped");
  }

  const tiles: SheetTile[] = [];
  for (const style of styles) {
    const scenes: Buffer[] = [];
    const missing: string[] = [];
    for (const v of views) {
      try {
        if (v === "closed") {
          if (!style.boxImageUrl || !style.logoZone) {
            missing.push("no box photo placement");
            continue;
          }
          const photo = await fitRaster(await loadImage(style.boxImageUrl), sceneW * 2);
          scenes.push(renderPng(closedSceneSvg({ photo, logoZone: style.logoZone, art }, sceneW)).png);
        } else {
          if (!interior || !messageZone) continue;
          const cutoutRaw = style.cutoutUrl ? await loadImage(style.cutoutUrl).catch(() => null) : null;
          const cutout = cutoutRaw ? await fitRaster(cutoutRaw, sceneW) : null;
          if (!cutout || !style.pinataZone) missing.push("no cut-out for the open box");
          scenes.push(
            renderPng(
              openSceneSvg(
                {
                  interior,
                  cutout,
                  pinataZone: style.pinataZone ?? null,
                  messageZone,
                  card: cardImg,
                  cardPadding: catalog.box?.messageCardPadding ?? null,
                  message: p.message,
                },
                sceneW,
              ),
            ).png,
          );
        }
      } catch (err) {
        missing.push(`${v} view failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (missing.length) warnings.push(`${style.id}: ${missing.join("; ")}`);
    if (!scenes.length) continue;
    const notes = [style.inStock ? "" : "out of stock", styleOffered(style) ? "" : "not offered on the storefront"].filter(Boolean);
    tiles.push({ caption: `${style.name} · ${style.id}`, note: notes.join(" · ") || undefined, scenes });
  }
  if (!tiles.length) return toolError(`nothing could be drawn: ${warnings.join(" | ")}`);

  const perImage = views.length === 2 ? PER_IMAGE.both : PER_IMAGE.single;
  const columns = views.length === 2 ? (tiles.length <= FEW ? 1 : 2) : tiles.length <= FEW ? tiles.length : 3;
  const title =
    front.kind === "url"
      ? `Custom art: ${(new URL(front.url).pathname.split("/").pop() || front.url).slice(0, 80)}`
      : describe(front, "Front").replace(/^Front: /, "");
  const showsFlap = views.includes("open");
  const subtitle = [
    showsFlap ? flapLabel.replace(/^flap: /, "Flap: ") : "",
    showsFlap && p.message ? `Message: “${p.message.replace(/\n/g, " / ")}”` : "",
  ]
    .filter(Boolean)
    .join("  ·  ");
  const pages = Math.ceil(tiles.length / perImage);
  const images: { type: "image"; data: string; mimeType: "image/jpeg" }[] = [];
  const sizes: string[] = [];
  for (let i = 0; i < pages; i++) {
    const sheet = await composeSheet(tiles.slice(i * perImage, (i + 1) * perImage), {
      columns,
      title: pages > 1 ? `${title}  (${i + 1}/${pages})` : title,
      subtitle,
    });
    images.push({ type: "image", data: sheet.jpeg.toString("base64"), mimeType: "image/jpeg" });
    sizes.push(`${sheet.width}×${sheet.height}`);
  }

  const summary = [
    `Rendered ${tiles.length} body style${tiles.length === 1 ? "" : "s"} (${views.join(" + ")}) in ${images.length} image${images.length === 1 ? "" : "s"} [${sizes.join(", ")}], ${Math.round(performance.now() - t0)} ms.`,
    describe(front, "front"),
    flapLabel,
    p.message ? `message: ${JSON.stringify(p.message)}` : "message: (none; pass `message` to see words on the flap)",
    `styles: ${tiles.map((t) => t.caption.split(" · ")[1]).join(", ")}`,
    ...(warnings.length ? ["notes:", ...warnings.map((w) => `- ${w}`)] : []),
    "This is a preview only: nothing was saved, priced or ordered. Show the image(s) to the user.",
  ].join("\n");

  return { content: [{ type: "text", text: summary }, ...images] };
}

export const mockupTools: Record<string, ToolDef> = {
  render_mockup: {
    title: "Render design mockups",
    description:
      "Draw a front graphic and an inside-flap card on Piñatagrams body styles and get back image(s) to show: each style's closed box (the front label on the real box photo) and/or its open box (the piñata inside, the flap card, and an optional message). Use it to try designs across the line-up or compare front/flap pairings. `front` and `flap` are each a design code (library codes like HBD01, hub uploads like H0001, or STANDARD — find them with list_designs), an https:// image URL (PNG, JPEG, WebP or SVG — e.g. new art someone wants to try), or \"none\"/\"blank\". `flap` defaults to \"match\": the front design's own card (the default card for a URL or hub upload). `styles` defaults to every body style the storefront offers; pass ids to focus on a few (larger images). A big line-up comes back as several images. Preview only: nothing is saved or ordered.",
    inputSchema: {
      type: "object",
      properties: {
        front: {
          type: "string",
          description: 'Front graphic: a design code (default STANDARD), an https:// image URL, or "none" for the bare box.',
        },
        flap: {
          type: "string",
          description: 'Inside-flap card: "match" (default: the front design\'s own card), a design code (uses THAT design\'s card), an https:// image URL, or "blank" for a plain white card.',
        },
        styles: {
          type: "array",
          items: { type: "string" },
          description: 'Body-style ids to draw (e.g. ["googly","unicorn"]); omit or ["all"] for every offered style.',
        },
        view: {
          type: "string",
          enum: [...VIEWS],
          description: "both (default), closed (front only) or open (flap only).",
        },
        message: {
          type: "string",
          description: `Optional words printed on the flap (≤ ${MESSAGE_RULES.maxChars} characters, ≤ ${MESSAGE_RULES.maxLines} lines; line breaks kept).`,
        },
        include_unoffered: {
          type: "boolean",
          description: 'With styles "all": also draw styles the storefront does not sell (e.g. the Chonky). Default false.',
        },
      },
      additionalProperties: false,
    },
    annotations: READ_ONLY,
    handler: renderMockup,
  },
};
