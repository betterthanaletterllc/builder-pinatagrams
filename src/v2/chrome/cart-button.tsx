"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { CART_EVENT, cartCount, PENDING_EVENT, pendingPieceCount } from "@/lib/flow";
import { checkPendingOrders } from "@/lib/checkout-client";
import { Bag } from "../ui/icons";
import c from "./chrome.module.css";

/** Live piñata count — the cart plus any order waiting for payment (this tab
 *  via CART_EVENT / PENDING_EVENT, other tabs via "storage"). 0 on the
 *  server render; hydrates to the real count immediately.
 *
 *  Both v2 headers (site + flow) render this instead of v1's <CartLink/>, so
 *  it also runs builder2's global "was the waiting order paid?" check — on
 *  mount and when a tab that sat open comes back into view. Throttled per
 *  order inside checkPendingOrders. */
export function useCartCount(): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    const update = () => setN(cartCount() + pendingPieceCount());
    update();
    window.addEventListener(CART_EVENT, update);
    window.addEventListener(PENDING_EVENT, update);
    window.addEventListener("storage", update);
    void checkPendingOrders();
    const onVisible = () => {
      if (document.visibilityState === "visible") void checkPendingOrders();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener(CART_EVENT, update);
      window.removeEventListener(PENDING_EVENT, update);
      window.removeEventListener("storage", update);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  return n;
}

function label(n: number) {
  return n > 0 ? `Your order, ${n} piñata${n === 1 ? "" : "s"} in the cart` : "Your order";
}

/**
 * The v2 cart icon. Step 4 of /design doubles as the order review, so with
 * piñatas in the cart the icon opens it there; an empty cart starts a new
 * piñata. Inside the flow the caller passes onClick to switch steps in place.
 */
export default function CartButton({
  onClick,
  extra = 0,
}: {
  onClick?: () => void;
  /** The piñata being built, when it already counts as part of the order
   *  (the flow decides — see design-flow-v2 cartExtra). */
  extra?: number;
}) {
  const n = useCartCount() + extra;
  const badge =
    n > 0 ? (
      <span className={c.count} aria-hidden="true">
        {n}
      </span>
    ) : null;
  if (onClick) {
    return (
      <button type="button" className={c.cart} onClick={onClick} aria-label={label(n)}>
        <Bag size={22} />
        {badge}
      </button>
    );
  }
  return (
    <Link
      href={n > 0 ? "/design?step=deliver" : "/design"}
      className={c.cart}
      aria-label={label(n)}
    >
      <Bag size={22} />
      {badge}
    </Link>
  );
}
