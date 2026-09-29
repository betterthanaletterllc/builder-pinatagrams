"use client";

import { useEffect, useState } from "react";
import { track } from "@/lib/analytics";
import s from "./app-states.module.css";

// Everything the builder keeps on this device shares this key prefix: cart,
// in-progress draft, discount codes, pending order, address book, library
// view, landing/variant flags.
const STORAGE_PREFIX = "pinatagrams-";

function clearBuilderStorage(): void {
  for (const store of ["localStorage", "sessionStorage"] as const) {
    try {
      const st = window[store];
      const keys: string[] = [];
      for (let i = 0; i < st.length; i++) {
        const k = st.key(i);
        if (k?.startsWith(STORAGE_PREFIX)) keys.push(k);
      }
      for (const k of keys) st.removeItem(k);
    } catch {
      // storage blocked — nothing to clear
    }
  }
}

/** Shared body of error.tsx (a page crashed) and global-error.tsx (the
 *  layout itself crashed). "Try again" re-renders; "Reset my cart" is the
 *  escape hatch when saved state is what keeps crashing the page — two taps,
 *  so a stray one can't empty a cart. */
export default function ErrorScreen({
  error,
  onRetry,
  boundary,
}: {
  error: Error & { digest?: string };
  onRetry: () => void;
  boundary: "route" | "global";
}) {
  const [confirmReset, setConfirmReset] = useState(false);

  useEffect(() => {
    track("app_error", {
      boundary,
      // Production server errors arrive redacted: message generic, digest
      // = the key to the server log line.
      message: String(error?.message ?? "").slice(0, 200),
      digest: error?.digest,
      path: window.location.pathname,
    });
  }, [error, boundary]);

  const resetCart = () => {
    if (!confirmReset) {
      setConfirmReset(true);
      return;
    }
    track("app_error_reset_cart", { boundary });
    clearBuilderStorage();
    window.location.assign("/");
  };

  return (
    <div className={s.error} role="alert">
      {boundary === "global" && <span className={s.wordmark}>Piñatagrams</span>}
      <h1>That didn&apos;t go to plan</h1>
      <p>
        Something on this page hit a snag. Try again — and if it keeps
        happening, resetting your cart usually clears it up.
      </p>
      <div className={s.actions}>
        <button type="button" className="btn primary" onClick={onRetry}>
          Try again
        </button>
        <button type="button" className="btn" onClick={resetCart}>
          {confirmReset ? "Yes, empty my cart" : "Reset my cart"}
        </button>
      </div>
      {confirmReset && (
        <p className={s.hint}>
          This removes the piñatas in your cart and everything the builder
          saved on this device (drafts, codes, addresses), then starts fresh.
        </p>
      )}
      <p className={s.hint}>
        Still stuck?{" "}
        <a href="mailto:nathan@pinatagrams.com">Email us</a> and we&apos;ll
        sort it out.
      </p>
    </div>
  );
}
