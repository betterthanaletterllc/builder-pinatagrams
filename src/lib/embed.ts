/**
 * The staff embed: the label editor on its own page (/embed/design), shown
 * inside Paper (paper.betterthanaletter.com) so a one-off sample is designed
 * with the very editor customers use — a change to the editor reaches
 * samples the moment it is deployed.
 *
 * What the embed is: the "Make your own" editor, nothing else. No cart, no
 * checkout, no analytics (lib/analytics switches itself off on /embed/), no
 * site header or footer. "Use this design" does exactly what it does for a
 * shopper — the print file and its design.json are staged under builder-art/
 * (lib/design-upload) — and then, instead of moving on to a gift message,
 * the page tells the page that framed it where the file is. Paper downloads
 * it, checks the sha256 and keeps its own copy (the staging area is swept
 * after 90 days).
 *
 * Who may frame it: only the origins below (a frame-ancestors header set by
 * src/middleware.ts). Nothing else on this site restricts framing, and this
 * does not change that.
 *
 * The conversation between the two pages (window.postMessage, version 1).
 * Paper holds a copy of this contract in its own repo
 * (paper-next: src/lib/builder-embed.ts) — change both together.
 *
 *   embed → parent   { source, v, type: "ready" }
 *   parent → embed   { source, v, type: "init", design: DesignDocument | null }
 *   embed → parent   { source, v, type: "design",
 *                      art: { url, sha256 }, designUrl, preview }
 *   embed → parent   { source, v, type: "close" }
 *
 * Import-free on purpose: the edge middleware, the server page, the client
 * component and the node tests all load this file.
 */

export const EMBED_SOURCE = "pinatagrams-builder-embed";
export const EMBED_VERSION = 1;

/** Request header the middleware stamps so the root layout can drop the
 *  site chrome (always set, never appended — a client can't smuggle it). */
export const EMBED_HEADER = "x-pg-embed";

/** The pages that may frame the embed, everywhere. */
export const EMBED_PARENTS = ["https://paper.betterthanaletter.com"] as const;

/** …plus, off production only (localhost and Vercel previews), Paper's own
 *  dev server — so the two can be tried together before a release. */
export const EMBED_PARENTS_DEV = ["http://localhost:3000"] as const;

export function isEmbedPath(pathname: string): boolean {
  return pathname === "/embed" || pathname.startsWith("/embed/");
}

/** The origins allowed to frame the embed and to talk to it. */
export function embedParentOrigins(production: boolean): string[] {
  return production ? [...EMBED_PARENTS] : [...EMBED_PARENTS, ...EMBED_PARENTS_DEV];
}

/** The Content-Security-Policy value that enforces it. */
export function embedFrameAncestors(production: boolean): string {
  return `frame-ancestors ${embedParentOrigins(production).join(" ")}`;
}

export function isEmbedRequest(h: { get(name: string): string | null }): boolean {
  return h.get(EMBED_HEADER) === "1";
}

export type EmbedReady = {
  source: typeof EMBED_SOURCE;
  v: typeof EMBED_VERSION;
  type: "ready";
};

export type EmbedClose = {
  source: typeof EMBED_SOURCE;
  v: typeof EMBED_VERSION;
  type: "close";
};

export type EmbedDesign = {
  source: typeof EMBED_SOURCE;
  v: typeof EMBED_VERSION;
  type: "design";
  /** The staged print file and the sha256 of exactly those bytes. */
  art: { url: string; sha256: string };
  /** The staged design.json (the DesignDocument, photos included), or null
   *  when there is none — the label can then be printed but not reopened. */
  designUrl: string | null;
  /** A small picture of the label, for the framing page to show. */
  preview: string;
};

export type EmbedInit = {
  source: typeof EMBED_SOURCE;
  v: typeof EMBED_VERSION;
  type: "init";
  /** A design made here before, to carry on with — or null for a new one.
   *  Checked with isCurrentDesign before it is used. */
  design: unknown;
};

export function embedMessage<T extends "ready" | "close">(
  type: T,
): { source: typeof EMBED_SOURCE; v: typeof EMBED_VERSION; type: T } {
  return { source: EMBED_SOURCE, v: EMBED_VERSION, type };
}

export function embedDesignMessage(input: {
  artUrl: string;
  sha256: string;
  designUrl: string | null;
  preview: string;
}): EmbedDesign {
  return {
    source: EMBED_SOURCE,
    v: EMBED_VERSION,
    type: "design",
    art: { url: input.artUrl, sha256: input.sha256 },
    designUrl: input.designUrl,
    preview: input.preview,
  };
}

/**
 * Read a message the framing page sent. Null for anything that is not an
 * "init" of this version from one of the allowed origins — the embed acts on
 * nothing else.
 */
export function readInit(
  origin: string,
  data: unknown,
  allowedOrigins: readonly string[],
): EmbedInit | null {
  if (!allowedOrigins.includes(origin)) return null;
  if (!data || typeof data !== "object") return null;
  const m = data as Partial<EmbedInit>;
  if (m.source !== EMBED_SOURCE || m.v !== EMBED_VERSION || m.type !== "init") {
    return null;
  }
  return {
    source: EMBED_SOURCE,
    v: EMBED_VERSION,
    type: "init",
    design: m.design ?? null,
  };
}

/**
 * Which body the editor's "On the box" preview shows: the one asked for (by
 * hub id, or by name as Paper prints it — "Googly", "CLASSIC"), else the
 * usual default, else the first there is. Null only with nothing to choose
 * from (the editor then works flat, without the box view).
 */
export function pickEmbedStyle<T extends { id: string; name: string }>(
  styles: readonly T[],
  wanted: string | null | undefined,
  fallbackId = "googly",
): T | null {
  const key = (wanted ?? "").trim().toLowerCase();
  if (key) {
    const hit = styles.find(
      (s) => s.id.toLowerCase() === key || s.name.trim().toLowerCase() === key,
    );
    if (hit) return hit;
  }
  return styles.find((s) => s.id === fallbackId) ?? styles[0] ?? null;
}
