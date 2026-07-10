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
      // _frontGraphic (the file Paper prints).
      art?: string | null;
      designUrl?: string | null;
    };

// Where ONE piñata ships. Addresses attach per line (a cart can send to
// several people); the payer's email is collected once at checkout.
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
    return JSON.parse(localStorage.getItem(CART_KEY) ?? "[]");
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
