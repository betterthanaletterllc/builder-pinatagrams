/**
 * Delivery-date rules. ONE place to keep them.
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

export function toYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function fromYmd(ymd: string): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function minDeliveryDate(): string {
  const d = new Date();
  d.setDate(d.getDate() + DELIVERY_RULES.leadDays);
  return toYmd(d);
}

export function maxDeliveryDate(): string {
  const d = new Date();
  d.setDate(d.getDate() + DELIVERY_RULES.maxDaysOut);
  return toYmd(d);
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
