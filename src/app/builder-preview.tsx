"use client";

import Link from "next/link";
import Image from "next/image";
import { formatCents, type HubBodyStyle } from "@/lib/hub";
import { track } from "@/lib/analytics";

/**
 * Step 1 of the flow: pick a body style. One tap goes straight into the
 * design flow — no intermediate panel. Each card shows the "from" DELIVERED
 * price: the Classic graphic included, cheapest carrier (USPS). Graphic
 * upcharges, extras and FedEx build on top in the flow's running dock
 * (version-B tiers, 2026-07-22 — the flat one-price display retired).
 */

export default function BuilderPreview({
  bodyStyles,
  priceCents,
  from = false,
  variantParam = null,
}: {
  bodyStyles: HubBodyStyle[];
  priceCents?: number | null;
  // Tiered variants say "from" (upcharges ride on top); flat variants show
  // the ONE all-in delivered price.
  from?: boolean;
  // Non-production preview sitting: the ?variant= name to carry onto the
  // server-rendered design page so the whole walkthrough stays one profile.
  variantParam?: string | null;
}) {
  const price =
    priceCents != null ? (
      <div className="style-price">
        {from ? "from " : ""}
        {formatCents(priceCents)}{" "}
        <span className="style-price-note">delivered</span>
      </div>
    ) : null;
  return (
    <div>
      <div className="style-grid">
        {bodyStyles.map((s) =>
          s.inStock ? (
            <Link
              key={s.id}
              href={`/design?style=${s.id}${
                variantParam ? `&variant=${encodeURIComponent(variantParam)}` : ""
              }`}
              className="style-card"
              onClick={() => track("body_style_selected", { style: s.id })}
            >
              {s.imageUrl ? (
                // next/image: ~10 KB WebP thumbs instead of full-size files
                <Image src={s.imageUrl} alt={s.name} width={445} height={720} sizes="180px" />
              ) : null}
              <div className="style-name">{s.name}</div>
              {price}
            </Link>
          ) : (
            <div key={s.id} className="style-card oos" aria-disabled>
              {s.imageUrl ? (
                <Image src={s.imageUrl} alt={s.name} width={445} height={720} sizes="180px" />
              ) : null}
              <div className="style-name">{s.name}</div>
              {price}
              <div className="oos-tag">out of stock</div>
            </div>
          ),
        )}
      </div>
    </div>
  );
}
