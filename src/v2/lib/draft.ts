import type { Carrier } from "@/lib/delivery";
import {
  EMPTY_ADDRESS,
  type CartLine,
  type DeliveryAddress,
  type GraphicChoice,
} from "@/lib/flow";
import { parseMessage } from "./message";
import { isOccasionId, type OccasionId } from "./occasions";
import type { GraphicSource, Preset } from "./types";

/**
 * The v2 in-progress piñata and the order-level choices around it. Both in
 * sessionStorage (a draft belongs to this sitting, the cart outlives it),
 * under v2-only keys: the v1 draft (lib/flow saveDraft) has a different
 * shape and only ever meets this one on localhost. Cart lines themselves use
 * lib/flow's CartLine unchanged, so /cart and /api/checkout take v2 lines
 * exactly like v1 lines.
 */

export type DraftV2 = {
  v: 2;
  styleId: string;
  graphic: GraphicChoice;
  graphicSource: GraphicSource;
  occasion: OccasionId | null;
  msgTo: string;
  msgBody: string;
  msgFrom: string;
  starterUsed: boolean;
  filling: string;
  /** true = the flow set the filling (Candy default or the design's own);
   *  it follows design changes until the shopper picks one by hand. */
  fillingAuto: boolean;
  addons: string[];
  date: string; // YYYY-MM-DD, "" = not picked (never silently preselected)
  dateSoonest: boolean; // picked via "Soonest" → follows carrier changes
  editLineId: string | null;
};

/** Order-level: one carrier, one recipient, one receipt email per order. */
export type OrderPrefs = {
  carrier: Carrier | null; // null = not chosen yet (two-carrier stores)
  address: DeliveryAddress;
  recipient: "same" | "new";
  email: string;
};

const DRAFT_KEY = "pinatagrams-v2-draft";
const PARKED_KEY = "pinatagrams-v2-parked";
const ORDER_KEY = "pinatagrams-v2-order";

export function draftFromPreset(p: Preset): DraftV2 {
  return {
    v: 2,
    styleId: p.styleId,
    graphic: p.graphic,
    graphicSource: p.graphicSource,
    occasion: p.occasion,
    msgTo: "",
    msgBody: "",
    msgFrom: "",
    starterUsed: false,
    filling: p.filling,
    fillingAuto: p.fillingAuto,
    addons: [], // paid extras are never pre-checked
    date: "",
    dateSoonest: false,
    editLineId: null,
  };
}

/** Edit mode: a cart line back into a draft (the saved message is split
 *  into To / Message / From when it was composed that way). */
export function draftFromLine(l: CartLine, occasion: OccasionId | null): DraftV2 {
  const parts = parseMessage(l.message ?? "");
  return {
    v: 2,
    styleId: l.styleId,
    graphic: l.graphic,
    graphicSource: "default",
    occasion,
    msgTo: parts.to,
    msgBody: parts.body,
    msgFrom: parts.from,
    starterUsed: false,
    filling: l.filling,
    fillingAuto: false,
    addons: l.addons ?? [],
    date: l.deliveryDate ?? "",
    dateSoonest: false,
    editLineId: l.id,
  };
}

function isDraft(d: unknown): d is DraftV2 {
  if (!d || typeof d !== "object") return false;
  const o = d as Record<string, unknown>;
  return (
    o.v === 2 &&
    typeof o.styleId === "string" &&
    !!o.graphic &&
    typeof o.graphic === "object" &&
    typeof o.filling === "string"
  );
}

function read(key: string): DraftV2 | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(key);
    const d = raw ? JSON.parse(raw) : null;
    if (!isDraft(d)) return null;
    return {
      ...d,
      occasion: isOccasionId(d.occasion) ? d.occasion : null,
      addons: Array.isArray(d.addons) ? d.addons.map(String) : [],
      msgTo: String(d.msgTo ?? ""),
      msgBody: String(d.msgBody ?? ""),
      msgFrom: String(d.msgFrom ?? ""),
      date: typeof d.date === "string" ? d.date : "",
      editLineId: typeof d.editLineId === "string" ? d.editLineId : null,
    };
  } catch {
    return null;
  }
}

function write(key: string, d: DraftV2 | null): void {
  try {
    if (d) sessionStorage.setItem(key, JSON.stringify(d));
    else sessionStorage.removeItem(key);
  } catch {
    // Photo-heavy custom designs can exceed the quota — the flow keeps
    // working in memory, it just won't survive a refresh.
  }
}

export const loadDraftV2 = () => read(DRAFT_KEY);
export const saveDraftV2 = (d: DraftV2 | null) => write(DRAFT_KEY, d);

/** A piñata set aside while the shopper edits another cart line; it comes
 *  back when that edit is saved (or the next time the flow opens). */
export const loadParked = () => read(PARKED_KEY);
export const saveParked = (d: DraftV2 | null) => write(PARKED_KEY, d);

export function loadOrderPrefs(): OrderPrefs {
  const fallback: OrderPrefs = {
    carrier: null,
    address: EMPTY_ADDRESS,
    recipient: "same",
    email: "",
  };
  if (typeof window === "undefined") return fallback;
  try {
    const o = JSON.parse(sessionStorage.getItem(ORDER_KEY) ?? "null");
    if (!o || typeof o !== "object") return fallback;
    const a = (o.address ?? {}) as Partial<DeliveryAddress>;
    return {
      carrier: o.carrier === "usps" || o.carrier === "fedex" ? o.carrier : null,
      address: {
        name: String(a.name ?? ""),
        address1: String(a.address1 ?? ""),
        address2: String(a.address2 ?? ""),
        city: String(a.city ?? ""),
        province: String(a.province ?? ""),
        zip: String(a.zip ?? ""),
        phone: String(a.phone ?? ""),
      },
      recipient: o.recipient === "new" ? "new" : "same",
      email: String(o.email ?? ""),
    };
  } catch {
    return fallback;
  }
}

export function saveOrderPrefs(p: OrderPrefs): void {
  try {
    sessionStorage.setItem(ORDER_KEY, JSON.stringify(p));
  } catch {}
}
