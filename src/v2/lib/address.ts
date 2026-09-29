import type { Carrier } from "@/lib/delivery";
import { stateCode, US_STATES, type DeliveryAddress } from "@/lib/flow";

/** US states + DC, for the State <select> — the one shared list in lib/flow
 *  (value = the 2-letter code the address suggestions and Shopify use). */
export { US_STATES };

/** Normalize whatever arrives (a full name from autofill, lower case) to a
 *  2-letter code, or "" when it isn't a US state. */
export const toStateCode = stateCode;

const ZIP_RE = /^\d{5}(-?\d{4})?$/;
// "PO Box 12", "P.O. Box", "Post Office Box", "POB 12", "Box 12" at the start.
const PO_BOX_RE =
  /\b(p\s*\.?\s*o\s*\.?\s*(box|b\b)|post\s*office\s*box|^\s*box\s+\d)/i;

export type AddressField = keyof DeliveryAddress;
export type AddressErrors = Partial<Record<AddressField, string>>;

export function isPoBox(a: DeliveryAddress): boolean {
  return PO_BOX_RE.test(a.address1) || PO_BOX_RE.test(a.address2);
}

/**
 * Field-level problems, in form order. FedEx can't deliver to PO boxes
 * (USPS can), so that check depends on the carrier.
 */
export function validateAddress(
  a: DeliveryAddress,
  carrier: Carrier | null,
  uspsOffered: boolean,
): AddressErrors {
  const e: AddressErrors = {};
  if (!a.name.trim()) e.name = "Enter the recipient's name.";
  if (!a.address1.trim()) e.address1 = "Enter the street address.";
  else if (carrier !== "usps" && PO_BOX_RE.test(a.address1))
    e.address1 = uspsOffered
      ? "FedEx can't deliver to PO boxes — use a street address or choose USPS."
      : "FedEx can't deliver to PO boxes — use a street address.";
  if (!e.address1 && carrier !== "usps" && PO_BOX_RE.test(a.address2))
    e.address2 = uspsOffered
      ? "FedEx can't deliver to PO boxes — use a street address or choose USPS."
      : "FedEx can't deliver to PO boxes — use a street address.";
  if (!a.city.trim()) e.city = "Enter the city.";
  if (!a.province.trim()) e.province = "Choose the state.";
  else if (stateCode(a.province) !== a.province) e.province = "Choose a US state.";
  if (!a.zip.trim()) e.zip = "Enter the ZIP code.";
  else if (!ZIP_RE.test(a.zip.trim())) e.zip = "Enter a 5-digit ZIP code.";
  if (a.phone.trim() && a.phone.replace(/\D/g, "").length < 10)
    e.phone = "Enter a 10-digit phone number, or leave it blank.";
  return e;
}

export const ADDRESS_ORDER: AddressField[] = [
  "name",
  "address1",
  "address2",
  "city",
  "province",
  "zip",
  "phone",
];

/** "Sam Rivera, Austin TX" */
export function shortAddress(a: DeliveryAddress): string {
  return `${a.name}, ${a.city} ${a.province}`.trim();
}

// Same pattern as checkout's own EMAIL_RE (route.ts) — anything it would
// refuse is refused here first, next to the field.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function emailProblem(email: string): string | null {
  const t = email.trim();
  if (!t) return null;
  return EMAIL_RE.test(t) ? null : "That email doesn't look right — check it, or leave it blank.";
}
