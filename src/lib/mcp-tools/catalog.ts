import type { HubCatalog } from "@/lib/hub";
import { maxDeliveryDate, minDeliveryDate, resolveDeliveryConfig } from "@/lib/delivery";

/**
 * The customer-safe projection of the hub catalog — what get_catalog returns
 * and what open_designer embeds for its app. Moved here from order-tools.ts
 * so the tool modules under src/lib/mcp-tools/* can reuse it without
 * importing the registry (which imports them: a cycle otherwise). One
 * additive field since the move: each filling's add-on rule.
 */

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** The filling's add-on rule as flow.ts's fillingAllowsAddon reads it:
 *  every add-on (the default), none, or the listed add-on ids. */
function addonRule(v: unknown): "all" | "none" | string[] {
  if (v === "none") return "none";
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  return "all";
}

/** Customer-safe projection of the hub catalog: nothing here is a cost,
 *  a margin or an exact stock count — the hub's public plane already
 *  withholds those, and this narrows further to what an agent needs. */
export function projectCatalog(catalog: HubCatalog) {
  const raw = catalog as unknown as Record<string, unknown>;
  const shipping = (raw.shipping ?? {}) as Record<string, unknown>;
  const pricing = (raw.pricing ?? {}) as Record<string, unknown>;
  const cfg = resolveDeliveryConfig(catalog.delivery);
  return {
    as_of: catalog.asOf,
    ...(catalog.stale ? { stale: catalog.stale } : {}),
    body_styles: catalog.bodyStyles.map((s) => ({
      id: s.id,
      name: s.name,
      in_stock: !!s.inStock,
      image_url: s.imageUrl ?? null,
    })),
    fillings: (catalog.fillings ?? []).map((f) => ({
      id: f.id,
      label: f.label,
      blurb: f.blurb ?? "",
      price_cents: num(f.priceCents) ?? 0,
      // So a UI never offers an add-on price_order would refuse.
      add_ons: addonRule(f.addons),
    })),
    add_ons: (catalog.addons ?? []).map((a) => ({
      id: a.id,
      label: a.label,
      price_cents: num(a.priceCents) ?? 0,
    })),
    shipping_per_unit_cents: {
      fedex_2day: num(shipping.fedexCents),
      usps_first_class: num(shipping.uspsCents),
    },
    graphic_upcharge_cents: {
      library_design: num(pricing.graphicLibraryUpchargeCents),
      custom_art: num(pricing.graphicCustomUpchargeCents),
    },
    delivery: {
      timezone: "America/Chicago",
      earliest_fedex: minDeliveryDate(cfg, "fedex"),
      earliest_usps: minDeliveryDate(cfg, "usps"),
      latest: maxDeliveryDate(cfg),
    },
    currency: "USD",
    note: "All amounts are integer cents before tax. Every piñata is a gift box with a printed message card inside; the recipient keeps the piñata and pulls the treats out.",
  };
}

export type ProjectedCatalog = ReturnType<typeof projectCatalog>;
