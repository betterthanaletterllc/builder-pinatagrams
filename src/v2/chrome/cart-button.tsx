"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { CART_EVENT, cartCount } from "@/lib/flow";
import { Bag } from "../ui/icons";
import c from "./chrome.module.css";

/** Live piñata count (this tab via CART_EVENT, other tabs via "storage").
 *  0 on the server render; hydrates to the real count immediately.
 *
 *  Both v2 headers (site + flow) render this instead of v1's <CartLink/>, so
 *  builder2's shared "was the pending order paid?" check belongs on this
 *  mount too: checkPendingOrders() from lib/checkout-client (MERGE NOTE — it
 *  lands with the checkout workstream; call it in the effect below). */
export function useCartCount(): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    const update = () => setN(cartCount());
    update();
    window.addEventListener(CART_EVENT, update);
    window.addEventListener("storage", update);
    return () => {
      window.removeEventListener(CART_EVENT, update);
      window.removeEventListener("storage", update);
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
export default function CartButton({ onClick }: { onClick?: () => void }) {
  const n = useCartCount();
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
