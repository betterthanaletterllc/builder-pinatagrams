import graphicsFile from "../../../public/graphics.json";
import { isOfferedDesign, type LibraryGraphic } from "@/lib/library-data";

/**
 * The ordering MCP's ONE reader of the store snapshot (public/graphics.json).
 * It applies the storefront's own rule — lib/library-data isOfferedDesign,
 * the same one the builder's library and /api/checkout use — so a design the
 * builder stopped offering can't be quoted, listed or ordered here either.
 */

type Manifest = { generatedAt?: string; graphics: LibraryGraphic[] };

/** The raw snapshot (every listing, offered or not). */
export const MANIFEST = graphicsFile as unknown as Manifest;

const ART_RE = /^https:\/\/cdn\.shopify\.com\//;

/** The library the storefront sells: print art present, and a design the
 *  builder offers. */
export function sellableLibrary(graphics: LibraryGraphic[] = MANIFEST.graphics): LibraryGraphic[] {
  return graphics.filter((g) => !!g?.design && !!g.art && isOfferedDesign(g.design));
}

/** Sellable designs by upper-cased code whose print art is a cdn.shopify.com
 *  file (checkout's ART_RE) — what price_order and create_checkout resolve
 *  a library code against. */
export const LIBRARY_BY_CODE: ReadonlyMap<string, LibraryGraphic> = new Map(
  sellableLibrary()
    .filter((g) => typeof g.design === "string" && typeof g.art === "string" && ART_RE.test(g.art))
    .map((g) => [g.design.toUpperCase(), g]),
);
