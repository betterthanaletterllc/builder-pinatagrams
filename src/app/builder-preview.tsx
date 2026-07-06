"use client";

import Link from "next/link";
import type { HubBodyStyle } from "@/lib/hub";

/**
 * Step 1 of the flow: pick a body style. One tap goes straight into the
 * design flow — no intermediate panel. The running price lives in the
 * build dock once a style is picked; quantity/shipping live in the cart.
 */

export default function BuilderPreview({
  bodyStyles,
}: {
  bodyStyles: HubBodyStyle[];
}) {
  return (
    <div>
      <div className="style-grid">
        {bodyStyles.map((s) =>
          s.inStock ? (
            <Link
              key={s.id}
              href={`/design?style=${s.id}`}
              className="style-card"
            >
              {s.imageUrl ? (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img src={s.imageUrl} alt={s.name} loading="lazy" />
              ) : null}
              <div className="style-name">{s.name}</div>
            </Link>
          ) : (
            <div key={s.id} className="style-card oos" aria-disabled>
              {s.imageUrl ? (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img src={s.imageUrl} alt={s.name} loading="lazy" />
              ) : null}
              <div className="style-name">{s.name}</div>
              <div className="oos-tag">out of stock</div>
            </div>
          ),
        )}
      </div>
    </div>
  );
}
