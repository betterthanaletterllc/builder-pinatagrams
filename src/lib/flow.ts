import type { DesignDocument } from "./design-document";
import type { HubFilling, LogoZone } from "./hub";

/**
 * The B2C order flow: body style → graphic (pick or design) → message →
 * filling → delivery date → cart → address → draft-order checkout.
 * Cart lives in localStorage until checkout hands it to /api/checkout.
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
      // an existing front graphic from the Shopify catalog
      type: "shopify";
      design: string; // design code, e.g. "HBD01"
      title: string;
      thumb: string | null;
      art: string | null; // print-art URL (graphics/front metafield)
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
  address: DeliveryAddress;
  qty: number;
};

const CART_KEY = "pinatagrams-builder-cart";

export function loadCart(): CartLine[] {
  if (typeof window === "undefined") return [];
  try {
    const lines: CartLine[] = JSON.parse(localStorage.getItem(CART_KEY) ?? "[]");
    if (!Array.isArray(lines) || lines.length < 2) return lines;
    // Single-address invariant: the whole cart ships to ONE address (one
    // order → one invoice). A cart left over from the old multi-address flow
    // could hold divergent addresses; collapse them to the first complete
    // one so the flow, cart UI, and checkout all agree on one destination.
    // (No-op for carts already single-address.) Not persisted here — the
    // next saveCart writes it back; every read re-collapses idempotently.
    const one =
      lines.find((l) => addressComplete(l.address))?.address ?? lines[0].address;
    const key = addressKey(one);
    return lines.some((l) => addressKey(l.address) !== key)
      ? lines.map((l) => (addressKey(l.address) === key ? l : { ...l, address: one }))
      : lines;
  } catch {
    return [];
  }
}

// Same-tab listeners (the header badge) hear this on every cart write;
// cross-tab updates ride the native "storage" event.
export const CART_EVENT = "pinatagrams-cart";

export function saveCart(lines: CartLine[]): boolean {
  try {
    localStorage.setItem(CART_KEY, JSON.stringify(lines));
    window.dispatchEvent(new Event(CART_EVENT));
    return true;
  } catch {
    // QuotaExceeded — custom designs embed uploaded photos as data URLs
    // until the hardened Blob upload lands. Caller shows the size warning.
    return false;
  }
}

/** Total piñatas in the cart (sum of line quantities). */
export function cartCount(): number {
  return loadCart().reduce((s, l) => s + l.qty, 0);
}

export function newLineId(): string {
  return `l${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/* ---------------------------------------------------------------------------
 * Pending order — a Shopify draft created at checkout but NOT yet paid. The
 * cart is NOT cleared on checkout, so hitting "back" from the hosted invoice
 * lands the customer on their cart intact; this record just adds a "Resume
 * payment" link back to that exact invoice. Expires so a stale/paid one clears.
 * ------------------------------------------------------------------------- */

export type PendingOrder = {
  invoiceUrl: string;
  createdAt: number; // ms epoch
  // The Shopify draft gid, so the cart can ask whether it's been paid yet.
  // Optional: records written before this field existed won't have it.
  draftOrderId?: string;
  // The cart line ids that went into this draft. When the order turns out
  // paid, ONLY these are cleared — lines added to the cart afterwards (the
  // cart persists through checkout) must survive. Written alongside draftOrderId.
  lineIds?: string[];
};

const PENDING_KEY = "pinatagrams-builder-pending";
const PENDING_TTL_MS = 24 * 60 * 60 * 1000; // 24h

export function savePendingOrder(p: PendingOrder): void {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(p));
  } catch {}
}

export function loadPendingOrder(): PendingOrder | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as PendingOrder;
    if (!p?.invoiceUrl || typeof p.createdAt !== "number") return null;
    if (Date.now() - p.createdAt > PENDING_TTL_MS) {
      localStorage.removeItem(PENDING_KEY);
      return null;
    }
    return {
      invoiceUrl: p.invoiceUrl,
      createdAt: p.createdAt,
      ...(typeof p.draftOrderId === "string"
        ? { draftOrderId: p.draftOrderId }
        : {}),
      ...(Array.isArray(p.lineIds)
        ? { lineIds: p.lineIds.filter((x): x is string => typeof x === "string") }
        : {}),
    };
  } catch {
    return null;
  }
}

export function clearPendingOrder(): void {
  try {
    localStorage.removeItem(PENDING_KEY);
  } catch {}
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
  address: DeliveryAddress;
  editLineId?: string | null;
};

const DRAFT_KEY = "pinatagrams-builder-draft";

export function loadDraft(): FlowDraft | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    return raw ? (JSON.parse(raw) as FlowDraft) : null;
  } catch {
    return null;
  }
}

export function saveDraft(d: FlowDraft): void {
  try {
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify(d));
  } catch {
    // photo-heavy custom designs can exceed the quota — the flow still works
    // in memory, it just won't survive a refresh
  }
}

export function clearDraft(): void {
  try {
    sessionStorage.removeItem(DRAFT_KEY);
  } catch {}
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
    .map((s) => s.trim().toLowerCase())
    .join("|");
}

export function addressComplete(a: DeliveryAddress | undefined | null): boolean {
  return !!a && !!a.name && !!a.address1 && !!a.city && !!a.province && !!a.zip;
}

export function formatAddress(a: DeliveryAddress): string {
  return `${a.name} — ${a.address1}, ${a.city}, ${a.province} ${a.zip}`;
}

export function loadAddresses(): DeliveryAddress[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(ADDR_KEY) ?? "[]");
  } catch {
    return [];
  }
}

export function rememberAddress(a: DeliveryAddress): void {
  const key = addressKey(a);
  const rest = loadAddresses().filter((x) => addressKey(x) !== key);
  try {
    localStorage.setItem(
      ADDR_KEY,
      JSON.stringify([a, ...rest].slice(0, ADDR_MAX)),
    );
  } catch {
    // full storage just means no address book — never block the flow
  }
}
