/**
 * The analytics ids, in a module with no browser code so server routes
 * (e.g. the Shopify orders/paid webhook) can use them without pulling in
 * lib/analytics' client loader. lib/analytics re-exports these.
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
