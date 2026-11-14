import type { Metadata } from "next";
import { embedEditorStyle, embedParentOrigins, embedSide, pickEmbedStyle } from "@/lib/embed";
import { previewOverridesAllowed } from "@/lib/flow-version";
import { getCatalog, type HubBodyStyle } from "@/lib/hub";
import { param, requestContext } from "@/v2/lib/server";
import EmbedDesign from "./embed-design";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Label designer — Piñatagrams",
  robots: { index: false, follow: false },
};

/**
 * /embed/design — the label editor on its own, for Paper to frame when staff
 * make a one-off sample (lib/embed has the whole story and the contract).
 *
 * ?style= names the body whose box the "On the box" preview shows (a hub id,
 * or the name Paper prints). Any body will do, in stock or not — a sample
 * can be of anything — and an unknown one falls back to the usual default.
 * With the hub unreachable the editor still opens, flat only.
 *
 * ?side=inside makes the card inside the box (the one the message prints
 * on) instead of the front label — the same editor, flat only (lib/embed).
 */
export default async function EmbedDesignPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const wanted = param(sp, "style") ?? null;
  const side = embedSide(param(sp, "side"));
  const { host, previewVariant } = await requestContext(undefined);

  let style: HubBodyStyle | null = null;
  try {
    const catalog = await getCatalog({ host, previewVariant });
    style = pickEmbedStyle(catalog.bodyStyles, wanted);
  } catch {
    // Hub unreachable: no box photo to show, but a label can still be made.
  }
  if (!style) {
    const id = wanted && /^[a-z0-9-]{1,40}$/i.test(wanted) ? wanted.toLowerCase() : "googly";
    style = {
      id,
      name: id,
      imageUrl: null,
      boxImageUrl: null,
      logoZone: null,
      inStock: true,
    };
  }

  return (
    <EmbedDesign
      style={embedEditorStyle(style, side)}
      side={side}
      parents={embedParentOrigins(!previewOverridesAllowed())}
    />
  );
}
