"use client";

import Link from "next/link";
import Image from "next/image";
import { formatCents, type HubBodyStyle } from "@/lib/hub";
import { track } from "@/lib/analytics";

/**
 * Step 1 of the flow: pick a body style. One tap goes straight into the
 * design flow — no intermediate panel. Each card shows the hub's DELIVERED
 * B2C price (same for every body; add-ons ride on top) so the number never
 * grows between landing and invoice; the running total lives in the build
 * dock once a style is picked.
 */

export default function BuilderPreview({
  bodyStyles,
  priceCents,
}: {
  bodyStyles: HubBodyStyle[];
  priceCents?: number | null;
}) {
  const price =
    priceCents != null ? (
      <div className="style-price">
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
              href={`/design?style=${s.id}`}
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
