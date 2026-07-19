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

type Gtag = (...args: unknown[]) => void;
type Fbq = (...args: unknown[]) => void;

declare global {
  interface Window {
    gtag?: Gtag;
    fbq?: Fbq;
  }
}

export function trackPageView(path: string): void {
  try {
    window.gtag?.("event", "page_view", { page_path: path });
    window.fbq?.("track", "PageView");
  } catch {}
}

export function trackAddToCart(valueCents: number | null): void {
  const value = valueCents !== null ? valueCents / 100 : undefined;
  try {
    window.gtag?.("event", "add_to_cart", { currency: "USD", value });
    window.fbq?.("track", "AddToCart", { currency: "USD", value });
  } catch {}
}

export function trackBeginCheckout(valueCents: number | null): void {
  const value = valueCents !== null ? valueCents / 100 : undefined;
  try {
    window.gtag?.("event", "begin_checkout", { currency: "USD", value });
    window.fbq?.("track", "InitiateCheckout", { currency: "USD", value });
  } catch {}
}
