"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { loadPendingOrder, type PendingOrder } from "@/lib/flow";
import { Info } from "../ui/icons";
import c from "./chrome.module.css";

/**
 * "Your order is waiting for payment" — a draft order was created but its
 * invoice hasn't been paid. Home and Step 1 show it so an interrupted
 * checkout is one tap from done. (Whether that draft has since been PAID is
 * checked by the shared cart logic, which clears the record.)
 */
export default function PendingBanner({ className }: { className?: string }) {
  const [pending, setPending] = useState<PendingOrder | null>(null);
  useEffect(() => setPending(loadPendingOrder()), []);
  if (!pending) return null;
  return (
    <section className={`${c.pending} ${className ?? ""}`} aria-label="Order waiting for payment">
      <p>
        <Info size={20} />
        <strong>Your order is waiting for payment.</strong>
      </p>
      <div className={c.pendingActions}>
        <a className={c.resume} href={pending.invoiceUrl}>
          Resume payment
        </a>
        <Link href="/cart">View order</Link>
      </div>
    </section>
  );
}
