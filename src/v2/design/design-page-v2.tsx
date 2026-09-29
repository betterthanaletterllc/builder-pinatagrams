import { preload } from "react-dom";
import { resolveDeliveryConfig } from "@/lib/delivery";
import { resolveFillings } from "@/lib/flow";
import {
  getCatalog,
  getReviews,
  resolveBuilderPricing,
  resolveGraphicCategories,
  resolveHubGraphics,
  type HubCatalog,
} from "@/lib/hub";
import { resolveVariantProfile } from "@/lib/variant";
import VariantBoot from "@/app/variant-boot";
import HubDown from "../chrome/hub-down";
import {
  defaultGraphic,
  defaultStyle,
  hubStrip,
  libraryCount,
  occasionForDesign,
  occasionStrips,
  resolveDesign,
} from "../lib/catalog-server";
import { candyFilling, fillingForGraphic } from "../lib/defaults";
import { isOccasionId } from "../lib/occasions";
import { UTM_PRESETS } from "../lib/presets";
import { b2cPrice, param, requestContext, toV2Addons, trustFrom } from "../lib/server";
import { parseStep } from "../lib/steps";
import type { FlowData, Preset } from "../lib/types";
import DesignFlowV2 from "./design-flow-v2-lazy";

/**
 * v2 /design (builder2): the four-step journey. Everything that needs the
 * catalog or the library manifest is resolved HERE, server-side — the deep
 * link (design / occasion / style / utm_content), the context defaults and
 * the occasion filmstrips — so the client gets a ready-to-render preset and
 * never downloads graphics.json. A missing or unknown ?style= never dead-
 * ends: the body is chosen by context instead.
 */
export default async function DesignPageV2({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const { host, previewVariant } = await requestContext(param(searchParams, "variant"));

  let catalog: HubCatalog;
  try {
    catalog = await getCatalog({ host, previewVariant });
  } catch {
    // Without the catalog there's no box, price or stock to build against.
    return <HubDown />;
  }
  const [price, reviews] = await Promise.all([b2cPrice(), getReviews({ limit: 1 })]);

  const variant = resolveVariantProfile(catalog.variant);
  const fillings = resolveFillings(catalog.fillings);
  const hubGraphics = resolveHubGraphics(catalog.hubGraphics);
  const styles = catalog.bodyStyles.filter((s) => s.inStock);
  if (styles.length === 0) return <HubDown />;

  // Deep link, with the ad's utm_content preset filling any gaps field by
  // field (explicit params always win).
  const utm = UTM_PRESETS[(param(searchParams, "utm_content") ?? "").toLowerCase()];
  const designParam = param(searchParams, "design") || utm?.design;
  const occasionParam = param(searchParams, "occasion") || utm?.occasion;
  const styleParam = param(searchParams, "style") || utm?.style;
  const explicitOccasion = isOccasionId(occasionParam) ? occasionParam : null;

  const strips = occasionStrips(variant);
  const hubList = hubStrip(hubGraphics);
  const linked = designParam ? resolveDesign(designParam, variant, hubGraphics) : null;
  const graphic = linked ?? defaultGraphic(variant, strips, explicitOccasion, hubList);
  // The filmstrip opens on the asked-for occasion, else the design's own,
  // else the first chip (Birthday — the #1 occasion).
  const occasion =
    (explicitOccasion && strips.some((s) => s.id === explicitOccasion)
      ? explicitOccasion
      : null) ??
    occasionForDesign(graphic, strips) ??
    strips[0]?.id ??
    null;
  const style =
    defaultStyle(styles, { styleParam, graphic, occasion: explicitOccasion }, hubGraphics) ??
    { id: styles[0].id, source: "default" as const };
  const filling = fillingForGraphic(graphic, fillings) ?? candyFilling(fillings);

  const preset: Preset = {
    styleId: style.id,
    styleSource: style.source,
    graphic,
    graphicSource: linked ? "deeplink" : "default",
    occasion,
    occasionSource: explicitOccasion ? "deeplink" : "default",
    filling: filling?.label ?? "Candy",
    fillingAuto: true,
  };

  // The Stage photo is the LCP: fetch it first. (BoxPreview renders a plain
  // <img>; this preload is what gives it priority.)
  const stageStyle = styles.find((s) => s.id === style.id);
  if (stageStyle?.boxImageUrl) {
    preload(stageStyle.boxImageUrl, { as: "image", fetchPriority: "high" });
  }

  const data: FlowData = {
    styles,
    box: catalog.box ?? null,
    addons: toV2Addons(catalog.addons),
    fillings,
    deliveryCfg: resolveDeliveryConfig(catalog.delivery),
    pricing: resolveBuilderPricing(catalog.pricing),
    variant,
    hubGraphics,
    hubCategories: resolveGraphicCategories(catalog.graphicCategories),
    strips,
    hubStrip: variant.library === "none" ? hubList : [],
    libraryCount: libraryCount(variant, hubGraphics),
    preset,
    deepLink: !!(linked || explicitOccasion || style.source === "deeplink"),
    requestedStep: parseStep(param(searchParams, "step")) ?? "design",
    editLineId: param(searchParams, "edit") || null,
    initialPrice: price,
    trust: trustFrom(reviews),
    previewVariant,
  };

  return (
    <>
      {/* Remembers a non-production preview for client surfaces and flags
          unresolved hosts loudly. Renders nothing. */}
      <VariantBoot
        variantName={variant.name}
        resolvedVia={variant.resolvedVia}
        preview={!!previewVariant}
      />
      <DesignFlowV2 {...data} />
    </>
  );
}
