"use client";

import { Callout } from "../ui/feedback";
import s from "./steps.module.css";

/**
 * A dry run (no Shopify credentials — local and preview builds): nothing
 * was charged; show what checkout WOULD have sent, one line per draft
 * order (ship-to, line items, the shipping title — "Guaranteed …" for
 * FedEx, never for USPS) and the raw payload behind a disclosure.
 * Addresses and messages stay out of autocapture and session replay.
 */
export default function DryRunResult({ payload }: { payload: Record<string, unknown> }) {
  const orders = Array.isArray(payload.draftOrders) ? payload.draftOrders : [];
  return (
    <div
      id="pg-dry-run"
      tabIndex={-1}
      className={`${s.block} ${s.dryRun} ph-sensitive`}
      data-ph-mask
    >
      <Callout tone="success" role="status">
        <p>
          <strong>Dry run — nothing was charged.</strong>{" "}
          {typeof payload.reason === "string" ? payload.reason : ""}
        </p>
        <ul>
          {orders.map((o, i) => {
            const rec = (o ?? {}) as Record<string, unknown>;
            const input = (rec.input ?? {}) as Record<string, unknown>;
            const shipping = (input.shippingLine ?? {}) as Record<string, unknown>;
            // 2026-07 payloads carry priceWithCurrency.amount (the deprecated
            // `price` is gone); older dry runs still show `price`.
            const shipAmount =
              (shipping.priceWithCurrency as { amount?: unknown } | undefined)?.amount ??
              shipping.price ??
              "";
            const items = Array.isArray(input.lineItems) ? input.lineItems.length : null;
            return (
              <li key={i}>
                {String(rec.shipTo ?? "Order")}
                {items !== null && ` · ${items} line item${items === 1 ? "" : "s"}`}
                {typeof shipping.title === "string" &&
                  ` · “${shipping.title}” $${String(shipAmount)}`}
              </li>
            );
          })}
        </ul>
        <details>
          <summary>What checkout would send</summary>
          <pre>{JSON.stringify(payload.draftOrders ?? payload, null, 2)}</pre>
        </details>
      </Callout>
    </div>
  );
}
