import type { DesignDocument } from "./design-document";
import type { BuilderPricing, HubFilling, LogoZone } from "./hub";
import type { Carrier } from "./delivery";

/**
 * The B2C order flow: body style → graphic (pick or design) → message →
 * filling → delivery date → cart → address → draft-order checkout.
 * Cart lives in localStorage; checkout (lib/checkout-client) moves the
 * drafted lines onto a pending order until Shopify says paid or gone.
 */

// What goes IN the piñata. Paper receives the label via the `_fillings`
// line-item property. The hub's Fillings editor is the source of truth;
// this compiled list is only the fallback when the hub block is absent.
export const FILLINGS = [
  "Candy",
  "School Fun Pack",
  "Dog Treats",
  "Cat Treats",
  "Realsy Dates",
] as const;
export type Filling = string;

/** Hub fillings when present, else the compiled list as plain records. */
export function resolveFillings(
  fillings: HubFilling[] | undefined,
): HubFilling[] {
  if (Array.isArray(fillings) && fillings.length > 0) return fillings;
  return FILLINGS.map((label) => ({
    id: label.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    label,
    blurb: "",
    priceCents: 0,
    imageUrl: null,
    addons: "all" as const,
  }));
}

/** The filling's add-on rule ("none" = it fills the whole box). */
export function fillingAllowsAddon(
  f: HubFilling | undefined,
  addonId: string,
): boolean {
  if (!f || f.addons === "all") return true;
  if (f.addons === "none") return false;
  return f.addons.includes(addonId);
}

// The uploaded-print-file trio the editor hands back on save/upload. One
// shared type — editor, shell, and flow must move in lockstep or a missed
// copy silently drops the hash and checkout refuses the line.
export type DesignAssets = {
  art: string | null;
  designUrl: string | null;
  artSha256: string | null;
};

export type GraphicChoice =
  | {
      // a hub-uploaded graphic (admin /catalog → "Hub graphics") — no
      // Shopify product. art + artSha256 live on the builder's blob store;
      // checkout re-resolves BOTH by design code from the live catalog (the
      // client copy is display-only). Prices as a library pick; the gift
      // message previews AND prints on the standard confetti card.
      type: "hub";
      design: string; // H0001-style code
      title: string;
      thumb: string | null;
      art: string | null;
      artSha256: string | null;
    }
  | {
      // an existing front graphic from the Shopify catalog
      type: "shopify";
      design: string; // design code, e.g. "HBD01"
      title: string;
      thumb: string | null;
      art: string | null; // print-art URL (graphics/front metafield)
      // matching inside-flap card (graphics/message metafield) — the message
      // preview renders ON it, exactly what Paper prints. Absent on drafts
      // saved before this field existed → generic flap preview.
      message?: string | null;
    }
  | {
      // made in the canvas editor
      type: "custom";
      design: DesignDocument;
      preview: string; // small dataURL for cart/library thumbnails
      // Blob-hosted flattened print PNG + design JSON sidecar, uploaded when
      // the customer finishes designing. art becomes the draft order's
      // _frontGraphic (the file Paper prints). artSha256 is the lowercase hex
      // sha256 of the exact uploaded print bytes — Paper verifies the blob
      // against it before snapshotting, so checkout refuses blob art without
      // it. Optional in the type only because carts saved before the field
      // existed must still parse; those lines re-save (re-upload + hash) via
      // the editor before they can check out.
      art?: string | null;
      designUrl?: string | null;
      artSha256?: string | null;
    };

/**
 * The branded default graphic (version-B tiers, 2026-07-22): the original
 * Piñatagram™ box art, included at the base price. Assets come straight from
 * the retail product (handle "pinatagram") — its graphics/front print file,
 * graphics/message flap card, and featured photo — so Paper prints it exactly
 * like any library design. The design code "STANDARD" is that product's SKU
 * and collides with nothing in graphics.json.
 */
export const CLASSIC_GRAPHIC: GraphicChoice = {
  type: "shopify",
  design: "STANDARD",
  title: "Classic Piñatagrams",
  thumb:
    "https://cdn.shopify.com/s/files/1/1116/8788/files/CLASSIC_STANDARD.png?v=1751310452",
  art: "https://cdn.shopify.com/s/files/1/1116/8788/files/STANDARD_front.png?v=1728860086",
  message:
    "https://cdn.shopify.com/s/files/1/1116/8788/files/STANDARD_message_graphic.svg?v=1695834587",
};

/** Which price tier a graphic sells at: the Classic default is included in
 *  the base price; a library pick and a custom design each add a flat
 *  upcharge (hub /pricing → catalog `pricing`). */
export type GraphicTier = "classic" | "library" | "custom";

export function graphicTier(g: GraphicChoice | null): GraphicTier | null {
  if (!g) return null;
  if (g.type === "custom") return "custom";
  // Hub-uploaded graphics price exactly like Shopify library picks.
  if (g.type === "hub") return "library";
  return g.design === CLASSIC_GRAPHIC.design ? "classic" : "library";
}

/** The tier's upcharge in cents — the builder's display math AND the
 *  checkout's server-side pricing both run through this one function. */
export function graphicTierCents(
  g: GraphicChoice | null,
  pricing: BuilderPricing,
): number {
  const tier = graphicTier(g);
  if (tier === "custom") return pricing.graphicCustomUpchargeCents;
  if (tier === "library") return pricing.graphicLibraryUpchargeCents;
  return 0;
}

// Where the order ships. Stored per line for the checkout's grouping, but
// the whole cart is ONE destination — loadCart() collapses any divergent
// addresses to a single one (see there). The payer's contact info is
// collected on Shopify's payment page.
export type DeliveryAddress = {
  name: string;
  address1: string;
  address2: string;
  city: string;
  province: string;
  zip: string;
  phone: string;
};

export type CartLine = {
  id: string;
  styleId: string;
  styleName: string;
  // Box context captured at add-time so the cart can composite "your box"
  // thumbnails without refetching the catalog.
  boxImageUrl: string | null;
  logoZone: LogoZone | null;
  graphic: GraphicChoice;
  message: string;
  filling: Filling;
  // Hub add-on ids (e.g. "double-candy"); priced per unit, server re-resolves
  // labels + prices from the live catalog at checkout. Absent on old carts.
  addons?: string[];
  deliveryDate: string; // YYYY-MM-DD
  // How the ORDER ships — one carrier per checkout (one draft = one shipping
  // line), mirroring the single-address invariant. Stored per line so old
  // carts parse; addToCart rewrites every line to the latest choice. Absent
  // (pre-USPS carts) = "fedex".
  carrier?: Carrier;
  address: DeliveryAddress;
  qty: number;
};

/** The whole cart's carrier (single-carrier invariant): first line wins,
 *  pre-USPS carts default to FedEx. */
export function cartCarrier(lines: CartLine[]): Carrier {
  return lines[0]?.carrier === "usps" ? "usps" : "fedex";
}

/** Every carrier the lines ask for (pre-USPS lines read as FedEx). More than
 *  one = a cart that disagrees with itself; checkout refuses it, so the cart
 *  asks the shopper to pick ONE rather than silently re-stamping lines. */
export function cartCarriers(lines: CartLine[]): Carrier[] {
  return [...new Set(lines.map((l) => (l.carrier === "usps" ? "usps" : "fedex") as Carrier))];
}

/* ---------------------------------------------------------------------------
 * Storage plumbing. Browser storage fails three ways and each gets its own
 * answer: absent (SSR), BLOCKED (Safari "block all cookies", some in-app
 * browsers and sandboxed frames — access or every write throws) and FULL
 * (QuotaExceeded — photo-heavy custom designs). Reads never throw. A write
 * that's blocked keeps the value in memory for this page session, so the
 * page still works (and says so) instead of blaming the design's size; a
 * write that's full changes nothing, so a change can't look saved and then
 * vanish on refresh.
 *
 * Versioning: object records carry `v`. The bare-array stores (cart,
 * address book) are version 1 of THEIR KEY — an incompatible change must
 * move to a new key and migrate on read, never reshape in place: a tab
 * still running an older bundle reads these keys without validation.
 * ------------------------------------------------------------------------- */

export type StorageProblem = "blocked" | "full";
type StoreKind = "local" | "session";
type WriteOutcome = "ok" | StorageProblem;

// Blocked-storage fallback for this page session, keyed "local:<key>";
// null is a tombstone (removed while blocked).
const memStore = new Map<string, string | null>();

function getStore(kind: StoreKind): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return kind === "local" ? window.localStorage : window.sessionStorage;
  } catch {
    return null; // SecurityError: storage disabled for this site
  }
}

// Tells FULL from BLOCKED after a failed write: a tiny write that succeeds
// means the store works and the payload was simply too big.
function storeWritable(s: Storage | null): boolean {
  if (!s) return false;
  try {
    s.setItem("pinatagrams-builder-probe", "1");
    s.removeItem("pinatagrams-builder-probe");
    return true;
  } catch {
    return false;
  }
}

function readRaw(kind: StoreKind, key: string): string | null {
  const mk = `${kind}:${key}`;
  if (memStore.has(mk)) return memStore.get(mk) ?? null;
  const s = getStore(kind);
  if (!s) return null;
  try {
    return s.getItem(key);
  } catch {
    return null;
  }
}

function readJson(kind: StoreKind, key: string): unknown {
  const raw = readRaw(kind, key);
  if (raw == null) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** null = remove. */
function writeRaw(kind: StoreKind, key: string, value: string | null): WriteOutcome {
  const mk = `${kind}:${key}`;
  const s = getStore(kind);
  try {
    if (!s) throw new Error("storage unavailable");
    if (value === null) s.removeItem(key);
    else s.setItem(key, value);
    memStore.delete(mk);
    return "ok";
  } catch {
    if (storeWritable(s)) return "full"; // over quota: nothing changes
    memStore.set(mk, value);
    return "blocked";
  }
}

let storageProbe: boolean | null = null;

/** False when this browser won't let the builder save anything between pages
 *  (private mode / storage blocked). Probed once per page. */
export function storageAvailable(): boolean {
  if (typeof window === "undefined") return true;
  if (storageProbe === null) storageProbe = storeWritable(getStore("local"));
  return storageProbe;
}

/** Customer-facing copy for a failed save — callers show this instead of
 *  guessing (a blocked browser is not a design that's "too large"). */
export const STORAGE_PROBLEM_COPY: Record<StorageProblem, string> = {
  blocked:
    "Your browser is blocking storage, so your cart can't be saved — it'll be lost if you leave or refresh this page. Check out from here, or turn off private browsing to keep it.",
  full: "Your cart is full and we couldn't save that change. Custom designs with photos take the most room — try removing one.",
};

/* ---------------------------------------------------------------------------
 * Cart lines — parsed defensively: a malformed entry (hand-edited storage,
 * a half-written old format, a newer bundle's shape) is dropped, never
 * allowed to crash the header badge or the cart page.
 * ------------------------------------------------------------------------- */

const CART_KEY = "pinatagrams-builder-cart";
const MAX_LINE_QTY = 25; // checkout's B2C bound

function strOf(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function cleanAddress(a: unknown): DeliveryAddress {
  const o = (a && typeof a === "object" ? a : {}) as Record<string, unknown>;
  return {
    name: strOf(o.name),
    address1: strOf(o.address1),
    address2: strOf(o.address2),
    city: strOf(o.city),
    province: strOf(o.province),
    zip: strOf(o.zip),
    phone: strOf(o.phone),
  };
}

function cleanZone(z: unknown): LogoZone | null {
  if (!z || typeof z !== "object") return null;
  const o = z as Record<string, unknown>;
  const n = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  return n(o.x) && n(o.y) && n(o.w) && n(o.h)
    ? { x: o.x, y: o.y, w: o.w, h: o.h }
    : null;
}

function cleanGraphic(g: unknown): GraphicChoice | null {
  if (!g || typeof g !== "object") return null;
  const o = g as Record<string, unknown>;
  if (o.type === "shopify" || o.type === "hub") {
    if (typeof o.design !== "string" || !o.design) return null;
    const url = (v: unknown) => (typeof v === "string" ? v : null);
    return {
      ...o,
      title: strOf(o.title) || o.design,
      thumb: url(o.thumb),
      art: url(o.art),
    } as GraphicChoice;
  }
  // A custom line needs its design document (the editor reopens it); the
  // preview is display-only and may be missing.
  if (o.type === "custom" && o.design && typeof o.design === "object") {
    return { ...(g as object), preview: strOf(o.preview) } as GraphicChoice;
  }
  return null;
}

function cleanLine(raw: unknown): CartLine | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== "string" || !o.id) return null;
  if (typeof o.styleId !== "string" || !o.styleId) return null;
  const graphic = cleanGraphic(o.graphic);
  if (!graphic) return null;
  const qty =
    typeof o.qty === "number" && Number.isFinite(o.qty) ? Math.floor(o.qty) : 1;
  // Unknown fields ride along (a newer bundle's additions survive a round
  // trip through this one); known ones are coerced to their types.
  const line = {
    ...o,
    id: o.id,
    styleId: o.styleId,
    styleName: strOf(o.styleName) || o.styleId,
    boxImageUrl: typeof o.boxImageUrl === "string" ? o.boxImageUrl : null,
    logoZone: cleanZone(o.logoZone),
    graphic,
    message: strOf(o.message),
    filling: strOf(o.filling),
    deliveryDate: strOf(o.deliveryDate),
    address: cleanAddress(o.address),
    qty: Math.min(MAX_LINE_QTY, Math.max(1, qty)),
  } as CartLine & Record<string, unknown>;
  if (Array.isArray(o.addons)) {
    line.addons = o.addons.filter((x): x is string => typeof x === "string");
  } else delete line.addons;
  if (o.carrier !== "usps" && o.carrier !== "fedex") delete line.carrier;
  return line;
}

/** Any stored value → valid lines. Duplicate ids (React keys + edit/remove
 *  identity) get a stable suffix rather than a random one, so every read
 *  agrees. Also accepts a `{ v, lines }` envelope, should one ever land. */
function cleanLines(raw: unknown): CartLine[] {
  const list: unknown[] = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { lines?: unknown }).lines)
      ? (raw as { lines: unknown[] }).lines
      : [];
  const seen = new Set<string>();
  const out: CartLine[] = [];
  for (const r of list) {
    const l = cleanLine(r);
    if (!l) continue;
    let id = l.id;
    for (let n = 2; seen.has(id); n++) id = `${l.id}-${n}`;
    seen.add(id);
    out.push(id === l.id ? l : { ...l, id });
  }
  return out;
}

// Single-address invariant: the whole cart ships to ONE address (one order
// → one invoice). A cart left over from the old multi-address flow could
// hold divergent addresses; collapse them to the first complete one so the
// flow, cart UI, and checkout all agree on one destination. (No-op for
// carts already single-address.) Not persisted here — the next saveCart
// writes it back; every read re-collapses idempotently.
function oneAddress(lines: CartLine[]): CartLine[] {
  if (lines.length < 2) return lines;
  const one =
    lines.find((l) => addressComplete(l.address))?.address ?? lines[0].address;
  const key = addressKey(one);
  return lines.some((l) => addressKey(l.address) !== key)
    ? lines.map((l) => (addressKey(l.address) === key ? l : { ...l, address: one }))
    : lines;
}

/** The active cart. Never throws; malformed entries are dropped. Lines that
 *  went to checkout are NOT here — they live on their pending order until
 *  Shopify says it's paid (cleared) or gone (restored). */
export function loadCart(): CartLine[] {
  if (typeof window === "undefined") return [];
  migrateLegacyPending();
  return oneAddress(cleanLines(readJson("local", CART_KEY)));
}

// Same-tab listeners (the header badge) hear this on every cart write;
// cross-tab updates ride the native "storage" event.
export const CART_EVENT = "pinatagrams-cart";

let lastCartProblem: StorageProblem | null = null;

/**
 * Persist the cart. true = saved. false = not saved, and cartSaveProblem()
 * says why: "full" → nothing changed (commit nothing, tell the shopper);
 * "blocked" → the browser refuses storage entirely, so the lines are kept
 * in memory for THIS page session (loadCart returns them) but will not
 * survive a reload or a full navigation.
 */
export function saveCart(lines: CartLine[]): boolean {
  if (typeof window === "undefined") return false;
  let json: string;
  try {
    json = JSON.stringify(lines);
  } catch {
    lastCartProblem = "full";
    return false;
  }
  const out = writeRaw("local", CART_KEY, json);
  lastCartProblem = out === "ok" ? null : out;
  if (out !== "full") window.dispatchEvent(new Event(CART_EVENT));
  return out === "ok";
}

/** Why the most recent saveCart() returned false (null after a success). */
export function cartSaveProblem(): StorageProblem | null {
  return lastCartProblem;
}

/** Total piñatas in the cart (sum of line quantities). */
export function cartCount(): number {
  return loadCart().reduce((s, l) => s + l.qty, 0);
}

export function newLineId(): string {
  return `l${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** True when both sets of lines can share one order's destination: either
 *  side has no complete address yet, or they're the same address. Anything
 *  else would be silently re-addressed by the single-address collapse. */
export function sameDestination(a: CartLine[], b: CartLine[]): boolean {
  const x = a.find((l) => addressComplete(l.address))?.address;
  const y = b.find((l) => addressComplete(l.address))?.address;
  return !x || !y || addressKey(x) === addressKey(y);
}

/* ---------------------------------------------------------------------------
 * Applied discount codes — persist so a code survives until checkout. The
 * cart re-resolves these against the hub on load and SAYS so when one no
 * longer applies. Marketing/QR links land with ?discount=CODE;
 * captureDiscountParam stashes it here so the cart applies it whenever the
 * shopper gets there.
 * ------------------------------------------------------------------------- */

const DISCOUNT_KEY = "pinatagrams-builder-discount";

/** Saved code strings. New format is a JSON array (starts "["); anything
 *  else is a legacy bare code string (pre-stacking) — treated literally so a
 *  digit- or keyword-like code can't be mangled by JSON.parse ("1E2" → 100). */
export function loadDiscountCodes(): string[] {
  if (typeof window === "undefined") return [];
  const saved = readRaw("local", DISCOUNT_KEY);
  if (!saved) return [];
  if (!saved.startsWith("[")) return [saved];
  try {
    const parsed = JSON.parse(saved);
    return Array.isArray(parsed)
      ? parsed.filter((c): c is string => typeof c === "string" && !!c.trim())
      : [];
  } catch {
    return [];
  }
}

export function saveDiscountCodes(codes: string[]): void {
  writeRaw("local", DISCOUNT_KEY, codes.length ? JSON.stringify(codes) : null);
}

/** The ?discount=CODE riding the current URL, normalized exactly like the
 *  cart's own input (trimmed, upper-cased, capped at checkout's 64-char
 *  limit so it can't truncate into a different code), or null. */
export function discountParamCode(): string | null {
  if (typeof window === "undefined") return null;
  const raw = new URLSearchParams(window.location.search).get("discount");
  const code = raw?.trim().slice(0, 64).toUpperCase();
  return code || null;
}

/** Stash the ?discount= code so it's still there when the shopper reaches
 *  the cart. Newest first: the cart keeps one code per kind and the first
 *  wins, so a freshly scanned code beats an older saved one of its kind. */
export function captureDiscountParam(): void {
  const code = discountParamCode();
  if (!code) return;
  saveDiscountCodes(
    [code, ...loadDiscountCodes().filter((c) => c !== code)].slice(0, 2),
  );
}

/* ---------------------------------------------------------------------------
 * Pending orders — Shopify drafts created at checkout but NOT yet paid.
 * Checkout MOVES the drafted lines out of the active cart onto the pending
 * record: a paid piñata must never linger as an ordinary cart line (the
 * next piñata would inherit its recipient, the next checkout would re-buy
 * it). The record lives until Shopify says the draft is paid (cleared) or
 * gone (lines restored); a global check on every page asks, throttled per
 * record via `checkedAt`. Several can wait at once (a shopper may pay one
 * separately and check out another), newest first.
 * ------------------------------------------------------------------------- */

export type PendingOrder = {
  invoiceUrl: string;
  createdAt: number; // ms epoch
  // The Shopify draft gid — the key the paid check asks about. Absent only
  // on records migrated from the oldest format (resume link only).
  draftOrderId?: string;
  // Server-issued proof of ownership: a later checkout sends it back in
  // `supersedes` so the server may delete this (unpaid) draft.
  nonce?: string;
  // The drafted lines, moved out of the active cart.
  lines: CartLine[];
  // Display total at checkout — analytics value only, never a price.
  valueCents?: number;
  // Last /api/order-status check (ms) — throttles the global check.
  checkedAt?: number;
  // Shopify says the draft is gone but its lines couldn't go back into the
  // cart (the cart ships somewhere else now). Not payable, never re-checked;
  // the cart offers the lines back once they fit.
  expired?: boolean;
  /** @deprecated pre-v2 records only (lines stayed in the cart); never set
   *  now — the drafted lines live in `lines`. */
  lineIds?: string[];
};

const PENDING_KEY = "pinatagrams-builder-pending-v2";
const PENDING_VERSION = 2;
// The pre-v2 single record ({ invoiceUrl, createdAt, draftOrderId?,
// lineIds? }) whose lines stayed in the cart. Migrated once per page load.
const LEGACY_PENDING_KEY = "pinatagrams-builder-pending";
const DAY_MS = 24 * 60 * 60 * 1000;
// A draft we can ask Shopify about stays until paid/gone — capped so an
// abandoned one can't sit forever. A record without a draft id can't be
// asked about, so it keeps the old 24h expiry.
const PENDING_MAX_AGE_MS = 30 * DAY_MS;
const PENDING_NO_DRAFT_TTL_MS = DAY_MS;
const PENDING_MAX = 5;

export const PENDING_EVENT = "pinatagrams-pending";

/** A record's identity: the draft gid, else its invoice URL. */
export function pendingKey(p: Pick<PendingOrder, "draftOrderId" | "invoiceUrl">): string {
  return p.draftOrderId ?? p.invoiceUrl;
}

function httpsUrl(u: unknown): u is string {
  if (typeof u !== "string") return false;
  try {
    return new URL(u).protocol === "https:";
  } catch {
    return false;
  }
}

function cleanPending(raw: unknown, now: number): PendingOrder | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  // "Resume payment" navigates here — only ever to an https invoice.
  if (!httpsUrl(o.invoiceUrl)) return null;
  if (typeof o.createdAt !== "number" || !Number.isFinite(o.createdAt)) return null;
  const draftOrderId =
    typeof o.draftOrderId === "string" && o.draftOrderId ? o.draftOrderId : undefined;
  const maxAge = draftOrderId ? PENDING_MAX_AGE_MS : PENDING_NO_DRAFT_TTL_MS;
  if (now - o.createdAt > maxAge) return null;
  const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  return {
    invoiceUrl: o.invoiceUrl,
    createdAt: o.createdAt,
    ...(draftOrderId ? { draftOrderId } : {}),
    ...(typeof o.nonce === "string" && o.nonce ? { nonce: o.nonce } : {}),
    lines: cleanLines(o.lines),
    ...(num(o.valueCents) ? { valueCents: o.valueCents } : {}),
    ...(num(o.checkedAt) ? { checkedAt: o.checkedAt } : {}),
    ...(o.expired === true ? { expired: true } : {}),
  };
}

function readPendingList(): PendingOrder[] {
  const raw = readJson("local", PENDING_KEY) as
    | { v?: unknown; orders?: unknown }
    | undefined;
  // A version from a NEWER bundle (a rollback) is unreadable here: treat it
  // as empty rather than misparse it.
  if (!raw || typeof raw !== "object" || raw.v !== PENDING_VERSION) return [];
  if (!Array.isArray(raw.orders)) return [];
  const now = Date.now();
  const seen = new Set<string>();
  return raw.orders
    .map((r) => cleanPending(r, now))
    .filter((p): p is PendingOrder => {
      if (!p || seen.has(pendingKey(p))) return false;
      seen.add(pendingKey(p));
      return true;
    })
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, PENDING_MAX);
}

function writePendingList(list: PendingOrder[]): WriteOutcome {
  if (typeof window === "undefined") return "blocked";
  const out = writeRaw(
    "local",
    PENDING_KEY,
    list.length
      ? JSON.stringify({ v: PENDING_VERSION, orders: list.slice(0, PENDING_MAX) })
      : null,
  );
  if (out !== "full") window.dispatchEvent(new Event(PENDING_EVENT));
  return out;
}

let legacyMigrated = false;

/** One-time move of a pre-v2 pending record into the list. Its drafted
 *  lines are still sitting in the cart (the old flow kept them there) —
 *  they move onto the record now, so a paid order stops hijacking the next
 *  one. Records the old 24h expiry would have dropped are still rescued if
 *  they carry a draft id (Shopify can still say paid/gone). */
function migrateLegacyPending(): void {
  if (legacyMigrated || typeof window === "undefined") return;
  legacyMigrated = true;
  const raw = readJson("local", LEGACY_PENDING_KEY) as Record<string, unknown> | undefined;
  if (raw === undefined && readRaw("local", LEGACY_PENDING_KEY) === null) return;
  const old =
    raw && typeof raw === "object"
      ? cleanPending({ ...raw, lines: [] }, Date.now())
      : null;
  if (old) {
    const ids = new Set(
      Array.isArray(raw!.lineIds)
        ? raw!.lineIds.filter((x): x is string => typeof x === "string")
        : [],
    );
    const cart = cleanLines(readJson("local", CART_KEY));
    const drafted = old.draftOrderId ? cart.filter((l) => ids.has(l.id)) : [];
    const record: PendingOrder = { ...old, lines: drafted };
    const list = readPendingList().filter((p) => pendingKey(p) !== pendingKey(record));
    if (writePendingList([record, ...list]) === "full") return; // retry next load
    if (drafted.length) saveCart(cart.filter((l) => !ids.has(l.id)));
  }
  writeRaw("local", LEGACY_PENDING_KEY, null);
}

/** Every pending order, newest first (expired ones included — the cart
 *  offers their lines back). Aged-out records are pruned as a side effect. */
export function loadPendingOrders(): PendingOrder[] {
  if (typeof window === "undefined") return [];
  migrateLegacyPending();
  const list = readPendingList();
  const stored = readJson("local", PENDING_KEY) as
    | { v?: unknown; orders?: unknown }
    | undefined;
  if (
    stored?.v === PENDING_VERSION &&
    Array.isArray(stored.orders) &&
    stored.orders.length !== list.length
  ) {
    writePendingList(list);
  }
  return list;
}

/** The newest order still waiting for payment (resume link), or null. */
export function loadPendingOrder(): PendingOrder | null {
  return loadPendingOrders().find((p) => !p.expired) ?? null;
}

/** Piñatas in orders still waiting for payment — the cart icon counts them
 *  too (it opens the order review, where the waiting order comes back). */
export function pendingPieceCount(): number {
  return loadPendingOrders()
    .filter((p) => !p.expired)
    .reduce((n, p) => n + p.lines.reduce((s, l) => s + l.qty, 0), 0);
}

/** Add or replace (by draft id / invoice URL). true = persisted. Checkout
 *  goes through recordCheckout (which also moves the lines); this is for
 *  records built elsewhere — `lines` defaults to none. */
export function savePendingOrder(
  p: Omit<PendingOrder, "lines"> & { lines?: CartLine[] },
): boolean {
  const rec = cleanPending({ ...p, lines: p.lines ?? [] }, Date.now());
  if (!rec) return false;
  const list = readPendingList().filter((x) => pendingKey(x) !== pendingKey(rec));
  return writePendingList([rec, ...list]) === "ok";
}

/** Forget one pending order (by pendingKey), or all of them. */
export function clearPendingOrder(key?: string): void {
  writePendingList(key ? readPendingList().filter((p) => pendingKey(p) !== key) : []);
}

/** Patch records in place (throttle stamps, expiry). */
export function updatePendingOrders(
  keys: string[],
  patch: Partial<Pick<PendingOrder, "checkedAt" | "expired">>,
): void {
  const want = new Set(keys);
  let touched = false;
  const list = readPendingList().map((p) => {
    if (!want.has(pendingKey(p))) return p;
    touched = true;
    const next = { ...p, ...patch };
    if (patch.checkedAt === undefined && "checkedAt" in patch) delete next.checkedAt;
    return next;
  });
  if (touched) writePendingList(list);
}

/**
 * A successful checkout: the drafted lines leave the active cart and wait on
 * their pending record(s). Write order matters for full storage — the record
 * is written while the cart still holds the lines only if both fit; else the
 * cart shrinks first and the record follows (same bytes, so it fits). If the
 * record still can't be written, the cart is put back exactly as it was:
 * the old keep-the-cart behaviour beats losing the lines. true = recorded.
 */
export function recordCheckout(orders: Omit<PendingOrder, "checkedAt" | "expired">[]): boolean {
  if (!orders.length) return false;
  const moved = new Set(orders.flatMap((o) => o.lines.map((l) => l.id)));
  const cart = cleanLines(readJson("local", CART_KEY));
  const rest = cart.filter((l) => !moved.has(l.id));
  const keys = new Set(orders.map((o) => pendingKey(o)));
  const list = [
    ...orders,
    ...readPendingList().filter((p) => !keys.has(pendingKey(p))),
  ];
  const first = writePendingList(list);
  if (first !== "full") {
    if (rest.length !== cart.length) saveCart(rest);
    return true;
  }
  saveCart(rest);
  if (writePendingList(list) !== "full") return true;
  saveCart(cart);
  return false;
}

export type RestoreResult =
  | { ok: true }
  | { ok: false; reason: "missing" | "address" | "full" };

/**
 * Move a pending order's lines back into the active cart ("Change order",
 * "Add the waiting order to this one", or Shopify says the draft is gone).
 * Lines already in the cart (same id) keep the cart's copy. Refuses when
 * the lines ship somewhere other than the cart — the single-address
 * collapse would otherwise silently re-address someone's piñata. With
 * `supersede`, the next checkout tells the server to delete the old draft.
 */
export function restorePendingToCart(
  key: string,
  opts: { supersede: boolean },
): RestoreResult {
  const rec = readPendingList().find((p) => pendingKey(p) === key);
  if (!rec) return { ok: false, reason: "missing" };
  const cart = loadCart();
  if (!sameDestination(cart, rec.lines)) return { ok: false, reason: "address" };
  const have = new Set(cart.map((l) => l.id));
  const add = rec.lines.filter((l) => !have.has(l.id));
  if (add.length && !saveCart([...cart, ...add]) && cartSaveProblem() === "full") {
    return { ok: false, reason: "full" };
  }
  clearPendingOrder(key);
  if (opts.supersede && rec.draftOrderId && rec.nonce && !rec.expired) {
    addSupersede({ draftOrderId: rec.draftOrderId, nonce: rec.nonce });
  }
  return { ok: true };
}

/* ---------------------------------------------------------------------------
 * Superseded drafts — "Change order" / merge put an unpaid draft's lines
 * back in the cart; the NEXT checkout sends { draftOrderId, nonce } so the
 * server can delete the old draft (it must refuse one that's been paid).
 * ------------------------------------------------------------------------- */

const SUPERSEDE_KEY = "pinatagrams-builder-supersede";

type SupersedeRecord = { draftOrderId: string; nonce: string; at: number };

function readSupersedes(): SupersedeRecord[] {
  const raw = readJson("local", SUPERSEDE_KEY) as { v?: unknown; drafts?: unknown } | undefined;
  if (!raw || raw.v !== 1 || !Array.isArray(raw.drafts)) return [];
  const now = Date.now();
  return raw.drafts.filter(
    (d): d is SupersedeRecord =>
      !!d &&
      typeof d.draftOrderId === "string" &&
      typeof d.nonce === "string" &&
      typeof d.at === "number" &&
      now - d.at < PENDING_MAX_AGE_MS,
  );
}

function addSupersede(d: { draftOrderId: string; nonce: string }): void {
  const rest = readSupersedes().filter((x) => x.draftOrderId !== d.draftOrderId);
  writeRaw(
    "local",
    SUPERSEDE_KEY,
    JSON.stringify({ v: 1, drafts: [{ ...d, at: Date.now() }, ...rest].slice(0, 3) }),
  );
}

/** The draft the next checkout replaces (newest), or null. The request
 *  carries one; older ones are left to the server's draft expiry. */
export function loadSupersede(): { draftOrderId: string; nonce: string } | null {
  const d = readSupersedes()[0];
  return d ? { draftOrderId: d.draftOrderId, nonce: d.nonce } : null;
}

export function clearSupersede(): void {
  writeRaw("local", SUPERSEDE_KEY, null);
}

/* ---------------------------------------------------------------------------
 * In-progress draft — survives refresh, back-swipes and accidental closes.
 * sessionStorage (a draft belongs to this sitting, unlike the cart).
 * editLineId set = this draft is editing an existing cart line.
 * ------------------------------------------------------------------------- */

export type FlowDraft = {
  styleId: string;
  graphic: GraphicChoice | null;
  message: string;
  filling: Filling | null;
  addons?: string[];
  date: string;
  carrier?: Carrier;
  address: DeliveryAddress;
  editLineId?: string | null;
};

const DRAFT_KEY = "pinatagrams-builder-draft";
const DRAFT_VERSION = 1;

export function loadDraft(): FlowDraft | null {
  if (typeof window === "undefined") return null;
  const raw = readJson("session", DRAFT_KEY);
  if (!raw || typeof raw !== "object") return null;
  const { v, ...d } = raw as Record<string, unknown>;
  // Unversioned = written before versioning (same shape); a newer version
  // is unreadable here. Either way a draft needs its style to mean anything.
  if ((v !== undefined && v !== DRAFT_VERSION) || typeof d.styleId !== "string") {
    return null;
  }
  // Unknown fields ride along; the known ones are coerced so a mangled
  // draft can't crash the flow that restores it.
  return {
    ...d,
    styleId: d.styleId,
    graphic: cleanGraphic(d.graphic),
    message: strOf(d.message),
    filling: typeof d.filling === "string" ? d.filling : null,
    addons: Array.isArray(d.addons)
      ? d.addons.filter((x): x is string => typeof x === "string")
      : undefined,
    date: strOf(d.date),
    carrier: d.carrier === "usps" || d.carrier === "fedex" ? d.carrier : undefined,
    address: cleanAddress(d.address),
    editLineId: typeof d.editLineId === "string" ? d.editLineId : null,
  };
}

export function saveDraft(d: FlowDraft): void {
  // Full (photo-heavy custom designs) = the flow still works in memory, it
  // just won't survive a refresh; blocked = kept for this page session.
  try {
    writeRaw("session", DRAFT_KEY, JSON.stringify({ ...d, v: DRAFT_VERSION }));
  } catch {}
}

export function clearDraft(): void {
  writeRaw("session", DRAFT_KEY, null);
}

/* ---------------------------------------------------------------------------
 * Address book — previously used delivery addresses, so sending another
 * piñata to grandma is one tap. localStorage, most-recent-first, capped.
 * ------------------------------------------------------------------------- */

const ADDR_KEY = "pinatagrams-builder-addresses";
const ADDR_MAX = 8;

export const EMPTY_ADDRESS: DeliveryAddress = {
  name: "",
  address1: "",
  address2: "",
  city: "",
  province: "",
  zip: "",
  phone: "",
};

export function addressKey(a: DeliveryAddress): string {
  return [a.name, a.address1, a.address2, a.city, a.province, a.zip]
    .map((s) => (s ?? "").trim().toLowerCase())
    .join("|");
}

export function addressComplete(a: DeliveryAddress | undefined | null): boolean {
  return !!a && !!a.name && !!a.address1 && !!a.city && !!a.province && !!a.zip;
}

export function formatAddress(a: DeliveryAddress): string {
  return `${a.name} — ${a.address1}, ${a.city}, ${a.province} ${a.zip}`;
}

export function loadAddresses(): DeliveryAddress[] {
  const raw = readJson("local", ADDR_KEY);
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((a) => !!a && typeof a === "object")
    .map(cleanAddress)
    .filter(addressComplete)
    .slice(0, ADDR_MAX);
}

export function rememberAddress(a: DeliveryAddress): void {
  const key = addressKey(a);
  const rest = loadAddresses().filter((x) => addressKey(x) !== key);
  // full storage just means no address book — never block the flow
  writeRaw("local", ADDR_KEY, JSON.stringify([a, ...rest].slice(0, ADDR_MAX)));
}

/* ---------------------------------------------------------------------------
 * US states + DC — the ship-to State select, [code, name]. The one list:
 * the cart, the Send-to form and the address autocomplete (which maps
 * Photon's state names to codes through it) all read this.
 * ------------------------------------------------------------------------- */

export const US_STATES: readonly (readonly [code: string, name: string])[] = [
  ["AL", "Alabama"], ["AK", "Alaska"], ["AZ", "Arizona"], ["AR", "Arkansas"],
  ["CA", "California"], ["CO", "Colorado"], ["CT", "Connecticut"],
  ["DE", "Delaware"], ["DC", "District of Columbia"], ["FL", "Florida"],
  ["GA", "Georgia"], ["HI", "Hawaii"], ["ID", "Idaho"], ["IL", "Illinois"],
  ["IN", "Indiana"], ["IA", "Iowa"], ["KS", "Kansas"], ["KY", "Kentucky"],
  ["LA", "Louisiana"], ["ME", "Maine"], ["MD", "Maryland"],
  ["MA", "Massachusetts"], ["MI", "Michigan"], ["MN", "Minnesota"],
  ["MS", "Mississippi"], ["MO", "Missouri"], ["MT", "Montana"],
  ["NE", "Nebraska"], ["NV", "Nevada"], ["NH", "New Hampshire"],
  ["NJ", "New Jersey"], ["NM", "New Mexico"], ["NY", "New York"],
  ["NC", "North Carolina"], ["ND", "North Dakota"], ["OH", "Ohio"],
  ["OK", "Oklahoma"], ["OR", "Oregon"], ["PA", "Pennsylvania"],
  ["RI", "Rhode Island"], ["SC", "South Carolina"], ["SD", "South Dakota"],
  ["TN", "Tennessee"], ["TX", "Texas"], ["UT", "Utah"], ["VT", "Vermont"],
  ["VA", "Virginia"], ["WA", "Washington"], ["WV", "West Virginia"],
  ["WI", "Wisconsin"], ["WY", "Wyoming"],
];

/** A typed or legacy state value ("ca", "California ") → its code, or "". */
export function stateCode(v: string): string {
  const s = v.trim().toLowerCase();
  if (!s) return "";
  const hit = US_STATES.find(
    ([code, name]) => code.toLowerCase() === s || name.toLowerCase() === s,
  );
  return hit ? hit[0] : "";
}
