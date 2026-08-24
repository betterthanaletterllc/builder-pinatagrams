"use client";

import { useEffect } from "react";
import { captureDiscountParam } from "@/lib/flow";

/**
 * Marketing/QR links land anywhere on the site with ?discount=CODE — stash
 * the code (window.location, not useSearchParams, so the server layout needs
 * no Suspense boundary) and the cart applies it when the shopper gets there.
 * The cart still validates against the hub, so a dead code applies nothing.
 */
export default function DiscountCapture() {
  useEffect(() => {
    captureDiscountParam();
  }, []);
  return null;
}
