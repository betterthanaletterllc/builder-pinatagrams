"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { formatCents, priceUrl, type HubPrice } from "@/lib/hub";
import {
  addressComplete,
  addressKey,
  loadCart,
  saveCart,
  type CartLine,
} from "@/lib/flow";

type CheckoutResult =
  | {
      dryRun: true;
      reason: string;
      draftOrders: { shipTo: string; input: unknown }[];
    }
  | {
      dryRun: false;
      orders: { shipTo: string; invoiceUrl: string; draftOrderId: string }[];
    };

// "Your box" thumbnail: the graphic composited onto the style's box photo
// (same logoZone math as the preview rail); falls back to the raw art.
function CartBoxThumb({ line }: { line: CartLine }) {
  const art =
    line.graphic.type === "custom"
      ? line.graphic.preview
      : (line.graphic.art ?? line.graphic.thumb ?? "");
  if (!line.boxImageUrl || !line.logoZone) {
    /* eslint-disable-next-line @next/next/no-img-element */
    return <img className="cart-thumb" src={art} alt="" />;
  }
  return (
    <div className="cart-thumb box-composite">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={line.boxImageUrl} alt="" className="box-img" />
      {art && (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img
          src={art}
          alt=""
          className="box-art"
          style={{
            left: `${line.logoZone.x * 100}%`,
            top: `${line.logoZone.y * 100}%`,
            width: `${line.logoZone.w * 100}%`,
            height: `${line.logoZone.h * 100}%`,
          }}
        />
      )}
    </div>
  );
}

export default function CartView() {
  const [lines, setLines] = useState<CartLine[] | null>(null);
  const [unitPrice, setUnitPrice] = useState<HubPrice | null>(null);
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<CheckoutResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLines(loadCart());
    fetch(
      priceUrl({
        qty: 1,
        fill: "filled",
        bodyType: "standard",
        graphicType: "custom",
        mode: "individual",
        carrier: "standard",
      }),
    )
      .then((r) => (r.ok ? r.json() : null))
      .then(setUnitPrice)
      .catch(() => {});
  }, []);

  const update = (next: CartLine[]) => {
    setLines(next);
    saveCart(next);
  };

  if (lines === null) return <p className="note">Loading…</p>;

  if (lines.length === 0 && !result) {
    return (
      <div className="step-panel">
        <p>Nothing here yet.</p>
        <Link className="btn primary" href="/">
          Design a piñata →
        </Link>
      </div>
    );
  }

  const totalUnits = lines.reduce((s, l) => s + l.qty, 0);
  const unitCents = unitPrice?.unitPriceCents ?? null;
  const shipCents = unitPrice?.shipPerUnitCents ?? null;
  const totalCents =
    unitCents !== null && shipCents !== null
      ? (unitCents + shipCents) * totalUnits
      : null;

  const missingAddress = lines.filter((l) => !addressComplete(l.address));
  const destinations = new Set(
    lines.filter((l) => addressComplete(l.address)).map((l) => addressKey(l.address)),
  ).size;
  const emailOk = email.includes("@") && email.includes(".");

  const checkout = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lines, email }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setResult(data);
      if (data.dryRun === false) update([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Checkout failed.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="cart-grid">
      <div>
        {lines.map((l) => (
          <div className="cart-line" key={l.id}>
            <CartBoxThumb line={l} />
            <div className="cart-line-info">
              <strong>
                {l.graphic.type === "custom"
                  ? `Your design — ${l.styleName}`
                  : `${l.graphic.title} — ${l.styleName}`}
              </strong>
              <p className="note">
                {l.filling} · arrives {l.deliveryDate}
                {l.message ? " · with gift message" : ""}
              </p>
              {addressComplete(l.address) ? (
                <p className="note">
                  → {l.address.name}, {l.address.city}, {l.address.province}
                </p>
              ) : (
                <p className="note" style={{ color: "var(--warn)" }}>
                  Missing delivery address — remove this piñata and add it
                  again.
                </p>
              )}
              <div className="el-controls">
                <button
                  className="btn mini"
                  onClick={() =>
                    update(
                      lines.map((x) =>
                        x.id === l.id
                          ? { ...x, qty: Math.max(1, x.qty - 1) }
                          : x,
                      ),
                    )
                  }
                >
                  −
                </button>
                <span className="qty">{l.qty}</span>
                <button
                  className="btn mini"
                  onClick={() =>
                    update(
                      lines.map((x) =>
                        x.id === l.id ? { ...x, qty: x.qty + 1 } : x,
                      ),
                    )
                  }
                >
                  +
                </button>
                <button
                  className="btn danger"
                  onClick={() => update(lines.filter((x) => x.id !== l.id))}
                >
                  ✕
                </button>
              </div>
            </div>
            {unitCents !== null && (
              <div className="cart-line-price">
                {formatCents(unitCents * l.qty)}
              </div>
            )}
          </div>
        ))}

        <p>
          <Link className="btn" href="/">
            + Add another piñata
          </Link>
        </p>

        {result && result.dryRun && (
          <div className="notice info" style={{ overflowX: "auto" }}>
            <strong>Checkout dry run</strong> — {result.reason}
            {result.draftOrders.map((o, i) => (
              <div key={i}>
                <p className="note">
                  Order {i + 1} → {o.shipTo}
                </p>
                <pre className="payload-pre">
                  {JSON.stringify(o.input, null, 2)}
                </pre>
              </div>
            ))}
          </div>
        )}
        {result && !result.dryRun && (
          <div className="notice info">
            <strong>
              {result.orders.length === 1
                ? "Order created!"
                : `${result.orders.length} orders created!`}
            </strong>
            <ul>
              {result.orders.map((o) => (
                <li key={o.draftOrderId}>
                  {o.shipTo}: <a href={o.invoiceUrl}>pay this invoice</a>
                </li>
              ))}
            </ul>
          </div>
        )}
        {error && <div className="notice warn">{error}</div>}
      </div>

      <aside className="panel">
        <h2>Checkout</h2>

        {destinations > 1 && (
          <div className="notice info">
            Shipping to {destinations} different addresses — each becomes its
            own order and invoice.
          </div>
        )}

        <div className="field">
          <label htmlFor="payer-email">Your email (for the invoice)</label>
          <input
            id="payer-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>

        <div className="price-lines">
          {unitCents !== null && shipCents !== null ? (
            <>
              <div className="row">
                <span>
                  {totalUnits} piñata{totalUnits === 1 ? "" : "s"}
                </span>
                <span>{formatCents(unitCents * totalUnits)}</span>
              </div>
              <div className="row">
                <span>Shipping</span>
                <span>{formatCents(shipCents * totalUnits)}</span>
              </div>
              <div className="row total">
                <span>Total</span>
                <span>{totalCents !== null ? formatCents(totalCents) : ""}</span>
              </div>
            </>
          ) : (
            <p className="note">Getting prices…</p>
          )}
        </div>

        {missingAddress.length > 0 && (
          <div className="notice warn">
            {missingAddress.length} piñata
            {missingAddress.length === 1 ? " is" : "s are"} missing a delivery
            address.
          </div>
        )}

        <button
          className="btn primary block"
          disabled={
            !emailOk ||
            submitting ||
            lines.length === 0 ||
            missingAddress.length > 0
          }
          onClick={checkout}
        >
          {submitting ? "Placing order…" : "Place order"}
        </button>
        <p className="note">
          You&apos;ll get a Shopify invoice by email — orders ship once paid.
        </p>
      </aside>
    </div>
  );
}
