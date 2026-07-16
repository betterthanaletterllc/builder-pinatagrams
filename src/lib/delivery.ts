/**
 * Delivery-date rules. ONE place to keep them.
 *
 * Model (Nathan, 2026-07-06): the earliest arrival = the NEXT fulfillment
 * working day after the order (one day to make + hand to FedEx), then TWO
 * qualified FedEx delivery days — "FedEx 2nd day away". A pickable date must
 * itself be a day FedEx delivers (not a FedEx weekly off-day or holiday).
 *
 * The calendars live in the hub (admin /delivery → public catalog
 * `delivery`); DEFAULT_DELIVERY below is the compiled fallback so a hub blip
 * still applies the real holidays.
 *
 * The clock is pinned to the SHOP's timezone (America/Chicago) on both the
 * client and the server — otherwise Vercel's UTC "today" runs a day ahead of
 * a US evening shopper and checkout rejects the very date the picker offered.
 * Checkout additionally applies a one-day grace (deliveryProblemAtCheckout)
 * so carts built just before a midnight boundary still clear.
 */

export type DeliveryConfig = {
  fulfillmentHolidays: string[]; // "YYYY-MM-DD" — shop closed, nothing ships
  fedexHolidays: string[]; // FedEx doesn't move or deliver
  uspsHolidays: string[]; // stored for future standard-ship logic
  fulfillmentWeekdaysOff: number[]; // 0=Sun..6=Sat
  fedexWeekdaysOff: number[];
  maxDaysOut: number;
};

// Carrier holidays 2026→2031 (federal set); fulfillment adds 2026-07-03
// (observed July 4th). Mirrors scripts/seed-delivery.mjs in the hub.
const CARRIER_HOLIDAYS = [
  "2026-05-25", "2026-07-04", "2026-09-07", "2026-11-26", "2026-12-25",
  "2027-01-01", "2027-03-28", "2027-05-31", "2027-07-04", "2027-09-06", "2027-11-25", "2027-12-25",
  "2028-01-01", "2028-04-16", "2028-05-29", "2028-07-04", "2028-09-04", "2028-11-23", "2028-12-25",
  "2029-01-01", "2029-04-01", "2029-05-28", "2029-07-04", "2029-09-03", "2029-11-22", "2029-12-25",
  "2030-01-01", "2030-04-21", "2030-05-27", "2030-07-04", "2030-09-02", "2030-11-28", "2030-12-25",
  "2031-01-01", "2031-04-13",
];

export const DEFAULT_DELIVERY: DeliveryConfig = {
  fulfillmentHolidays: [...CARRIER_HOLIDAYS, "2026-07-03"].sort(),
  fedexHolidays: CARRIER_HOLIDAYS,
  uspsHolidays: CARRIER_HOLIDAYS,
  fulfillmentWeekdaysOff: [0],
  fedexWeekdaysOff: [0],
  maxDaysOut: 120,
};

/** Merge the hub's (possibly partial/absent) delivery block over defaults. */
export function resolveDeliveryConfig(raw: unknown): DeliveryConfig {
  const r = (raw ?? {}) as Partial<Record<keyof DeliveryConfig, unknown>>;
  const dates = (v: unknown, fb: string[]) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : fb;
  const days = (v: unknown, fb: number[]) =>
    Array.isArray(v) ? v.filter((x): x is number => typeof x === "number") : fb;
  return {
    fulfillmentHolidays: dates(r.fulfillmentHolidays, DEFAULT_DELIVERY.fulfillmentHolidays),
    fedexHolidays: dates(r.fedexHolidays, DEFAULT_DELIVERY.fedexHolidays),
    uspsHolidays: dates(r.uspsHolidays, DEFAULT_DELIVERY.uspsHolidays),
    fulfillmentWeekdaysOff: days(r.fulfillmentWeekdaysOff, DEFAULT_DELIVERY.fulfillmentWeekdaysOff),
    fedexWeekdaysOff: days(r.fedexWeekdaysOff, DEFAULT_DELIVERY.fedexWeekdaysOff),
    maxDaysOut:
      typeof r.maxDaysOut === "number" && r.maxDaysOut > 0
        ? r.maxDaysOut
        : DEFAULT_DELIVERY.maxDaysOut,
  };
}

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

/** A YYYY-MM-DD date the customer can read at a glance, e.g. "Mon, Jul 20".
 *  Falls back to the raw string if it isn't a valid date. */
export function formatYmd(ymd: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return ymd;
  return fromYmd(ymd).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function addDays(ymd: string, days: number): string {
  const d = fromYmd(ymd);
  d.setDate(d.getDate() + days);
  return toYmd(d);
}

/** First day AFTER `fromExclusive` that isn't a weekly off-day or holiday. */
function nextWorkingDay(
  fromExclusive: string,
  weekdaysOff: number[],
  holidays: string[],
): string {
  let d = addDays(fromExclusive, 1);
  for (let i = 0; i < 90; i++) {
    if (!weekdaysOff.includes(fromYmd(d).getDay()) && !holidays.includes(d)) {
      return d;
    }
    d = addDays(d, 1);
  }
  return d; // 90 dead days straight = misconfigured calendar; fail open
}

/**
 * Earliest arrival for an order placed on `orderDay`: the next fulfillment
 * working day (make + ship), then the 2nd qualified FedEx delivery day.
 */
export function earliestDeliveryDate(
  cfg: DeliveryConfig,
  orderDay: string = shopToday(),
): string {
  const ship = nextWorkingDay(orderDay, cfg.fulfillmentWeekdaysOff, cfg.fulfillmentHolidays);
  let d = ship;
  for (let n = 0; n < 2; n++) {
    d = nextWorkingDay(d, cfg.fedexWeekdaysOff, cfg.fedexHolidays);
  }
  return d;
}

export function minDeliveryDate(cfg: DeliveryConfig): string {
  return earliestDeliveryDate(cfg);
}

export function maxDeliveryDate(cfg: DeliveryConfig): string {
  return addDays(shopToday(), cfg.maxDaysOut);
}

function carrierDead(ymd: string, cfg: DeliveryConfig): string | null {
  if (cfg.fedexWeekdaysOff.includes(fromYmd(ymd).getDay())) {
    return "FedEx doesn't deliver on that day of the week — pick the day before or after.";
  }
  if (cfg.fedexHolidays.includes(ymd)) {
    return "That's a carrier holiday — pick another day.";
  }
  return null;
}

/** null = fine; otherwise a customer-facing reason the date doesn't work. */
export function deliveryProblem(ymd: string, cfg: DeliveryConfig): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return "Pick a delivery date.";
  if (ymd < minDeliveryDate(cfg)) {
    return `We need a day to make your piñata and two FedEx days to fly it there — ${minDeliveryDate(cfg)} is the soonest.`;
  }
  if (ymd > maxDeliveryDate(cfg)) return "That's a bit too far out — pick a closer date.";
  return carrierDead(ymd, cfg);
}

/**
 * Server-side validation at checkout: the earliest date is recomputed as if
 * the order were placed YESTERDAY, so a date that was legitimately selectable
 * when the cart was built isn't rejected because midnight passed (or a clock
 * skews) in between.
 */
export function deliveryProblemAtCheckout(ymd: string, cfg: DeliveryConfig): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return "Pick a delivery date.";
  const graceMin = earliestDeliveryDate(cfg, addDays(shopToday(), -1));
  if (ymd < graceMin) {
    return `That delivery date is too soon now — ${earliestDeliveryDate(cfg)} is the earliest. Pick a new date.`;
  }
  if (ymd > maxDeliveryDate(cfg)) return "That's a bit too far out — pick a closer date.";
  return carrierDead(ymd, cfg);
}
