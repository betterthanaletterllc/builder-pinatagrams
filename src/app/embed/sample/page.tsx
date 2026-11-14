import type { Metadata } from "next";
import { preload } from "react-dom";
import { embedParentOrigins } from "@/lib/embed";
import { previewOverridesAllowed } from "@/lib/flow-version";
import {
  getCatalog,
  resolveBuilderPricing,
  resolveGraphicCategories,
  resolveHubGraphics,
  type HubCatalog,
} from "@/lib/hub";
import { resolveVariantProfile } from "@/lib/variant";
import {
  defaultGraphic,
  defaultStyle,
  hubStrip,
  libraryCount,
  occasionForDesign,
  occasionStrips,
} from "@/v2/lib/catalog-server";
import { param, requestContext } from "@/v2/lib/server";
import { Callout } from "@/v2/ui/feedback";
import EmbedSample from "./embed-sample";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Pick a piñata — Piñatagrams",
  robots: { index: false, follow: false },
};

/**
 * /embed/sample — the journey's step one on its own, for Paper to frame when
 * staff start a one-off sample (lib/embed has the whole story and the
 * contract): cycle through the body styles, pick a design from the library
 * or make your own, then "Use this piñata".
 *
 * Everything is resolved here exactly as /design resolves it for a shopper
 * (the same catalog, the same occasion strips, the same starting design and
 * body), with two differences: every body style is offered, in stock or not
 * — a sample can be of anything — and there are no prices.
 *
 * ?style= names the body to start on (a hub id). Without the hub there is no
 * box and no library to show, so the page says so instead.
 */
export default async function EmbedSamplePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const { host, previewVariant } = await requestContext(undefined);

  let catalog: HubCatalog | null = null;
  try {
    catalog = await getCatalog({ host, previewVariant });
  } catch {
    catalog = null;
  }
  const styles = catalog?.bodyStyles ?? [];
  if (!catalog || styles.length === 0) {
    return (
      <main style={{ maxWidth: 560, margin: "0 auto", padding: 24 }}>
        <Callout tone="warning" role="alert">
          The piñata catalog can&apos;t be reached right now, so there is nothing to pick from. Try
          again in a minute — or make the sample without a design and add one afterwards.
        </Callout>
      </main>
    );
  }

  const variant = resolveVariantProfile(catalog.variant);
  const hubGraphics = resolveHubGraphics(catalog.hubGraphics);
  const strips = occasionStrips(variant);
  const hubList = hubStrip(hubGraphics);
  const graphic = defaultGraphic(variant, strips, null, hubList);
  const occasion = occasionForDesign(graphic, strips) ?? strips[0]?.id ?? null;
  const style =
    defaultStyle(styles, { styleParam: param(sp, "style"), graphic, occasion: null }, hubGraphics) ??
    { id: styles[0].id, source: "default" as const };

  // The Stage photo is the first thing seen: fetch it first.
  const stageStyle = styles.find((s) => s.id === style.id);
  if (stageStyle?.boxImageUrl) {
    preload(stageStyle.boxImageUrl, { as: "image", fetchPriority: "high" });
  }

  return (
    <EmbedSample
      parents={embedParentOrigins(!previewOverridesAllowed())}
      styles={styles}
      box={catalog.box ?? null}
      pricing={resolveBuilderPricing(catalog.pricing)}
      hubGraphics={hubGraphics}
      hubCategories={resolveGraphicCategories(catalog.graphicCategories)}
      strips={strips}
      hubStrip={variant.library === "none" ? hubList : []}
      libraryCount={libraryCount(variant, hubGraphics)}
      library={variant.library}
      allowCustom={variant.allowCustom}
      startStyleId={style.id}
      startGraphic={graphic}
      startOccasion={occasion}
    />
  );
}
