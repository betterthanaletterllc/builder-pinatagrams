"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  discountAmountCents,
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
  clearPendingOrder,
  EMPTY_ADDRESS,
  loadCart,
  loadPendingOrder,
  rememberAddress,
  resolveFillings,
  saveCart,
  saveDraft,
  savePendingOrder,
  type CartLine,
  type DeliveryAddress,
  type PendingOrder,
} from "@/lib/flow";
import { cdnThumb } from "@/lib/library-data";
import { trackBeginCheckout } from "@/lib/analytics";

const MAX_QTY = 25;
const DISCOUNT_KEY = "pinatagrams-builder-discount";

// Up to two codes stack (one order + one free-shipping). Persist just the code
// strings (re-resolved on load) as a JSON array; a bare legacy string is read
// as a single code so pre-stacking carts still restore their discount.
const persistCodes = (codes: string[]) => {
  if (codes.length) localStorage.setItem(DISCOUNT_KEY, JSON.stringify(codes));
  else localStorage.removeItem(DISCOUNT_KEY);
};

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

// Shown when a draft was created but not yet paid — one tap back to the exact
// Shopify invoice. The cart itself is kept, so "keep editing" = the cart below.
function PendingCard({
  onResume,
  onDismiss,
}: {
  onResume: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="pending-order">
      <div className="pending-head">
        <strong>Your order is placed — it just needs payment.</strong>
        <button className="link-btn" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
      <p className="note">
        Finish paying on our secure checkout to lock it in — or change your cart
        and check out again for a new total.
      </p>
      <div className="pending-actions">
        <button className="btn primary" onClick={onResume}>
          Resume payment →
        </button>
      </div>
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
  const [discounts, setDiscounts] = useState<HubDiscount[]>([]);
  const [discountMsg, setDiscountMsg] = useState<string | null>(null);
  const [checkingCode, setCheckingCode] = useState(false);
  // True once the shopper applies/removes a code — stops the async mount
  // restore from clobbering a code they added before it resolved.
  const userTouched = useRef(false);
  // Non-null while editing the single ship-to address.
  const [editingAddr, setEditingAddr] = useState<DeliveryAddress | null>(null);
  // An unpaid draft from a prior checkout (abandoned invoice recovery).
  const [pending, setPending] = useState<PendingOrder | null>(null);
  // Set true when the pending order turns out to be already PAID — the cart
  // clears itself and shows a thank-you instead of the paid order.
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    const cart = loadCart();
    const p = loadPendingOrder();
    setPending(p);
    // If a recent order is pending, verify it wasn't ALREADY PAID before
    // showing the cart — a paid order must not reappear as an editable cart.
    // While the check runs, lines stays null (the "Loading…" state); it
    // resolves in well under a second and falls back to the cart on any hiccup.
    if (p?.draftOrderId) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5000);
      fetch("/api/order-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ draftOrderId: p.draftOrderId }),
        signal: ctrl.signal,
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((res) => {
          if (res?.status === "paid") {
            // Clear ONLY the lines that were in this (now-paid) draft — the
            // cart persists through checkout, so anything added afterwards
            // must survive.
            const draftedIds = new Set(p.lineIds ?? []);
            const remaining = cart.filter((l) => !draftedIds.has(l.id));
            saveCart(remaining);
            clearPendingOrder();
            setLines(remaining);
            setPending(null);
            setConfirmed(true);
          } else {
            // "gone" = the draft was deleted/cleaned up → drop the stale
            // banner but keep the (unpurchased) cart.
            if (res?.status === "gone") {
              clearPendingOrder();
              setPending(null);
            }
            setLines(cart);
          }
        })
        .catch(() => setLines(cart))
        .finally(() => clearTimeout(t));
    } else {
      setLines(cart);
    }
    // Restore a previously applied code (survives a cart refresh). If it no
    // longer resolves (deleted/deactivated since), self-heal: clear the
    // field + storage so a dead code can't sit there looking applied.
    const saved = localStorage.getItem(DISCOUNT_KEY);
    if (saved) {
      // New format is a JSON array (starts "["); anything else is a legacy
      // bare code string (pre-stacking) — treat it literally so a digit- or
      // keyword-like code can't be mangled by JSON.parse (e.g. "1E2" -> 100).
      let codes: string[];
      if (saved.startsWith("[")) {
        try {
          const parsed = JSON.parse(saved);
          codes = Array.isArray(parsed) ? parsed.map(String) : [];
        } catch {
          codes = [];
        }
      } else {
        codes = [saved];
      }
      Promise.all(codes.slice(0, 2).map((c) => resolveDiscount(c))).then((rs) => {
        // If the shopper already applied/removed a code while this resolved,
        // theirs wins — don't overwrite it with the restored set.
        if (userTouched.current) return;
        // Keep only codes that still resolve, at most one per kind (self-heal:
        // a since-deleted or now-duplicate-kind code drops out of storage).
        const seen = new Set<string>();
        const live = rs.filter(
          (d): d is HubDiscount =>
            !!d && !seen.has(d.kind) && !!seen.add(d.kind),
        );
        setDiscounts(live);
        persistCodes(live.map((d) => d.code));
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
      setDiscountMsg(null);
      return;
    }
    if (discounts.some((d) => d.code === code)) {
      setDiscountMsg("That code is already applied.");
      return;
    }
    if (discounts.length >= 2) {
      setDiscountMsg("You can apply up to two codes.");
      return;
    }
    setCheckingCode(true);
    setDiscountMsg(null);
    const d = await resolveDiscount(code);
    setCheckingCode(false);
    if (!d) {
      setDiscountMsg("That code isn’t valid.");
      return;
    }
    // Codes stack only ACROSS kinds — one order discount + one free-shipping.
    if (discounts.some((x) => x.kind === d.kind)) {
      setDiscountMsg(
        d.kind === "shipping"
          ? "You already have a free-shipping code."
          : "You already have an order discount — it only stacks with a free-shipping code.",
      );
      return;
    }
    userTouched.current = true;
    const next = [...discounts, d];
    setDiscounts(next);
    persistCodes(next.map((x) => x.code));
    setCodeInput("");
  };

  const removeCode = (code: string) => {
    userTouched.current = true;
    const next = discounts.filter((d) => d.code !== code);
    setDiscounts(next);
    persistCodes(next.map((d) => d.code));
    setDiscountMsg(null);
  };

  // Pending-order (unpaid draft) recovery — resume the invoice or dismiss.
  const resumePayment = () => {
    if (pending) window.location.assign(pending.invoiceUrl);
  };
  const dismissPending = () => {
    clearPendingOrder();
    setPending(null);
  };

  if (lines === null) return <p className="note">Loading…</p>;

  // The pending order was paid and nothing else is in the cart — thank-you.
  if (confirmed && lines.length === 0) {
    return (
      <div className="step-panel">
        <div className="pending-order">
          <div className="pending-head">
            <strong>Thanks — your order is confirmed! 🎉</strong>
          </div>
          <p className="note">
            We&apos;ve got it from here. Watch for a confirmation, and we&apos;ll
            get your piñata on its way.
          </p>
        </div>
        <p>
          <Link className="btn" href="/">
            + Send another piñata
          </Link>
        </p>
      </div>
    );
  }

  if (lines.length === 0 && !result) {
    return (
      <div className="step-panel">
        {pending && (
          <PendingCard onResume={resumePayment} onDismiss={dismissPending} />
        )}
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
  // Merchandise (piñatas + fillings + add-ons) and shipping, for the PREVIEW
  // estimate only — the real discount is the native Shopify code applied to
  // the draft, so the Shopify invoice is the true total. An order code takes
  // %/$ off merchandise; a shipping code zeroes shipping.
  const merchandiseCents =
    unitCents !== null ? unitCents * totalUnits + extrasTotalCents : null;
  const shipTotalCents = shipCents !== null ? shipCents * totalUnits : null;
  // One row per applied code. Amount/eligibility need loaded prices; until
  // they arrive (or if the price fetch failed) we still LIST the code — so it
  // stays visible and removable — but as amount-unknown, not below-minimum.
  // An order code comes off merchandise, a shipping code off shipping; kinds
  // are distinct (enforced on apply) so the amounts sum without double
  // counting. Shopify recomputes the authoritative invoice total.
  const pricesKnown = merchandiseCents !== null && shipTotalCents !== null;
  const codePreview = discounts.map((d) => {
    const eligible = pricesKnown && merchandiseCents! >= d.minSubtotalCents;
    return {
      d,
      known: pricesKnown,
      eligible,
      off: eligible
        ? discountAmountCents(d, merchandiseCents!, shipTotalCents!)
        : 0,
    };
  });
  const discountOffCents = codePreview.reduce((s, c) => s + c.off, 0);
  const totalCents =
    merchandiseCents !== null && shipTotalCents !== null
      ? merchandiseCents + shipTotalCents - discountOffCents
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
      // Send every applied CODE (never a claimed amount); Shopify enforces
      // each code's minimum and skips any that doesn't qualify. Don't gate on
      // our price ESTIMATE — it can differ from the real subtotal and would
      // wrongly withhold a code the customer legitimately earned.
      const codesToSend = discounts.map((d) => d.code);
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lines: payloadLines,
          ...(codesToSend.length ? { discountCodes: codesToSend } : {}),
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
          // becomes "$X again"), so drop fixed codes on the retry. Percent
          // and free-shipping codes are per-order by nature and stay.
          // (Single-address checkout never partial-fails, so this is a guard.)
          const fixed = discounts.filter(
            (d) => d.kind === "order" && d.type === "fixed",
          );
          if (fixed.length) {
            const kept = discounts.filter(
              (d) => !(d.kind === "order" && d.type === "fixed"),
            );
            setDiscounts(kept);
            persistCodes(kept.map((d) => d.code));
            setDiscountMsg(
              `${fixed.map((d) => d.code).join(", ")} applied to the order(s) already created.`,
            );
          }
        }
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      setResult(data);
      if (data.dryRun === false) {
        // Single-destination order: record the draft's invoice as PENDING and
        // hand off to Shopify's hosted checkout — but DON'T clear the cart, so
        // hitting "back" from the invoice lands them on their cart intact (the
        // banner just offers a one-tap return to this exact invoice).
        if (data.orders?.length === 1) {
          savePendingOrder({
            invoiceUrl: data.orders[0].invoiceUrl,
            createdAt: Date.now(),
            draftOrderId: data.orders[0].draftOrderId,
            lineIds: current.map((l) => l.id),
          });
          window.location.assign(data.orders[0].invoiceUrl);
          return;
        }
        // Multi-destination (can't happen under single-address) stays on this
        // page listing each invoice.
        update([]);
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
        {confirmed && (
          <div className="pending-order">
            <div className="pending-head">
              <strong>Your order is confirmed! 🎉</strong>
            </div>
            <p className="note">
              That piñata&apos;s on its way. Anything below is a separate order
              you haven&apos;t placed yet.
            </p>
          </div>
        )}
        {pending && (
          <PendingCard onResume={resumePayment} onDismiss={dismissPending} />
        )}
        {lines.map((l) => (
          <div className="cart-line" key={l.id}>
            <CartBoxThumb line={l} />
            <div className="cart-line-info">
              <strong>
                {l.graphic.type === "custom"
                  ? `Your design — ${l.styleName}`
                  : `${l.graphic.title} — ${l.styleName}`}
              </strong>
              <dl className="cart-detail">
                <div>
                  <dt>Filling</dt>
                  <dd>{l.filling}</dd>
                </div>
                {(l.addons ?? []).some((id) => addonById.get(id)?.label) && (
                  <div>
                    <dt>Add-ons</dt>
                    <dd>
                      {(l.addons ?? [])
                        .map((id) => addonById.get(id)?.label)
                        .filter(Boolean)
                        .join(", ")}
                    </dd>
                  </div>
                )}
                <div>
                  <dt>Arrives</dt>
                  <dd>{l.deliveryDate}</dd>
                </div>
                {l.message && (
                  <div>
                    <dt>Message</dt>
                    <dd className="cart-msg">“{l.message}”</dd>
                  </div>
                )}
                {addressComplete(l.address) && (
                  <div>
                    <dt>Ships to</dt>
                    <dd>
                      {l.address.name} · {l.address.address1}
                      {l.address.address2 ? `, ${l.address.address2}` : ""},{" "}
                      {l.address.city}, {l.address.province} {l.address.zip}
                    </dd>
                  </div>
                )}
              </dl>
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
                    // Land on the last step (address is inherited, so the
                    // Send-to step is skipped) — ready to re-save, with the
                    // chips to jump back to graphic/message/etc.
                    router.push(
                      `/design?style=${l.styleId}&edit=${l.id}&step=delivery`,
                    );
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
                {formatCents(
                  (unitCents +
                    lineAddonCents(l) +
                    lineFillingCents(l) +
                    (shipCents ?? 0)) *
                    l.qty,
                )}
                <span className="cart-line-price-note">incl. shipping</span>
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
              {codePreview.map(({ d, off }) =>
                off > 0 ? (
                  <div className="row discount-row" key={d.code}>
                    <span>
                      {d.code}
                      {d.kind === "shipping" ? " (free shipping)" : ""}
                    </span>
                    <span>−{formatCents(off)}</span>
                  </div>
                ) : null,
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
          {codePreview.map(({ d, eligible, known }) => (
            <div
              key={d.code}
              className={"discount-applied" + (known && !eligible ? " below" : "")}
            >
              <span>
                {known && !eligible ? "○" : "✓"} <strong>{d.code}</strong>{" "}
                {d.kind === "shipping"
                  ? "free shipping"
                  : d.type === "percent"
                    ? `${d.value}% off`
                    : `${formatCents(d.value)} off`}
              </span>
              <button
                className="btn mini ghost"
                onClick={() => removeCode(d.code)}
              >
                Remove
              </button>
            </div>
          ))}
          {codePreview.map(({ d, eligible, known }) =>
            known && !eligible ? (
              <p className="note discount-msg" key={d.code + "-min"}>
                {d.code} needs a {formatCents(d.minSubtotalCents)} minimum — add
                more to use it.
              </p>
            ) : null,
          )}
          {discounts.length < 2 && (
            <div className="row" style={{ gap: 8 }}>
              <input
                className="in"
                placeholder={discounts.length ? "Add another code" : "Discount code"}
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
          {discounts.length === 1 && (
            <p className="note discount-hint">
              An order code and a free-shipping code can stack.
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
