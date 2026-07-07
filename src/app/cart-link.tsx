"use client";

import { useEffect, useState } from "react";
import { CART_EVENT, cartCount } from "@/lib/flow";

/** Header cart link with a live piñata count. */
export default function CartLink() {
  // 0 on the server render; hydrates to the real count immediately.
  const [n, setN] = useState(0);

  useEffect(() => {
    const update = () => setN(cartCount());
    update();
    window.addEventListener(CART_EVENT, update); // this tab
    window.addEventListener("storage", update); // other tabs
    return () => {
      window.removeEventListener(CART_EVENT, update);
      window.removeEventListener("storage", update);
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
