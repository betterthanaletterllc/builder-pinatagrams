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
 * Step 1 of the B2C flow: pick a body style. Quantity/shipping choices live
 * in the cart now — this page just anchors the price ("From $X delivered",
 * single unit, filled, shipped individually).
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
  const firstInStock = bodyStyles.find((s) => s.inStock);
  const [styleId, setStyleId] = useState<string | null>(
    firstInStock ? firstInStock.id : null,
  );
  const [price, setPrice] = useState<HubPrice | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    fetch(priceUrl(PRICE_KNOBS), { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then(setPrice)
      .catch(() => {});
    return () => ctrl.abort();
  }, []);

  const selected = bodyStyles.find((s) => s.id === styleId);

  return (
    <div className="builder-grid">
      <div className="style-grid">
        {bodyStyles.map((s) => (
          <div
            key={s.id}
            className={
              "style-card" +
              (s.id === styleId ? " selected" : "") +
              (s.inStock ? "" : " oos")
            }
            onClick={() => s.inStock && setStyleId(s.id)}
            role="button"
            aria-pressed={s.id === styleId}
            aria-disabled={!s.inStock}
          >
            {s.imageUrl ? (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img src={s.imageUrl} alt={s.name} loading="lazy" />
            ) : null}
            <div className="style-name">{s.name}</div>
            {!s.inStock && <div className="oos-tag">out of stock</div>}
          </div>
        ))}
      </div>

      <aside className="panel">
        <h2>{selected ? selected.name : "Pick a style"}</h2>
        {price && (
          <p className="price-from">
            From <strong>{formatCents(price.unitDeliveredCents)}</strong>{" "}
            delivered
          </p>
        )}
        {selected && (
          <Link
            className="btn primary block"
            href={`/design?style=${selected.id}`}
          >
            Start designing →
          </Link>
        )}
        <p className="note">
          Next you&apos;ll pick or design the front graphic, add a message,
          choose the filling, and set a delivery date.
        </p>
        <p className="note">
          <Link href="/cart">View cart</Link>
        </p>
      </aside>
    </div>
  );
}
