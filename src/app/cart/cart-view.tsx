"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { formatCents, priceUrl, type HubPrice } from "@/lib/hub";
import {
  loadCart,
  saveCart,
  type CartLine,
  type ShippingAddress,
} from "@/lib/flow";

const EMPTY_ADDRESS: ShippingAddress = {
  name: "",
  email: "",
  address1: "",
  address2: "",
  city: "",
  province: "",
  zip: "",
  phone: "",
};

type CheckoutResult =
  | { dryRun: true; reason: string; draftOrderInput: unknown }
  | { dryRun: false; invoiceUrl: string; draftOrderId: string };

export default function CartView() {
  const [lines, setLines] = useState<CartLine[] | null>(null);
  const [unitPrice, setUnitPrice] = useState<HubPrice | null>(null);
  const [address, setAddress] = useState<ShippingAddress>(EMPTY_ADDRESS);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<CheckoutResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLines(loadCart());
    // B2C single-destination pricing: per-unit delivered price from the hub.
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

  const addressOk =
    address.name && address.email.includes("@") && address.address1 &&
    address.city && address.province && address.zip;

  const checkout = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lines, address }),
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
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              className="cart-thumb"
              src={
                l.graphic.type === "custom"
                  ? l.graphic.preview
                  : (l.graphic.thumb ?? "")
              }
              alt=""
            />
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
            <pre className="payload-pre">
              {JSON.stringify(result.draftOrderInput, null, 2)}
            </pre>
          </div>
        )}
        {result && !result.dryRun && (
          <div className="notice info">
            <strong>Order created!</strong>{" "}
            <a href={result.invoiceUrl}>Pay your invoice here.</a>
          </div>
        )}
        {error && <div className="notice warn">{error}</div>}
      </div>

      <aside className="panel">
        <h2>Delivery address</h2>
        {(
          [
            ["name", "Full name"],
            ["email", "Email"],
            ["address1", "Address"],
            ["address2", "Apt / suite (optional)"],
            ["city", "City"],
            ["province", "State"],
            ["zip", "ZIP"],
            ["phone", "Phone (optional)"],
          ] as const
        ).map(([key, label]) => (
          <div className="field" key={key}>
            <label htmlFor={`addr-${key}`}>{label}</label>
            <input
              id={`addr-${key}`}
              value={address[key]}
              onChange={(e) =>
                setAddress((a) => ({ ...a, [key]: e.target.value }))
              }
            />
          </div>
        ))}

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

        <button
          className="btn primary block"
          disabled={!addressOk || submitting || lines.length === 0}
          onClick={checkout}
        >
          {submitting ? "Placing order…" : "Place order"}
        </button>
        <p className="note">
          You&apos;ll get a Shopify invoice by email — the order ships once
          it&apos;s paid.
        </p>
      </aside>
    </div>
  );
}
