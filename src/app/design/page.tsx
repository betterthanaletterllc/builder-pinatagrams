import Link from "next/link";
import { headers } from "next/headers";
import {
  getCatalog,
  resolveBuilderPricing,
  resolveGraphicCategories,
  resolveHubGraphics,
  type BuilderPricing,
  type HubAddon,
  type HubBodyStyle,
  type HubFilling,
  type HubGraphicCategory,
  type HubGraphicEntry,
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
import { flowFromHeaders } from "@/lib/flow-version";
import DesignPageV2 from "@/v2/design/design-page-v2";
import dynamicImport from "next/dynamic";
import VariantBoot from "../variant-boot";

// v1's flow (and the graphic library it pulls in) as its own chunk, so
// v2 visitors — everyone in production since v1's sunset — never download it.
const DesignFlow = dynamicImport(() => import("./design-flow"));

export const dynamic = "force-dynamic";

// The best-selling body — the default when a link names none (or one that
// can't be sold right now).
const DEFAULT_STYLE_ID = "googly";

export default async function DesignPage({
  searchParams,
}: {
  searchParams: Promise<{ style?: string; variant?: string; edit?: string }>;
}) {
  // Flow v2 (every host): the four-step journey in src/v2. It resolves its own
  // defaults, so a missing or unknown ?style= never dead-ends there.
  if (flowFromHeaders(await headers()) === "v2") {
    return (
      <DesignPageV2
        searchParams={(await searchParams) as Record<string, string | string[] | undefined>}
      />
    );
  }
  const { style, variant: variantParam, edit } = await searchParams;
  const host = normalizeHost((await headers()).get("host"));
  const previewVariant =
    process.env.VERCEL_ENV !== "production" ? (variantParam ?? null) : null;

  let match: HubBodyStyle | null = null;
  // The body the URL asked for, even if it can't be sold right now.
  let requested: HubBodyStyle | null = null;
  let fallback: HubBodyStyle | null = null;
  let box: { interiorUrl: string | null; messageZone: LogoZone | null } | null =
    null;
  let addons: HubAddon[] = [];
  let fillings: HubFilling[] = resolveFillings(undefined);
  let deliveryCfg: DeliveryConfig = resolveDeliveryConfig(undefined);
  let pricing: BuilderPricing = resolveBuilderPricing(undefined);
  let variant: VariantProfile = DEFAULT_VARIANT;
  let hubGraphics: HubGraphicEntry[] = [];
  let hubCategories: HubGraphicCategory[] = [];
  let hubDown = false;
  try {
    const catalog = await getCatalog({ host, previewVariant });
    requested = catalog.bodyStyles.find((s) => s.id === style) ?? null;
    match = requested?.inStock ? requested : null;
    if (!match) {
      const inStock = catalog.bodyStyles.filter((s) => s.inStock);
      fallback =
        inStock.find((s) => s.id === DEFAULT_STYLE_ID) ?? inStock[0] ?? null;
    }
    box = catalog.box ?? null;
    addons = catalog.addons ?? [];
    fillings = resolveFillings(catalog.fillings);
    deliveryCfg = resolveDeliveryConfig(catalog.delivery);
    pricing = resolveBuilderPricing(catalog.pricing);
    variant = resolveVariantProfile(catalog.variant);
    hubGraphics = resolveHubGraphics(catalog.hubGraphics);
    hubCategories = resolveGraphicCategories(catalog.graphicCategories);
  } catch {
    // Hub unreachable — the flow still works; the style is re-validated
    // server-side at order time anyway.
    hubDown = true;
  }

  // A missing, unknown or out-of-stock body no longer dead-ends here: start
  // on an in-stock default (Googly first). A CART EDIT of a line whose body
  // sold out opens with the style switcher and says why — its design,
  // message and the rest carry over to whichever body they pick.
  // Only a hub outage with no style at all (nothing to fall back to), or a
  // catalog with nothing in stock, still stops.
  const chosen: HubBodyStyle | null = match ?? fallback;
  let styleNotice: string | null = null;
  if (!match && fallback && style) {
    const why = requested
      ? `The ${requested.name} body is out of stock right now`
      : "That body style isn't available anymore";
    styleNotice = edit
      ? `${why} — pick another style below. Your design and message stay put.`
      : `${why} — we started you on ${fallback.name}. Tap it above to swap.`;
  }
  if (!chosen && (!style || !hubDown)) {
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
  const styleId = chosen?.id ?? style!;

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
          id: styleId,
          name: chosen?.name ?? styleId,
          imageUrl: chosen?.imageUrl ?? null,
          boxImageUrl: chosen?.boxImageUrl ?? null,
          logoZone: chosen?.logoZone ?? null,
          pinataZone: chosen?.pinataZone ?? null,
          cutoutUrl: chosen?.cutoutUrl ?? null,
        }}
        boxInterior={box}
        addonOptions={addons}
        fillingOptions={fillings}
        deliveryCfg={deliveryCfg}
        pricing={pricing}
        variant={variant}
        hubGraphics={hubGraphics}
        hubCategories={hubCategories}
        styleNotice={styleNotice}
        openSwitcher={!!styleNotice && !!edit}
      />
    </main>
  );
}
