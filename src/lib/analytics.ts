/**
 * Funnel analytics. GA4 uses the SAME property as pinatagrams.com
 * (G-TF4J3S84QY) so builder traffic lands in the store's existing reports.
 * A Meta pixel hook is wired but dormant — set NEXT_PUBLIC_META_PIXEL_ID in
 * Vercel when a pixel exists and every event below starts firing to it too.
 * Purchases are tracked by Shopify's own checkout, not here.
 */

export const GA_ID = process.env.NEXT_PUBLIC_GA_ID ?? "G-TF4J3S84QY";
// Nathan's pixel (2026-07-19). Pixel IDs are public client-side values —
// same pattern as GA_ID; the env var can still override.
export const META_PIXEL_ID =
  process.env.NEXT_PUBLIC_META_PIXEL_ID ?? "621443411344269";
// PostHog project 520051 (US cloud). Write-only client token — public-safe
// per PostHog; env can still override.
export const POSTHOG_KEY =
  process.env.NEXT_PUBLIC_POSTHOG_KEY ??
  "phc_uC4uwDEo2gnWrvt9TsoFgm4vCdrTJfA5Gsqf8prBA8GE";
export const POSTHOG_HOST =
  process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com";

type Gtag = (...args: unknown[]) => void;
type Fbq = (...args: unknown[]) => void;

declare global {
  interface Window {
    gtag?: Gtag;
    fbq?: Fbq;
  }
}

import posthog from "posthog-js";

/** The variant dimension for every event: the HOSTNAME, available
 *  synchronously before any event fires (the async-fetched profile name
 *  would miss the landing pageview — the funnel's denominator). Map
 *  hostname → variant at analysis time via the hub's variants table. */
function hostProps(): Record<string, string> {
  try {
    return { store_host: window.location.hostname };
  } catch {
    return {};
  }
}

/** Fan a funnel event out to GA4 + PostHog (Meta gets only its standard
 *  events — AddToCart/InitiateCheckout/PageView — via the helpers below).
 *  One call per moment in flow code; never throws. */
export function track(event: string, props?: Record<string, unknown>): void {
  const p = { ...hostProps(), ...(props ?? {}) };
  try {
    window.gtag?.("event", event, p);
  } catch {}
  try {
    if (POSTHOG_KEY) posthog.capture(event, p);
  } catch {}
}

export function trackPageView(path: string): void {
  try {
    window.gtag?.("event", "page_view", { page_path: path, ...hostProps() });
    window.fbq?.("track", "PageView");
  } catch {}
  try {
    if (POSTHOG_KEY) posthog.capture("$pageview", hostProps());
  } catch {}
}

export function trackAddToCart(valueCents: number | null): void {
  const value = valueCents !== null ? valueCents / 100 : undefined;
  try {
    window.gtag?.("event", "add_to_cart", { currency: "USD", value, ...hostProps() });
    window.fbq?.("track", "AddToCart", { currency: "USD", value });
  } catch {}
  try {
    if (POSTHOG_KEY)
      posthog.capture("add_to_cart", { currency: "USD", value, ...hostProps() });
  } catch {}
}

export function trackBeginCheckout(valueCents: number | null): void {
  const value = valueCents !== null ? valueCents / 100 : undefined;
  try {
    window.gtag?.("event", "begin_checkout", { currency: "USD", value, ...hostProps() });
    window.fbq?.("track", "InitiateCheckout", { currency: "USD", value });
  } catch {}
  try {
    if (POSTHOG_KEY)
      posthog.capture("begin_checkout", { currency: "USD", value, ...hostProps() });
  } catch {}
}
