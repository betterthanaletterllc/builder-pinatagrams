"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  formatCents,
  HUB_URL,
  priceUrl,
  type HubAddon,
  type HubFilling,
  type HubPrice,
} from "@/lib/hub";
import {
  addressComplete,
  addressKey,
  loadCart,
  resolveFillings,
  saveCart,
  saveDraft,
  type CartLine,
} from "@/lib/flow";
import { cdnThumb } from "@/lib/library-data";
import { trackBeginCheckout } from "@/lib/analytics";

const MAX_QTY = 25;

type CheckoutResult =
  | {
      dryRun: true;
      reason: string;
      draftOrders: { groupKey: string; shipTo: string; input?: unknown }[];
    }
  | {
      dryRun: false;
      orders: {
        groupKey: string;
        shipTo: string;
        invoiceUrl: string;
        draftOrderId: string;
        invoiceSent: boolean;
      }[];
    };

// "Your box" thumbnail: the graphic composited onto the style's box photo
// (same logoZone math as the preview rail); falls back to the raw art.
function CartBoxThumb({ line }: { line: CartLine }) {
  const art =
    line.graphic.type === "custom"
      ? line.graphic.preview
      : (cdnThumb(line.graphic.art ?? line.graphic.thumb, 360) ?? "");
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
  const router = useRouter();
  const [lines, setLines] = useState<CartLine[] | null>(null);
  const [unitPrice, setUnitPrice] = useState<HubPrice | null>(null);
  const [addonCatalog, setAddonCatalog] = useState<HubAddon[]>([]);
  const [fillingCatalog, setFillingCatalog] = useState<HubFilling[]>(
    resolveFillings(undefined),
  );
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
    // Add-on/filling labels + prices come from the live catalog (display
    // only — checkout re-resolves everything server-side).
    fetch(`${HUB_URL}/api/public/catalog`)
      .then((r) => (r.ok ? r.json() : null))
      .then((c) => {
        setAddonCatalog(c?.addons ?? []);
        setFillingCatalog(resolveFillings(c?.fillings));
      })
      .catch(() => {});
  }, []);

  const addonById = new Map(addonCatalog.map((a) => [a.id, a]));
  const fillingByLabel = new Map(fillingCatalog.map((f) => [f.label, f]));
  // Per-unit add-on/filling cost for one line; unknown ids price at 0 here
  // and get rejected server-side if they somehow reach checkout.
  const lineAddonCents = (l: CartLine) =>
    (l.addons ?? []).reduce(
      (s, id) => s + (addonById.get(id)?.priceCents ?? 0),
      0,
    );
  const lineFillingCents = (l: CartLine) =>
    fillingByLabel.get(l.filling)?.priceCents ?? 0;

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
  const extrasTotalCents = lines.reduce(
    (s, l) => s + (lineAddonCents(l) + lineFillingCents(l)) * l.qty,
    0,
  );
  const totalCents =
    unitCents !== null && shipCents !== null
      ? (unitCents + shipCents) * totalUnits + extrasTotalCents
      : null;

  const missingAddress = lines.filter((l) => !addressComplete(l.address));
  const destinations = new Set(
    lines.filter((l) => addressComplete(l.address)).map((l) => addressKey(l.address)),
  ).size;

  const checkout = async () => {
    setSubmitting(true);
    setError(null);
    trackBeginCheckout(totalCents);
    try {
      // No email squeeze: Shopify's payment page collects contact info.
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lines }),
      });
      const data = await res.json();
      if (!res.ok) {
        // Partial multi-destination failure: some orders WERE created.
        // Mark those lines ordered (remove from cart) so a retry can't
        // duplicate them, and show their invoice links.
        const createdSoFar = data.createdSoFar as
          | { groupKey: string; shipTo: string; invoiceUrl: string; draftOrderId: string; invoiceSent: boolean }[]
          | undefined;
        if (createdSoFar && createdSoFar.length > 0) {
          const orderedKeys = new Set(createdSoFar.map((o) => o.groupKey));
          update(
            lines.filter(
              (l) => !addressComplete(l.address) || !orderedKeys.has(addressKey(l.address)),
            ),
          );
          setResult({ dryRun: false, orders: createdSoFar });
        }
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      setResult(data);
      if (data.dryRun === false) {
        update([]);
        // Single-destination order: hand off straight into Shopify's hosted
        // checkout (card / Shop Pay / Apple Pay). Multi-destination stays on
        // this page listing each invoice.
        if (data.orders?.length === 1) {
          window.location.assign(data.orders[0].invoiceUrl);
          return;
        }
      }
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
                {l.filling}
                {(l.addons ?? [])
                  .map((id) => addonById.get(id)?.label)
                  .filter(Boolean)
                  .map((label) => ` + ${label}`)
                  .join("")}{" "}
                · arrives {l.deliveryDate}
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
                  onClick={() => {
                    // reopen the flow loaded with this line; saving replaces it
                    saveDraft({
                      styleId: l.styleId,
                      graphic: l.graphic,
                      message: l.message,
                      filling: l.filling,
                      addons: l.addons ?? [],
                      date: l.deliveryDate,
                      address: l.address,
                      editLineId: l.id,
                    });
                    router.push(`/design?style=${l.styleId}&edit=${l.id}`);
                  }}
                >
                  Edit
                </button>
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
                  disabled={l.qty >= MAX_QTY}
                  onClick={() =>
                    update(
                      lines.map((x) =>
                        x.id === l.id
                          ? { ...x, qty: Math.min(MAX_QTY, x.qty + 1) }
                          : x,
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
                {formatCents((unitCents + lineAddonCents(l)) * l.qty)}
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
            <strong>Heads up</strong> — {result.reason}
            {result.draftOrders.map((o, i) => (
              <div key={o.groupKey ?? i}>
                <p className="note">
                  Order {i + 1} → {o.shipTo}
                </p>
                {o.input != null && (
                  <pre className="payload-pre">
                    {JSON.stringify(o.input, null, 2)}
                  </pre>
                )}
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
            {result.orders.length > 1 && (
              <p className="note">
                Each destination is its own order — open and pay each one
                below. Keep this page open until they&apos;re all paid.
              </p>
            )}
            <ul>
              {result.orders.map((o) => (
                <li key={o.draftOrderId}>
                  {o.shipTo}: <a href={o.invoiceUrl}>pay now</a>
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

        <div className="price-lines">
          {unitCents !== null && shipCents !== null ? (
            <>
              <div className="row">
                <span>
                  {totalUnits} piñata{totalUnits === 1 ? "" : "s"}
                </span>
                <span>{formatCents(unitCents * totalUnits)}</span>
              </div>
              {extrasTotalCents > 0 && (
                <div className="row">
                  <span>Add-ons &amp; extras</span>
                  <span>{formatCents(extrasTotalCents)}</span>
                </div>
              )}
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
            submitting || lines.length === 0 || missingAddress.length > 0
          }
          onClick={checkout}
        >
          {submitting ? "Heading to checkout…" : "Check out"}
        </button>
        <p className="note">
          You&apos;ll finish up on our secure Shopify checkout — card, Shop
          Pay, or Apple Pay.
        </p>
      </aside>
    </div>
  );
}
