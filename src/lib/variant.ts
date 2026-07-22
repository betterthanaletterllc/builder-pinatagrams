import type { Carrier } from "./delivery";

/**
 * Variant profiles — ONE mechanism for every storefront variation (A/B arms,
 * niche stores like birthday.pinatagrams.com). The hub owns the registry
 * (admin /pricing → "Builder variants"); the HOSTNAME the customer visited
 * picks the profile, and /api/checkout re-resolves by its own request Host,
 * so the flow a variant displays is always the flow its invoice charges.
 *
 * The compiled DEFAULT_VARIANT is the hub-down fallback and MUST equal the
 * main site's intended flow: flat one-price, FedEx-only, full library.
 *
 * Variant identity is ADVISORY — order tags + analytics only. It must never
 * authorize anything (no per-variant discounts or entitlements, ever).
 */

export type VariantProfile = {
  name: string;
  pricing: "flat" | "tiered";
  carriers: Carrier[];
  library: "all" | "birthday";
  landingLines: string[] | null;
  // "name" = preview override; "host" = matched a configured hostname;
  // "fallback" = no match. A fallback on a host that isn't the main site is
  // a MISCONFIGURATION (typo'd hub row, ads live before the profile) — the
  // builder surfaces it loudly instead of silently selling the default flow.
  resolvedVia: "name" | "host" | "fallback";
};

export const DEFAULT_VARIANT: VariantProfile = {
  name: "default",
  pricing: "flat",
  carriers: ["fedex"],
  library: "all",
  landingLines: null,
  resolvedVia: "fallback",
};

/** Hosts where a fallback resolution is EXPECTED (the main site + local/CI
 *  surfaces), not a misconfiguration. */
const EXPECTED_FALLBACK_HOSTS = /^(builder\.pinatagrams\.com|localhost|127\.0\.0\.1|.*\.vercel\.app)$/;

export function normalizeHost(host: string | null | undefined): string {
  return (host ?? "").trim().toLowerCase().replace(/:\d+$/, "");
}

/** Parse the catalog's `variant` block; anything malformed → the default. */
export function resolveVariantProfile(raw: unknown): VariantProfile {
  if (!raw || typeof raw !== "object") return DEFAULT_VARIANT;
  const r = raw as Record<string, unknown>;
  const carriers: Carrier[] =
    Array.isArray(r.carriers) && r.carriers.includes("usps")
      ? ["fedex", "usps"]
      : ["fedex"];
  return {
    name:
      typeof r.name === "string" && /^[a-z0-9-]{1,32}$/.test(r.name)
        ? r.name
        : "default",
    pricing: r.pricing === "tiered" ? "tiered" : "flat",
    carriers,
    library: r.library === "birthday" ? "birthday" : "all",
    landingLines:
      Array.isArray(r.landingLines) && r.landingLines.length
        ? r.landingLines.map(String).slice(0, 4)
        : null,
    resolvedVia:
      r.resolvedVia === "name" || r.resolvedVia === "host"
        ? r.resolvedVia
        : "fallback",
  };
}

/** True when this resolution smells like a misconfigured storefront: the
 *  registry didn't recognize the host and the host isn't a known-safe one. */
export function variantUnresolved(
  resolvedVia: VariantProfile["resolvedVia"],
  host: string,
): boolean {
  return resolvedVia === "fallback" && !EXPECTED_FALLBACK_HOSTS.test(normalizeHost(host));
}

/* --- non-production preview override ---------------------------------------
 * ?variant=<name> on the home/design pages renders any profile locally and
 * on Vercel previews, WITHOUT a host. Production ignores it completely —
 * checkout always resolves by real request Host there. The chosen name is
 * kept for the sitting so client surfaces (cart) preview the same profile.
 * ------------------------------------------------------------------------- */

const PREVIEW_KEY = "pinatagrams-variant-preview";

export function previewAllowed(): boolean {
  return process.env.NEXT_PUBLIC_VERCEL_ENV !== "production";
}

export function rememberPreviewVariant(name: string | null): void {
  try {
    if (name) sessionStorage.setItem(PREVIEW_KEY, name);
    else sessionStorage.removeItem(PREVIEW_KEY);
  } catch {}
}

export function previewVariantName(): string | null {
  if (!previewAllowed()) return null;
  try {
    // Belt and braces beyond the env gate (NEXT_PUBLIC_VERCEL_ENV depends on
    // Vercel's expose-system-env setting): previews never run on the real
    // storefront domains, only localhost / *.vercel.app preview deploys.
    if (/\.pinatagrams\.com$/.test(window.location.hostname)) return null;
    return sessionStorage.getItem(PREVIEW_KEY);
  } catch {
    return null;
  }
}
