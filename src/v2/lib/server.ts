import "server-only";
import { cookies, headers } from "next/headers";
import { previewOverridesAllowed, VARIANT_COOKIE } from "@/lib/flow-version";
import { priceUrl, type HubAddon, type HubPrice, type HubReviews } from "@/lib/hub";
import { normalizeHost } from "@/lib/variant";
import type { Trust, V2Addon } from "./types";

/**
 * Request context for v2 server pages: the hostname (which picks the hub's
 * variant profile) and, outside production only, a previewed profile —
 * ?variant= on this request, else the one the middleware remembered in a
 * cookie, so a preview holds while the shopper moves between pages.
 * Production ignores both, exactly like v1.
 */
export async function requestContext(
  variantParam: string | undefined,
): Promise<{ host: string; previewVariant: string | null }> {
  const host = normalizeHost((await headers()).get("host"));
  if (!previewOverridesAllowed()) return { host, previewVariant: null };
  const fromCookie = (await cookies()).get(VARIANT_COOKIE)?.value ?? null;
  const previewVariant =
    variantParam !== undefined ? variantParam || null : fromCookie;
  return { host, previewVariant };
}

/**
 * The base retail price + FedEx ship rate — the same request (and cache) as
 * page.tsx's b2cPrice, so v2 shows the numbers v1 shows. Null on any hiccup:
 * prices then read "—" and the client retries; the flow never blocks on it.
 */
export async function b2cPrice(): Promise<HubPrice | null> {
  try {
    const res = await fetch(
      priceUrl({
        qty: 1,
        fill: "filled",
        bodyType: "standard",
        graphicType: "custom",
        mode: "individual",
        carrier: "standard",
      }),
      { next: { revalidate: 300 }, signal: AbortSignal.timeout(5000) },
    );
    if (!res.ok) return null;
    const p: HubPrice = await res.json();
    return Number.isFinite(p.unitPriceCents) && p.unitPriceCents > 0 ? p : null;
  } catch {
    return null;
  }
}

/** Rating + its scope label (brand-pooled; the label travels with it). */
export function trustFrom(reviews: HubReviews | null): Trust | null {
  if (!reviews || !(reviews.aggregate.count > 0)) return null;
  return {
    rating: reviews.aggregate.rating,
    count: reviews.aggregate.count,
    label: reviews.scope.label,
  };
}

/** The catalog's add-ons with the optional photo/blurb the hub now serves
 *  (read defensively: older hubs send neither). */
export function toV2Addons(raw: HubAddon[] | undefined): V2Addon[] {
  return (raw ?? []).map((a) => {
    const o = a as HubAddon & { blurb?: unknown; imageUrl?: unknown };
    return {
      id: a.id,
      label: a.label,
      priceCents: a.priceCents,
      sku: a.sku,
      blurb: typeof o.blurb === "string" ? o.blurb : "",
      imageUrl: typeof o.imageUrl === "string" && o.imageUrl ? o.imageUrl : null,
    };
  });
}

/** First value of a search param (Next hands arrays for repeated keys). */
export function param(
  sp: Record<string, string | string[] | undefined>,
  key: string,
): string | undefined {
  const v = sp[key];
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === "string" ? s.trim() : undefined;
}
