import {
  deliveryProblem,
  earliestDeliveryDate,
  formatWindow,
  formatYmd,
  minDeliveryDate,
  uspsWindow,
  type Carrier,
  type DeliveryConfig,
} from "@/lib/delivery";

/**
 * Promise-first date copy for v2, on top of lib/delivery's rules (which stay
 * the single source of truth). Nothing here decides validity.
 */

const SHOP_TZ = "America/Chicago";

/** Today in the shop's timezone (YYYY-MM-DD) — lib/delivery's clock. */
export function shopTodayYmd(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: SHOP_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function nextDay(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(y, m - 1, d + 1);
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${dt.getFullYear()}-${mm}-${dd}`;
}

/**
 * Honest urgency: "Order by midnight CT" only when it's TRUE — i.e. an
 * order placed tomorrow (shop time) would arrive later than one placed
 * today. On a weekend both may land the same day, so no cutoff is claimed.
 */
export function cutoffTonight(cfg: DeliveryConfig, carrier: Carrier = "fedex"): boolean {
  const today = shopTodayYmd();
  return (
    earliestDeliveryDate(cfg, today, carrier) !==
    earliestDeliveryDate(cfg, nextDay(today), carrier)
  );
}

export function soonest(cfg: DeliveryConfig, carrier: Carrier = "fedex"): string {
  return minDeliveryDate(cfg, carrier);
}

/** "Thu, Oct 1" (FedEx: the exact day) or "Oct 7 – Oct 12" (USPS window). */
export function arrivalText(ymd: string, carrier: Carrier, cfg: DeliveryConfig): string {
  return carrier === "usps" ? formatWindow(uspsWindow(ymd, cfg)) : formatYmd(ymd);
}

/** Customer-facing date problem with every raw YYYY-MM-DD formatted
 *  ("Thu, Oct 1") — error copy never shows ISO dates. */
export function dateProblemText(
  ymd: string,
  cfg: DeliveryConfig,
  carrier: Carrier,
): string | null {
  if (!ymd) return "Pick a delivery date.";
  const p = deliveryProblem(ymd, cfg, carrier);
  return p ? friendlyDates(p) : null;
}

export function friendlyDates(text: string): string {
  return text.replace(/\b\d{4}-\d{2}-\d{2}\b/g, (d) => formatYmd(d));
}
