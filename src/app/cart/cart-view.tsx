"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  discountCents,
  formatCents,
  HUB_URL,
  priceUrl,
  resolveDiscount,
  type HubAddon,
  type HubDiscount,
  type HubFilling,
  type HubPrice,
} from "@/lib/hub";
import {
  addressComplete,
  addressKey,
  EMPTY_ADDRESS,
  loadCart,
  rememberAddress,
  resolveFillings,
  saveCart,
  saveDraft,
  type CartLine,
  type DeliveryAddress,
} from "@/lib/flow";
import { cdnThumb } from "@/lib/library-data";
import { trackBeginCheckout } from "@/lib/analytics";

const MAX_QTY = 25;
const DISCOUNT_KEY = "pinatagrams-builder-discount";

// The whole cart ships to ONE address (one order, one invoice). Editing it
// here rewrites every line.
const ADDRESS_FIELDS: [keyof DeliveryAddress, string][] = [
  ["name", "Recipient name"],
  ["address1", "Address"],
  ["address2", "Apt / suite (optional)"],
  ["city", "City"],
  ["province", "State"],
  ["zip", "ZIP"],
  ["phone", "Phone (optional)"],
];

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
  const [codeInput, setCodeInput] = useState("");
  const [discount, setDiscount] = useState<HubDiscount | null>(null);
  const [discountMsg, setDiscountMsg] = useState<string | null>(null);
  const [checkingCode, setCheckingCode] = useState(false);
  // Non-null while editing the single ship-to address.
  const [editingAddr, setEditingAddr] = useState<DeliveryAddress | null>(null);

  useEffect(() => {
    setLines(loadCart());
    // Restore a previously applied code (survives a cart refresh). If it no
    // longer resolves (deleted/deactivated since), self-heal: clear the
    // field + storage so a dead code can't sit there looking applied.
    const savedCode = localStorage.getItem(DISCOUNT_KEY);
    if (savedCode) {
      setCodeInput(savedCode);
      resolveDiscount(savedCode).then((d) => {
        if (d) setDiscount(d);
        else {
          setCodeInput("");
          localStorage.removeItem(DISCOUNT_KEY);
        }
      });
    }
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

  // The one ship-to address (all lines share it). Editing rewrites every
  // line so the whole cart stays one destination → one draft → one invoice.
  const shipTo =
    (lines ?? []).find((l) => addressComplete(l.address))?.address ?? null;
  const saveAddr = () => {
    if (!editingAddr || !addressComplete(editingAddr) || !lines) return;
    update(lines.map((l) => ({ ...l, address: editingAddr })));
    rememberAddress(editingAddr);
    setEditingAddr(null);
  };

  const applyCode = async () => {
    const code = codeInput.trim().toUpperCase();
    if (!code) {
      setDiscount(null);
      setDiscountMsg(null);
      localStorage.removeItem(DISCOUNT_KEY);
      return;
    }
    setCheckingCode(true);
    setDiscountMsg(null);
    const d = await resolveDiscount(code);
    setCheckingCode(false);
    if (!d) {
      setDiscount(null);
      setDiscountMsg("That code isn’t valid.");
      localStorage.removeItem(DISCOUNT_KEY);
      return;
    }
    setDiscount(d);
    localStorage.setItem(DISCOUNT_KEY, d.code);
  };

  const clearCode = () => {
    setCodeInput("");
    setDiscount(null);
    setDiscountMsg(null);
    localStorage.removeItem(DISCOUNT_KEY);
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
  // Merchandise only (piñatas + fillings + add-ons) — a discount applies
  // here, never to shipping. Matches the invoice exactly for single
  // destinations and fixed codes; a multi-destination percent may differ a
  // cent (Shopify rounds per draft). The invoice is always the real total.
  const merchandiseCents =
    unitCents !== null ? unitCents * totalUnits + extrasTotalCents : null;
  const discountAmountCents =
    merchandiseCents !== null ? discountCents(discount, merchandiseCents) : 0;
  // A code that no longer qualifies (subtotal fell below its minimum).
  const belowMin =
    !!discount &&
    merchandiseCents !== null &&
    merchandiseCents < discount.minSubtotalCents;
  const totalCents =
    unitCents !== null && shipCents !== null && merchandiseCents !== null
      ? merchandiseCents + shipCents * totalUnits - discountAmountCents
      : null;

  const missingAddress = lines.filter((l) => !addressComplete(l.address));

  const checkout = async () => {
    setSubmitting(true);
    setError(null);
    trackBeginCheckout(totalCents);
    // Re-read storage NOW: a background art upload may have patched the
    // cart since this page mounted, and the "give it a few seconds and try
    // again" retry only works if the retry actually sees the patch.
    const current = loadCart();
    setLines(current);
    try {
      // The server prices from ids and prints from the uploaded Blob URLs
      // (art/designUrl/artSha256) — it never reads the embedded design
      // document or the preview data URL. Null ONLY those two on the POST
      // (photo-heavy customs would otherwise blow Vercel's ~4.5 MB body
      // cap); spread keeps every other field — checkout hard-requires
      // artSha256 for blob art, and an allowlist here would silently drop
      // the next field someone adds.
      const payloadLines = current.map((l) =>
        l.graphic.type === "custom"
          ? {
              ...l,
              graphic: {
                ...l.graphic,
                design: null,
                preview: "",
              } as unknown as CartLine["graphic"],
            }
          : l,
      );
      // No email squeeze: Shopify's payment page collects contact info.
      // Send the CODE only (never a claimed amount); checkout re-resolves
      // and applies it to each draft, and the invoice shows the real total.
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lines: payloadLines,
          ...(discount && !belowMin ? { discountCode: discount.code } : {}),
        }),
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
            current.filter(
              (l) => !addressComplete(l.address) || !orderedKeys.has(addressKey(l.address)),
            ),
          );
          setResult({ dryRun: false, orders: createdSoFar });
          // A FIXED code's total was split across ALL destinations; part of
          // it is already baked into the created order(s). Re-applying it to
          // the surviving lines would over-discount (the code's "$X total"
          // becomes "$X again"), so drop it on the retry. Percent codes are
          // per-order by nature and stay.
          if (discount?.type === "fixed") {
            clearCode();
            setDiscountMsg(
              `${discount.code} was applied to the order(s) already created.`,
            );
          }
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

        <div className="ship-to">
          <div className="ship-to-head">
            <strong>Ship to</strong>
            {!editingAddr && (
              <button
                className="link-btn"
                onClick={() => setEditingAddr(shipTo ?? EMPTY_ADDRESS)}
              >
                {shipTo ? "Edit" : "Add address"}
              </button>
            )}
          </div>
          {editingAddr ? (
            <div className="addr-edit">
              {ADDRESS_FIELDS.map(([key, label]) => (
                <label key={key} className="ffield">
                  <input
                    className="in"
                    placeholder={label}
                    value={editingAddr[key]}
                    onChange={(e) =>
                      setEditingAddr({ ...editingAddr, [key]: e.target.value })
                    }
                  />
                </label>
              ))}
              <div className="row" style={{ gap: 8 }}>
                <button
                  className="btn sm"
                  onClick={saveAddr}
                  disabled={!addressComplete(editingAddr)}
                >
                  Save address
                </button>
                <button
                  className="btn ghost sm"
                  onClick={() => setEditingAddr(null)}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : shipTo ? (
            <p className="note ship-to-addr">
              {shipTo.name}
              <br />
              {shipTo.address1}
              {shipTo.address2 ? `, ${shipTo.address2}` : ""}
              <br />
              {shipTo.city}, {shipTo.province} {shipTo.zip}
            </p>
          ) : (
            <p className="note" style={{ color: "var(--warn)" }}>
              No delivery address yet — add one to check out.
            </p>
          )}
          <p className="note ship-to-hint">
            One address per checkout. Sending to someone else? Place this
            order, then start another.
          </p>
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
              {extrasTotalCents > 0 && (
                <div className="row">
                  <span>Add-ons &amp; extras</span>
                  <span>{formatCents(extrasTotalCents)}</span>
                </div>
              )}
              {discount && !belowMin && discountAmountCents > 0 && (
                <div className="row discount-row">
                  <span>{discount.code}</span>
                  <span>−{formatCents(discountAmountCents)}</span>
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

        <div className="discount-field">
          {discount && !belowMin ? (
            <div className="discount-applied">
              <span>
                ✓ <strong>{discount.code}</strong> applied
              </span>
              <button className="btn mini ghost" onClick={clearCode}>
                Remove
              </button>
            </div>
          ) : (
            <div className="row" style={{ gap: 8 }}>
              <input
                className="in"
                placeholder="Discount code"
                value={codeInput}
                onChange={(e) => setCodeInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && applyCode()}
                style={{ textTransform: "uppercase" }}
                aria-label="Discount code"
              />
              <button
                className="btn ghost"
                onClick={applyCode}
                disabled={checkingCode || !codeInput.trim()}
              >
                {checkingCode ? "…" : "Apply"}
              </button>
            </div>
          )}
          {belowMin && discount && (
            <p className="note discount-msg">
              {discount.code} needs a{" "}
              {formatCents(discount.minSubtotalCents)} minimum — add more to
              use it, or{" "}
              <button className="link-btn" onClick={clearCode}>
                remove it
              </button>
              .
            </p>
          )}
          {discountMsg && <p className="note discount-msg">{discountMsg}</p>}
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
