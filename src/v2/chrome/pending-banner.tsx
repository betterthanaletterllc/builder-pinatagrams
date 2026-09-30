"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  clearPendingOrder,
  loadPendingOrder,
  PENDING_EVENT,
  pendingKey,
  type PendingOrder,
} from "@/lib/flow";
import { resumePayment } from "@/lib/checkout-client";
import { Info } from "../ui/icons";
import c from "./chrome.module.css";

/**
 * "Your order is waiting for payment" — a draft order was created but its
 * invoice hasn't been paid. Home and Step 1 show it (and the last step, when
 * a new piñata is in progress) so an interrupted checkout is one tap from
 * done: Resume payment, View order (the order review, where it comes back
 * into the cart), or Remove order right here — after one "are you sure".
 * (Whether that draft has since been PAID is checked by the shared cart
 * logic, which clears the record — the banner listens for that and
 * disappears.)
 */
export default function PendingBanner({
  className,
  showView = true,
}: {
  className?: string;
  /** false where the banner already sits on the order review */
  showView?: boolean;
}) {
  const [pending, setPending] = useState<PendingOrder | null>(null);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    const update = () => setPending(loadPendingOrder());
    update();
    window.addEventListener(PENDING_EVENT, update);
    window.addEventListener("storage", update);
    return () => {
      window.removeEventListener(PENDING_EVENT, update);
      window.removeEventListener("storage", update);
    };
  }, []);
  if (!pending) return null;
  const count = pending.lines.reduce((n, l) => n + l.qty, 0);
  return (
    <section className={`${c.pending} ${className ?? ""}`} aria-label="Order waiting for payment">
      <p>
        <Info size={20} />
        <strong>
          {confirming
            ? `Remove this order${count ? ` (${count} piñata${count === 1 ? "" : "s"})` : ""}?`
            : "Your order is waiting for payment."}
        </strong>
      </p>
      <div className={c.pendingActions}>
        {confirming ? (
          <>
            <button
              type="button"
              className={c.remove}
              onClick={() => {
                // An unpaid draft is never charged; the store's expiry job
                // clears it once its date passes.
                clearPendingOrder(pendingKey(pending));
                setConfirming(false);
              }}
            >
              Remove order
            </button>
            <button type="button" className={c.keep} onClick={() => setConfirming(false)}>
              Keep it
            </button>
          </>
        ) : (
          <>
            <a
              className={c.resume}
              href={pending.invoiceUrl}
              onClick={(e) => {
                // Clears the paid-check throttle on the way out, so whichever
                // builder page they come back to re-checks right away.
                e.preventDefault();
                resumePayment(pending);
              }}
            >
              Resume payment
            </a>
            {showView && <Link href="/design?step=deliver">View order</Link>}
            <button type="button" className={c.keep} onClick={() => setConfirming(true)}>
              Remove order
            </button>
          </>
        )}
      </div>
    </section>
  );
}
