/**
 * The staff embed: the label editor on its own page (/embed/design), shown
 * inside Paper (paper.betterthanaletter.com) so a one-off sample is designed
 * with the very editor customers use — a change to the editor reaches
 * samples the moment it is deployed.
 *
 * There are two pages:
 *   /embed/design — the "Make your own" editor alone, for changing the label
 *     of a piñata that already exists in Paper. With ?side=inside it makes
 *     the card INSIDE the box (the one the message prints on) instead of the
 *     front label: the same editor and the same print size, shown flat only,
 *     because the box photo shows the front;
 *   /embed/sample — the journey's own step one ("Pick your design"), for
 *     starting a sample: cycle through the body styles, pick a design from
 *     the store's library or make your own. It is built from the very
 *     components the journey renders (Stage, StepDesign, the sheets, the
 *     editor), so step one here is step one there.
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
 *   embed → parent   { source, v, type: "choice", seq,            (/embed/sample)
 *                      style: { id, name, body },
 *                      graphic: custom | shopify | hub, messageCard, preview }
 *   parent → embed   { source, v, type: "held", seq,              (/embed/sample)
 *                      state: "kept" | "failed" | "released" }
 *   embed → parent   { source, v, type: "pick-state",             (/embed/sample)
 *                      state: "none" | "current" | "changed" | "saving" }
 *
 * "choice" is numbered (seq: 1, 2, …). "held" is the framing page saying what
 * it did with that pick — kept it, could not take it, or let it go again —
 * so "Sent to Paper" does not stay on a pick Paper refused or let go. (It is
 * shown from the moment of sending: "sent" is true then, and the answer
 * follows within moments.)
 * "pick-state" tells the framing page how what is on screen now stands
 * against what it was last sent, so it can ask before using a pick that is
 * no longer what is showing. A framing page that sends no "held" and reads no
 * "pick-state" still works: both are additions.
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

/* --- /embed/design?side=: which card is being made -------------------------- */

/** The front label, or the message graphic: the card inside the box that the message prints on. */
export type EmbedSide = "front" | "inside";

/** What ?side= asks for. Anything but "inside" is the front label. */
export function embedSide(value: string | null | undefined): EmbedSide {
  return (value ?? "").trim().toLowerCase() === "inside" ? "inside" : "front";
}

/**
 * The body style as the editor is given it for that card. The inside card is
 * never on the box photo (the photo shows the front label), so its editor is
 * handed no photo and works flat — which is where editing happens anyway.
 */
export function embedEditorStyle<T extends { boxImageUrl: string | null; logoZone: unknown }>(
  style: T,
  side: EmbedSide,
): T {
  return side === "inside" ? { ...style, boxImageUrl: null, logoZone: null } : style;
}

/* --- /embed/sample: "this piñata" ------------------------------------------ */

// Checkout sells every piñata as the Custom Built product's CUSTOM-{BODY}
// variant, and Paper reads the body from that SKU (api/checkout: customSkuFor).
// A sample has no checkout, so the embed tells Paper the same body token.
// tests/embed.test.mjs holds this table and checkout's together.
const BODY_TOKEN_SPECIAL: Record<string, string> = {
  "white-uni": "WHITE UNICORN",
  "pink-uni": "PINK UNICORN",
};

/** The body as Paper names it: what follows "CUSTOM-" in a builder line's SKU. */
export function embedBodyToken(styleId: string): string {
  return BODY_TOKEN_SPECIAL[styleId] ?? styleId.toUpperCase().replace(/-/g, " ");
}

/** What was picked for the front, in the three shapes the journey has. */
export type EmbedGraphic =
  /** Made in the editor: the staged print file, as in a "design" message. */
  | { kind: "custom"; art: { url: string; sha256: string }; designUrl: string | null }
  /** A design the store sells: its print file on the store's own CDN. */
  | { kind: "shopify"; design: string; title: string; art: string }
  /** A graphic uploaded in the hub: its print file and the sha256 of it. */
  | { kind: "hub"; design: string; title: string; art: { url: string; sha256: string } };

export type EmbedChoice = {
  source: typeof EMBED_SOURCE;
  v: typeof EMBED_VERSION;
  type: "choice";
  /** Which send this is (1, 2, …), for the framing page's "held" answer. */
  seq: number | null;
  /** The body style: the hub's id and name, and the body as Paper names it. */
  style: { id: string; name: string; body: string };
  graphic: EmbedGraphic;
  /** The inside-flap card the gift message prints on, or null for a plain one. */
  messageCard: string | null;
  /** A small picture of the front: a data URL, or the design's thumbnail. */
  preview: string | null;
};

export function embedChoiceMessage(input: {
  style: { id: string; name: string };
  graphic: EmbedGraphic;
  messageCard: string | null;
  preview: string | null;
  seq?: number | null;
}): EmbedChoice {
  return {
    source: EMBED_SOURCE,
    v: EMBED_VERSION,
    type: "choice",
    seq: input.seq ?? null,
    style: { id: input.style.id, name: input.style.name, body: embedBodyToken(input.style.id) },
    graphic: input.graphic,
    messageCard: input.messageCard,
    preview: input.preview,
  };
}

/**
 * The journey's pick, as the embed reports it. Null while it cannot be
 * reported: a design made in the editor whose print file is not staged yet,
 * or a library design with no print file at all.
 */
export function embedGraphicFor(
  g:
    | { type: "custom"; art?: string | null; artSha256?: string | null; designUrl?: string | null }
    | { type: "shopify"; design: string; title: string; art: string | null }
    | { type: "hub"; design: string; title: string; art: string | null; artSha256: string | null },
): EmbedGraphic | null {
  if (g.type === "custom") {
    return g.art && g.artSha256
      ? { kind: "custom", art: { url: g.art, sha256: g.artSha256 }, designUrl: g.designUrl ?? null }
      : null;
  }
  if (g.type === "hub") {
    return g.art && g.artSha256
      ? { kind: "hub", design: g.design, title: g.title, art: { url: g.art, sha256: g.artSha256 } }
      : null;
  }
  return g.art ? { kind: "shopify", design: g.design, title: g.title, art: g.art } : null;
}

/**
 * What a pick is, as one string: the body and the front. Two picks with the
 * same key are the same pick. A design made in the editor is known by its
 * print file's sha256, so a design changed since it was sent is a different
 * pick (and one whose print file is not staged yet is never a sent one).
 */
export function embedPickKey(
  styleId: string,
  g:
    | { type: "custom"; artSha256?: string | null }
    | { type: "shopify"; design: string }
    | { type: "hub"; design: string },
): string {
  const front = g.type === "custom" ? `custom:${g.artSha256 ?? ""}` : `${g.type}:${g.design}`;
  return `${styleId}|${front}`;
}

/** How what is on screen stands against what the framing page was last sent. */
export type EmbedPickState =
  /** Nothing is with the framing page (never sent, or it let the pick go). */
  | "none"
  /** What is on screen is what was last sent. */
  | "current"
  /** Something else is on screen now. */
  | "changed"
  /** The button was pressed; the pick goes the moment its design is saved. */
  | "saving";

export function embedPickState(input: {
  /** embedPickKey of what was last sent, or null. */
  sentKey: string | null;
  /** embedPickKey of what is on screen. */
  nowKey: string;
  /** "Use this piñata" was pressed and the pick is waiting for its print file. */
  waiting: boolean;
  /** The editor is open: a design is being made or changed and is not the pick yet. */
  editing?: boolean;
}): EmbedPickState {
  if (input.waiting) return "saving";
  if (input.sentKey === null) return "none";
  // Work going on in the editor is "something else" until it is used.
  if (input.editing) return "changed";
  return input.sentKey === input.nowKey ? "current" : "changed";
}

export type EmbedPickStateMessage = {
  source: typeof EMBED_SOURCE;
  v: typeof EMBED_VERSION;
  type: "pick-state";
  state: EmbedPickState;
};

export function embedPickStateMessage(state: EmbedPickState): EmbedPickStateMessage {
  return { source: EMBED_SOURCE, v: EMBED_VERSION, type: "pick-state", state };
}

/** The pick last sent to the framing page, and what it has said about it. */
export type EmbedSent = {
  /** embedPickKey of what was sent. */
  key: string;
  /** Its number, which the framing page's answer carries. */
  seq: number;
  /** "sent": no answer (yet). "kept": it has its copy. "failed": it could not take it. */
  held: "sent" | "kept" | "failed";
};

/**
 * What is remembered as sent, after the framing page's answer. Only an
 * answer about the LATEST pick counts — one about an older pick changes
 * nothing — and a pick it let go again is no longer a sent one at all.
 */
export function embedSentAfterHeld(sent: EmbedSent | null, held: EmbedHeld): EmbedSent | null {
  if (!sent || sent.seq !== held.seq) return sent;
  if (held.state === "released") return null;
  return { ...sent, held: held.state };
}

/** What the framing page did with the pick numbered `seq`. */
export type EmbedHeld = {
  seq: number;
  /** It has its own copy · it could not take it · it let it go again. */
  state: "kept" | "failed" | "released";
};

/**
 * Read a "held" the framing page sent. Null for anything else, from anywhere
 * else, or not of this version.
 */
export function readHeld(
  origin: string,
  data: unknown,
  allowedOrigins: readonly string[],
): EmbedHeld | null {
  if (!allowedOrigins.includes(origin)) return null;
  if (!data || typeof data !== "object") return null;
  const m = data as Record<string, unknown>;
  if (m.source !== EMBED_SOURCE || m.v !== EMBED_VERSION || m.type !== "held") return null;
  if (typeof m.seq !== "number" || !Number.isInteger(m.seq) || m.seq < 1) return null;
  if (m.state !== "kept" && m.state !== "failed" && m.state !== "released") return null;
  return { seq: m.seq, state: m.state };
}
