import type { Carrier } from "./delivery";
import { FROM_MAX, MESSAGE_LIMIT, MESSAGE_MAX_LINES, TO_MAX } from "@/v2/lib/message";

/**
 * The order rules and the words the customer reads about them — ONE copy for
 * the builder (Step 4, the order summary), the ordering MCP's tools and the
 * in-chat designer (which the server fills in from here, so it carries no
 * limits or promises of its own). Change a promise here and every surface
 * says the new thing; nothing else may spell these out.
 */

/** The paid guaranteed date's name, on the toggle and on the price rows. */
export const GUARANTEE_LABEL = "Guaranteed delivery date";

/** What the guarantee promises, and what happens when it's missed. */
export const GUARANTEE_TERMS =
  "With the guarantee, your piñata arrives on the date you picked. If it doesn't, you get a 50% refund, and a full refund if it's more than one business day off.";

/** Business days either side of an unguaranteed FedEx date it may land on
 *  (lib/delivery fedexNearbyDays' default; the calendar shades them). */
export const FEDEX_NEARBY_BUSINESS_DAYS = 2;

/** Each carrier as the customer picks it (title + one-line promise). */
export const CARRIER_COPY: Record<Carrier, { title: string; description: string }> = {
  fedex: { title: "FedEx", description: "Expected to arrive on the exact date you pick" },
  usps: { title: "USPS First Class", description: "Arrives within 2–3 business days of your selected date" },
};

/**
 * What each carrier promises on a storefront, in one line (the MCP quote's
 * shipping service and get_delivery_options). With a paid guarantee on
 * offer, a plain FedEx date is aimed at the day and may land up to two
 * business days either side; without one (legacy profiles), FedEx 2-Day is
 * itself the guaranteed service — its invoice line reads "Guaranteed
 * delivery on your selected dates".
 */
export function carrierService(carrier: Carrier, guaranteeOffered: boolean): string {
  if (carrier === "usps") return "USPS First Class — arrives in a window around the chosen date";
  return guaranteeOffered
    ? `FedEx 2-Day — aimed at the chosen date; it may arrive up to ${FEDEX_NEARBY_BUSINESS_DAYS} business days either side unless the ${GUARANTEE_LABEL.toLowerCase()} is added`
    : "FedEx 2-Day — guaranteed arrival on the chosen date";
}

/** The card's limits: the whole printed text (To + message + From) and the
 *  message box's lines (the "From:" line is extra). */
export const MESSAGE_RULES = {
  maxChars: MESSAGE_LIMIT,
  maxLines: MESSAGE_MAX_LINES,
  toMax: TO_MAX,
  fromMax: FROM_MAX,
} as const;
