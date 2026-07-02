import type { DesignDocument } from "./design-document";
import type { LogoZone } from "./hub";

/**
 * The B2C order flow: body style → graphic (pick or design) → message →
 * filling → delivery date → cart → address → draft-order checkout.
 * Cart lives in localStorage until checkout hands it to /api/checkout.
 */

// What goes IN the piñata. Paper receives the label via the `_fillings`
// line-item property. Pricing v1: every filling prices as "filled".
export const FILLINGS = [
  "Candy",
  "School Fun Pack",
  "Dog Treats",
  "Cat Treats",
  "Realsy Dates",
] as const;
export type Filling = (typeof FILLINGS)[number];

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
  deliveryDate: string; // YYYY-MM-DD
  qty: number;
};

export type ShippingAddress = {
  name: string;
  email: string;
  address1: string;
  address2: string;
  city: string;
  province: string;
  zip: string;
  phone: string;
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

export function saveCart(lines: CartLine[]): boolean {
  try {
    localStorage.setItem(CART_KEY, JSON.stringify(lines));
    return true;
  } catch {
    // QuotaExceeded — custom designs embed uploaded photos as data URLs
    // until the hardened Blob upload lands. Caller shows the size warning.
    return false;
  }
}

export function newLineId(): string {
  return `l${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
