import Link from "next/link";
import { headers } from "next/headers";
import {
  getCatalog,
  resolveBuilderPricing,
  type BuilderPricing,
  type HubAddon,
  type HubBodyStyle,
  type HubFilling,
  type LogoZone,
} from "@/lib/hub";
import { resolveFillings } from "@/lib/flow";
import { resolveDeliveryConfig, type DeliveryConfig } from "@/lib/delivery";
import {
  DEFAULT_VARIANT,
  normalizeHost,
  resolveVariantProfile,
  type VariantProfile,
} from "@/lib/variant";
import VariantBoot from "../variant-boot";
import DesignFlow from "./design-flow";

export const dynamic = "force-dynamic";

export default async function DesignPage({
  searchParams,
}: {
  searchParams: Promise<{ style?: string; variant?: string }>;
}) {
  const { style, variant: variantParam } = await searchParams;
  const host = normalizeHost((await headers()).get("host"));
  const previewVariant =
    process.env.VERCEL_ENV !== "production" ? (variantParam ?? null) : null;

  let match: HubBodyStyle | null = null;
  let box: { interiorUrl: string | null; messageZone: LogoZone | null } | null =
    null;
  let addons: HubAddon[] = [];
  let fillings: HubFilling[] = resolveFillings(undefined);
  let deliveryCfg: DeliveryConfig = resolveDeliveryConfig(undefined);
  let pricing: BuilderPricing = resolveBuilderPricing(undefined);
  let variant: VariantProfile = DEFAULT_VARIANT;
  let hubDown = false;
  try {
    const catalog = await getCatalog({ host, previewVariant });
    match = catalog.bodyStyles.find((s) => s.id === style && s.inStock) ?? null;
    box = catalog.box ?? null;
    addons = catalog.addons ?? [];
    fillings = resolveFillings(catalog.fillings);
    deliveryCfg = resolveDeliveryConfig(catalog.delivery);
    pricing = resolveBuilderPricing(catalog.pricing);
    variant = resolveVariantProfile(catalog.variant);
  } catch {
    // Hub unreachable — the flow still works; the style is re-validated
    // server-side at order time anyway.
    hubDown = true;
  }

  if (!style || (!match && !hubDown)) {
    return (
      <main>
        <div className="error-box">
          <strong>Pick a body style first.</strong>
          <p className="note">
            <Link href="/">Back to the style picker</Link>
          </p>
        </div>
      </main>
    );
  }

  return (
    <main>
      {/* No boot while the hub is down: a fallback-by-outage must not fire
          the misconfiguration alarm (checkout 503s anyway — no order risk). */}
      {!hubDown && (
        <VariantBoot
          variantName={variant.name}
          resolvedVia={variant.resolvedVia}
          preview={!!previewVariant}
        />
      )}
      <DesignFlow
        style={{
          id: style,
          name: match?.name ?? style,
          imageUrl: match?.imageUrl ?? null,
          boxImageUrl: match?.boxImageUrl ?? null,
          logoZone: match?.logoZone ?? null,
          pinataZone: match?.pinataZone ?? null,
          cutoutUrl: match?.cutoutUrl ?? null,
        }}
        boxInterior={box}
        addonOptions={addons}
        fillingOptions={fillings}
        deliveryCfg={deliveryCfg}
        pricing={pricing}
        variant={variant}
      />
    </main>
  );
}
