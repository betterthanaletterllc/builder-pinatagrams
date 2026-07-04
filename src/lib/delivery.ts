/**
 * Delivery-date rules. ONE place to keep them.
 *
 * The clock is pinned to the SHOP's timezone (America/Chicago) on both the
 * client and the server — otherwise Vercel's UTC "today" runs a day ahead of
 * a US evening shopper and checkout rejects the very date the picker offered.
 * Checkout additionally applies a one-day grace (deliveryProblemAtCheckout)
 * so carts built just before a midnight boundary still clear.
 *
 * ⚠️ TODO: port the EXACT lead-time + blackout logic from the live
 * pinatagrams.com storefront (its date picker feeds the `_requestedDate`
 * line-item property that Paper schedules by). These defaults are sensible
 * placeholders until that port happens — adjust freely.
 */

export const DELIVERY_RULES = {
  // Earliest deliverable date = today + leadDays.
  leadDays: 7,
  // How far out customers may schedule.
  maxDaysOut: 120,
  // No standard-ground delivery on these weekdays (0 = Sunday).
  blackoutWeekdays: [0],
  // Specific undeliverable dates, "YYYY-MM-DD" (holidays, shutdowns).
  blackoutDates: [] as string[],
};

const SHOP_TZ = "America/Chicago";

/** Today's date in the shop's timezone, as YYYY-MM-DD. */
function shopToday(): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: SHOP_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export function toYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function fromYmd(ymd: string): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function addDays(ymd: string, days: number): string {
  const d = fromYmd(ymd);
  d.setDate(d.getDate() + days);
  return toYmd(d);
}

export function minDeliveryDate(): string {
  return addDays(shopToday(), DELIVERY_RULES.leadDays);
}

export function maxDeliveryDate(): string {
  return addDays(shopToday(), DELIVERY_RULES.maxDaysOut);
}

/** null = fine; otherwise a customer-facing reason the date doesn't work. */
export function deliveryProblem(ymd: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return "Pick a delivery date.";
  if (ymd < minDeliveryDate())
    return `We need ${DELIVERY_RULES.leadDays} days to make and ship your piñata.`;
  if (ymd > maxDeliveryDate()) return "That's a bit too far out — pick a closer date.";
  const d = fromYmd(ymd);
  if (DELIVERY_RULES.blackoutWeekdays.includes(d.getDay()))
    return "We can't deliver on that day of the week — pick the day before or after.";
  if (DELIVERY_RULES.blackoutDates.includes(ymd))
    return "That date isn't available — pick another day.";
  return null;
}

/**
 * Server-side validation at checkout: one day of grace on the lead-time
 * check, so a date that was legitimately selectable when the cart was built
 * isn't rejected because midnight passed (or a clock skews) in between.
 */
export function deliveryProblemAtCheckout(ymd: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return "Pick a delivery date.";
  const graceMin = addDays(shopToday(), DELIVERY_RULES.leadDays - 1);
  if (ymd < graceMin)
    return `That delivery date is too soon now — we need ${DELIVERY_RULES.leadDays} days. Pick a new date.`;
  if (ymd > maxDeliveryDate()) return "That's a bit too far out — pick a closer date.";
  const d = fromYmd(ymd);
  if (DELIVERY_RULES.blackoutWeekdays.includes(d.getDay()))
    return "We can't deliver on that day of the week.";
  if (DELIVERY_RULES.blackoutDates.includes(ymd))
    return "That date isn't available anymore.";
  return null;
}

/** First date that passes every rule (for the picker default). */
export function firstAvailableDate(): string {
  const d = fromYmd(minDeliveryDate());
  for (let i = 0; i < 60; i++) {
    const ymd = toYmd(d);
    if (!deliveryProblem(ymd)) return ymd;
    d.setDate(d.getDate() + 1);
  }
  return minDeliveryDate();
}
