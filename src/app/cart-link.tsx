"use client";

import { useEffect, useState } from "react";
import { CART_EVENT, cartCount } from "@/lib/flow";
import { checkPendingOrders } from "@/lib/checkout-client";

/**
 * Header cart link with a live piñata count — ACTIVE cart lines only (lines
 * sent to checkout wait on their pending order, not in the cart).
 *
 * Rendered on every page, so it also runs the global paid check: a shopper
 * who paid on Shopify and came back anywhere — not just /cart — gets the
 * waiting order cleared (and the funnel closed); a deleted draft's lines
 * come back into the cart. Throttled per order inside checkPendingOrders.
 */
export default function CartLink() {
  // 0 on the server render; hydrates to the real count immediately.
  const [n, setN] = useState(0);

  useEffect(() => {
    const update = () => setN(cartCount());
    update();
    window.addEventListener(CART_EVENT, update); // this tab
    window.addEventListener("storage", update); // other tabs
    void checkPendingOrders();
    // Coming back to a builder tab that sat open while they paid elsewhere.
    const onVisible = () => {
      if (document.visibilityState === "visible") void checkPendingOrders();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener(CART_EVENT, update);
      window.removeEventListener("storage", update);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return (
    <a href="/cart" className="cart-link">
      Cart
      {n > 0 && (
        <span className="cart-count" aria-label={`${n} piñatas in the cart`}>
          {n}
        </span>
      )}
    </a>
  );
}
