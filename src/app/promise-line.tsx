import type { ReactNode } from "react";

/**
 * The promise, before any effort: when it arrives, what it costs delivered,
 * and how senders rate it — "Order by midnight CT → arrives Thu, Oct 1 ·
 * $44.99 delivered · ★ 4.8 across all Piñatagrams". Every part is optional
 * and simply drops out when its data didn't load.
 *
 * The rating is brand-pooled: the reviews API's scope label always renders
 * WITH the number (its display contract), never the number alone.
 *
 * A plain component (no hooks) so the server home page and the client
 * landing overlay render the exact same line.
 */

export type PromiseInfo = {
  // Soonest FedEx arrival for an order placed today (shop time), formatted.
  arrives: string | null;
  // "$44.99 delivered" / "From $41.49 delivered".
  price: string | null;
  rating: { value: number; label: string } | null;
};

/** "Across all Piñatagrams" reads mid-sentence as "across all Piñatagrams";
 *  an acronym-led label ("USA …") keeps its case. */
function inline(label: string): string {
  return /^[A-Z][a-z]/.test(label)
    ? label[0].toLowerCase() + label.slice(1)
    : label;
}

export default function PromiseLine({
  info,
  className,
}: {
  info: PromiseInfo;
  className?: string;
}) {
  const parts: ReactNode[] = [];
  if (info.arrives) {
    parts.push(
      <span key="arrives" className="promise-part">
        Order by midnight CT → arrives <strong>{info.arrives}</strong>
      </span>,
    );
  }
  if (info.price) {
    parts.push(
      <span key="price" className="promise-part">
        {info.price}
      </span>,
    );
  }
  if (info.rating) {
    parts.push(
      <span key="rating" className="promise-part">
        <span aria-hidden="true">★ </span>
        <span className="visually-hidden">Rated </span>
        {info.rating.value.toFixed(1)} {inline(info.rating.label)}
      </span>,
    );
  }
  if (!parts.length) return null;
  return (
    <p className={"promise-line" + (className ? ` ${className}` : "")}>
      {parts.flatMap((p, i) =>
        i === 0
          ? [p]
          : [
              <span key={`sep${i}`} className="promise-sep" aria-hidden="true">
                ·
              </span>,
              p,
            ],
      )}
    </p>
  );
}
