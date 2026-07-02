"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  formatCents,
  priceUrl,
  type HubBodyStyle,
  type HubPrice,
} from "@/lib/hub";

/**
 * Step 1 of the flow: pick a body style. One tap goes straight into the
 * design flow — no intermediate panel. Quantity/shipping live in the cart.
 */

const PRICE_KNOBS = {
  qty: 1,
  fill: "filled",
  bodyType: "standard",
  graphicType: "custom",
  mode: "individual",
  carrier: "standard",
} as const;

export default function BuilderPreview({
  bodyStyles,
}: {
  bodyStyles: HubBodyStyle[];
}) {
  const [price, setPrice] = useState<HubPrice | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    fetch(priceUrl(PRICE_KNOBS), { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then(setPrice)
      .catch(() => {});
    return () => ctrl.abort();
  }, []);

  return (
    <div>
      {price && (
        <p className="price-from">
          <strong>{formatCents(price.unitDeliveredCents)}</strong> delivered —
          tap a style to start designing.
        </p>
      )}
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
